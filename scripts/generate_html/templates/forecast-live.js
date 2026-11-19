(() => {
  "use strict";
  const script = document.currentScript;
  const revision = script.dataset.revision;
  const statusUrl = new URL("api/status", script.src).href;
  if (script.dataset.previousResult === "true") {
    const updatedAt = document.getElementById("updatedAt");
    if (updatedAt) {
      const label = document.createElement("span");
      label.setAttribute("role", "status");
      label.textContent = "上次生成结果 · ";
      updatedAt.before(label);
    }
  }
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
