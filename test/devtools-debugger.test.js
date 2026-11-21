const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function event() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); } };
}

function setup() {
  const calls = [];
  const tab = { id: 1, windowId: 10, active: true, url: 'https://example.com', status: 'complete' };
  const port = { onMessage: event(), onDisconnect: event(), postMessage() {} };
  const chrome = {
    runtime: { id: 'ext', onMessage: event(), onStartup: event(), onInstalled: event(), connectNative: () => port, getManifest: () => ({ version: '1' }) },
    alarms: { onAlarm: event(), create() {} },
    storage: { local: { get: (key, cb) => cb({}), set: (data, cb) => cb() } },
    identity: { getProfileUserInfo: (args, cb) => cb({}) },
    extension: { isAllowedIncognitoAccess: (cb) => cb(false) },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    windows: { getAll: (args, cb) => cb([{ tabs: [tab] }]) },
    tabs: {
      onRemoved: event(), onUpdated: event(), get: (id, cb) => cb(tab),
      captureVisibleTab: (id, args, cb) => { calls.push(['visible']); cb('visible-png'); },
      reload: async (id) => { calls.push(['reload']); chrome.tabs.onUpdated.emit(id, { status: 'complete' }); },
    },
    debugger: {
      onDetach: event(), onEvent: event(),
      attach: async () => { calls.push(['attach']); },
      detach: async (target) => { calls.push(['detach']); chrome.debugger.onDetach.emit(target); },
      sendCommand: async (target, method, params) => {
        calls.push([method, params]);
        if (method === 'Runtime.evaluate') return { result: { value: { innerWidth: 390, innerHeight: 844 } } };
        if (method === 'Page.captureScreenshot') return { data: 'cG5n' };
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { x: 0, y: 0, width: 390, height: 3000 }, contentSize: { x: 0, y: 0, width: 1170, height: 9000 } };
        if (method === 'Page.reload') chrome.tabs.onUpdated.emit(target.tabId, { status: 'complete' });
        if (method === 'Network.getResponseBody') return { body: 'hello world', base64Encoded: false };
        return {};
      },
    },
  };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout, navigator: { userAgent: 'Chrome/142.0' }, crypto: { randomUUID: () => 'id' }, TextDecoder, Uint8Array, atob });
  context.importScripts = (...files) => { for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), context); };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  return { chrome, context, tab, calls, run: (cmd, args = {}) => context.dispatch({ id: 'test', cmd, args: { tabId: 1, ...args } }) };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('emulateはpresetを適用し同じ接続をdebugと共有、双方の終了まで切断しない', async () => {
  for (const first of ['emulate', 'debugStart']) {
    const { run, calls } = setup();
    const start = () => run('emulate', { preset: 'sp' });
    if (first === 'emulate') { await start(); await run('debugStart'); }
    else { await run('debugStart'); await start(); }
    assert.equal(calls.filter(([name]) => name === 'attach').length, 1);
    const result = await run('emulate', { colorScheme: 'dark', reducedMotion: true });
    assert.equal(result.innerWidth, 390);
    assert.equal(result.settings.width, 390);
    assert.equal(result.settings.touch, true);
    assert.equal(calls.filter(([name]) => name === 'detach').length, 0);
    if (first === 'emulate') {
      assert.equal((await run('debugStop')).detached, false);
      await assert.rejects(run('network'), { code: 'NOT_DEBUGGING' });
      await run('emulate', { reset: true });
    } else {
      await run('emulate', { reset: true });
      assert.equal(calls.filter(([name]) => name === 'detach').length, 0);
      await run('network');
      await run('debugStop');
    }
    assert.equal(calls.filter(([name]) => name === 'detach').length, 1);
    assert.ok(calls.some(([name]) => name === 'Emulation.clearDeviceMetricsOverride'));
    assert.deepEqual(plain(calls.filter(([name]) => name === 'Emulation.setEmulatedMedia').at(-1)[1]), { media: '', features: [] });
  }
});

