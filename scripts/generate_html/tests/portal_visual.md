# 门户导航视觉回归

`portal_visual.cjs` 打开计划工作台的 `/#/app/forecast`。桌面、窄屏和键盘焦点分别生成 expected 与 actual 两份 PNG。两份图在同一个 Edge 版本、同一套系统字体上绘制。宽高改变或任一像素的任一 RGB 分量差超过 12 就失败，差异以红色标注。生成时间和车型来自固定匿名数据。基准源码与门户版本记录在 `portal_visual_refs.json`，正常运行不会更新它们。

CI 检出这两个固定提交，在 4173 启动门户及其真实反向代理，另外启动临时预测服务并在结束时关闭。两侧不需要业务 Excel 或运行中的其他应用。查看 GitHub Actions 的 `forecast-header` 产物核对图像。只有在设计变更经人工确认后，再单独把 `forecast` 指向已确认版本。当前测试还会用一条 1 像素的横线验证差异检测本身。

## 本地复验

在当前销量预测仓库，把 `portal_visual_refs.json` 里的预测基准提交检出到 `.test_runtime/visual-baseline`。默认从同级的 `计划工作台` 目录读取固定门户提交；也可以通过 `PLANHUB_TEST_ROOT` 指向独立的干净检出，`FORECAST_VISUAL_BASELINE` 可覆盖预测基准目录。基准代码仅供验收，生产启动时不依赖计划工作台源码。

需要共享 Python、Edge，以及同一 Node 模块目录里的 `playwright@1.56.1` 和 `pngjs@7.0.0`。如不在项目的 `.test_runtime/node_modules` 下，请将 `PLAYWRIGHT_MODULE` 指向 Playwright 的绝对目录。随后从仓库根目录运行：

```powershell
node scripts/generate_html/tests/portal_visual.cjs
```

4173 被日常门户占用时，设置 `$env:PLANHUB_TEST_PORT='0'` 可另启真实门户代理并自动分配空闲端口。要核对已打开的本机门户，可设置 `$env:PLANHUB_TEST_LIVE_URL='http://127.0.0.1:4173'`。此模式仅在隔离浏览器会话中把预测请求转到匿名服务，不停止或重配门户。默认图片写到 `.test_outputs/portal-visual/`，可用 `FORECAST_SCREENSHOTS` 指定其他测试目录。
