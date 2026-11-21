const debugConnections = new Map();
const emulationStates = new Map();
const attachedDebuggerTabs = new Set();
const debuggerQueues = new Map();

function serializeDebugger(tabId, task) {
  const previous = debuggerQueues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  debuggerQueues.set(tabId, next);
  return next.finally(() => {
    if (debuggerQueues.get(tabId) === next) debuggerQueues.delete(tabId);
  });
}

async function attachDebugger(tabId) {
  await getTab(tabId);
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedDebuggerTabs.add(tabId);
  } catch (error) {
    throw new BridgeError("DEBUGGER_FAILED", "デバッガに接続できません", { cause: String(error.message || error) });
  }
}

async function withDebugger(tabId, task, options = {}) {
  return serializeDebugger(tabId, () => useDebuggerConnection(tabId, task, options));
}

async function useDebuggerConnection(tabId, task, options = {}) {
  if (!attachedDebuggerTabs.has(tabId)) await attachDebugger(tabId);
  try {
    if (options.input) {
      await chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", { state: "active" });
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    }
    return await task((method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params));
  } finally {
    if (options.input && hasPersistentDebugger(tabId)) {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
    }
    await releaseDebugger(tabId).catch(() => {});
  }
}

function hasPersistentDebugger(tabId) {
  return debugConnections.has(tabId) || emulationStates.has(tabId);
}

async function releaseDebugger(tabId) {
  if (!hasPersistentDebugger(tabId) && attachedDebuggerTabs.has(tabId)) {
    await chrome.debugger.detach({ tabId });
    attachedDebuggerTabs.delete(tabId);
  }
}

async function disableDebugDomains(tabId) {
  for (const domain of ["Network", "Log", "Runtime"]) {
    await chrome.debugger.sendCommand({ tabId }, `${domain}.disable`).catch(() => {});
  }
}

async function debugStart(args) {
  const tabId = requireTabId(args);
  return serializeDebugger(tabId, async () => {
    if (debugConnections.has(tabId)) return { attached: true };
    if (!attachedDebuggerTabs.has(tabId)) await attachDebugger(tabId);
    const state = { messages: [], requests: [], pending: new Map(), extra: new Map() };
    debugConnections.set(tabId, state);
    let ready = false;
    try {
      for (const domain of ["Runtime", "Log", "Network"]) {
        await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
      }
      if (debugConnections.get(tabId) !== state) throw new BridgeError("DEBUGGER_FAILED", "デバッガが切断されました", { cause: "detached" });
      ready = true;
      return { attached: true };
    } finally {
      if (!ready) {
        debugConnections.delete(tabId);
        await disableDebugDomains(tabId);
        await releaseDebugger(tabId);
      }
    }
  });
}

async function debugStop(args) {
  const tabId = requireTabId(args);
  return serializeDebugger(tabId, async () => {
    if (debugConnections.has(tabId)) {
      debugConnections.delete(tabId);
      await disableDebugDomains(tabId);
    }
    await releaseDebugger(tabId);
    return { detached: !attachedDebuggerTabs.has(tabId) };
  });
}

function appendRecord(list, record) {
  list.unshift(record);
  if (list.length > 1000) list.pop();
}

function clearDebuggerState(tabId) {
  debugConnections.delete(tabId);
  emulationStates.delete(tabId);
  attachedDebuggerTabs.delete(tabId);
}

