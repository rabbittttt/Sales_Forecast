# AI 维护指南

## 先看这里

这个项目只有三层，不要再拆层：

1. `core/`：Excel 读取、主体识别、通用组件数据结构、输出与校验。
2. `modules/`：一个业务标签一个文件，看板口径和排布都在这里。
3. `templates/`：页面外壳、样式和通用组件渲染。

`main.py` 只编排生成流程，`config.json` 放标签顺序、显示名称和可选的销量预测复盘日期。修改页面时编辑模板和生成器源码。

## 常见修改

- 改某个看板：只改对应的 `modules/*.py`。
- 调整颜色、密度、布局：改 `templates/dashboard.css`。
- 新增一种已有组件组合：新建一个 `modules/*.py`，然后加到 `modules/registry.py` 和 `config.json`。
- 新增一种全新图形：先在业务模块输出新 `kind`，再在 `templates/dashboard.js` 增加一个同名渲染函数。
- 新增品牌或代际：不改代码，Sheet 名前缀符合现有命名即可。

## 预测代码定位

| 要核对的内容 | 从这里读 |
| --- | --- |
| 预测模块是否运行 | `modules/registry.py` 的 `MODULES`、`modules/sales_forecast.py` 的 `SalesForecastModule` |
| 小订、首销开始与结束边界 | Python 的 `_small_order_stage`、`_forecast_stage`；浏览器的 `smallStage`、`launchStage`；双端用例 `tests/test_forecast_contract.py` |
| 小时快照、盘中推算、逐日分配 | `templates/forecast-math.js` 的 `smallHourlyForecast`、`intradayComponents`；`templates/dashboard.js` 按函数调用定位对应阶段 |
| 原始 Excel、来源优先级、共享汇总 | `core/forecast_summary.py`、`tools/refresh_sales_forecast_data.py` 的 `forecast_signature` 和 `summary_is_current` |
| 动态刷新与共享导入 | `server.py`、`core/live_server.py` 的 `LiveMonitor`、`core/external_imports.py` |
| 顶部车型控件 | 在 `templates/dashboard.css` 检索 `#subjectSelect` 和 `#forecastNavParameters` |

## 模块契约

每个模块实现：

```python
class XxxModule:
    id = "unique_id"
    label = "页面标签"

    def build(self, store, subject):
        # 有数据返回 Dashboard，无数据返回 None。
        ...
```

返回 `None` 时顶部标签自动置灰。不要在页面中写死品牌、代际或周期。

## 业务约束

- 集团固定为“鸿蒙智行”，品牌和代际动态识别。
- 主体类型不同，可用看板可以不同；不要强行补齐空看板。
- 原始输入、共享汇总、静态输出、动态持久目录和日志遵循[项目路径表](../../README.md#输入与输出)，路径由 `core/data_paths.py` 统一解析。
- 不添加“数据覆盖情况”、筛选区“数据口径”或自动管理建议。
- 独立预测页在“来源与时间详情”展示数据来源和时间口径，可核对来源文件、Sheet 与可用的单元格信息。
- 销量汇总输出“首销期退订当日数量”（兼容读取旧名“退订当日数量”），保留既有D1累计基数口径；“小订期退订当日数量”按小订窗口保存真实日量并紧跟“小订当日数量”。两者均仅指小订退订，优先整理表、缺值再取小订退订分析，0与未知不能混淆。
- 销量汇总的维护数量只接受有效非负数；空白、待更新、Excel错误、布尔值、负数或非有限值保持未知，允许有效来源按既有优先级补缺。真实0（包括数字文本0）保留原优先级；独立维护的有效比例保留，未知分母不生成完成度0。清洗只发生在生成过程的临时副本，不改原始整理表。
- 小订分时的重复小时、非法小时或数量异常必须保留日期级质量状态；派生“小订by时”通过“分时口径状态”列传递，旧表无此列时仍校验小时和数量。异常小时不能参与D1拟合、历史分时参考或当日数量下限，独立有效日量和真实0仍保留；不能过滤坏点后把剩余小时重新当作有效完整记录。
- 首销预测不可用时，真实数据回退仍保留完整Dn位置及独立已知日量。累计值遇到未知前缀保持未知，斜率仅比较相邻已知日；周卡不能把部分和称为完整周总量，实际锁单率也须有同范围完整数量或已有可信终值依据。真实0不等于缺日。
- 累计锚点之间的缺口不平均摊成日量；仅相邻日期的可信累计允许差分补日量，缺日且无有效终值依据时继续留空。
- 同类多文件合并必须在实际选值时记录物理文件、原Sheet和单元格，不得按数值相等反查来源。补缺字段跟随实际提供者，跨文件日/周汇总保留所有参与来源；同值重复或低优先级未选中的数据不列入贡献来源。回归见 `test_forecast_cell_sources.py`、`test_forecast_source_propagation.py` 和 `test_forecast_invalid_quantities.py`。
- 本项目生成单个独立销量预测 HTML（app_mode=forecast），包含小订、首销和平销预测。
- 车型与时间参数常驻独立预测页头，使用原 DOM 控件和即时重算绑定。首销“参数配置”承载两种方法的参数。各阶段的“预测依据”保留公共参数与参考设置，沿用原控件属性和草稿键，草稿使用本项目独立存储键。无预测块或禁用时显示明确的空态。

## 修改后验证

本项目独立维护，不沿用订单分析 Git 仓库或远端。以项目根目录 AGENTS.md 为准。

```powershell
python -m compileall -q core modules tools main.py
node --check templates/dashboard.js
node --check templates/forecast-math.js
node --check templates/forecast-import.js
python -m unittest discover -s tests
python main.py --no-open --check
```

检查本次日志是否存在异常，并验证预测主体切换、参数联动与来源说明。
