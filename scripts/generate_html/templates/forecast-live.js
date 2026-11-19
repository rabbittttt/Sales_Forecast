(() => {
  "use strict";
  const script = document.currentScript;
  const revision = script.dataset.revision;
  const statusUrl = new URL("api/status", script.src).href;
  // Live reports may serve a cached HTML revision while the next one is generated.
  const style = document.createElement("style");
  style.textContent = `
    .topbar .forecast-refresh-status {
      flex: none; margin-inline-start: auto; align-self: center;
      color: var(--muted, #606775); font-size: 12px; white-space: nowrap;
    }
    @media (max-width: 700px) {
      body.forecast-app .topbar:has(.forecast-refresh-status) {
        display: grid; grid-template: 28px 32px / minmax(0,1fr) auto;
        align-content: center; gap: 2px 6px;
      }
      body.forecast-app .topbar:has(.forecast-refresh-status) > .brand {
        grid-area: 1 / 1; width: 100%; min-width: 0; overflow: hidden;
      }
      .topbar:has(.forecast-refresh-status) .brand div { min-width: 0; }
      .topbar:has(.forecast-refresh-status) .brand strong {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      body.forecast-app .topbar:has(.forecast-refresh-status) > .topbar-main { grid-area: 2 / 1 / 3 / -1; }
      .topbar .forecast-refresh-status {
        grid-area: 1 / 2; max-width: 43vw; overflow: hidden; text-overflow: ellipsis;
      }
    }`;
  document.head.append(style);
  let label;
  function updateRefreshNotice(previous, state) {
    if (!previous) {
      label?.remove();
      label = undefined;
      return;
    }
    if (!label) {
      const toolbar = document.querySelector(".topbar");
      if (!toolbar) return;
      label = document.createElement("small");
      label.setAttribute("role", "status");
      label.className = "forecast-refresh-status";
      toolbar.append(label);
    }
    const message = state === "error" ? "后台数据刷新失败，等待重试" : "后台数据刷新中";
    if (label.textContent !== message) {
      label.textContent = message;
      label.title = message;
    }
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