chrome.debugger.onDetach.addListener(({ tabId }) => clearDebuggerState(tabId));
chrome.tabs.onRemoved.addListener(clearDebuggerState);
chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  const state = debugConnections.get(tabId);
  if (!state) return;
  const at = new Date().toISOString();
  if (method === "Runtime.consoleAPICalled") {
    const frame = params.stackTrace?.callFrames?.[0];
    appendRecord(state.messages, { level: params.type, text: (params.args || []).map((arg) => arg.value === undefined ? arg.description || arg.unserializableValue || "" : typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value)).join(" "), url: frame?.url || "", line: frame?.lineNumber || 0, at });
  } else if (method === "Runtime.exceptionThrown") {
    const detail = params.exceptionDetails;
    appendRecord(state.messages, { level: "error", text: detail.exception?.description || detail.text, url: detail.url || "", line: detail.lineNumber || 0, at });
  } else if (method === "Log.entryAdded") {
    const entry = params.entry;
    appendRecord(state.messages, { level: entry.level, text: entry.text, url: entry.url || "", line: entry.lineNumber || 0, at });
  } else if (method === "Network.requestWillBeSent") {
    const previous = state.pending.get(params.requestId);
    if (previous && params.redirectResponse) previous.status = params.redirectResponse.status;
    const record = {
      requestId: params.requestId, method: params.request.method, url: redactUrl(params.request.url),
      status: null, type: params.type || "", at, failed: false,
      requestHeaders: redactHeaders(params.request.headers), responseHeaders: {}, mimeType: "",
    };
    const extra = state.extra.get(params.requestId);
    if (extra) {
      record.requestHeaders = { ...record.requestHeaders, ...extra.requestHeaders };
      record.responseHeaders = { ...extra.responseHeaders };
      if (extra.status !== undefined) record.status = extra.status;
      state.extra.delete(params.requestId);
    }
    appendRecord(state.requests, record);
    state.pending.set(params.requestId, record);
    for (const [id, item] of state.pending) if (!state.requests.includes(item)) state.pending.delete(id);
  } else if (method === "Network.responseReceived") {
    const record = state.pending.get(params.requestId);
    if (record) {
      record.status = params.response.status;
      record.type = params.type;
      record.responseHeaders = { ...redactHeaders(params.response.headers), ...record.responseHeaders };
      record.mimeType = params.response.mimeType || "";
    }
  } else if (method === "Network.requestWillBeSentExtraInfo" || method === "Network.responseReceivedExtraInfo") {
    const record = state.requests.find((item) => item.requestId === params.requestId);
    const extra = record || state.extra.get(params.requestId) || {};
    const key = method === "Network.requestWillBeSentExtraInfo" ? "requestHeaders" : "responseHeaders";
    extra[key] = { ...extra[key], ...redactHeaders(params.headers) };
    if (params.statusCode !== undefined) extra.status = params.statusCode;
    if (!record) {
      state.extra.set(params.requestId, extra);
      if (state.extra.size > 1000) state.extra.delete(state.extra.keys().next().value);
    }
  } else if (method === "Network.loadingFailed" || method === "Network.loadingFinished") {
    const record = state.pending.get(params.requestId);
    if (record && method === "Network.loadingFailed") record.failed = true;
    state.pending.delete(params.requestId);
  }
});

function debugRecords(args, kind) {
  const tabId = requireTabId(args);
  requireBooleanIfPresent(args, "clear");
  let pattern;
  if (args.pattern !== undefined) {
    if (typeof args.pattern !== "string") badArgs("patternが不正です");
    try { pattern = new RegExp(args.pattern); } catch { badArgs("patternが不正です"); }
  }
  const state = debugConnections.get(tabId);
  if (!state) throw new BridgeError("NOT_DEBUGGING", "デバッグを開始していません", { tabId });
  const records = state[kind].filter((item) => !pattern || pattern.test(kind === "messages" ? item.text : item.url)).map((item) => kind === "requests" ? networkSummary(item) : ({ ...item }));
  if (args.clear) {
    state[kind] = [];
    if (kind === "requests") { state.pending.clear(); state.extra.clear(); }
  }
  return { [kind]: records };
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    for (const name of [...url.searchParams.keys()]) {
      if (/token|key|secret|code|password/i.test(name)) url.searchParams.set(name, "[redacted]");
    }
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    return url.href;
  } catch {
    const source = String(value || "");
    const queryStart = source.indexOf("?");
    const hashStart = source.indexOf("#");
    if (queryStart < 0 || (hashStart >= 0 && hashStart < queryStart)) return source;
    const queryEnd = hashStart < 0 ? source.length : hashStart;
    const query = source.slice(queryStart + 1, queryEnd).split("&").map((part) => {
      const name = part.split("=", 1)[0];
      let decoded = name;
      try { decoded = decodeURIComponent(name.replace(/\+/g, " ")); } catch {}
      return /token|key|secret|code|password/i.test(decoded) ? `${name}=[redacted]` : part;
    }).join("&");
    return `${source.slice(0, queryStart + 1)}${query}${source.slice(queryEnd)}`;
  }
}

function redactHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name,
    /^(?:authorization|proxy-authorization|cookie|set-cookie)$/i.test(name) || /^x-.*token/i.test(name) || /api[-_]?key/i.test(name)
      ? "[redacted]"
      : /^(?:location|content-location|referer|referrer)$/i.test(name)
        ? redactUrl(String(value))
        : String(value).replace(/https?:\/\/[^\s<>"']+/gi, redactUrl),
  ]));
}

function networkSummary(record) {
  const { requestId, method, url, status, type, at, failed } = record;
  return { requestId, method, url, status, type, at, failed };
}

