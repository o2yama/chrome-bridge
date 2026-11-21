const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function stop(server) {
  // ブラウザ側のkeep-alive接続が残っていると close が終わらないので、先に切る。
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

function reason(error) {
  if (error?.remote) return `${error.remote.code}: ${error.remote.message}`;
  return error?.message || String(error);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function runSelftest({ entry, request, output = process.stdout }) {
  const fixture = fs.readFileSync(path.resolve(__dirname, '../test/fixtures/selftest.html'));
  let posts = 0;
  const server = http.createServer((incoming, response) => {
    if (incoming.method === 'POST' && incoming.url === '/submit') {
      posts += 1;
      incoming.resume();
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('posted');
      return;
    }
    if (incoming.url === '/probe') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    if (incoming.url === '/' || incoming.url === '/selftest.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(fixture);
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });

  const failures = [];
  let tabId;
  let debugging = false;
  let focusChanged = false;
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}/selftest.html`;

  const call = async (cmd, args = {}) => {
    const response = await request(entry.socket, cmd, args);
    if (!response.ok) {
      const error = new Error(`${response.error.code}: ${response.error.message}`);
      error.remote = response.error;
      throw error;
    }
    return response.result;
  };
  const raw = (cmd, args = {}) => request(entry.socket, cmd, args);
  const pageState = async () => JSON.parse((await call('read', { tabId, selector: '#state' })).text);
  const inspectFocus = async () => {
    const tabs = (await call('tabs')).tabs;
    // 利用者が自分でタブやアプリを切り替えても落ちないよう、テスト用タブが前面に出たかだけを見る。
    if (tabs.some((tab) => tab.tabId === tabId && tab.active)) focusChanged = true;
  };
  const evaluate = async (expression) => (await call('eval', { tabId, expression })).value;
  const element = async (text) => {
    const result = await call('elements', { tabId });
    const found = result.elements?.find((candidate) => candidate.text === text);
    assert(found, `要素「${text}」が見つかりません`);
    return found;
  };
  const check = async (name, action) => {
    try {
      assert(tabId !== undefined, 'テスト用タブを開けていません');
      await action();
      await inspectFocus();
      output.write(`${name}\tok\n`);
    } catch (error) {
      failures.push(name);
      output.write(`${name}\tNG\t${reason(error)}\n`);
    }
  };

  try {
    try {
      tabId = (await call('open', { url })).tabId;
    } catch (error) {
      output.write(`open\tNG\t${reason(error)}\n`);
    }

    await check('group', async () => {
      const tab = (await call('tabs')).tabs.find((item) => item.tabId === tabId);
      assert(Number.isInteger(tab?.groupId) && tab.groupId >= 0, 'Bridgeグループに入っていません');
    });
    await check('screenshot-bg', async () => {
      const tab = (await call('tabs')).tabs.find((item) => item.tabId === tabId);
      assert(tab && !tab.active, 'テスト用タブが前面です');
      const shot = await call('screenshot', { tabId });
      const png = Buffer.from(shot.dataUrl?.split(',')[1] || '', 'base64');
      assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNGではありません');
    });
    await check('read', async () => {
      const result = await call('read', { tabId });
      assert(result.text?.includes('chrome-bridge selftest'), 'テストページを読めません');
    });
    await check('elements', async () => {
      const result = await call('elements', { tabId });
      assert(result.elements?.length >= 6, '必要な操作要素が不足しています');
    });
    await check('scroll', async () => {
      const result = await call('scroll', { tabId, to: 'bottom' });
      // 裏のタブではscrollイベントが発火しないので、イベントではなく実際の位置で確かめる。
      assert(result.scroll?.y > 0, 'スクロール位置が動いていません');
      assert((await call('read', { tabId })).scroll.y > 0, 'スクロールがページに届いていません');
    });
    await check('click', async () => {
      const target = await element('表示切替');
      await call('click', { tabId, ref: target.ref });
      assert((await pageState()).clicked === 'true', '表示が切り替わっていません');
    });
    await check('click-guard', async () => {
      const target = await element('送信');
      const response = await raw('click', { tabId, ref: target.ref });
      assert(!response.ok && response.error.code === 'NEEDS_CONFIRMATION', '危険なクリックが拒否されません');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert(posts === 0, 'POSTが送信されました');
    });
    await check('input-guard', async () => {
      const target = await element('テキスト入力');
      const response = await raw('click', { tabId, ref: target.ref });
      assert(!response.ok && response.error.code === 'INPUT_BLOCKED', '入力欄クリックが拒否されません');
    });
    await check('click-real', async () => {
      const target = await element('実クリック');
      await call('click', { tabId, ref: target.ref, real: true });
      assert((await pageState()).realClicked === 'true', '実クリックが届いていません');
    });
    await check('click-xy', async () => {
      await call('click', { tabId, x: 60, y: 25 });
      assert((await pageState()).xyClicked === 'true', '座標クリックが届いていません');
    });
    await check('hover', async () => {
      const target = await element('ホバー対象');
      await call('hover', { tabId, ref: target.ref });
      assert((await pageState()).hovered === 'true', 'ホバーが届いていません');
    });
    await check('key', async () => {
      await call('key', { tabId, key: 'Escape' });
      assert((await pageState()).key === 'Escape', 'Escapeが届いていません');
    });
    await check('key-guard', async () => {
      const target = await element('テキスト入力');
      await call('click', { tabId, ref: target.ref, allowInput: true, real: true });
      const response = await raw('key', { tabId, key: 'Enter' });
      assert(!response.ok && response.error.code === 'NEEDS_CONFIRMATION', 'form内のEnterが拒否されません');
    });
    await check('type', async () => {
      const target = await element('テキスト入力');
      await call('type', { tabId, ref: target.ref, text: 'bridge-text', userInstructed: true });
      assert((await pageState()).textValue === 'bridge-text', '文字が入りません');
    });
    await check('type-real', async () => {
      const target = await element('実入力');
      await call('type', { tabId, ref: target.ref, text: 'bridge-real', userInstructed: true, real: true });
      assert((await pageState()).realValue === 'bridge-real', '実入力が入りません');
    });
    await check('eval', async () => {
      assert(await evaluate('6 * 7') === 42, '式の評価結果が違います');
    });
    await check('console', async () => {
      await call('debugStart', { tabId });
      debugging = true;
      await evaluate('window.runDebugSignals()');
      const result = await call('console', { tabId, pattern: 'selftest-console' });
      assert(result.messages?.some((message) => message.text.includes('selftest-console')), 'console.logを取得できません');
    });
    await check('network', async () => {
      const result = await call('network', { tabId, pattern: '/probe' });
      assert(result.requests?.some((requestItem) => requestItem.url.includes('/probe')), 'fetchを取得できません');
    });
    await check('nav', async () => {
      await call('nav', { tabId, action: 'reload' });
      const result = await call('read', { tabId });
      assert(result.text?.includes('chrome-bridge selftest'), '再読み込み後に読めません');
    });
    await check('no-focus-steal', async () => {
      await inspectFocus();
      assert(!focusChanged, 'テスト用タブが前面に出ました');
    });
  } finally {
    if (debugging && tabId !== undefined) await raw('debugStop', { tabId }).catch(() => {});
    if (tabId !== undefined) await raw('close', { tabId }).catch(() => {});
    await stop(server);
  }

  const resultResponse = await raw('selftestResult', {
    chromeVersion: entry.browser.chromeVersion,
    ok: failures.length === 0,
    failures,
  });
  if (!resultResponse.ok) {
    output.write(`selftestResult\tNG\t${resultResponse.error.code}: ${resultResponse.error.message}\n`);
    return 1;
  }
  return failures.length === 0 ? 0 : 1;
}

module.exports = { runSelftest };
