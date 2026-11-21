const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function event() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); }, listeners };
}

function setup() {
  const calls = [];
  const stored = {};
  const tabs = new Map([[1, { id: 1, windowId: 10, url: "https://example.com", title: "Example", status: "complete", active: false, lastAccessed: 1 }]]);
  const port = { onMessage: event(), onDisconnect: event(), postMessage: (data) => calls.push(["post", data]) };
  const chrome = {
    runtime: { id: "extension", onMessage: event(), onStartup: event(), onInstalled: event(), connectNative: () => port, getManifest: () => ({ version: "1.0.0" }) },
    alarms: { onAlarm: event(), create() {} },
    storage: { local: { get: (key, cb) => cb({ [key]: stored[key] }), set: (data, cb) => { Object.assign(stored, data); cb(); } } },
    identity: { getProfileUserInfo: (args, cb) => cb({ email: "test@example.com" }) },
    extension: { isAllowedIncognitoAccess: (cb) => cb(false) },
    tabGroups: { query: async () => [], update: async (id, args) => calls.push(["groupUpdate", id, args]) },
    windows: { getLastFocused: async () => ({ id: 10 }), getAll: (args, cb) => cb([{ id: 10, type: "normal", tabs: [...tabs.values()] }]) },
    action: { setBadgeText: async (args) => calls.push(["badge", args.text]), setBadgeBackgroundColor: async () => {} },
    tabs: {
      onRemoved: event(), onUpdated: event(),
      group: async (args) => { calls.push(["group", args]); return 9; },
      get: (id, cb) => cb(tabs.get(id)),
      create: async (args) => { calls.push(["create", args]); const tab = { id: 2, windowId: args.windowId, url: args.url, title: "New", status: "complete", active: args.active, lastAccessed: 2 }; tabs.set(2, tab); return tab; },
      update: async (id, args) => { Object.assign(tabs.get(id), args); chrome.tabs.onUpdated.emit(id, { status: "complete" }); return tabs.get(id); },
      remove: async (id) => { tabs.delete(id); chrome.tabs.onRemoved.emit(id); },
      reload: async (id) => { calls.push(["reload", id]); chrome.tabs.onUpdated.emit(id, { status: "complete" }); },
      goBack: async () => {}, goForward: async () => {},
    },
    debugger: {
      onEvent: event(), onDetach: event(),
      attach: async (target, version) => calls.push(["attach", target.tabId, version]),
      detach: async (target) => { calls.push(["detach", target.tabId]); chrome.debugger.onDetach.emit(target); },
      sendCommand: async (target, method, args) => { calls.push([method, args]); return { result: { value: 42 } }; },
    },
    scripting: { executeScript: async (args) => args.files ? [] : [{ result: { ok: true, result: { x: 12, y: 34, element: { ref: 0 } } } }] },
  };
  const context = vm.createContext({ chrome, navigator: { userAgent: "Chrome/142.0.0.0" }, crypto: { randomUUID: () => "test-id" }, URL, setTimeout, clearTimeout });
  context.importScripts = (...files) => { for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension", file), "utf8"), context); };
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/background.js"), "utf8"), context);
  const run = (cmd, args = {}) => context.dispatch({ id: "test", cmd, args });
  return { chrome, calls, stored, context, run, port };
}

test("openのスキーム制限とタブの所有権", async () => {
  const { run, calls, context } = setup();
  for (const url of ["javascript:alert(1)", "chrome://settings", "data:text/html,a", "ftp://example.com", "bad"]) {
    await assert.rejects(run("open", { url }), { code: "BAD_ARGS" });
  }
  await assert.rejects(run("close", { tabId: 1 }), { code: "NOT_OWNED" });
  await run("open", { url: "https://example.org", tabId: 1 });
  await assert.rejects(run("close", { tabId: 1 }), { code: "NOT_OWNED" });
  assert.equal((await run("open", { url: "file:///test", background: true })).tabId, 2);
  assert.equal(calls.find((c) => c[0] === "create")[1].active, false);
  assert.equal((await run("close", { tabId: 2 })).closed, true);
  assert.equal(vm.runInContext("ownedTabs.size", context), 0);
  assert.equal(vm.runInContext("requestedUrls.size", context), 0);
});

test("一時CDP接続は成功・失敗ともfinallyで解除する", async () => {
  const { run, calls, chrome } = setup();
  assert.equal((await run("eval", { tabId: 1, expression: "42" })).value, 42);
  assert.deepEqual(calls.find((c) => c[0] === "attach"), ["attach", 1, "1.3"]);
  assert.equal(calls.filter((c) => c[0] === "detach").length, 1);
  chrome.debugger.sendCommand = async () => { throw new Error("failed"); };
  await assert.rejects(run("eval", { tabId: 1, expression: "42" }));
  assert.equal(calls.filter((c) => c[0] === "detach").length, 2);
  chrome.debugger.attach = async () => { throw new Error("DevTools open"); };
  await assert.rejects(run("eval", { tabId: 1, expression: "42" }), (error) => error.code === "DEBUGGER_FAILED" && error.detail.cause === "DevTools open");
});

test("debugStartの接続を再利用し、外部切断・タブ閉鎖時に記録を消す", async () => {
  const { run, calls, chrome } = setup();
  await run("debugStart", { tabId: 1 });
  await run("eval", { tabId: 1, expression: "42" });
  assert.equal(calls.filter((c) => c[0] === "attach").length, 1);
  assert.equal(calls.filter((c) => c[0] === "detach").length, 0);
  assert.equal((await run("hello")).debugTabs[0], 1);
  chrome.debugger.onDetach.emit({ tabId: 1 });
  await assert.rejects(run("console", { tabId: 1 }), { code: "NOT_DEBUGGING" });
  await run("debugStart", { tabId: 1 });
  chrome.tabs.onRemoved.emit(1);
  await assert.rejects(run("network", { tabId: 1 }), { code: "NOT_DEBUGGING" });
});

test("debugStartの途中失敗でも接続と状態を片付ける", async () => {
  const { run, chrome, calls } = setup();
  chrome.debugger.sendCommand = async () => { throw new Error("enable failed"); };
  await assert.rejects(run("debugStart", { tabId: 1 }));
  assert.equal(calls.filter((c) => c[0] === "detach").length, 1);
  await assert.rejects(run("console", { tabId: 1 }), { code: "NOT_DEBUGGING" });
});

test("同一タブの並列CDP操作で接続を奪い合わない", async () => {
  const { run, calls } = setup();
  await Promise.all([run("eval", { tabId: 1, expression: "42" }), run("debugStart", { tabId: 1 }), run("eval", { tabId: 1, expression: "42" })]);
  assert.deepEqual(calls.filter((c) => ["attach", "detach"].includes(c[0])).map((c) => c[0]), ["attach", "detach", "attach"]);
  await run("debugStop", { tabId: 1 });
  await assert.rejects(run("network", { tabId: 1 }), { code: "NOT_DEBUGGING" });
});

test("consoleは新しい順で最大1000件、検索とclearに対応する", async () => {
  const { run, chrome } = setup();
  await run("debugStart", { tabId: 1 });
  for (let i = 0; i < 1002; i++) chrome.debugger.onEvent.emit({ tabId: 1 }, "Runtime.consoleAPICalled", { type: "log", args: [{ value: `message-${i}` }] });
  const all = (await run("console", { tabId: 1 })).messages;
  assert.equal(all.length, 1000);
  assert.equal(all[0].text, "message-1001");
  assert.equal((await run("console", { tabId: 1, pattern: "1001$", clear: true })).messages.length, 1);
  assert.equal((await run("console", { tabId: 1 })).messages.length, 0);
  await assert.rejects(run("console", { tabId: 1, pattern: "[" }), { code: "BAD_ARGS" });
});

test("network一覧は本文・ヘッダーを含まず応答・失敗とrequestIdを記録する", async () => {
  const { run, chrome, context } = setup();
  await run("debugStart", { tabId: 1 });
  const emit = (method, params) => chrome.debugger.onEvent.emit({ tabId: 1 }, `Network.${method}`, params);
  for (let i = 0; i < 1002; i++) emit("requestWillBeSent", { requestId: String(i), request: { method: "GET", url: `https://example.com/${i}`, headers: { secret: true }, postData: "secret" }, type: "Fetch" });
  emit("responseReceived", { requestId: "1001", response: { status: 500 }, type: "Fetch" });
  emit("loadingFailed", { requestId: "1001" });
  const requests = (await run("network", { tabId: 1 })).requests;
  assert.equal(requests.length, 1000);
  assert.equal(requests[0].status, 500);
  assert.equal(requests[0].failed, true);
  assert.deepEqual(Object.keys(requests[0]).sort(), ["at", "failed", "method", "requestId", "status", "type", "url"]);
  assert.equal(vm.runInContext("debugConnections.get(1).pending.size", context), 999);
  assert.equal((await run("network", { tabId: 1, pattern: "/1001$", clear: true })).requests.length, 1);
  assert.equal(vm.runInContext("debugConnections.get(1).pending.size", context), 0);
});

test("実クリック・ホバー・入力・キーのCDPイベント", async () => {
  const { run, calls, chrome } = setup();
  await run("click", { tabId: 1, ref: 0, real: true });
  assert.deepEqual(calls.filter((c) => c[0] === "Input.dispatchMouseEvent").map((c) => [c[1].type, c[1].x, c[1].y]), [["mouseMoved", 12, 34], ["mousePressed", 12, 34], ["mouseReleased", 12, 34]]);
  await run("hover", { tabId: 1, ref: 0 });
  await run("type", { tabId: 1, ref: 0, text: "hello", userInstructed: true, real: true });
  assert.equal(calls.find((c) => c[0] === "Input.insertText")[1].text, "hello");
  await run("key", { tabId: 1, key: "Meta+a" });
  assert.equal(calls.find((c) => c[0] === "Input.dispatchKeyEvent")[1].modifiers, 4);
  for (const key of ["", "Unknown", "Meta+", "Nope+a"]) await assert.rejects(run("key", { tabId: 1, key }), { code: "BAD_ARGS" });
  const before = calls.length;
  chrome.scripting.executeScript = async (args) => args.files ? [] : [{ result: { ok: false, error: { code: "INPUT_BLOCKED", message: "blocked" } } }];
  await assert.rejects(run("key", { tabId: 1, key: "a" }), { code: "INPUT_BLOCKED" });
  assert.equal(calls.slice(before).some((c) => c[0] === "Input.dispatchKeyEvent"), false);
});

test("確認結果の保存とChromeメジャーに対応したバッジ", async () => {
  const { run, calls, stored, context } = setup();
  await context.updateBadge();
  assert.equal(calls.filter((c) => c[0] === "badge").at(-1)[1], "!");
  await run("selftestResult", { chromeVersion: "142.1.2.3", ok: true, failures: [] });
  assert.equal(calls.filter((c) => c[0] === "badge").at(-1)[1], "");
  assert.ok(stored.verified.at);
  await run("selftestResult", { chromeVersion: "141.1", ok: true, failures: [] });
  assert.equal(calls.filter((c) => c[0] === "badge").at(-1)[1], "!");
  await run("selftestResult", { chromeVersion: "142.0", ok: false, failures: ["key"] });
  assert.equal(calls.filter((c) => c[0] === "badge").at(-1)[1], "!");
});

test("ポップアップはidなしイベントを送り結果まで待機する", async () => {
  const { chrome, calls, run } = setup();
  const message = (cmd) => new Promise((resolve) => chrome.runtime.onMessage.emit({ cmd }, { id: "extension" }, resolve));
  assert.equal((await message("requestSelftest")).result.selftestRunning, true);
  const posted = calls.find((c) => c[0] === "post")[1];
  assert.equal(posted.event, "selftestRequested");
  assert.equal(posted.instanceId, "test-id");
  assert.equal(Object.hasOwn(posted, "id"), false);
  await message("requestSelftest");
  assert.equal(calls.filter((c) => c[0] === "post").length, 1);
  await run("selftestResult", { chromeVersion: "142", ok: true, failures: [] });
  assert.equal((await message("popupStatus")).result.selftestRunning, false);
});

test("ページ内の座標はスクロール後の矩形の中心で、実クリックも既存ガードを使う", () => {
  const order = [];
  const element = {
    tagName: "BUTTON", isConnected: true, isContentEditable: false, innerText: "送信",
    form: { action: "https://example.com", method: "post" },
    getAttribute: (name) => name === "type" ? "submit" : "",
    hasAttribute: () => false, closest: () => null, matches: () => false,
    getClientRects: () => [{}],
    getBoundingClientRect: () => { order.push("rect"); return { left: 20, top: 40, width: 60, height: 20, bottom: 60, right: 80 }; },
    scrollIntoView: () => order.push("scroll"),
    click: () => order.push("click"),
  };
  const context = vm.createContext({ URL, document: { querySelectorAll: () => [element] }, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }), innerHeight: 800, innerWidth: 1000 });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/page-functions.js"), "utf8"), context);
  const command = context.ChromeBridgePage.command;
  command("elements");
  order.length = 0;
  assert.equal(command("preparePointer", { ref: 0, click: true }).error.code, "NEEDS_CONFIRMATION");
  assert.equal(order.includes("scroll"), false);
  order.length = 0;
  const result = command("preparePointer", { ref: 0, click: true, allowRisky: true }).result;
  assert.equal(order[0], "scroll");
  assert.equal(result.x, 50);
  assert.equal(result.y, 50);
  assert.equal(order.includes("click"), false);
  assert.equal(command("preparePointer", { ref: 0, click: false }).ok, true);
  element.isConnected = false;
  assert.equal(command("preparePointer", { ref: 0, click: false }).error.code, "STALE_REF");
});