async function network(args) {
  if (args.detail === undefined) {
    if (args.maxChars !== undefined) badArgs("maxCharsにはdetailが必要です");
    return debugRecords(args, "requests");
  }
  const tabId = requireTabId(args);
  if (typeof args.detail !== "string" || !args.detail) badArgs("detailが不正です");
  if (args.clear !== undefined || args.pattern !== undefined) badArgs("detailとclear/patternは併用できません");
  const maxChars = args.maxChars === undefined ? 20000 : args.maxChars;
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) badArgs("maxCharsが不正です");
  return serializeDebugger(tabId, async () => {
    const state = debugConnections.get(tabId);
    if (!state) throw new BridgeError("NOT_DEBUGGING", "デバッグを開始していません", { tabId });
    const record = state.requests.find((item) => item.requestId === args.detail);
    if (!record) throw new BridgeError("NO_SUCH_REQUEST", "記録されたリクエストがありません", { requestId: args.detail });
    const result = { ...networkSummary(record), requestHeaders: { ...record.requestHeaders }, responseHeaders: { ...record.responseHeaders }, mimeType: record.mimeType, body: null, truncated: false };
    if (!/^(?:text\/|application\/(?:json|javascript|x-javascript|xml|x-www-form-urlencoded|graphql)(?:;|$)|[^;]+\+(?:json|xml)(?:;|$))/i.test(record.mimeType)) {
      return { ...result, bodyUnavailable: "non-text" };
    }
    try {
      const response = await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId: args.detail });
      const body = response.base64Encoded
        ? new TextDecoder().decode(Uint8Array.from(atob(response.body), (char) => char.charCodeAt(0)))
        : response.body;
      result.body = body.slice(0, maxChars);
      result.totalChars = body.length;
      result.truncated = body.length > maxChars;
    } catch {
      result.bodyUnavailable = "unavailable";
    }
    return result;
  });
}

function emulationOptions(args, previous) {
  const presets = {
    sp: { width: 390, height: 844, dpr: 3, mobile: true, touch: true },
    tablet: { width: 820, height: 1180, dpr: 2, mobile: true, touch: true },
    pc: { width: 1440, height: 900, dpr: 1, mobile: false, touch: false },
  };
  for (const name of ["reset", "mobile", "touch", "reducedMotion"]) requireBooleanIfPresent(args, name);
  if (args.preset !== undefined && !Object.hasOwn(presets, args.preset)) badArgs("presetが不正です");
  const names = ["preset", "width", "height", "dpr", "mobile", "touch", "colorScheme", "reducedMotion"];
  if (args.reset && names.some((name) => args[name] !== undefined)) badArgs("resetと設定は併用できません");
  if (!args.reset && !names.some((name) => args[name] !== undefined)) badArgs("エミュレーション設定を指定してください");
  if ((args.width === undefined) !== (args.height === undefined)) badArgs("widthとheightを指定してください");
  for (const name of ["width", "height"]) {
    if (args[name] !== undefined && (!Number.isInteger(args[name]) || args[name] <= 0 || args[name] > 10000000)) badArgs(`${name}が不正です`);
  }
  if (args.dpr !== undefined && (!Number.isFinite(args.dpr) || args.dpr <= 0)) badArgs("dprが不正です");
  if (args.colorScheme !== undefined && !["light", "dark"].includes(args.colorScheme)) badArgs("colorSchemeが不正です");
  const state = { dpr: 1, mobile: false, touch: false, ...previous, ...(presets[args.preset] || {}) };
  for (const name of names.slice(1)) if (args[name] !== undefined) state[name] = args[name];
  return state;
}

async function applyEmulation(send, state) {
  if (state) {
    await send("Emulation.setDeviceMetricsOverride", { width: state.width || 0, height: state.height || 0, deviceScaleFactor: state.dpr, mobile: state.mobile });
    await send("Emulation.setTouchEmulationEnabled", { enabled: state.touch });
    const features = [];
    if (state.colorScheme) features.push({ name: "prefers-color-scheme", value: state.colorScheme });
    if (state.reducedMotion !== undefined) features.push({ name: "prefers-reduced-motion", value: state.reducedMotion ? "reduce" : "no-preference" });
    await send("Emulation.setEmulatedMedia", { features });
  } else {
    await send("Emulation.clearDeviceMetricsOverride");
    await send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await send("Emulation.setEmulatedMedia", { media: "", features: [] });
  }
}

