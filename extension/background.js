importScripts("debugger.js", "tab-commands.js", "status.js", "devtools.js");

const NATIVE_HOST = "com.o2yama.chrome_bridge";
const CONNECTION_ALARM = "chrome-bridge-connection";
const RECONNECT_DELAY_MS = 3000;
const INJECT_TIMEOUT_MS = 8000;

let nativePort = null;
let reconnectTimer = null;
let lastConnectAttempt = 0;
let instanceIdPromise = null;

class BridgeError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

function callbackCall(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function badArgs(message, detail = {}) {
  throw new BridgeError("BAD_ARGS", message, detail);
}

function requireObject(value, name = "args") {
  if (!value || typeof value !== "object" || Array.isArray(value)) badArgs(`${name}が不正です`);
  return value;
}

function requireTabId(args) {
  if (!Number.isInteger(args.tabId) || args.tabId < 0) badArgs("tabIdが不正です");
  return args.tabId;
}

function requireBooleanIfPresent(args, name) {
  if (args[name] !== undefined && typeof args[name] !== "boolean") badArgs(`${name}が不正です`);
}

function isBlockedUrl(url) {
  if (typeof url !== "string" || !url) return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (
    parsed.hostname === "chrome.google.com" &&
    (parsed.pathname === "/webstore" || parsed.pathname.startsWith("/webstore/"))
  ) {
    return true;
  }
  if (parsed.hostname === "chromewebstore.google.com") return true;
  return !["http:", "https:", "file:", "ftp:"].includes(parsed.protocol);
}

async function getTab(tabId) {
  try {
    return await callbackCall(chrome.tabs.get.bind(chrome.tabs), tabId);
  } catch (error) {
    if (/No tab with id|Invalid tab ID/i.test(error.message)) {
      throw new BridgeError("NO_SUCH_TAB", "指定されたタブがありません", { tabId });
    }
    throw error;
  }
}

async function ensureFront(tabId) {
  const tab = await getTab(tabId);
  if (tab.active) return false;
  await chrome.tabs.update(tabId, { active: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  return true;
}

async function executePage(tabId, operation, args, allFrames = false, send) {
  try {
    return await executePageOnce(tabId, operation, args, allFrames);
  } catch (error) {
    if (error.code !== "TAB_NOT_RESPONDING") throw error;
    let awake = false;
    try {
      if (send) await send("Page.setWebLifecycleState", { state: "active" });
      else await withDebugger(tabId, (command) => command("Page.setWebLifecycleState", { state: "active" }));
      awake = true;
    } catch {}
    if (awake) {
      try { return await executePageOnce(tabId, operation, args, allFrames); }
      catch (retryError) {
        if (retryError.code !== "TAB_NOT_RESPONDING") throw retryError;
        error = retryError;
      }
    }
    if (!(await ensureFront(tabId))) throw error;
    return executePageOnce(tabId, operation, args, allFrames);
  }
}

async function executePageOnce(tabId, operation, args, allFrames = false) {
  const tab = await getTab(tabId);
  if (isBlockedUrl(tab.url)) {
    throw new BridgeError("CANNOT_ACCESS_PAGE", "このページにはアクセスできません", {
      tabId,
      url: tab.url || "",
    });
  }
  const target = { tabId, allFrames };
  // 時間切れのあとでタブが目覚めたとき、待たされていた操作が遅れて実行される（クリックの二重実行など）のを防ぐ。
  let abandoned = false;
  try {
    // 休止・凍結された裏のタブでは注入が返ってこないため、待ち続けずに状態を返す。
    const results = await withTimeout(
      (async () => {
        await chrome.scripting.executeScript({ target, files: ["page-functions.js"] });
        if (abandoned) return [];
        return chrome.scripting.executeScript({
          target,
          func: (name, commandArgs) => globalThis.ChromeBridgePage.command(name, commandArgs),
          args: [operation, args],
        });
      })(),
      INJECT_TIMEOUT_MS,
      () => {
        abandoned = true;
        return new BridgeError("TAB_NOT_RESPONDING", "タブが応答しません（休止中の可能性）。activate で前面にすると読めます", {
          tabId,
          active: tab.active,
          discarded: Boolean(tab.discarded),
          frozen: Boolean(tab.frozen),
        });
      },
    );
    for (const entry of results) {
      if (!entry.result) {
        throw new BridgeError("INTERNAL", "ページ内の処理が結果を返しませんでした", { tabId, frameId: entry.frameId });
      }
      if (entry.result.ok === false) {
        const error = entry.result.error || {};
        throw new BridgeError(error.code || "INTERNAL", error.message || "ページ操作に失敗しました", error.detail || {});
      }
    }
    return results;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (/No tab with id|Invalid tab ID/i.test(error.message || "")) {
      throw new BridgeError("NO_SUCH_TAB", "指定されたタブがありません", { tabId });
    }
    throw new BridgeError("CANNOT_ACCESS_PAGE", "このページにはアクセスできません", {
      tabId,
      url: tab.url || "",
      cause: String(error?.message || error),
    });
  }
}

function withTimeout(promise, ms, makeError) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function activate(args) {
  const tabId = requireTabId(args);
  await getTab(tabId);
  const tab = await chrome.tabs.update(tabId, { active: true });
  return { tabId, active: tab.active, discarded: Boolean(tab.discarded) };
}

async function getInstanceId() {
  if (!instanceIdPromise) {
    instanceIdPromise = (async () => {
      const stored = await callbackCall(chrome.storage.local.get.bind(chrome.storage.local), "instanceId");
      if (typeof stored.instanceId === "string" && stored.instanceId) return stored.instanceId;
      const instanceId = crypto.randomUUID();
      await callbackCall(chrome.storage.local.set.bind(chrome.storage.local), { instanceId });
      return instanceId;
    })();
  }
  return instanceIdPromise;
}

async function hello() {
  const [instanceId, profile, stored, windows, incognitoAllowed] = await Promise.all([
    getInstanceId(),
    callbackCall(chrome.identity.getProfileUserInfo.bind(chrome.identity), { accountStatus: "ANY" }),
    callbackCall(chrome.storage.local.get.bind(chrome.storage.local), "label"),
    callbackCall(chrome.windows.getAll.bind(chrome.windows), { populate: true }),
    callbackCall(chrome.extension.isAllowedIncognitoAccess.bind(chrome.extension)),
  ]);
  return {
    instanceId,
    email: profile?.email || "",
    label: typeof stored.label === "string" ? stored.label : "",
    extensionVersion: chrome.runtime.getManifest().version,
    ...(await verificationInfo()),
    debugTabs: [...attachedDebuggerTabs],
    incognitoAllowed: Boolean(incognitoAllowed),
    windows: {
      normal: windows.filter((window) => !window.incognito).length,
      incognito: windows.filter((window) => window.incognito).length,
    },
    tabCount: windows.reduce((count, window) => count + (window.tabs?.length || 0), 0),
  };
}

async function setLabel(args) {
  if (typeof args.label !== "string") badArgs("labelが不正です");
  await callbackCall(chrome.storage.local.set.bind(chrome.storage.local), { label: args.label });
  return { label: args.label };
}

async function listTabs() {
  const windows = await callbackCall(chrome.windows.getAll.bind(chrome.windows), { populate: true });
  return {
    tabs: windows.flatMap((window) =>
      (window.tabs || []).map((tab) => ({
        tabId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        groupId: tab.groupId,
        active: tab.active,
        windowFocused: window.focused,
        incognito: tab.incognito,
        title: tab.title || "",
        url: tab.url || "",
        status: tab.status || "",
        discarded: Boolean(tab.discarded),
        frozen: Boolean(tab.frozen),
      })),
    ),
  };
}

async function read(args) {
  const tabId = requireTabId(args);
  const mode = args.mode === undefined ? "text" : args.mode;
  if (mode !== "text" && mode !== "html") badArgs("modeが不正です");
  if (args.selector !== undefined && typeof args.selector !== "string") badArgs("selectorが不正です");
  requireBooleanIfPresent(args, "allFrames");
  const offset = args.offset === undefined ? 0 : args.offset;
  const maxChars = args.maxChars === undefined ? 100000 : args.maxChars;
  if (!Number.isInteger(offset) || offset < 0) badArgs("offsetが不正です");
  if (!Number.isInteger(maxChars) || maxChars < 0) badArgs("maxCharsが不正です");

  const entries = await executePage(
    tabId,
    "read",
    { mode, selector: args.selector || "" },
    args.allFrames === true,
  );
  entries.sort((a, b) => a.frameId - b.frameId);
  const main = entries.find((entry) => entry.frameId === 0)?.result.result || entries[0]?.result.result;
  const source = entries.map((entry) => entry.result.result.source).join("\n");
  const totalChars = source.length;
  return {
    url: main.url,
    title: main.title,
    text: source.slice(offset, offset + maxChars),
    totalChars,
    truncated: offset + maxChars < totalChars,
    scroll: main.scroll,
  };
}

async function elements(args) {
  const tabId = requireTabId(args);
  requireBooleanIfPresent(args, "inViewportOnly");
  const entries = await executePage(tabId, "elements", {
    inViewportOnly: args.inViewportOnly === true,
  });
  return entries[0].result.result;
}

function validPoint(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y)
  );
}

async function scroll(args) {
  const tabId = requireTabId(args);
  const choices = [args.by !== undefined, args.to !== undefined, args.ref !== undefined, args.selector !== undefined];
  if (choices.filter(Boolean).length !== 1) badArgs("scroll先を1つ指定してください");
  if (args.by !== undefined && !validPoint(args.by)) badArgs("byが不正です");
  if (
    args.to !== undefined &&
    args.to !== "top" &&
    args.to !== "bottom" &&
    !validPoint(args.to)
  ) {
    badArgs("toが不正です");
  }
  if (args.ref !== undefined && (!Number.isInteger(args.ref) || args.ref < 0)) badArgs("refが不正です");
  if (args.selector !== undefined && (typeof args.selector !== "string" || !args.selector)) {
    badArgs("selectorが不正です");
  }
  const entries = await executePage(tabId, "scroll", {
    by: args.by,
    to: args.to,
    ref: args.ref,
    selector: args.selector,
  });
  return entries[0].result.result;
}

function validateClickTarget(args) {
  const point = args.x !== undefined || args.y !== undefined;
  if (point) {
    if (args.ref !== undefined || !validPoint(args)) badArgs("ref または x, y を指定してください");
  } else if (!Number.isInteger(args.ref) || args.ref < 0) badArgs("refが不正です");
}

async function click(args) {
  const tabId = requireTabId(args);
  validateClickTarget(args);
  requireBooleanIfPresent(args, "allowRisky");
  requireBooleanIfPresent(args, "allowInput");
  requireBooleanIfPresent(args, "real");
  if (args.real || args.x !== undefined) return realPointer(args, true);
  const entries = await executePage(tabId, "click", {
    ref: args.ref,
    allowRisky: args.allowRisky === true,
    allowInput: args.allowInput === true,
  });
  return entries[0].result.result;
}

async function type(args) {
  const tabId = requireTabId(args);
  if (!Number.isInteger(args.ref) || args.ref < 0) badArgs("refが不正です");
  if (typeof args.text !== "string") badArgs("textが不正です");
  if (typeof args.userInstructed !== "boolean") badArgs("userInstructedが不正です");
  requireBooleanIfPresent(args, "real");
  if (args.real) return realType(args);
  const entries = await executePage(tabId, "type", {
    ref: args.ref,
    text: args.text,
    userInstructed: args.userInstructed,
  });
  return entries[0].result.result;
}

async function screenshot(args) {
  const tabId = requireTabId(args);
  requireBooleanIfPresent(args, "full");
  return serializeDebugger(tabId, () => captureScreenshot(tabId, args));
}

async function captureScreenshot(tabId, args) {
  const tab = await getTab(tabId);
  if (tab.active && !args.full && !emulationStates.has(tabId)) {
    try {
      const dataUrl = await callbackCall(chrome.tabs.captureVisibleTab.bind(chrome.tabs), tab.windowId, { format: "png" });
      return { dataUrl };
    } catch {}
  }
  try {
    return await useDebuggerConnection(tabId, async (send) => {
      await send("Page.setWebLifecycleState", { state: "active" });
      const params = { format: "png" };
      if (args.full) {
        const metrics = await send("Page.getLayoutMetrics");
        const size = metrics.cssContentSize || metrics.contentSize;
        if (!size || !(size.width > 0) || !(size.height > 0)) throw new Error("ページのサイズを取得できません");
        params.captureBeyondViewport = true;
        params.clip = { x: size.x || 0, y: size.y || 0, width: size.width, height: size.height, scale: 1 };
      }
      const result = await send("Page.captureScreenshot", params);
      if (!result.data) throw new Error("PNGが返りませんでした");
      return { dataUrl: `data:image/png;base64,${result.data}` };
    });
  } catch (error) {
    if (tab.active) throw error;
    throw new BridgeError("TAB_NOT_ACTIVE", "裏のタブを撮影できません", {
      tabId, cause: error.detail?.cause || error.message, code: error.code,
    });
  }
}

async function dispatch(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) badArgs("要求が不正です");
  if (typeof request.id !== "string") badArgs("idが不正です");
  if (typeof request.cmd !== "string") badArgs("cmdが不正です");
  const args = request.args === undefined ? {} : requireObject(request.args);
  switch (request.cmd) {
    case "open": return openTab(args);
    case "nav": return navigateTab(args);
    case "close": return closeTab(args);
    case "hover": return realPointer(args, false);
    case "key": return pressKey(args);
    case "debugStart": return debugStart(args);
    case "debugStop": return debugStop(args);
    case "console": return debugRecords(args, "messages");
    case "network": return network(args);
    case "emulate": return emulate(args);
    case "inspect": return inspect(args);
    case "style": return style(args);
    case "perf": return perf(args);
    case "eval": return evaluate(args);
    case "selftestResult": return selftestResult(args);
    case "hello":
      return hello();
    case "setLabel":
      return setLabel(args);
    case "tabs":
      return listTabs();
    case "read":
      return read(args);
    case "elements":
      return elements(args);
    case "scroll":
      return scroll(args);
    case "click":
      return click(args);
    case "type":
      return type(args);
    case "screenshot":
      return screenshot(args);
    case "activate":
      return activate(args);
    case "reload":
      // 応答を返してから自分を読み込み直す（コード更新を手動操作なしで反映するため）。
      setTimeout(() => chrome.runtime.reload(), 200);
      return { reloading: true };
    default:
      badArgs("不明なコマンドです", { cmd: request.cmd });
  }
}

