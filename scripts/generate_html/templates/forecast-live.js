(() => {
  "use strict";
  const script = document.currentScript;
  const revision = script.dataset.revision;
  const statusUrl = new URL("api/status", script.src).href;
  // Live reports may serve a cached HTML revision while the next one is generated.
  const style = document.createElement("style");
  style.textContent = `
    .forecast-live-diagnostic {width:100%; min-width:0; order:2}
    .forecast-live-diagnostic p {white-space:pre-line; overflow-wrap:anywhere; margin:0 0 6px; line-height:1.6}
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
      (document.querySelector(".module-bar .top-actions") || toolbar).append(label);
    }
    const message = ({
      error: "后台数据刷新失败，等待重试",
      awaiting_publication: "显示上次结果，等待小订与首销首次发布"
    })[state] || "后台数据刷新中";
    if (label.textContent !== message) {
      label.textContent = message;
      label.title = message;
    }
  }
  updateRefreshNotice(script.dataset.previousResult === "true");
  let latestStatus;
  function renderDiagnostic() {
    const host = document.querySelector(".forecast-header-menu[open] .forecast-target-sources");
    if (!host || !latestStatus) return;
    let text = host.querySelector("[data-live-diagnostic]");
    if (!text) {
      const group = document.createElement("div");
      group.className = "forecast-live-diagnostic";
      text = document.createElement("p");
      text.dataset.liveDiagnostic = "";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.dataset.copyLiveDiagnostic = "";
      copy.textContent = "复制刷新诊断";
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(text.textContent);
          copy.textContent = "已复制";
        } catch {
          const range = document.createRange();
          range.selectNodeContents(text);
          const selection = document.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          let copied = false;
          try { copied = document.execCommand("copy"); } catch { /* Selection remains available. */ }
          copy.textContent = copied ? "已复制" : "请复制所选文字";
        }
      };
      group.append(text, copy);
      host.append(group);
    }
    const status = latestStatus;
    const short = id => id ? String(id).slice(0, 12) : "—";
    const states = {starting:"启动中", ready:"已就绪", building:"生成中", stabilizing:"等待文件稳定", awaiting_publication:"等待小订与首销首次发布", waiting:"等待文件稳定", error:"失败，等待重试"};
    const diagnostic = [
      "后台状态　" + (states[status.state] || status.state || "—"),
      "刷新原因　" + (status.refresh_reason || "—"),
      "最近生成成功　" + (status.last_success_at || "—"),
      "当前显示　" + short(revision) + (status.previous_result ? "（上次结果）" : ""),
      "目标页面版本　" + short(status.page_version),
      "服务版本　" + short(status.service_version)
    ].join("\n");
    if (text.textContent !== diagnostic) text.textContent = diagnostic;
  }
  document.addEventListener("toggle", event => {
    if (event.target.matches?.(".forecast-header-menu[open]")) renderDiagnostic();
  }, true);

  let frameInView = true;
  const frame = globalThis.window?.frameElement;
  if (frame && typeof IntersectionObserver === "function") {
    const observer = new frame.ownerDocument.defaultView.IntersectionObserver(entries => {
      const wasVisible = frameInView;
      frameInView = entries[entries.length - 1].isIntersecting;
      if (!wasVisible && frameInView) checkForUpdate();
    });
    observer.observe(frame);
  }

  let checking = false;
  async function checkForUpdate() {
    if (checking || document.hidden || !frameInView) return;
    if (frame && (frame.getClientRects().length === 0 || frame.checkVisibility?.({visibilityProperty:true}) === false)) return;
    checking = true;
    try {
      const response = await fetch(statusUrl, {cache: "no-store"});
      if (!response.ok) return;
      const status = await response.json();
      latestStatus = status;
      renderDiagnostic();
      if (status.revision && status.revision !== revision) {
        // The dashboard saves the current model and manual inputs on pagehide.
        location.reload();
      } else {
        updateRefreshNotice(status.previous_result, status.state);
        document.querySelector(".forecast-workspace")?._syncSharedImports?.();
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