async function emulate(args) {
  const tabId = requireTabId(args);
  emulationOptions(args);
  return serializeDebugger(tabId, async () => {
    const previous = emulationStates.get(tabId);
    const state = emulationOptions(args, previous);
    const send = (method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
    if (!attachedDebuggerTabs.has(tabId)) await attachDebugger(tabId);
    if (!args.reset) emulationStates.set(tabId, state);
    try {
      await applyEmulation(send, args.reset ? null : state);
      if (!attachedDebuggerTabs.has(tabId)) throw new BridgeError("DEBUGGER_FAILED", "デバッガが切断されました");
      const response = await send("Runtime.evaluate", { expression: "({innerWidth: window.innerWidth, innerHeight: window.innerHeight})", returnByValue: true });
      if (!attachedDebuggerTabs.has(tabId)) throw new BridgeError("DEBUGGER_FAILED", "デバッガが切断されました");
      if (response.exceptionDetails || !response.result?.value || typeof response.result.value.innerWidth !== "number") throw new BridgeError("DEBUGGER_FAILED", "ビューポートを取得できません");
      if (args.reset) {
        emulationStates.delete(tabId);
        await releaseDebugger(tabId);
      }
      return { emulating: !args.reset, ...(args.reset ? {} : { settings: state }), ...response.result.value };
    } catch (error) {
      if (attachedDebuggerTabs.has(tabId)) {
        try {
          await applyEmulation(send, previous);
          if (previous) emulationStates.set(tabId, previous);
          else emulationStates.delete(tabId);
          await releaseDebugger(tabId);
        } catch {
          if (!hasPersistentDebugger(tabId)) emulationStates.set(tabId, state);
        }
      }
      throw error;
    }
  });
}

async function realPointer(args, click) {
  const tabId = requireTabId(args);
  if (click) validateClickTarget(args);
  else if (!Number.isInteger(args.ref) || args.ref < 0) badArgs("refが不正です");
  return withDebugger(tabId, async (send) => {
    const entries = await executePage(tabId, "preparePointer", { ...args, click }, false, send);
    const { x, y, element } = entries[0].result.result;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    if (click) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    }
    return { [click ? "clicked" : "hovered"]: element };
  }, { input: true });
}

async function realType(args) {
  return withDebugger(args.tabId, async (send) => {
    await executePage(args.tabId, "prepareType", args, false, send);
    await send("Input.insertText", { text: args.text });
    return { typed: true };
  }, { input: true });
}

function keyParameters(value) {
  if (typeof value !== "string" || !value) badArgs("keyが不正です");
  const parts = [...value].length === 1 ? [value] : value.split("+");
  const name = parts.pop();
  const masks = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
  if (parts.some((part) => !masks[part]) || new Set(parts).size !== parts.length) badArgs("keyが不正です");
  const codes = { Enter: 13, Escape: 27, Tab: 9, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35, Backspace: 8, Delete: 46 };
  if (!codes[name] && [...name].length !== 1) badArgs("keyが不正です");
  const modifiers = parts.reduce((mask, part) => mask | masks[part], 0);
  const key = name === "Space" ? " " : name;
  const params = { key, modifiers, windowsVirtualKeyCode: codes[name] || name.toUpperCase().charCodeAt(0) };
  if (!(modifiers & 7)) {
    if (name === "Enter") params.text = "\r";
    else if ([...key].length === 1) params.text = key;
  }
  return params;
}

async function pressKey(args) {
  const tabId = requireTabId(args);
  requireBooleanIfPresent(args, "allowRisky");
  requireBooleanIfPresent(args, "allowInput");
  const params = keyParameters(args.key);
  return withDebugger(tabId, async (send) => {
    await executePage(tabId, "checkKey", args, false, send);
    await send("Input.dispatchKeyEvent", { ...params, type: params.text ? "keyDown" : "rawKeyDown" });
    const { text, ...up } = params;
    await send("Input.dispatchKeyEvent", { ...up, type: "keyUp" });
    return { pressed: args.key };
  }, { input: true });
}

async function evaluate(args) {
  const tabId = requireTabId(args);
  if (typeof args.expression !== "string") badArgs("expressionが不正です");
  return withDebugger(tabId, async (send) => {
    const response = await send("Runtime.evaluate", { expression: args.expression, awaitPromise: true, returnByValue: true });
    const result = response.result || {};
    const serialized = JSON.stringify(result.value);
    const value = serialized === undefined
      ? (result.unserializableValue || result.description || "undefined").slice(0, 100000)
      : serialized.length > 100000 ? serialized.slice(0, 100000) : result.value;
    return { value, ...(response.exceptionDetails ? { exception: response.exceptionDetails.exception?.description || response.exceptionDetails.text } : {}) };
  });
}
