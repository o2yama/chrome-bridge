const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');

const bridgeHome = process.env.CHROME_BRIDGE_HOME || path.join(os.homedir(), '.chrome-bridge');
const runDir = path.join(bridgeHome, 'run');
const socketPath = path.join(runDir, `${process.pid}.sock`);
const timeoutMs = Number(process.env.CHROME_BRIDGE_TIMEOUT_MS) || 30_000;
const clients = new Set();
const pending = new Map();
let nativeBuffer = Buffer.alloc(0);
let shuttingDown = false;

function browserApp() {
  try {
    const command = execFileSync('/bin/ps', ['-p', String(process.ppid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim();
    const app = command.match(/\/([^/]+)\.app(?:\/|$)/);
    if (app) return app[1];
    return path.basename(command.split(/\s+/)[0] || 'Unknown');
  } catch {
    return 'Unknown';
  }
}

function writeNative(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

function writeLine(socket, message) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function forwardRequest(socket, request) {
  const timer = setTimeout(() => {
    pending.delete(request.id);
    writeLine(socket, {
      id: request.id,
      ok: false,
      error: { code: 'TIMEOUT', message: '拡張機能から30秒以内に応答がありませんでした' },
    });
  }, timeoutMs);
  pending.set(request.id, { socket, command: request.cmd, timer });
  writeNative(request);
}

function acceptClient(socket) {
  clients.add(socket);
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      try {
        forwardRequest(socket, JSON.parse(line));
      } catch (error) {
        writeLine(socket, {
          id: null,
          ok: false,
          error: { code: 'INTERNAL', message: error.message },
        });
      }
    }
  });
  socket.on('close', () => {
    clients.delete(socket);
    for (const [id, entry] of pending) {
      if (entry.socket !== socket) continue;
      clearTimeout(entry.timer);
      pending.delete(id);
    }
  });
  socket.on('error', () => {});
}

function startSelftest(instanceId) {
  const override = process.env.CHROME_BRIDGE_SELFTEST_COMMAND;
  const command = override || process.execPath;
  const cbPath = path.resolve(__dirname, '../bin/cb');
  const args = override
    ? ['selftest', '-b', instanceId]
    : [cbPath, 'selftest', '-b', instanceId];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.on('error', (error) => {
    process.stderr.write(`selftestを起動できません: ${error.message}\n`);
  });
  child.unref();
}

function handleNativeMessage(message) {
  if (!message.id) {
    if (message.event === 'selftestRequested' && typeof message.instanceId === 'string') {
      startSelftest(message.instanceId);
    }
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(message.id);
  if (entry.command === 'hello' && message.ok && message.result) {
    message.result = {
      ...message.result,
      hostPid: process.pid,
      browserApp: browserApp(),
    };
  }
  writeLine(entry.socket, message);
}

function consumeNative(chunk) {
  nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
  while (nativeBuffer.length >= 4) {
    const size = nativeBuffer.readUInt32LE(0);
    if (nativeBuffer.length < size + 4) return;
    const body = nativeBuffer.subarray(4, size + 4);
    nativeBuffer = nativeBuffer.subarray(size + 4);
    try {
      handleNativeMessage(JSON.parse(body.toString('utf8')));
    } catch (error) {
      process.stderr.write(`Native Messaging応答を解析できません: ${error.message}\n`);
    }
  }
}

function removeSocket() {
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`ソケットを削除できません: ${error.message}\n`);
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  for (const socket of clients) socket.destroy();
  server.close(() => {
    removeSocket();
    process.exit(0);
  });
  removeSocket();
}

fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
fs.chmodSync(runDir, 0o700);
removeSocket();
const server = net.createServer(acceptClient);
server.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  removeSocket();
  process.exit(1);
});
// 作成後のchmodだけでは、作成からchmodまでの間ソケットが既定権限で見える。
const previousUmask = process.umask(0o077);
try {
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
} finally {
  process.umask(previousUmask);
}

process.stdin.on('data', consumeNative);
process.stdin.on('end', shutdown);
process.stdin.on('error', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
