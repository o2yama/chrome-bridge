const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..');
const cliPath = path.join(projectRoot, 'bin/cb');

test('selftest runs every item in order and reports the result to the extension', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-selftest-'));
  const bridgeHome = path.join(temp, 'bridge');
  const runDir = path.join(bridgeHome, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const requests = [];
  const state = {};
  let reported;
  const elements = [
    { ref: 1, text: '表示切替', kind: 'button' },
    { ref: 2, text: 'テキスト入力', kind: 'input', inForm: true },
    { ref: 3, text: '送信', kind: 'button', inForm: true },
    { ref: 4, text: '実クリック', kind: 'button' },
    { ref: 5, text: '実入力', kind: 'input' },
    { ref: 6, text: 'ホバー対象', kind: 'other' },
  ];
  const server = net.createServer((socket) => {
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const request = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        requests.push(request);
        let result = {};
        let error;
        if (request.cmd === 'hello') result = {
          instanceId: 'abababab-8888', browserApp: 'Google Chrome', email: '', label: 'Fake',
          extensionVersion: '2.0.0', chromeVersion: '142.0.7444.60', verified: null,
          debugTabs: [], windows: { normal: 1, incognito: 0 }, tabCount: 1, incognitoAllowed: true,
        };
        else if (request.cmd === 'open') result = { tabId: 77, url: request.args.url, title: 'selftest' };
        else if (request.cmd === 'tabs') result = { tabs: [{ tabId: 1, active: true, windowFocused: true }, { tabId: 77, active: false, groupId: 9 }] };
        else if (request.cmd === 'screenshot') result = { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
        else if (request.cmd === 'read') result = { text: request.args.selector ? JSON.stringify(state) : 'chrome-bridge selftest', scroll: { y: 100 } };
        else if (request.cmd === 'elements') result = { elements };
        else if (request.cmd === 'scroll') result = { scroll: { x: 0, y: 100 } };
        else if (request.cmd === 'click' && request.args.ref === 3 && !request.args.allowRisky) error = { code: 'NEEDS_CONFIRMATION', message: 'blocked' };
        else if (request.cmd === 'click' && request.args.ref === 2 && !request.args.allowInput) error = { code: 'INPUT_BLOCKED', message: 'blocked' };
        else if (request.cmd === 'click') {
          if (request.args.x === 60) state.xyClicked = 'true';
          if (request.args.ref === 1) state.clicked = 'true';
          if (request.args.ref === 4) state.realClicked = 'true';
          result = { clicked: elements.find((item) => item.ref === request.args.ref) };
        } else if (request.cmd === 'hover') {
          state.hovered = 'true';
          result = { hovered: elements[5] };
        } else if (request.cmd === 'key' && request.args.key === 'Enter') error = { code: 'NEEDS_CONFIRMATION', message: 'blocked' };
        else if (request.cmd === 'key') {
          state.key = request.args.key;
          result = { pressed: request.args.key };
        } else if (request.cmd === 'type') {
          if (request.args.ref === 2) state.textValue = request.args.text;
          if (request.args.ref === 5) state.realValue = request.args.text;
          result = { typed: true };
        } else if (request.cmd === 'eval') {
          const expression = request.args.expression;
          if (expression === 'document.body.dataset.clicked') result = { value: state.clicked };
          else if (expression === 'document.body.dataset.scrolled') result = { value: 'true' };
          else if (expression === 'document.body.dataset.realClicked') result = { value: state.realClicked };
          else if (expression === 'document.body.dataset.hovered') result = { value: state.hovered };
          else if (expression === 'document.body.dataset.key') result = { value: state.key };
          else if (expression === 'document.body.dataset.textValue') result = { value: state.textValue };
          else if (expression === 'document.body.dataset.realValue') result = { value: state.realValue };
          else if (expression === '6 * 7') result = { value: 42 };
          else result = { value: true };
        } else if (request.cmd === 'console') result = { messages: [{ level: 'log', text: 'selftest-console' }] };
        else if (request.cmd === 'network') result = { requests: [{ method: 'GET', url: 'http://127.0.0.1/probe' }] };
        else if (request.cmd === 'selftestResult') {
          reported = request.args;
          result = { verified: request.args };
        }
        socket.write(`${JSON.stringify(error
          ? { id: request.id, ok: false, error }
          : { id: request.id, ok: true, result })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(path.join(runDir, '808.sock'), resolve).once('error', reject));
  t.after(() => {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const result = await execFileAsync(cliPath, ['selftest', '-b', 'abababab'], {
    cwd: projectRoot,
    env: { ...process.env, CHROME_BRIDGE_HOME: bridgeHome },
  });
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 20);
  assert.ok(lines.every((line) => line.endsWith('\tok')));
  assert.deepEqual(reported, { chromeVersion: '142.0.7444.60', ok: true, failures: [] });
  assert.equal(requests.find((request) => request.cmd === 'open').args.front, undefined);
  assert.ok(requests.findIndex((request) => request.cmd === 'close') < requests.findIndex((request) => request.cmd === 'selftestResult'));
});