test('emulate引数の検証とpreset更新、タブ閉鎖/強制切断で状態を破棄', async () => {
  const { run, calls, context, chrome } = setup();
  for (const args of [{}, { preset: 'bad' }, { width: 390 }, { width: 0, height: 100 }, { dpr: -1 }, { mobile: 'true' }, { colorScheme: 'auto' }, { reset: true, preset: 'sp' }]) {
    await assert.rejects(run('emulate', args), { code: 'BAD_ARGS' });
  }
  assert.equal(calls.length, 0);
  for (const preset of ['sp', 'tablet', 'pc']) await run('emulate', { preset });
  const metrics = calls.filter(([name]) => name === 'Emulation.setDeviceMetricsOverride').map(([, params]) => plain(params));
  assert.deepEqual(metrics, [
    { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  ]);
  chrome.debugger.onDetach.emit({ tabId: 1 });
  assert.equal(vm.runInContext('emulationStates.size', context), 0);
  await run('emulate', { preset: 'sp' });
  chrome.tabs.onRemoved.emit(1);
  assert.equal(vm.runInContext('emulationStates.size + debugConnections.size + attachedDebuggerTabs.size', context), 0);
});

test('emulate途中失敗はdebug接続を維持し、既存のエミュレーションへ戻す', async () => {
  const { run, chrome, calls, context } = setup();
  await run('debugStart');
  await run('emulate', { preset: 'sp' });
  const original = chrome.debugger.sendCommand;
  let failed = false;
  chrome.debugger.sendCommand = async (...args) => {
    if (!failed && args[1] === 'Emulation.setTouchEmulationEnabled') { failed = true; throw new Error('failed'); }
    return original(...args);
  };
  await assert.rejects(run('emulate', { preset: 'pc' }), /failed/);
  assert.equal(calls.filter(([name]) => name === 'detach').length, 0);
  assert.equal(vm.runInContext('emulationStates.get(1).width', context), 390);
  await run('network');
});

test('debugStart失敗はemulateの接続を維持、同一タブ操作は直列化', async () => {
  const { run, chrome, calls } = setup();
  await Promise.all([run('emulate', { preset: 'sp' }), run('screenshot'), run('emulate', { colorScheme: 'dark' })]);
  const original = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (...args) => {
    if (args[1] === 'Network.enable') throw new Error('enable failed');
    return original(...args);
  };
  await assert.rejects(run('debugStart'), /enable failed/);
  await run('emulate', { reset: true });
  assert.equal(calls.filter(([name]) => name === 'attach').length, 1);
  assert.equal(calls.filter(([name]) => name === 'detach').length, 1);
});

test('screenshotは通常visible、失敗/裏/emulate/fullはCDP、fullはCSS contentSizeを使用', async () => {
  const { run, calls, chrome, tab } = setup();
  assert.equal((await run('screenshot')).dataUrl, 'visible-png');
  chrome.tabs.captureVisibleTab = (id, args, cb) => { chrome.runtime.lastError = { message: 'image readback failed' }; cb(); delete chrome.runtime.lastError; };
  assert.equal((await run('screenshot')).dataUrl, 'data:image/png;base64,cG5n');
  await run('screenshot', { full: true });
  const full = calls.filter(([name]) => name === 'Page.captureScreenshot').at(-1)[1];
  assert.deepEqual(plain(full), { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 390, height: 3000, scale: 1 } });
  await run('emulate', { preset: 'sp' });
  chrome.tabs.captureVisibleTab = () => { throw new Error('must not use visible'); };
  await run('screenshot');
  tab.active = false;
  await run('screenshot');
  assert.equal(calls.filter(([name]) => name === 'visible').length, 1);
  await run('emulate', { reset: true });
  chrome.debugger.sendCommand = async () => { throw new Error('capture failed'); };
  await assert.rejects(run('screenshot'), { code: 'TAB_NOT_ACTIVE' });
});

