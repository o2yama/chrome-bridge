const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');

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

function nativeReader(stream) {
  let buffered = Buffer.alloc(0);
  const messages = [];
  const waiters = [];
  stream.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size = buffered.readUInt32LE(0);
      if (buffered.length < size + 4) break;
      const message = JSON.parse(buffered.subarray(4, size + 4).toString('utf8'));
      buffered = buffered.subarray(size + 4);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    }
  });
  return () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiters.push(resolve));
}

function writeNative(stream, message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  stream.write(Buffer.concat([header, body]));
}

function lineReader(socket) {
  let buffered = '';
  const messages = [];
  const waiters = [];
  socket.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const message = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    }
  });
  return () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiters.push(resolve));
}

test('host relays requests, enriches hello, times out, and removes its socket on EOF', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-host-'));
  const bridgeHome = path.join(temp, 'bridge');
  const child = spawn(process.execPath, [path.join(projectRoot, 'host/host.js')], {
    cwd: projectRoot,
    env: { ...process.env, CHROME_BRIDGE_HOME: bridgeHome, CHROME_BRIDGE_TIMEOUT_MS: '80' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const socketPath = path.join(bridgeHome, 'run', `${child.pid}.sock`);
  await waitFor(() => fs.existsSync(socketPath));
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
  await waitFor(() => (fs.statSync(socketPath).mode & 0o777) === 0o600);

  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const nextCliMessage = lineReader(socket);
  const nextNativeMessage = nativeReader(child.stdout);

  const hello = { id: 'hello-1', cmd: 'hello', args: {} };
  socket.write(`${JSON.stringify(hello)}\n`);
  assert.deepEqual(await nextNativeMessage(), hello);
  writeNative(child.stdin, {
    id: 'hello-1',
    ok: true,
    result: { instanceId: 'instance-a', browserApp: 'wrong' },
  });
  const helloResponse = await nextCliMessage();
  assert.equal(helloResponse.ok, true);
  assert.equal(helloResponse.result.instanceId, 'instance-a');
  assert.equal(helloResponse.result.hostPid, child.pid);
  assert.equal(typeof helloResponse.result.browserApp, 'string');
  assert.notEqual(helloResponse.result.browserApp, 'wrong');

  const tabs = { id: 'tabs-1', cmd: 'tabs', args: {} };
  socket.write(`${JSON.stringify(tabs)}\n`);
  assert.deepEqual(await nextNativeMessage(), tabs);
  const tabsResponse = { id: 'tabs-1', ok: true, result: { tabs: [{ tabId: 7 }] } };
  writeNative(child.stdin, tabsResponse);
  assert.deepEqual(await nextCliMessage(), tabsResponse);

  socket.write(`${JSON.stringify({ id: 'slow-1', cmd: 'read', args: { tabId: 7 } })}\n`);
  await nextNativeMessage();
  assert.deepEqual(await nextCliMessage(), {
    id: 'slow-1',
    ok: false,
    error: { code: 'TIMEOUT', message: '拡張機能から30秒以内に応答がありませんでした' },
  });

  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin.end();
  await exited;
  assert.equal(fs.existsSync(socketPath), false);
});

test('host socket is closed to other users even before the post-listen chmod', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-host-perm-'));
  const bridgeHome = path.join(temp, 'bridge');
  const runDir = path.join(bridgeHome, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.chmodSync(runDir, 0o755);
  const preloadPath = path.join(temp, 'skip-socket-chmod.js');
  fs.writeFileSync(preloadPath, `const fs = require('node:fs');
const chmodSync = fs.chmodSync;
fs.chmodSync = (target, mode) => (String(target).endsWith('.sock') ? undefined : chmodSync(target, mode));
process.umask(0o022);
`);
  const child = spawn(process.execPath, ['--require', preloadPath, path.join(projectRoot, 'host/host.js')], {
    cwd: projectRoot,
    env: { ...process.env, CHROME_BRIDGE_HOME: bridgeHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const socketPath = path.join(runDir, `${child.pid}.sock`);
  await waitFor(() => fs.existsSync(socketPath));
  assert.equal(fs.statSync(runDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(socketPath).mode & 0o077, 0);
});

test('host starts detached selftest for selftestRequested events', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-host-event-'));
  const bridgeHome = path.join(temp, 'bridge');
  const capturePath = path.join(temp, 'selftest-args.json');
  const helperPath = path.join(temp, 'capture-selftest');
  fs.writeFileSync(helperPath, `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.SELFTEST_CAPTURE, JSON.stringify(process.argv.slice(2)));
`);
  fs.chmodSync(helperPath, 0o755);
  const child = spawn(process.execPath, [path.join(projectRoot, 'host/host.js')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CHROME_BRIDGE_HOME: bridgeHome,
      CHROME_BRIDGE_SELFTEST_COMMAND: helperPath,
      SELFTEST_CAPTURE: capturePath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  await waitFor(() => fs.existsSync(path.join(bridgeHome, 'run', `${child.pid}.sock`)));
  writeNative(child.stdin, { event: 'ignored', instanceId: 'wrong' });
  writeNative(child.stdin, { event: 'selftestRequested', instanceId: 'instance-v2' });
  await waitFor(() => {
    try {
      JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, 'utf8')), ['selftest', '-b', 'instance-v2']);
});
