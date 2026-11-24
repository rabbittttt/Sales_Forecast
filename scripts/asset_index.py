"""Build a searchable local inventory of the forecast workspace. No workbook data is read."""
from collections import defaultdict
import html
import os
from pathlib import Path
import re
import stat
import subprocess
from tempfile import NamedTemporaryFile
from datetime import datetime
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output_file/maintenance/资产索引.html"
TEXT = {".py", ".js", ".cjs", ".css", ".html", ".md", ".yml", ".json", ".bat"}


def tracked_files():
    result = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True)
    return {Path(name.decode("utf-8")) for name in result.stdout.split(b"\0") if name}


def references(tracked):
    names = defaultdict(set)
    for path in tracked:
        names[path.name].add(path)
    found = defaultdict(set)
    word = re.compile(r"[\w.-]+\.(?:py|js|cjs|css|html|md|yml|json|bat|svg|txt)\b", re.I)
    module = re.compile(r"\b(?:from|import)\s+((?:core|modules|tools|tests)\.[\w.]+)")
    for source in sorted(tracked):
        if source.suffix.lower() not in TEXT or not (ROOT / source).is_file():
            continue
        content = (ROOT / source).read_text(encoding="utf-8-sig", errors="replace")
        targets = set()
        for token in set(word.findall(content)):
            matches = names.get(token, ())
            if len(matches) == 1:
                targets.update(matches)
            else:
                targets.update(path for path in matches if path.as_posix() in content)
        for token in module.findall(content):
            file = Path("scripts/generate_html", *token.split(".")).with_suffix(".py")
            if file in tracked:
                targets.add(file)
        for target in targets - {source}:
            found[target].add(source.as_posix())
    return found


def describe(path, is_dir):
    folders = path.parts
    name = path.name
    if folders[0] == ".git": return "Git", "版本历史与仓库元数据"
    if "archive" in folders[:2]: return "历史归档", "保留原相对路径的历史文件"
    if "forecast_assets" in folders: return "旧版网页资源", "旧版离线 HTML 配套脚本"
    if any(tag in folders for tag in (".test_outputs", "tests", ".test_runtime")):
        return ("历史订单回归", "订单测试数据与兼容行为") if "legacy_order" in folders else ("测试", "回归用例、夹具或验收产物")
    if any(tag in folders for tag in ("__pycache__", ".cache", ".pytest_cache")): return "缓存", "运行时生成"
    if "audit" in folders or "审计" in name: return "审计", "历史问题、验证或资产索引"
    if folders[0] == "output_file": return "本机输出", "本机生成结果、日志或维护产物"
    if "templates" in folders: return "网页界面", "嵌入报告的脚本、样式或界面资源"
    if name.startswith(("live_", "server", "serve")) or folders[0] == "dynamic": return "动态服务", "服务入口、刷新、存储或版本管理"
    if "refresh" in name or "headers" in name or "excel" in name: return "Excel", "读取原始输入、校验或输出销量汇总"
    if "forecast" in name or "modules" in folders: return "预测", "预测阶段、数据来源或计算规则"
    if "docs" in folders or path.suffix == ".md": return "文档", "项目说明、维护指南或历史记录"
    if folders[0] == ".github": return "持续集成", "GitHub 自动验证"
    if folders[0] == "static" or path.suffix == ".bat": return "启动入口", "启动预测服务或静态生成"
    return "基础设施", "项目目录" if is_dir else "工具、共享组件或配置"


def inventory(tracked, refs):
    rows = []
    owned_dirs = {parent for file in tracked for parent in file.parents}
    def on_error(error):
        raise error
    for base, dirs, files in os.walk(ROOT, onerror=on_error, followlinks=False):
        for name in sorted(dirs + files):
            full = Path(base, name)
            path = full.relative_to(ROOT)
            info = full.lstat()
            folder = name in dirs
            link = stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400
            if folder and link:
                dirs.remove(name)
            if full == OUTPUT:
                continue
            theme, purpose = describe(path, folder)
            uses = sorted(refs.get(path, ()))
            if link: status = "外部链接，仅记录入口"
            elif folder: status = "含仓内跟踪文件" if path in owned_dirs else "本地目录"
            elif uses: status = "仓内文字引用（" + str(len(uses)) + "）"
            elif path in tracked: status = "Git 已跟踪，未检出显式文字引用"
            else: status = "本地文件，运行或外部引用待核"
            rows.append((path.as_posix(), "目录" if folder else "文件", theme, purpose,
                         datetime.fromtimestamp(info.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                         "" if folder else str(info.st_size), status, " · ".join(uses)))
    return sorted(rows)


def main():
    tracked = tracked_files()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    rows = inventory(tracked, references(tracked))
    body = []
    for path, *values in rows:
        href = quote(os.path.relpath(ROOT / path, OUTPUT.parent).replace(os.sep, "/"), safe="/")
        cells = "".join("<td>" + html.escape(v) + "</td>" for v in values)
        body.append('<tr><td><a href="' + href + '">' + html.escape(path) + "</a></td>" + cells + "</tr>")
    doc = """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>销量预测资产索引</title>
<style>body{font:14px system-ui;margin:20px;color:#172338}input{padding:6px}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #ddd;padding:6px;overflow-wrap:anywhere}th{background:#f2f4f6}td:last-child{max-width:28em}a{color:#18468c}</style>
<h1>销量预测资产索引</h1><label>筛选 <input id="search" type="search"></label> <output id="count"></output>
<table><thead><tr>""" + "".join("<th>"+v+"</th>" for v in ("相对路径","类型","主题","用途","最后更新","字节","引用状态","引用证据")) + "</tr></thead><tbody>" + "\n".join(body) + """</tbody></table>
<script>const search=document.getElementById('search'),count=document.getElementById('count');const rows=Array.from(document.querySelectorAll('tbody tr'),row=>[row,row.textContent.toLowerCase()]);function filter(){const words=search.value.toLowerCase().trim().split(/\\s+/);let n=0;for(const [row,text] of rows){row.hidden=!words.every(w=>text.includes(w));if(!row.hidden)n++}count.textContent=n+' / '+rows.length}search.addEventListener('input',filter);filter()</script></html>"""
    tmp = None
    try:
        with NamedTemporaryFile("w", dir=OUTPUT.parent, encoding="utf-8", delete=False) as out:
            tmp = Path(out.name)
            out.write(doc)
        os.replace(tmp, OUTPUT)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
    print(f"{len(rows)} 条资产 | {OUTPUT}")


if __name__ == "__main__":
    main()