function record(chrome, id = 'req', mime = 'application/json') {
  const emit = (name, params) => chrome.debugger.onEvent.emit({ tabId: 1 }, `Network.${name}`, params);
  emit('requestWillBeSentExtraInfo', { requestId: id, headers: { Cookie: 'secret-cookie', 'X-Access-Token': 'token-secret' } });
  emit('requestWillBeSent', { requestId: id, type: 'Fetch', request: { method: 'GET', url: 'https://example.com/?token=abc&API_KEY=def&client_secret=ghi&code=jkl&password=mno&ok=visible', headers: { Authorization: 'Bearer xyz', 'Proxy-Authorization': 'proxy', 'api-key': 'secret-key', Accept: 'text/plain', Referer: 'https://example.com/?code=private' } } });
  emit('responseReceivedExtraInfo', { requestId: id, headers: { 'Set-Cookie': 'session=secret', 'X-Trace-Token': 'xyz' }, statusCode: 200 });
  emit('responseReceived', { requestId: id, type: 'Fetch', response: { status: 200, mimeType: mime, headers: { 'Content-Type': mime, Location: 'https://example.com/?password=secret' } } });
  emit('loadingFinished', { requestId: id });
}

test('network一覧/detailはrequestId、headersとURL queryをredactしtext本文だけ上限付きで返す', async () => {
  const { run, chrome, calls } = setup();
  await run('debugStart');
  record(chrome);
  const list = (await run('network')).requests;
  assert.equal(list[0].requestId, 'req');
  assert.equal(list[0].requestHeaders, undefined);
  const url = new URL(list[0].url);
  for (const name of ['token', 'API_KEY', 'client_secret', 'code', 'password']) assert.equal(url.searchParams.get(name), '[redacted]');
  assert.equal(url.searchParams.get('ok'), 'visible');
  const detail = await run('network', { detail: 'req', maxChars: 5 });
  assert.equal(detail.body, 'hello');
  assert.equal(detail.totalChars, 11);
  assert.equal(detail.truncated, true);
  for (const name of ['Cookie', 'X-Access-Token', 'Authorization', 'Proxy-Authorization', 'api-key']) assert.equal(detail.requestHeaders[name], '[redacted]');
  assert.equal(detail.requestHeaders.Accept, 'text/plain');
  assert.equal(new URL(detail.requestHeaders.Referer).searchParams.get('code'), '[redacted]');
  assert.equal(new URL(detail.responseHeaders.Location).searchParams.get('password'), '[redacted]');
  assert.equal(detail.responseHeaders['Set-Cookie'], '[redacted]');
  assert.equal(detail.responseHeaders['X-Trace-Token'], '[redacted]');
  record(chrome, 'binary', 'image/png');
  const before = calls.filter(([name]) => name === 'Network.getResponseBody').length;
  assert.equal((await run('network', { detail: 'binary' })).bodyUnavailable, 'non-text');
  assert.equal(calls.filter(([name]) => name === 'Network.getResponseBody').length, before);
  await assert.rejects(run('network', { detail: 'missing' }), { code: 'NO_SUCH_REQUEST' });
  await assert.rejects(run('network', { detail: 'req', maxChars: -1 }), { code: 'BAD_ARGS' });
  await run('network', { clear: true });
  await assert.rejects(run('network', { detail: 'req' }), { code: 'NO_SUCH_REQUEST' });
});

test('network本文base64をUTF-8に戻し、既定20000字、取得不能もヘッダーは返す', async () => {
  const { run, chrome } = setup();
  await run('debugStart');
  record(chrome, 'text', 'text/html');
  const original = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (...args) => args[1] === 'Network.getResponseBody' ? { body: Buffer.from('日本語'.repeat(10000)).toString('base64'), base64Encoded: true } : original(...args);
  const result = await run('network', { detail: 'text' });
  assert.equal(result.body.length, 20000);
  assert.equal(result.body.slice(0, 3), '日本語');
  assert.equal(result.truncated, true);
  chrome.debugger.sendCommand = async () => { throw new Error('No resource'); };
  const unavailable = await run('network', { detail: 'text' });
  assert.equal(unavailable.bodyUnavailable, 'unavailable');
  assert.equal(unavailable.status, 200);
});

test('nav --no-cacheはPage.reload ignoreCache、既存reloadはtabs.reloadを維持', async () => {
  const { run, calls } = setup();
  await run('nav', { action: 'reload', noCache: true });
  assert.deepEqual(plain(calls.find(([name]) => name === 'Page.reload')[1]), { ignoreCache: true });
  assert.equal(calls.filter(([name]) => name === 'detach').length, 1);
  await run('nav', { action: 'reload' });
  assert.equal(calls.filter(([name]) => name === 'reload').length, 1);
  await assert.rejects(run('nav', { action: 'back', noCache: true }), { code: 'BAD_ARGS' });
});

