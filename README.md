# 销量预测

公共代码仓库：[rabbittttt/Sales_Forecast](https://github.com/rabbittttt/Sales_Forecast)。

本目录是独立项目。代码、模板、配置、预测算法、测试、浏览器草稿、网页资源和日志均由本项目独立维护，不导入或调用“订单分析”的代码。销量数据汇总由本项目更新到共享目录，供各项目读取。

## 运行

所有项目默认共用所在 `Project/.venv`。新电脑先安装 Python 3.11 或更新版本（共享环境要求），在 `Project` 根目录双击“初始化共享环境.cmd”重建共享环境并安装依赖。项目位于 `Project/销量预测/` 时，也可在本项目目录手动安装依赖、启动：

```powershell
..\.venv\Scripts\python.exe -m pip install -r requirements.txt
..\.venv\Scripts\python.exe main.py
```

换电脑后应重新创建 `Project/.venv`，不要直接复制旧电脑的虚拟环境。整体移动 `Project` 时保留项目与共享目录的相对位置；`Project` 的上级目录和盘符可以不同。

`运行销量预测.bat` 从脚本所在目录向上找到最近名为 `Project` 的目录，固定使用其中 `.venv\Scripts\python.exe`，忽略子项目自己的 `.venv`，也不回退 PATH 或 Codex Python。可用 `SALES_FORECAST_PYTHON` 显式指定其他解释器文件；相对路径按本项目目录解析。启动窗口显示所选 Python，并在环境缺失或依赖不全时停止，提示初始化或安装命令。

也可双击根目录的“运行销量预测.bat”。只生成文件、不打开浏览器：`..\.venv\Scripts\python.exe main.py --no-open`。
也可直接运行 `scripts/generate_html/main.py`。启动位置不影响默认输入、输出路径。

生成结果：`output_file/鸿蒙智行销量预测.html`。
预测看板为单个 HTML 文件，可直接打开。

## 输入与输出

- 输入：相对于本项目根目录的 `../共享数据/订单汇总/`，其中“小订及首销数据整理.xlsx”为维护表，其余订单 Excel 为真实订单来源。
- 车型信息：`../共享数据/车型信息/`；现行车型属性主要读取上述整理表首个 Sheet。
- 可用 `SHARED_DATA_ROOT` 指定其他共享根目录；相对值相对于本项目根目录解析。
- 不读取“订单分析”的目录，不回退本地旧输入副本。缺少共享数据时明确报错。
- 本项目重新计算的销量数据汇总写入 `../共享数据/订单汇总/鸿蒙智行销量数据汇总.xlsx`，预测读取这份共享汇总，不回退 `output_file/` 中的旧汇总。设置 `SHARED_DATA_ROOT` 时，汇总位于所指定共享根的 `订单汇总/` 下。
- 该销量汇总是本项目唯一允许写入的共享派生文件；共享原始输入只读，其他共享文件不得覆盖。HTML 默认生成在本项目 `output_file/`。
- 日志保存在 `output_file/log/`，缓存仅在本项目输出目录下创建。运行结束清理自身缓存。
- 人工更新共享原始输入后，各项目下次运行会读取新数据；销量预测刷新共享销量汇总后，使用该汇总的项目也会读取到新版本。两边的代码和配置仍独立维护。

`main.py --input` 可显式指定订单输入目录，`main.py --output` 只指定 HTML 输出位置；日志和网页读取缓存随 HTML 输出目录保存；刷新缓存固定在本项目 `output_file/.cache/`，运行结束会同时清理两处缓存，销量汇总仍写入上述固定共享位置。HTML、日志和缓存不得放进共享数据目录。

单独运行刷新工具时，显式 `--output` 仍可指定自定义非共享汇总文件；不传该参数时更新上述共享汇总。不得覆盖原始输入或共享目录中的其他文件。自定义刷新输出不会改变主入口读取共享汇总的约定。

## 维护

配置：`scripts/generate_html/config.json`。
算法：`scripts/generate_html/modules/sales_forecast.py`。
刷新汇总：`scripts/generate_html/tools/refresh_sales_forecast_data.py`。
页面：`scripts/generate_html/templates/`。
所有依赖为实文件副本，没有符号链接或对另一个项目的运行时引用；模块注册只包含销量预测。保留的通用实现和历史业务测试也是本项目自己的副本。

历史功能说明见 `docs/原预测功能说明.md`；其中旧目录、双页构建、订单分析发布和 Git 远端说明已失效。历史迁移验收记录保留当时状态；当前路径、汇总输出约定与运行方式以本文件为准。

浏览器测试生成 Python 夹具时也默认使用所在 `Project/.venv`；既有 `PYTHON_EXE`、`PYTHON_BINARY` 可显式覆盖。带目录的相对值按本项目根目录解析，显式命令名保持兼容。

```powershell
cd scripts/generate_html
..\..\..\.venv\Scripts\python.exe -m compileall -q core modules tools main.py
node --check templates/dashboard.js
node --check templates/forecast-math.js
node --check templates/forecast-import.js
..\..\..\.venv\Scripts\python.exe -m unittest discover -s tests
..\..\..\.venv\Scripts\python.exe main.py --no-open --check
```

`--check` 遇到数据质量警告会返回非零状态；请查看日志中的具体数据定位。
