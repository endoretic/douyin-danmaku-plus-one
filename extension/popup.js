"use strict";
const enabled = document.querySelector("#enabled");
const pageStatus = document.querySelector("#page-status");
async function checkPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const info = await chrome.tabs.sendMessage(tab.id, { type: "dy-plus-one:status" });
    if (!info.enabled) pageStatus.textContent = "当前已停用。";
    else if (!info.bridge) pageStatus.textContent = "点击功能已加载，但弹幕识别未连接。请刷新直播间。";
    else if (info.bridge.records || info.domCount) pageStatus.textContent = `已就绪：识别到 ${info.bridge.records + info.domCount} 段画面弹幕，点击原文即可 +1。`;
    else pageStatus.textContent = "扩展已连接，等待画面弹幕。请开启弹幕；更新扩展后请刷新页面。";
  } catch {
    pageStatus.textContent = "尚未连接当前页面。请打开抖音直播间并刷新；确认扩展拥有此网站的访问权限。";
  }
}
checkPage();
chrome.storage.local.get({ enabled: true }).then(value => { enabled.checked = value.enabled; });
enabled.addEventListener("change", async () => {
  try {
    await chrome.storage.local.set({ enabled: enabled.checked });
    document.querySelector("#status").textContent = enabled.checked ? "已启用，当前抖音页面立即生效" : "已停用弹幕点击";
    checkPage();
  } catch {
    document.querySelector("#status").textContent = "设置未保存，请重新打开扩展重试";
  }
});