test('emulate初回失敗は解除、reset失敗は継続状態を維持し再試行できる', async () => {
  const { run, chrome, context, calls } = setup();
  const original = chrome.debugger.sendCommand;
  let failMethod = 'Emulation.setEmulatedMedia';
  chrome.debugger.sendCommand = async (...args) => {
    if (args[1] === failMethod) { failMethod = ''; throw new Error('one-time failure'); }
    return original(...args);
  };
  await assert.rejects(run('emulate', { preset: 'sp' }), /one-time failure/);
  assert.equal(vm.runInContext('emulationStates.size + attachedDebuggerTabs.size', context), 0);
  await run('emulate', { preset: 'sp' });
  failMethod = 'Emulation.setTouchEmulationEnabled';
  await assert.rejects(run('emulate', { reset: true }), /one-time failure/);
  assert.equal(vm.runInContext('emulationStates.get(1).width', context), 390);
  assert.equal(vm.runInContext('attachedDebuggerTabs.has(1)', context), true);
  await run('debugStart');
  const prior = calls.length;
  await Promise.all([run('debugStop'), run('screenshot'), run('emulate', { reset: true })]);
  assert.equal(calls.slice(prior).filter(([name]) => name === 'detach').length, 1);
  assert.equal(vm.runInContext('emulationStates.size + debugConnections.size + attachedDebuggerTabs.size', context), 0);
});

test('一時接続のdetach失敗後は再attachせず既存接続を再利用して解除する', async () => {
  const { run, chrome, calls, context } = setup();
  const original = chrome.debugger.detach;
  let fail = true;
  chrome.debugger.detach = async (...args) => { if (fail) { fail = false; throw new Error('detach failed'); } return original(...args); };
  await run('screenshot', { full: true });
  assert.equal(vm.runInContext('attachedDebuggerTabs.has(1)', context), true);
  await run('screenshot', { full: true });
  assert.equal(calls.filter(([name]) => name === 'attach').length, 1);
  assert.equal(vm.runInContext('attachedDebuggerTabs.has(1)', context), false);
});

test('emulate途中の強制detach後に状態を復活させない', async () => {
  const { run, chrome, context } = setup();
  const original = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (...args) => {
    if (args[1] === 'Runtime.evaluate') chrome.debugger.onDetach.emit({ tabId: 1 });
    return original(...args);
  };
  await assert.rejects(run('emulate', { preset: 'sp' }), { code: 'DEBUGGER_FAILED' });
  assert.equal(vm.runInContext('emulationStates.size + attachedDebuggerTabs.size', context), 0);
});


test('networkは相対Locationとpercent encoded query名も伏せ、通常のURL入りヘッダーも維持する', async () => {
  const { run, chrome } = setup();
  await run('debugStart');
  record(chrome);
  chrome.debugger.onEvent.emit({ tabId: 1 }, 'Network.responseReceivedExtraInfo', {
    requestId: 'req', headers: {
      Location: '/callback?code=private&ok=visible',
      'Content-Location': '../result?%74oken=secret&%61pi_key=private#fragment',
      Referer: '?access_token=secret&keep=1',
      Refresh: '0; url=https://example.com/?password=private&ok=visible',
    },
  });
  const { responseHeaders } = await run('network', { detail: 'req' });
  assert.equal(responseHeaders.Location, '/callback?code=[redacted]&ok=visible');
  assert.equal(responseHeaders['Content-Location'], '../result?%74oken=[redacted]&%61pi_key=[redacted]#fragment');
  assert.equal(responseHeaders.Referer, '?access_token=[redacted]&keep=1');
  assert.equal(new URL(responseHeaders.Refresh.slice(7)).searchParams.get('password'), '[redacted]');
  assert.equal(new URL(responseHeaders.Refresh.slice(7)).searchParams.get('ok'), 'visible');
});