function errorResponse(id, error) {
  const known = error instanceof BridgeError;
  return {
    id,
    ok: false,
    error: {
      code: known ? error.code : "INTERNAL",
      message: known ? error.message : "内部エラーが発生しました",
      detail: known ? error.detail : { cause: String(error?.stack || error?.message || error) },
    },
  };
}

async function handleMessage(port, request) {
  const id = request && typeof request === "object" ? request.id : undefined;
  let response;
  try {
    response = { id, ok: true, result: await dispatch(request) };
  } catch (error) {
    response = errorResponse(id, error);
  }
  try {
    port.postMessage(response);
  } catch {
    // 切断直後に完了した処理の応答は送れないため破棄する。
  }
}

function scheduleReconnect() {
  if (nativePort || reconnectTimer) return;
  const wait = Math.max(0, RECONNECT_DELAY_MS - (Date.now() - lastConnectAttempt));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureNativeConnection();
  }, wait);
}

function ensureNativeConnection() {
  if (nativePort) return;
  const elapsed = Date.now() - lastConnectAttempt;
  if (elapsed < RECONNECT_DELAY_MS) {
    scheduleReconnect();
    return;
  }
  lastConnectAttempt = Date.now();
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch {
    scheduleReconnect();
    return;
  }
  nativePort = port;
  port.onMessage.addListener((message) => {
    void handleMessage(port, message);
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (nativePort === port) nativePort = null;
    scheduleReconnect();
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CONNECTION_ALARM) ensureNativeConnection();
});
chrome.runtime.onStartup.addListener(ensureNativeConnection);
chrome.runtime.onInstalled.addListener(ensureNativeConnection);
chrome.alarms.create(CONNECTION_ALARM, { periodInMinutes: 1 });
ensureNativeConnection();

void updateBadge().catch(() => {});
