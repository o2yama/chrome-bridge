const ownedTabs = new Set();
const requestedUrls = new Map();
let groupQueue = Promise.resolve();

function forgetOwnedTab(tabId) {
  ownedTabs.delete(tabId);
  requestedUrls.delete(tabId);
}

chrome.tabs.onRemoved.addListener(forgetOwnedTab);

function normalizeOpenUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    url.hostname = url.hostname.toLowerCase();
    return url.href;
  } catch {
    return value;
  }
}

async function findReusableTab(url) {
  const target = normalizeOpenUrl(url);
  const windows = await callbackCall(
    chrome.windows.getAll.bind(chrome.windows),
    { populate: true, windowTypes: ["normal"] },
  );
  const candidates = windows.flatMap((window) => window.tabs || []).filter((tab) => (
    normalizeOpenUrl(tab.url || "") === target
    || (requestedUrls.has(tab.id) && normalizeOpenUrl(requestedUrls.get(tab.id)) === target)
  ));
  candidates.sort((a, b) => {
    const ownership = Number(ownedTabs.has(b.id)) - Number(ownedTabs.has(a.id));
    return ownership || (Number(b.lastAccessed) || 0) - (Number(a.lastAccessed) || 0);
  });
  return candidates[0];
}

async function waitForTab(tabId, action) {
  let timer;
  let finish;
  let fail;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const updated = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
  const removed = (id) => { if (id === tabId) fail(new BridgeError("NO_SUCH_TAB", "指定されたタブがありません", { tabId })); };
  chrome.tabs.onUpdated.addListener(updated);
  chrome.tabs.onRemoved.addListener(removed);
  timer = setTimeout(finish, 15000);
  try {
    await Promise.all([completed, (async () => {
      if (action) await action();
      if (!action) {
        const tab = await getTab(tabId);
        if (tab.status === "complete") finish();
      }
    })()]);
    const tab = await getTab(tabId);
    return { tabId, url: tab.url || "", title: tab.title || "" };
  } finally {
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(updated);
    chrome.tabs.onRemoved.removeListener(removed);
  }
}

async function openTab(args) {
  if (typeof args.url !== "string") badArgs("urlが不正です");
  let url;
  try { url = new URL(args.url); } catch { badArgs("urlが不正です"); }
  if (!["http:", "https:", "file:"].includes(url.protocol)) badArgs("このURLは開けません");
  requireBooleanIfPresent(args, "background");
  requireBooleanIfPresent(args, "front");
  requireBooleanIfPresent(args, "new");
  if (args.tabId !== undefined) {
    const tabId = requireTabId(args);
    await getTab(tabId);
    return { ...(await waitForTab(tabId, () => chrome.tabs.update(tabId, { url: args.url }))), reused: false };
  }
  if (args.new !== true) {
    let tab = await findReusableTab(args.url);
    if (tab) {
      if (args.front === true) tab = await chrome.tabs.update(tab.id, { active: true });
      return { tabId: tab.id, url: tab.url || "", title: tab.title || "", reused: true };
    }
  }
  const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  const tab = await chrome.tabs.create({ windowId: window.id, url: args.url, active: args.front === true });
  ownedTabs.add(tab.id);
  requestedUrls.set(tab.id, args.url);
  const grouped = groupQueue.catch(() => {}).then(async () => {
    const groups = await chrome.tabGroups.query({ windowId: window.id, title: "Bridge" });
    const existing = groups[0];
    const groupId = await chrome.tabs.group({
      tabIds: [tab.id],
      ...(existing ? { groupId: existing.id } : { createProperties: { windowId: window.id } }),
    });
    await chrome.tabGroups.update(groupId, { title: "Bridge", color: "orange" });
  });
  groupQueue = grouped;
  try { await grouped; }
  catch (error) {
    await chrome.tabs.remove(tab.id);
    forgetOwnedTab(tab.id);
    throw error;
  }
  return { ...(await waitForTab(tab.id)), reused: false };
}

async function navigateTab(args) {
  const tabId = requireTabId(args);
  const methods = { back: "goBack", forward: "goForward", reload: "reload" };
  if (!Object.hasOwn(methods, args.action)) badArgs("actionが不正です");
  requireBooleanIfPresent(args, "noCache");
  if (args.noCache && args.action !== "reload") badArgs("noCacheにはreloadが必要です");
  await getTab(tabId);
  if (args.noCache) {
    return withDebugger(tabId, (send) => waitForTab(tabId, () => send("Page.reload", { ignoreCache: true })));
  }
  return waitForTab(tabId, () => chrome.tabs[methods[args.action]](tabId));
}

async function closeTab(args) {
  const tabId = requireTabId(args);
  await getTab(tabId);
  if (!ownedTabs.has(tabId)) throw new BridgeError("NOT_OWNED", "この拡張が開いたタブではありません", { tabId });
  await chrome.tabs.remove(tabId);
  forgetOwnedTab(tabId);
  return { closed: true };
}
