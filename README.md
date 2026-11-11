# 销量预测

公共代码仓库：[rabbittttt/Sales_Forecast](https://github.com/rabbittttt/Sales_Forecast)。

本目录是独立项目。代码、模板、配置、预测算法、测试、浏览器草稿、网页资源和日志均由本项目独立维护，不导入或调用“订单分析”的代码。销量数据汇总由本项目更新到共享目录，供各项目读取。

## 运行

静态网页与动态网页分别启动，输出也分别保存：

```text
销量预测/
├─ 运行静态销量预测.bat
├─ 运行动态销量预测.bat
├─ 运行销量预测.bat                （兼容旧静态启动方式）
├─ static/
│  └─ main.py
├─ dynamic/
│  └─ serve.py
├─ output_file/
│  ├─ static/
│  │  ├─ 鸿蒙智行销量预测.html
│  │  └─ log/
│  └─ dynamic/
│     └─ log/
├─ main.py                        （兼容静态入口）
└─ serve.py                       （兼容动态入口）
```

所有项目默认共用所在 `Project/.venv`。新电脑先安装 Python 3.11 或更新版本（共享环境要求），在 `Project` 根目录双击“初始化共享环境.cmd”重建共享环境并安装依赖。也可在本项目根目录手动安装：

```powershell
..\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

启动脚本从项目根目录向上找到最近名为 `Project` 的目录，使用其中 `.venv\Scripts\python.exe`。可用 `SALES_FORECAST_PYTHON` 指定其他解释器文件，相对路径始终按本项目根目录解析。启动窗口显示所选 Python，环境缺失或依赖不全时停止并提示处理命令。

换电脑后应重新创建 `Project/.venv`，不要直接复制旧电脑的虚拟环境。整体移动 `Project` 时保留项目与共享目录的相对位置，上级目录和盘符可以不同。

### 静态网页

双击根目录的 `运行静态销量预测.bat`，生成并打开 `output_file/static/鸿蒙智行销量预测.html`。生成后可直接打开该 HTML，无需保持启动窗口运行，下次手动运行时更新数据。日志位于 `output_file/static/log/`。

在项目根目录运行命令，只生成文件、不打开浏览器：

```powershell
..\.venv\Scripts\python.exe static/main.py --no-open
```

### 动态网页

双击根目录的 `运行动态销量预测.bat`，启动本地服务并打开浏览器，默认地址为 `http://127.0.0.1:8780/`。动态结果位于 `output_file/dynamic/`，日志位于 `output_file/dynamic/log/`。

后台服务每 300 秒检查共享原始输入，发现变化后，等待文件连续稳定 60 秒再更新预测。浏览器在页面可见时每 15 秒检查页面版本，发现新版本后自动刷新。首次启动也会等待连续稳定 60 秒，期间可查看已有结果。更新失败时保留上次成功页面并自动重试。使用期间保持服务窗口打开，按 `Ctrl+C` 停止服务。

在项目根目录手动启动：

```powershell
..\.venv\Scripts\python.exe dynamic/serve.py
..\.venv\Scripts\python.exe dynamic/serve.py --host 127.0.0.1 --port 8780 --no-open
```

`--no-open` 只关闭自动打开浏览器。动态地址与直接打开静态文件的浏览器人工参数各自保存。

所有启动 bat 均放在项目根目录，`运行销量预测.bat` 转发到 `运行静态销量预测.bat`，兼容旧调用。根目录原有 `main.py`、`serve.py` 也保留兼容入口，命令行参数继续有效。启动位置不影响默认输入、输出路径。

## 输入与输出

- 输入：相对于本项目根目录的 `../共享数据/订单汇总/`，其中“小订及首销数据整理.xlsx”为维护表，其余订单 Excel 为真实订单来源。
- 车型信息：`../共享数据/车型信息/`；现行车型属性主要读取上述整理表首个 Sheet。
- 可用 `SHARED_DATA_ROOT` 指定其他共享根目录；相对值相对于本项目根目录解析。
- 不读取“订单分析”的目录，不回退本地旧输入副本。缺少共享数据时明确报错。
- 本项目重新计算的销量数据汇总写入 `../共享数据/订单汇总/鸿蒙智行销量数据汇总.xlsx`，预测读取这份共享汇总，不回退 `output_file/` 中的旧汇总。设置 `SHARED_DATA_ROOT` 时，汇总位于所指定共享根的 `订单汇总/` 下。
- 该销量汇总是本项目唯一允许写入的共享派生文件；共享原始输入只读，其他共享文件不得覆盖。静态 HTML 默认生成在本项目 `output_file/static/`，动态结果保存在 `output_file/dynamic/`。
- 静态和动态日志分别保存在 `output_file/static/log/`、`output_file/dynamic/log/`，缓存仅在本项目输出目录下创建。运行结束清理自身缓存。
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
