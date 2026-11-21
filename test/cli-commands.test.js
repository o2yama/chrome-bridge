const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..');
const cliPath = path.join(projectRoot, 'bin/cb');

function waitFor(check, timeoutMs = 2_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function startFakeHost(socketPath, hello, onRequest = () => null) {
  const server = net.createServer((socket) => {
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const request = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        const result = request.cmd === 'hello' ? hello : onRequest(request);
        if (result?.error) socket.write(`${JSON.stringify({ id: request.id, ok: false, error: result.error })}\n`);
        else if (result) socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
  return server;
}

async function runCli(args, bridgeHome, extraEnv = {}) {
  try {
    const result = await execFileAsync(cliPath, args, {
      cwd: projectRoot,
      env: { ...process.env, CHROME_BRIDGE_HOME: bridgeHome, ...extraEnv },
    });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function hello(instanceId, label, email = '') {
  return {
    instanceId,
    browserApp: 'Google Chrome',
    email,
    label,
    extensionVersion: '1.0.0',
    incognitoAllowed: true,
    windows: { normal: 1, incognito: 0 },
    tabCount: 2,
    chromeVersion: '142.0.7444.60',
    verified: null,
    debugTabs: [],
  };
}

test('CLI selects one browser, rejects ambiguous selection, and forwards command flags', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-cli-'));
  const bridgeHome = path.join(temp, 'bridge');
  const runDir = path.join(bridgeHome, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const requests = [];
  const serverA = await startFakeHost(path.join(runDir, '101.sock'), hello('aaaaaaaa-1111', 'Work', 'a@example.com'), (request) => {
    requests.push(request);
    return { elements: [] };
  });
  t.after(async () => {
    await Promise.all([new Promise((resolve) => serverA.close(resolve))]);
    fs.rmSync(temp, { recursive: true, force: true });
  });

  let result = await runCli(['elements', '-t', '9', '--viewport', '--json'], bridgeHome);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests.at(-1).args, { tabId: 9, inViewportOnly: true });
  assert.deepEqual(JSON.parse(result.stdout), { elements: [] });

  const serverB = await startFakeHost(path.join(runDir, '202.sock'), hello('bbbbbbbb-2222', 'Work two', 'b@example.com'));
  t.after(() => new Promise((resolve) => serverB.close(resolve)));

  result = await runCli(['elements', '-t', '9'], bridgeHome);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /複数/);

  result = await runCli(['elements', '-b', 'work', '-t', '9'], bridgeHome);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /候補/);

  result = await runCli(['elements', '-b', 'aaaaaaaa', '-t', '9'], bridgeHome);
  assert.equal(result.code, 0, result.stderr);
});

test('CLI removes stale sockets while listing browsers', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-stale-'));
  const bridgeHome = path.join(temp, 'bridge');
  const runDir = path.join(bridgeHome, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const stalePath = path.join(runDir, '999.sock');
  const stale = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(stalePath)})`]);
  t.after(() => {
    if (stale.exitCode === null) stale.kill('SIGKILL');
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await waitFor(() => fs.existsSync(stalePath));
  stale.kill('SIGKILL');
  await new Promise((resolve) => stale.once('exit', resolve));
  assert.equal(fs.existsSync(stalePath), true);

  const result = await runCli(['browsers', '--json'], bridgeHome);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
  assert.equal(fs.existsSync(stalePath), false);
});

test('CLI maps every command option to the specified request shape', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-options-'));
  const bridgeHome = path.join(temp, 'bridge');
  const runDir = path.join(bridgeHome, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const requests = [];
  const server = await startFakeHost(path.join(runDir, '404.sock'), hello('dddddddd-4444', 'Only'), (request) => {
    requests.push(request);
    if (request.cmd === 'setLabel') return { label: request.args.label };
    if (request.cmd === 'tabs') return { tabs: [] };
    if (request.cmd === 'read') return { text: 'page text' };
    if (request.cmd === 'scroll') return { scroll: { x: 0, y: 10 } };
    if (request.cmd === 'click') return { clicked: { ref: request.args.ref } };
    if (request.cmd === 'type') return { typed: true };
    if (request.cmd === 'elements') return { error: { code: 'BAD_ARGS', message: 'bad request' } };
    return {};
  });
  t.after(() => {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  let result = await runCli(['label', '-b', 'dddddddd', 'Personal'], bridgeHome);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests.at(-1), { id: requests.at(-1).id, cmd: 'setLabel', args: { label: 'Personal' } });

  result = await runCli(['tabs', '--json'], bridgeHome);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.at(-1).cmd, 'tabs');

  result = await runCli([
    'read', '-t', '5', '--html', '--selector', 'main', '--all-frames', '--offset', '2', '--max-chars', '99',
  ], bridgeHome);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests.at(-1).args, {
    tabId: 5, mode: 'html', selector: 'main', allFrames: true, offset: 2, maxChars: 99,
  });

  result = await runCli(['scroll', '-t', '5', '--by', '-120'], bridgeHome);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests.at(-1).args, { tabId: 5, by: { x: 0, y: -120 } });

  result = await runCli(['click', '-t', '5', '--ref', '3', '--user-approved', '--allow-input'], bridgeHome);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests.at(-1).args, { tabId: 5, ref: 3, allowRisky: true, allowInput: true });

  result = await runCli(['type', '-t', '5', '--ref', '4', '--text', 'hello', '--user-instructed'], bridgeHome);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests.at(-1).args, { tabId: 5, ref: 4, text: 'hello', userInstructed: true });

  result = await runCli(['elements', '-t', '5', '--json'], bridgeHome);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stderr), { code: 'BAD_ARGS', message: 'bad request' });

  result = await runCli(['read', '-t', '5', '--json'], bridgeHome);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /不明なオプション/);
});

test('screenshot decodes the returned data URL into --out', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-shot-'));
  const bridgeHome = path.join(temp, 'bridge');
  const runDir = path.join(bridgeHome, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const png = Buffer.from('fake-png-bytes');
  const server = await startFakeHost(path.join(runDir, '303.sock'), hello('cccccccc-3333', 'Only'), () => ({
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
  }));
  t.after(() => {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const out = path.join(temp, 'shot.png');

  const result = await runCli(['screenshot', '-t', '3', '--out', out], bridgeHome);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(out), png);
});

test('install fails clearly without EXTENSION_ID and is idempotent with an ID', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-install-'));
  const copyRoot = path.join(temp, 'project');
  fs.mkdirSync(path.join(copyRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(copyRoot, 'host'), { recursive: true });
  fs.mkdirSync(path.join(copyRoot, 'extension'), { recursive: true });
  fs.copyFileSync(cliPath, path.join(copyRoot, 'bin/cb'));
  fs.copyFileSync(path.join(projectRoot, 'host/host.js'), path.join(copyRoot, 'host/host.js'));
  fs.chmodSync(path.join(copyRoot, 'bin/cb'), 0o755);
  const home = path.join(temp, 'home');
  const chromeHosts = path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
  fs.mkdirSync(chromeHosts, { recursive: true });
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const copiedCli = path.join(copyRoot, 'bin/cb');
  const runCopied = async () => {
    try {
      const value = await execFileAsync(copiedCli, ['install'], { env: { ...process.env, HOME: home } });
      return { code: 0, ...value };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };

  let result = await runCopied();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /EXTENSION_ID/);

  const extensionId = 'abcdefghijklmnopqrstuvwxyzabcdef';
  fs.writeFileSync(path.join(copyRoot, 'extension/EXTENSION_ID'), extensionId);
  result = await runCopied();
  assert.equal(result.code, 0, result.stderr);
  const manifestPath = path.join(chromeHosts, 'com.o2yama.chrome_bridge.json');
  const firstManifest = fs.readFileSync(manifestPath, 'utf8');
  const firstRunner = fs.readFileSync(path.join(copyRoot, 'host/run-host.sh'), 'utf8');
  result = await runCopied();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), firstManifest);
  assert.equal(fs.readFileSync(path.join(copyRoot, 'host/run-host.sh'), 'utf8'), firstRunner);
  assert.equal(fs.statSync(path.join(copyRoot, 'host/run-host.sh')).mode & 0o111, 0o111);
  const manifest = JSON.parse(firstManifest);
  assert.equal(manifest.path, fs.realpathSync(path.join(copyRoot, 'host/run-host.sh')));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.match(firstRunner, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('CLI maps v2 command options to extension requests', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-v2-options-'));
  const bridgeHome = path.join(temp, 'bridge');
  const runDir = path.join(bridgeHome, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const requests = [];
  const server = await startFakeHost(path.join(runDir, '505.sock'), hello('eeeeeeee-5555', 'Only'), (request) => {
    requests.push(request);
    if (request.cmd === 'open') return { tabId: 8, url: request.args.url, title: 'Open', reused: true };
    return request.cmd === 'console' ? { messages: [] }
      : request.cmd === 'network' ? { requests: [] }
        : { ok: true };
  });
  t.after(() => {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const cases = [
    [['open', 'https://example.com', '--front', '--background', '--new'], 'open', { url: 'https://example.com', front: true, new: true }],
    [['click', '-t', '8', '--xy', '12.5,34'], 'click', { tabId: 8, x: 12.5, y: 34 }],
    [['open', 'https://example.com/a', '--tab', '8', '--background'], 'open', { url: 'https://example.com/a', tabId: 8 }],
    [['nav', '-t', '8', '--back'], 'nav', { tabId: 8, action: 'back' }],
    [['close', '-t', '8'], 'close', { tabId: 8 }],
    [['click', '-t', '8', '--ref', '2', '--real'], 'click', { tabId: 8, ref: 2, real: true }],
    [['hover', '-t', '8', '--ref', '3'], 'hover', { tabId: 8, ref: 3 }],
    [['key', '-t', '8', 'Enter', '--user-approved', '--allow-input'], 'key', { tabId: 8, key: 'Enter', allowRisky: true, allowInput: true }],
    [['type', '-t', '8', '--ref', '4', '--text', 'x', '--user-instructed', '--real'], 'type', { tabId: 8, ref: 4, text: 'x', userInstructed: true, real: true }],
    [['debug', 'start', '-t', '8'], 'debugStart', { tabId: 8 }],
    [['debug', 'stop', '-t', '8'], 'debugStop', { tabId: 8 }],
    [['console', '-t', '8', '--pattern', 'warn', '--clear', '--json'], 'console', { tabId: 8, pattern: 'warn', clear: true }],
    [['network', '-t', '8', '--pattern', 'api', '--clear', '--json'], 'network', { tabId: 8, pattern: 'api', clear: true }],
    [['eval', '-t', '8', 'document.title'], 'eval', { tabId: 8, expression: 'document.title' }],
  ];
  for (const [argv, cmd, args] of cases) {
    const result = await runCli(argv, bridgeHome);
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    assert.equal(requests.at(-1).cmd, cmd);
    assert.deepEqual(requests.at(-1).args, args);
  }
  const reused = await runCli(['open', 'https://example.com'], bridgeHome);
  assert.equal(reused.code, 0, reused.stderr);
  assert.match(reused.stdout, /既存タブを再利用/);
});

test('CLI records selected extension failures and keeps the newest 500 lines', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-failures-'));
  const bridgeHome = path.join(temp, 'bridge');
  const runDir = path.join(bridgeHome, 'run');
  const logDir = path.join(bridgeHome, 'log');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const old = Array.from({ length: 500 }, (_, index) => JSON.stringify({ at: String(index), cmd: 'old' }));
  fs.writeFileSync(path.join(logDir, 'failures.jsonl'), `${old.join('\n')}\n`);
  const server = await startFakeHost(path.join(runDir, '606.sock'), hello('ffffffff-6666', 'Only'), () => ({
    error: { code: 'DEBUGGER_FAILED', message: 'attach failed', detail: { cause: 'DevTools open' } },
  }));
  t.after(() => {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const result = await runCli(['open', 'https://example.com/private?q=secret'], bridgeHome);
  assert.equal(result.code, 1);
  const lines = fs.readFileSync(path.join(logDir, 'failures.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 500);
  assert.equal(JSON.parse(lines[0]).at, '1');
  assert.deepEqual(JSON.parse(lines.at(-1)), {
    at: JSON.parse(lines.at(-1)).at,
    cmd: 'open',
    code: 'DEBUGGER_FAILED',
    message: 'attach failed',
    cause: 'DevTools open',
    chromeVersion: '142.0.7444.60',
    browserApp: 'Google Chrome',
    urlHost: 'example.com',
  });
});

test('doctor reports browser verification, debug tabs, and recent failures', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-doctor-'));
  const bridgeHome = path.join(temp, 'bridge');
  const runDir = path.join(bridgeHome, 'run');
  const logDir = path.join(bridgeHome, 'log');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const browser = hello('12121212-7777', 'Doctor');
  browser.verified = { chromeVersion: browser.chromeVersion, ok: false, failures: ['hover'], at: '2026-11-10T00:00:00.000Z' };
  browser.debugTabs = [12, 18];
  const server = await startFakeHost(path.join(runDir, '707.sock'), browser);
  fs.writeFileSync(path.join(logDir, 'failures.jsonl'), `${JSON.stringify({
    at: '2026-11-10T00:00:00.000Z', cmd: 'hover', code: 'DEBUGGER_FAILED', message: 'failed',
  })}\n`);
  t.after(() => {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  let result = await runCli(['doctor'], bridgeHome);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Chrome 142\.0\.7444\.60/);
  assert.match(result.stdout, /失敗: hover/);
  assert.match(result.stdout, /12, 18/);
  assert.match(result.stdout, /DEBUGGER_FAILED/);

  result = await runCli(['doctor', '--json'], bridgeHome);
  assert.equal(result.code, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.deepEqual(json.browsers[0].debugTabs, [12, 18]);
  assert.equal(json.failures[0].cmd, 'hover');
});

test('CLI maps DevTools options and writes full screenshots', async (t) => {
  const tempRoot = path.join(projectRoot, 'tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(tempRoot, 'cbd-'));
  const runDir = path.join(temp, 'run');
  fs.mkdirSync(runDir);
  const requests = [];
  const png = Buffer.from('full-png');
  const server = await startFakeHost(path.join(runDir, '1.sock'), hello('devtools', 'DevTools'), (request) => {
    requests.push(request);
    return request.cmd === 'screenshot' ? { dataUrl: `data:image/png;base64,${png.toString('base64')}` } : { received: request.cmd };
  });
  t.after(() => {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const cases = [
    [['emulate', '-t', '8', '--preset', 'sp'], 'emulate', { tabId: 8, preset: 'sp' }],
    [['emulate', '-b', 'devtools', '-t', '8', '--preset', 'tablet', '--size', '900x1200', '--dpr', '2.5', '--mobile', '--touch', '--color-scheme', 'dark', '--reduced-motion', '--json'], 'emulate', { tabId: 8, preset: 'tablet', width: 900, height: 1200, dpr: 2.5, mobile: true, touch: true, colorScheme: 'dark', reducedMotion: true }],
    [['emulate', '-t', '8', '--preset', 'pc'], 'emulate', { tabId: 8, preset: 'pc' }],
    [['emulate', '-t', '8', '--reset'], 'emulate', { tabId: 8, reset: true }],
    [['inspect', '-t', '8', '--selector', '.card', '--props', 'color, padding', '--rules'], 'inspect', { tabId: 8, selector: '.card', props: ['color', 'padding'], rules: true }],
    [['inspect', '-t', '8', '--ref', '0', '--json'], 'inspect', { tabId: 8, ref: 0 }],
    [['style', 'add', '-t', '8', '--css', 'body { color: red; }'], 'style', { tabId: 8, action: 'add', css: 'body { color: red; }' }],
    [['style', 'clear', '-t', '8', '--id', 'bridge-style-1', '--json'], 'style', { tabId: 8, action: 'clear', id: 'bridge-style-1' }],
    [['style', 'clear', '-t', '8'], 'style', { tabId: 8, action: 'clear' }],
    [['network', '-t', '8', '--detail', '123.4', '--max-chars', '0'], 'network', { tabId: 8, detail: '123.4', maxChars: 0 }],
    [['network', '-t', '8', '--detail', '123.4'], 'network', { tabId: 8, detail: '123.4' }],
    [['nav', '-t', '8', '--reload', '--no-cache'], 'nav', { tabId: 8, action: 'reload', noCache: true }],
    [['perf', '-t', '8', '--json'], 'perf', { tabId: 8 }],
    [['screenshot', '-t', '8', '--full', '--out', path.join(temp, 'full.png')], 'screenshot', { tabId: 8, full: true }],
  ];
  for (const [argv, cmd, args] of cases) {
    const result = await runCli(argv, temp);
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    assert.equal(requests.at(-1).cmd, cmd);
    assert.deepEqual(requests.at(-1).args, args);
  }
  assert.deepEqual(fs.readFileSync(path.join(temp, 'full.png')), png);

  const invalid = [
    ['emulate', '--preset', 'phone'], ['emulate', '--size', '0x844'], ['emulate', '--size', '390'],
    ['emulate', '--dpr', 'NaN'], ['emulate', '--dpr', '0'], ['emulate', '--color-scheme', 'auto'],
    ['emulate', '--reset', '--touch'], ['emulate'], ['inspect'], ['inspect', '--selector', '.a', '--ref', '0'],
    ['inspect', '--selector', ''], ['inspect', '--ref', '-1'], ['inspect', '--ref', '1', '--props', 'color,'],
    ['style', 'add'], ['style', 'add', '--css', 'a{}', '--id', '1'], ['style', 'clear', '--css', 'a{}'], ['style', 'clear', '--id', ''],
    ['network', '--detail', ''], ['network', '--detail', '1', '--clear'], ['network', '--detail', '1', '--pattern', 'x'],
    ['network', '--detail', '1', '--max-chars', '-1'], ['network', '--max-chars', '1'],
    ['console', '--detail', '1'], ['nav', '--back', '--no-cache'], ['perf', 'unexpected'],
  ];
  const count = requests.length;
  for (const argv of invalid) {
    const result = await runCli([...argv, '-t', '8'], temp);
    assert.equal(result.code, 2, `${argv.join(' ')}: ${result.stderr}`);
  }
  assert.equal(requests.length, count, 'invalid commands must not be forwarded');
});

test('CLI help includes new commands without connecting to a browser', async () => {
  const missingHome = path.join(projectRoot, 'tmp', 'missing-help-home');
  const result = await runCli(['--help'], missingHome);
  assert.equal(result.code, 0, result.stderr);
  for (const command of ['emulate', 'inspect', 'style', 'perf']) assert.match(result.stdout, new RegExp(`cb ${command} `));
  for (const option of ['--full', '--detail', '--max-chars', '--no-cache']) assert.ok(result.stdout.includes(option));
  const specific = await runCli(['emulate', '--help'], missingHome);
  assert.equal(specific.code, 0, specific.stderr);
  assert.match(specific.stdout, /--preset sp\|tablet\|pc/);
});
