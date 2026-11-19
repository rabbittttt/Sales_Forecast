(() => {
  "use strict";
  const script = document.currentScript;
  const revision = script.dataset.revision;
  const statusUrl = new URL("api/status", script.src).href;
  let label;
  function updateRefreshNotice(previous, state) {
    if (!previous) {
      label?.remove();
      label = undefined;
      return;
    }
    if (!label) {
      const brand = document.querySelector(".topbar .brand > div");
      if (!brand) return;
      label = document.createElement("small");
      label.setAttribute("role", "status");
      // Also apply on cached pages, whose styles may hide the default subtitle on phones.
      label.style.cssText = "display:block;color:var(--muted,#526078);font-size:11px;letter-spacing:0";
      brand.append(label);
    }
    const message = state === "error" ? "后台数据刷新失败，等待重试" : "后台数据刷新中";
    if (label.textContent !== message) label.textContent = message;
  }
  updateRefreshNotice(script.dataset.previousResult === "true");
  let checking = false;
  async function checkForUpdate() {
    if (checking || document.hidden) return;
    checking = true;
    try {
      const response = await fetch(statusUrl, {cache: "no-store"});
      if (!response.ok) return;
      const status = await response.json();
      if (status.revision && status.revision !== revision) {
        // The dashboard saves the current model and manual inputs on pagehide.
        location.reload();
      } else {
        updateRefreshNotice(status.previous_result, status.state);
      }
    } catch {
      // Keep the current report when the local service is temporarily unavailable.
    } finally {
      checking = false;
    }
  }
  setInterval(checkForUpdate, 15000);
  document.addEventListener("visibilitychange", checkForUpdate);
  checkForUpdate();
})();
