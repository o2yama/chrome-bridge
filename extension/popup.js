const byId = (id) => document.getElementById(id);
let pendingRequest = false;

async function refresh(cmd = "popupStatus") {
  try {
    const response = await chrome.runtime.sendMessage({ cmd });
    if (!response?.ok) throw new Error(response?.error?.message || "状態を取得できません");
    const state = response.result;
    byId("connection").textContent = state.connected ? "接続中" : "未接続";
    byId("email").textContent = state.email || "未ログイン";
    byId("extension-version").textContent = state.extensionVersion;
    byId("chrome-version").textContent = state.chromeVersion;
    const verified = state.verified;
    const sameVersion = verified?.chromeVersion.split(".")[0] === state.chromeVersion.split(".")[0];
    byId("verification").textContent = !verified || !sameVersion ? "未確認" : verified.ok ? "確認済み" : `失敗：${verified.failures.join("、")}`;
    byId("message").textContent = state.selftestRunning ? "動作確認中…結果を待っています" : "";
    byId("selftest").disabled = !state.connected || state.selftestRunning || pendingRequest;
  } catch (error) {
    byId("message").textContent = error.message;
  }
}

byId("reload").addEventListener("click", () => chrome.runtime.reload());
byId("selftest").addEventListener("click", async () => {
  pendingRequest = true;
  byId("selftest").disabled = true;
  await refresh("requestSelftest");
  pendingRequest = false;
  await refresh();
});
void refresh();
const statusTimer = setInterval(() => { if (!pendingRequest) void refresh(); }, 1000);
window.addEventListener("unload", () => clearInterval(statusTimer));
