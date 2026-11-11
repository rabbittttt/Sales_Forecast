(() => {
  "use strict";
  const revision = document.currentScript.dataset.revision;
  let checking = false;
  async function checkForUpdate() {
    if (checking || document.hidden) return;
    checking = true;
    try {
      const response = await fetch("/api/status", {cache: "no-store"});
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
  setInterval(checkForUpdate, 60000);
  document.addEventListener("visibilitychange", checkForUpdate);
  checkForUpdate();
})();
