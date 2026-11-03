# 销量预测

本目录是独立项目。代码、模板、配置、预测算法、测试、浏览器草稿、派生汇总、网页资源和日志均由本项目维护，不导入或调用“订单分析”的代码。

## 运行

```powershell
python -m pip install -r requirements.txt
python main.py
```

也可双击根目录的“运行销量预测.bat”。只生成文件、不打开浏览器：`python main.py --no-open`。
也可直接运行 `scripts/generate_html/main.py`。启动位置不影响默认输入、输出路径。

生成结果：`output_file/鸿蒙智行销量预测.html`。
复制或发布网页时，必须一并携带同目录 `forecast_assets/`。

## 输入与输出

- 输入：相对于本项目根目录的 `../共享数据/订单汇总/`，其中“小订及首销数据整理.xlsx”为维护表，其余订单 Excel 为真实订单来源。
- 车型信息：`../共享数据/车型信息/`；现行车型属性主要读取上述整理表首个 Sheet。
- 可用 `SHARED_DATA_ROOT` 指定其他共享根目录；相对值相对于本项目根目录解析。
- 不读取“订单分析”的目录，不回退本地旧输入副本。缺少共享数据时明确报错。
- 本项目重新计算的“鸿蒙智行销量数据汇总.xlsx”仅写入 `output_file/`，不读取或覆盖共享目录中的同名派生文件。
- 日志保存在 `output_file/log/`，缓存仅在本项目输出目录下创建。运行结束清理自身缓存。
- 修改共享原始输入会使各项目下次运行读取到新数据；这是唯一有意保留的共同来源。

`--input`、`--output` 可显式指定输入目录和 HTML 输出；自定义输出的派生汇总与资源随 HTML 放在同一目录。禁止把输出放进共享数据目录。

## 维护

配置：`scripts/generate_html/config.json`。
算法：`scripts/generate_html/modules/sales_forecast.py`。
刷新汇总：`scripts/generate_html/tools/refresh_sales_forecast_data.py`。
页面：`scripts/generate_html/templates/`。
所有依赖为实文件副本，没有符号链接或对另一个项目的运行时引用；模块注册只包含销量预测。保留的通用实现和历史业务测试也是本项目自己的副本。

历史功能说明见 `docs/原预测功能说明.md`；其中旧目录、双页构建、订单分析发布和 Git 远端说明已失效，路径与运行方式以本文件为准。

```powershell
cd scripts/generate_html
python -m compileall -q core modules tools main.py
node --check templates/dashboard.js
node --check templates/forecast-math.js
node --check templates/forecast-import.js
python -m unittest discover -s tests
python main.py --no-open --check
```

`--check` 遇到数据质量警告会返回非零状态；请查看日志中的具体数据定位。
