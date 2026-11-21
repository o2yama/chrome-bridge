let selftestRunning = false;
let chromeVersionPromise;

function currentChromeVersion() {
  if (!chromeVersionPromise) {
    chromeVersionPromise = (async () => {
      try {
        const data = await navigator.userAgentData?.getHighEntropyValues(["fullVersionList"]);
        const brand = data?.fullVersionList?.find((item) => item.brand === "Google Chrome") || data?.fullVersionList?.find((item) => item.brand === "Chromium");
        if (brand) return brand.version;
      } catch {}
      return navigator.userAgent.match(/(?:Chrome|Chromium)\/([\d.]+)/)?.[1] || "";
    })();
  }
  return chromeVersionPromise;
}

async function verificationInfo() {
  const [chromeVersion, stored] = await Promise.all([
    currentChromeVersion(),
    callbackCall(chrome.storage.local.get.bind(chrome.storage.local), "verified"),
  ]);
  return { chromeVersion, verified: stored.verified || null };
}

async function updateBadge() {
  const { chromeVersion, verified } = await verificationInfo();
  const confirmed = verified?.ok === true && verified.chromeVersion.split(".")[0] === chromeVersion.split(".")[0];
  await chrome.action.setBadgeBackgroundColor({ color: "#D97757" });
  await chrome.action.setBadgeText({ text: confirmed ? "" : "!" });
}

async function selftestResult(args) {
  if (typeof args.chromeVersion !== "string" || !/^\d+(?:\.\d+)*$/.test(args.chromeVersion)) badArgs("chromeVersionが不正です");
  if (typeof args.ok !== "boolean") badArgs("okが不正です");
  if (!Array.isArray(args.failures) || args.failures.some((item) => typeof item !== "string")) badArgs("failuresが不正です");
  const verified = { chromeVersion: args.chromeVersion, ok: args.ok, failures: args.failures, at: new Date().toISOString() };
  await callbackCall(chrome.storage.local.set.bind(chrome.storage.local), { verified });
  selftestRunning = false;
  await updateBadge();
  return { verified };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  if (!["popupStatus", "requestSelftest"].includes(message?.cmd)) return false;
  (async () => {
    if (message.cmd === "requestSelftest" && !selftestRunning) {
      const instanceId = await getInstanceId();
      if (!nativePort) throw new Error("ホストに接続していません");
      nativePort.postMessage({ event: "selftestRequested", instanceId });
      selftestRunning = true;
      // 動作確認が結果を返さずに落ちても、ボタンが押せないまま残らないようにする。
      const resetTimer = setTimeout(() => { selftestRunning = false; }, 120000);
      resetTimer?.unref?.();
    }
    return { ...(await hello()), connected: Boolean(nativePort), selftestRunning };
  })().then((result) => respond({ ok: true, result }), (error) => respond({ ok: false, error: { message: error.message } }));
  return true;
});
