# 销量预测

持久目录统一为同级工作区的 `工作台数据/database/forecast/`；独立运行与门户运行读取同一位置。可用 `PLANHUB_DATA_ROOT` 指定数据根（相对路径按应用根解析），应用原有显式数据目录参数继续优先。程序发布不携带业务数据库；发布版使用 `planhub-runtime/database/forecast/`。共享 Excel 仍在原共享目录，数据库集中不改变业务口径。首次升级必须停服迁移，旧目录改名为 `.pre-central-*` 恢复备份，不再参与运行。

公共代码仓库：[rabbittttt/Sales_Forecast](https://github.com/rabbittttt/Sales_Forecast)。

本目录是独立项目。代码、模板、配置、预测算法、测试、浏览器草稿、网页资源和日志均由本项目独立维护，不导入或调用“订单分析”的代码。销量数据汇总由本项目更新到共享目录，供各项目读取。

## 运行

静态网页与动态网页分别启动，输出也分别保存：

```text
销量预测/
├─ 运行静态销量预测.bat
├─ 运行动态销量预测.bat
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

双击根目录的 `运行静态销量预测.bat`，生成并打开 `../工作台数据/database/forecast/static/鸿蒙智行销量预测.html`。生成后可直接打开该 HTML，无需保持启动窗口运行，下次手动运行时更新数据。日志位于 `../工作台数据/database/forecast/static/log/`。

在项目根目录运行命令，只生成文件、不打开浏览器：

```powershell
..\.venv\Scripts\python.exe static/main.py --no-open
```

### 动态网页

双击根目录的 `运行动态销量预测.bat`，启动本地服务并打开浏览器，默认地址为 `http://127.0.0.1:8780/`。动态结果位于 `../工作台数据/database/forecast/dynamic/`，日志位于 `../工作台数据/database/forecast/dynamic/log/`。

后台服务每 300 秒检查共享原始输入，发现变化后，等待文件连续稳定 60 秒再更新预测。浏览器在页面可见时每 15 秒检查页面版本，发现新版本后自动刷新。同一程序版本重启时，先展示上次页面；后台首轮核对原始输入、配置、业务日期以及共享汇总文件，全部未变化便直接恢复，不再重复等待或计算。首次运行该版本、输入变化或快速启动缓存失效时仍等待连续稳定 60 秒再生成，期间可查看该版本已有结果。更新失败时保留上次成功页面并自动重试。使用期间保持服务窗口打开，按 `Ctrl+C` 停止服务。同一版本重复启动会打开已有服务。更新程序后，先在原服务窗口按 `Ctrl+C` 并等待退出，再重新运行动态启动脚本。

在项目根目录手动启动：

```powershell
..\.venv\Scripts\python.exe dynamic/serve.py
..\.venv\Scripts\python.exe dynamic/serve.py --host 127.0.0.1 --port 8780 --no-open
```

`--no-open` 只关闭自动打开浏览器。动态地址与直接打开静态文件的浏览器人工参数各自保存。

两个启动 bat 均放在项目根目录。根目录的 `main.py`、`serve.py` 分别提供静态和动态命令行入口。默认输入、输出路径以项目根目录解析。

## 门户接入与发布

门户仍访问 `/forecast/`，独立运行仍访问 `/`。原项目启动示例：

```powershell
..\.venv\Scripts\python.exe -B dynamic/serve.py --no-open --public-prefix /forecast/
..\.venv\Scripts\python.exe -B scripts/build_release.py --version 2026.11.11.1 --destination output_file/releases/forecast-2026.11.11.1
```

标准包只有 `app-release.json` 和 `payload/`，包含同版代码、模板、资源与 requirements.txt，不带 Excel、日志、缓存或浏览器草稿。发布目录不可覆盖，前后端一起切换。部署电脑安装依赖后运行包内 `dynamic/serve.py`：

- `--host 127.0.0.1 --port 8780 --no-open --public-prefix /forecast/`；代理整段前缀，支持剥除或保留前缀，页面可同源嵌入。
- `--data-dir` 或 `SALES_FORECAST_DATA_DIR` 指定版本目录外的运行根；相对值按项目（发布时为 payload）根解析，正式部署传绝对路径。页面、资源、锁、缓存和日志全部写入该目录，不能放共享原始输入目录。未配置时使用同级 `工作台数据/database/forecast`。
- `SHARED_DATA_ROOT` 显式指向部署电脑的共享根。保留原预测规则：只读原始输入，仅更新订单汇总中的销量汇总派生文件。账号须能写入该派生文件。
- `/healthz` 为轻量进程探针，返回 ok/app/ready/state；`/readyz` 在首次等待或更新错误时返回 503；`/api/status` 给出更新状态。首次页面返回等待壳并自动重试，生成失败可查状态和服务日志。

同一版本重启可读取外置目录中的上次结果；源码、模板或配置变更后不会复用旧版本页面，重新等待输入稳定并生成。发布前停掉旧服务，再切换版本；不要让新旧服务同时写共享汇总。浏览器人工参数仍由原页面维护，门户公共地址不变时继续沿用。

## 输入与输出

- 输入：相对于本项目根目录的 `../共享数据/订单汇总/`，其中“小订及首销数据整理.xlsx”为维护表，其余订单 Excel 为真实订单来源。
- 车型信息：`../共享数据/车型信息/`；现行车型属性主要读取上述整理表首个 Sheet。
- 可用 `SHARED_DATA_ROOT` 指定其他共享根目录；相对值相对于本项目根目录解析。
- 不读取“订单分析”的目录，不回退本地旧输入副本。缺少共享数据时明确报错。
- 本项目重新计算的销量数据汇总写入 `../共享数据/订单汇总/鸿蒙智行销量数据汇总.xlsx`，预测读取这份共享汇总，不回退 `output_file/` 中的旧汇总。设置 `SHARED_DATA_ROOT` 时，汇总位于所指定共享根的 `订单汇总/` 下。
- 该销量汇总是本项目唯一允许写入的共享派生文件；共享原始输入只读，其他共享文件不得覆盖。静态 HTML 默认生成在本项目 `../工作台数据/database/forecast/static/`，动态结果保存在 `../工作台数据/database/forecast/dynamic/`。
- 静态和动态日志分别保存在 `../工作台数据/database/forecast/static/log/`、`../工作台数据/database/forecast/dynamic/log/`，缓存仅在本项目输出目录下创建。运行结束清理自身缓存。
- 人工更新共享原始输入后，各项目下次运行会读取新数据；销量预测刷新共享销量汇总后，使用该汇总的项目也会读取到新版本。两边的代码和配置仍独立维护。

`main.py --input` 可显式指定订单输入目录，`main.py --output` 只指定 HTML 输出位置；日志和网页读取缓存随 HTML 输出目录保存；刷新缓存固定在本项目 `../工作台数据/database/forecast/.cache/`，运行结束会同时清理两处缓存，销量汇总仍写入上述固定共享位置。HTML、日志和缓存不得放进共享数据目录。

单独运行刷新工具时，显式 `--output` 仍可指定自定义非共享汇总文件；不传该参数时更新上述共享汇总。不得覆盖原始输入或共享目录中的其他文件。自定义刷新输出不会改变主入口读取共享汇总的约定。

## 维护

配置：`scripts/generate_html/config.json`。
算法：`scripts/generate_html/modules/sales_forecast.py`。
刷新汇总：`scripts/generate_html/tools/refresh_sales_forecast_data.py`。
页面：`scripts/generate_html/templates/`。
汇总代际的新旧名称对应关系统一维护在 `scripts/generate_html/core/model_identity.py` 的 `AGGREGATE_GENERATIONS`：`问界 M9&M9U 2026款`、`尊界 V680&V800 2026款`、`尚界 Z7&Z7T 2026款`、`享界 S9&S9T 2026款` 不再依赖“汇总”后缀识别。四组旧汇总代号与新名称可以在输入中混用，整理表决定预测显示名称；整理表中明确维护且名称无旧汇总后缀的预测对象继续参与取数，未维护的派生聚合继续排除。同一观察量沿用首个非空值，不重复累加，也不将单个成员车型视为聚合别名。新增组合须显式配置，程序不会仅凭 `&` 推断合并关系。
所有依赖为实文件副本，没有符号链接或对另一个项目的运行时引用；模块注册只包含销量预测。保留的通用实现和历史业务测试也是本项目自己的副本。

历史功能说明见 `docs/原预测功能说明.md`；其中旧目录、双页构建、订单分析发布和 Git 远端说明已失效。历史迁移验收记录通过 Git 历史查阅，迁移备份仍保留在 `.migration/`；当前路径、汇总输出约定与运行方式以本文件为准。

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


### 参考车型评分审查（2026-11-17）

- 直接大定占比：小订规模权重从 6% 调整为 16%。历史终值可用性仍是自动推荐资格，不再作为相似度加 10% 的固定分。规模相似度为两车总小订较小值除以较大值。
- 当前小订期未结束（包括结束当天）：仅使用同车型、同评估日期且无错误的小订预测终值参与规模比较；没有有效预测终值时跳过规模项，不把阶段累计量当最终规模。小订结束后沿用实际/维护总量。
- 转化率、直接占比和锁单参数：首销 D1 完整观测尚未形成时，使用阶段可获得的评分项计算覆盖率。缺少小订终值本身不排除参考，其他证据仍需达到有效权重门槛，历史输出指标仍须有效。
- 未知、缺失、横杠属性不作为匹配证据。平销锁单率相似度接受真实 0，排除空值、负数和超过 100% 的比例。

本轮核对范围与后续校准方向：

| 评分任务 | 当前审查结论 |
| --- | --- |
| 小订日节奏 | 属性、时长、规模共同评分；进行中累计量与历史终值的规模比较仍值得改为同进度比较，需单独验证预测联动。 |
| 小订及首销分时 | 比较共同已观测窗口内的小时形状与进度，发布时间可用于初选；不加入绝对小时销量。 |
| 首销小转大/直接大定进度 | 只比较已发生结构和曲线；D1/D2与累计形状存在相关性，后续应通过逐车型留出检验重复加权影响。 |
| 最终转化率/直接占比/锁单参数 | 本轮修正阶段覆盖和小订规模处理；参考终值有效性仍独立检查。 |
| 到天分配/每日斜率 | 保留完整曲线资格及真实日、日历还原边界；缺失曲线的固定分仍可在后续统一改成资格展示。 |
| 首销量级 | 保留属性、首销天数与小订规模；共用修正后的未结束小订取数。 |
| 平销承接 | 保留首销归一形状和同龄完整周趋势为主的权重，修正锁单率零值边界。 |

以上是规则修正，16% 并非历史误差拟合出的最优权重。后续校准应按历史预测时点重建当时可见数据，用逐车型留出比较预测误差与简单基准，避免拿终局信息参与当时评分。