test("ページ内の実入力準備は許可後だけフォーカスする", () => {
  let focused = false;
  const element = {
    tagName: "INPUT", isConnected: true, type: "text", value: "", isContentEditable: false,
    getAttribute: () => "", closest: () => null, matches: () => false,
    getClientRects: () => [{}], getBoundingClientRect: () => ({ bottom: 20, right: 20, top: 0, left: 0 }),
    focus: () => { focused = true; },
  };
  Object.defineProperty(element, "value", { set() {}, get: () => "" });
  const context = vm.createContext({ URL, document: { querySelectorAll: () => [element] }, getComputedStyle: () => ({}), innerHeight: 800, innerWidth: 1000 });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/page-functions.js"), "utf8"), context);
  context.ChromeBridgePage.command("elements");
  assert.equal(context.ChromeBridgePage.command("prepareType", { ref: 0 }).error.code, "INPUT_BLOCKED");
  assert.equal(focused, false);
  Object.setPrototypeOf(element, Object.defineProperty({}, "value", { set() {} }));
  assert.equal(context.ChromeBridgePage.command("prepareType", { ref: 0, userInstructed: true }).ok, true);
  assert.equal(focused, true);
});

test("読み込み待ちは15秒で返し、失敗・タブ閉鎖でもリスナーを外す", async () => {
  const { context, chrome, run } = setup();
  const callbacks = [];
  context.setTimeout = (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; };
  context.clearTimeout = () => {};
  chrome.tabs.update = async () => {};
  const pending = run("open", { tabId: 1, url: "https://example.org" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks.at(-1).ms, 15000);
  callbacks.at(-1).fn();
  assert.equal((await pending).tabId, 1);
  assert.equal(chrome.tabs.onUpdated.listeners.size, 0);
  chrome.tabs.reload = async () => { throw new Error("reload failed"); };
  await assert.rejects(run("nav", { tabId: 1, action: "reload" }), /reload failed/);
  assert.equal(chrome.tabs.onUpdated.listeners.size, 0);
  const removed = run("open", { tabId: 1, url: "https://example.org" });
  await new Promise((resolve) => setImmediate(resolve));
  chrome.tabs.onRemoved.emit(1);
  await assert.rejects(removed, { code: "NO_SUCH_TAB" });
  assert.equal(chrome.tabs.onUpdated.listeners.size, 0);
});

test("evalはawaitPromiseで評価し文字列を10万字まで返す", async () => {
  const { chrome, run } = setup();
  chrome.debugger.sendCommand = async (target, method, args) => {
    assert.equal(method, "Runtime.evaluate");
    assert.equal(args.awaitPromise, true);
    assert.equal(args.returnByValue, true);
    return { result: { value: "x".repeat(100010) }, exceptionDetails: { text: "exception" } };
  };
  const result = await run("eval", { tabId: 1, expression: "expression" });
  assert.equal(result.value.length, 100000);
  assert.equal(result.exception, "exception");
});


test("evalは上限以内のJSON値の型を保つ", async () => {
  const { chrome, run } = setup();
  for (const value of [42, "true", true, null, { a: [1, 2] }]) {
    chrome.debugger.sendCommand = async () => ({ result: { value } });
    assert.deepEqual((await run("eval", { tabId: 1, expression: "value" })).value, value);
  }
});

test("openは通常ウィンドウに裏で作り、Bridgeを再利用・再作成する", async () => {
  const { run, calls, chrome } = setup();
  chrome.windows.getLastFocused = async (args) => {
    assert.deepEqual(Array.from(args.windowTypes), ["normal"]);
    return { id: 10 };
  };
  await run("open", { url: "https://new.example.com" });
  assert.equal(calls.find((c) => c[0] === "create")[1].windowId, 10);
  assert.equal(calls.find((c) => c[0] === "create")[1].active, false);
  assert.equal(calls.find((c) => c[0] === "group")[1].createProperties.windowId, 10);
  chrome.tabGroups.query = async () => [{ id: 42, title: "Bridge", color: "blue" }];
  await run("open", { url: "https://new.example.com", front: true, new: true });
  assert.equal(calls.filter((c) => c[0] === "create").at(-1)[1].active, true);
  assert.equal(calls.filter((c) => c[0] === "group").at(-1)[1].groupId, 42);
  assert.equal(calls.filter((c) => c[0] === "groupUpdate").at(-1)[2].color, "orange");
  chrome.tabGroups.query = async () => [];
  await run("open", { url: "https://new.example.com", background: false, new: true });
  assert.equal(calls.filter((c) => c[0] === "create").at(-1)[1].active, false);
  assert.equal(calls.filter((c) => c[0] === "group").at(-1)[1].createProperties.windowId, 10);
});

test("openはURLを正規化して既存タブを再利用する", async () => {
  const { context, run, calls } = setup();
  assert.equal(context.normalizeOpenUrl("https://EXAMPLE.com/path/#section"), "https://example.com/path");
  assert.equal(context.normalizeOpenUrl("https://example.com/?q=1#section"), "https://example.com/?q=1");
  assert.equal(context.normalizeOpenUrl("not a url#x"), "not a url#x");
  assert.notEqual(context.normalizeOpenUrl("http://example.com"), context.normalizeOpenUrl("https://example.com"));
  assert.notEqual(context.normalizeOpenUrl("https://example.com?q=1"), context.normalizeOpenUrl("https://example.com?q=2"));
  const result = await run("open", { url: "https://EXAMPLE.com/#section" });
  assert.equal(result.tabId, 1);
  assert.equal(result.reused, true);
  assert.equal(calls.some((call) => call[0] === "create"), false);
  assert.equal(calls.some((call) => call[0] === "group"), false);
  await assert.rejects(run("close", { tabId: 1 }), { code: "NOT_OWNED" });
});

test("openは所有タブを優先し、同順位ではlastAccessedが新しいタブを使う", async () => {
  const { context, chrome, run, calls } = setup();
  chrome.windows.getAll = (args, cb) => cb([{ id: 10, type: "normal", tabs: [
    { id: 11, windowId: 10, url: "https://same.example/", title: "User newest", status: "complete", lastAccessed: 300 },
    { id: 12, windowId: 10, url: "https://same.example", title: "Bridge old", status: "complete", lastAccessed: 100 },
    { id: 13, windowId: 10, url: "https://same.example", title: "Bridge newest", status: "complete", lastAccessed: 200 },
  ] }]);
  vm.runInContext("ownedTabs.add(12); ownedTabs.add(13)", context);
  const result = await run("open", { url: "https://same.example/#hash" });
  assert.equal(result.tabId, 13);
  assert.equal(result.reused, true);
  assert.deepEqual(calls.filter((call) => call[0] === "create"), []);
  assert.deepEqual(calls.filter((call) => call[0] === "group"), []);
});

test("openは作成時の要求URLでも照合し、--new相当なら必ず新規作成する", async () => {
  const { context, chrome, run, calls } = setup();
  const created = await run("open", { url: "https://redirect.example/start" });
  assert.equal(created.reused, false);
  chrome.tabs.update = async (id, args) => {
    calls.push(["update", id, args]);
    return { id, ...args };
  };
  chrome.windows.getAll = (args, cb) => cb([{ id: 10, type: "normal", tabs: [
    { id: 2, windowId: 10, url: "https://redirect.example/destination", title: "Redirected", status: "complete", lastAccessed: 10 },
  ] }]);
  const reused = await run("open", { url: "https://redirect.example/start#again" });
  assert.equal(reused.tabId, 2);
  assert.equal(reused.reused, true);
  assert.equal(calls.filter((call) => call[0] === "create").length, 1);
  assert.equal(calls.filter((call) => call[0] === "update").length, 0);
  const front = await run("open", { url: "https://redirect.example/start", front: true });
  assert.equal(front.reused, true);
  const update = calls.filter((call) => call[0] === "update").at(-1);
  assert.equal(update[0], "update");
  assert.equal(update[1], 2);
  assert.equal(update[2].active, true);
  const forced = await run("open", { url: "https://redirect.example/start", new: true });
  assert.equal(forced.reused, false);
  assert.equal(calls.filter((call) => call[0] === "create").length, 2);
  assert.equal(vm.runInContext("requestedUrls.get(2)", context), "https://redirect.example/start");
});

test("clickのrefと座標を排他的に検証する", () => {
  const { context } = setup();
  for (const args of [{ ref: 0 }, { x: 0, y: -1 }, { x: 1.5, y: 2 }]) context.validateClickTarget(args);
  for (const args of [{}, { ref: -1 }, { x: 1 }, { y: 2 }, { x: Infinity, y: 0 }, { x: "1", y: 2 }, { ref: 0, x: 1, y: 2 }]) {
    assert.throws(() => context.validateClickTarget(args), { code: "BAD_ARGS" });
  }
});

test("裏の撮影と実入力は前面化せず、撮影失敗も接続を解除する", async () => {
  const { run, chrome, calls } = setup();
  chrome.tabs.update = async () => { throw new Error("前面化した"); };
  chrome.debugger.sendCommand = async (target, method, args) => {
    calls.push([method, args]);
    return { data: "PNG" };
  };
  assert.equal((await run("screenshot", { tabId: 1 })).dataUrl, "data:image/png;base64,PNG");
  for (const [cmd, args] of [["click", { x: 10, y: 20 }], ["hover", { ref: 0 }], ["key", { key: "Escape" }], ["type", { ref: 0, text: "x", userInstructed: true, real: true }]]) {
    await run(cmd, { tabId: 1, ...args });
  }
  assert.ok(calls.some((c) => c[0] === "Page.setWebLifecycleState"));
  chrome.debugger.attach = async () => { throw new Error("attach failed"); };
  await assert.rejects(run("screenshot", { tabId: 1 }), (e) => e.code === "TAB_NOT_ACTIVE" && e.detail.code === "DEBUGGER_FAILED");
  assert.equal((await run("hello")).debugTabs.length, 0);
});

test("注入の時間切れはCDPで起こし、失敗時だけ前面化する", async () => {
  for (const mode of ["wake", "attach-failed", "still-frozen"]) {
    const { context, chrome, calls } = setup();
    let attempts = 0;
    let fronts = 0;
    context.executePageOnce = async () => {
      attempts++;
      if (attempts === 1 || (mode === "still-frozen" && attempts === 2)) {
        const e = new Error("timeout"); e.code = "TAB_NOT_RESPONDING"; throw e;
      }
      return "readable";
    };
    context.ensureFront = async () => { fronts++; return true; };
    if (mode === "attach-failed") chrome.debugger.attach = async () => { throw new Error("attach failed"); };
    assert.equal(await context.executePage(1, "read", {}), "readable");
    assert.equal(fronts, mode === "wake" ? 0 : 1);
    assert.equal((await context.hello()).debugTabs.length, 0);
    if (mode !== "attach-failed") assert.ok(calls.some((c) => c[0] === "detach"));
  }
});

test("CDP操作内の復旧は既存sendを使いキューへ再入しない", async () => {
  const { context } = setup();
  let attempts = 0;
  context.executePageOnce = async () => {
    if (++attempts === 1) { const e = new Error(); e.code = "TAB_NOT_RESPONDING"; throw e; }
    return "ok";
  };
  context.withDebugger = () => { throw new Error("キューへ再入した"); };
  let woke = false;
  assert.equal(await context.executePage(1, "read", {}, false, async () => { woke = true; }), "ok");
  assert.equal(woke, true);
});

test("時間切れの注入が遅れて完了しても操作は実行しない", async () => {
  const { context, chrome } = setup();
  let release;
  let operations = 0;
  chrome.scripting.executeScript = (args) => {
    if (args.files) return new Promise((resolve) => { release = resolve; });
    operations++; return Promise.resolve([]);
  };
  context.setTimeout = (fn) => setTimeout(fn, 1);
  await assert.rejects(context.executePageOnce(1, "click", { ref: 0 }), { code: "TAB_NOT_RESPONDING" });
  release([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operations, 0);
});

test("座標の要素なし・入力・送信ボタンの子要素にもガードを適用する", () => {
  const element = {
    tagName: "INPUT", isContentEditable: false,
    getAttribute: () => "", closest: () => null, matches: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 10, right: 10 }),
  };
  let hit = null;
  const context = vm.createContext({ URL, document: { elementFromPoint: () => hit }, innerHeight: 800, innerWidth: 1000 });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/page-functions.js"), "utf8"), context);
  const command = () => context.ChromeBridgePage.command("preparePointer", { x: 2, y: 3, click: true });
  assert.equal(command().error.code, "NEEDS_CONFIRMATION");
  hit = element;
  assert.equal(command().error.code, "INPUT_BLOCKED");
  hit = { ...element, tagName: "SPAN", parentElement: { ...element, tagName: "BUTTON", form: {} } };
  assert.equal(command().error.code, "NEEDS_CONFIRMATION");
  hit = { ...element, tagName: "BUTTON" };
  assert.equal(command().result.x, 2);
});
