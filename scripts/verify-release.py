"""
独立核对发布包 —— 刻意不复用 scripts/make-release.mjs 的任何代码。

用 Python 标准库 zipfile 作为第二套 ZIP 解析实现：如果我的写入器有 bug
（比如中央目录和本地头的长度写岔了），zipfile 会直接抛异常，而自读自写
的检查发现不了。同时用它逐字节比对源文件、核对 sha256 清单。

用法:  py scripts/verify-release.py
退出码 0 才算过。
"""
import hashlib
import io
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZIP = ROOT / "dist" / "notrat-workbuddy-pool.zip"
SHA_FILE = Path(str(ZIP) + ".sha256")

problems = []


def bad(msg):
    problems.append(msg)


if not ZIP.exists():
    print("FAIL: 找不到 " + str(ZIP) + "，先跑 node scripts/make-release.mjs")
    sys.exit(1)

raw = ZIP.read_bytes()

# ---- 1. 打开（这一步就能抓到结构错误）----
try:
    zf = zipfile.ZipFile(io.BytesIO(raw))
except Exception as e:
    print("FAIL: zipfile 打不开（结构损坏）：" + repr(e))
    sys.exit(1)

names = zf.namelist()
infos = {i.filename: i for i in zf.infolist()}

print(f"entries: {len(names)}   zip bytes: {len(raw)}")

# ---- 2. 结构断言（宿主 installOfficialPluginZip 的硬限制）----
if "manifest.json" not in names:
    bad("manifest.json 不在根")
if not (1 <= len(names) <= 200):
    bad(f"条目数 {len(names)} 超出 1..200")

for n in names:
    if len(n) > 200:
        bad(f"路径过长(>200): {n}")
    if n.startswith("/"):
        bad(f"绝对路径: {n}")
    if "../" in n:
        bad(f"含 ../: {n}")
    if n.startswith("~"):
        bad(f"以 ~ 开头: {n}")
    if "\\" in n:
        bad(f"条目名含反斜杠（mac/linux 会整包报废）: {n}")

# ---- 3. 禁入：状态 / 凭据 / 预览产物 ----
FORBIDDEN = [
    (r"^(preview|tests|scripts)/", "dev-only dir"),
    (r"(^|/)data/", "runtime data"),
    (r"(^|/)(config|state|auth)\.json$", "state/credential file"),
    (r"\.state\.json$", "state file"),
    (r"\.(log|bak|pem|p12|token)$", "log/key"),
    (r"~$", "backup"),
    (r"\.(png|jpe?g)$", "screenshot"),
]
for n in names:
    for pat, why in FORBIDDEN:
        if re.search(pat, n, re.I):
            bad(f"禁入({why}): {n}")

# ---- 4. 逐字节比对源文件 + CRC 校验 ----
checked = 0
for n in names:
    if n.endswith("/"):
        continue
    packed = zf.read(n)  # zipfile 自己会校验 CRC，坏了这里就抛
    src = ROOT / n
    if not src.exists():
        bad(f"包内有源里没有的文件: {n}")
        continue
    if packed != src.read_bytes():
        bad(f"内容与源不一致: {n}")
        continue
    checked += 1

print(f"byte-identical to source: {checked}/{len([n for n in names if not n.endswith('/')])}")

# ---- 5. 清单引用可解析 ----
import json
mf = json.loads(zf.read("manifest.json").decode("utf-8"))
have = set(names)
for ui in mf.get("contributions", {}).get("ui", []):
    p = (ui.get("content") or {}).get("sourceFile")
    if isinstance(p, str) and p:
        if p.replace("\\", "/").lstrip("./") not in have:
            bad(f"manifest 引用的面板不在包里: {ui.get('id')} -> {p}")
for s in mf.get("mcpServers", []):
    for a in [s.get("command")] + list(s.get("args") or []):
        if not isinstance(a, str) or "${pluginDir}" not in a:
            continue
        rel = a.replace("${pluginDir}", "").lstrip("/\\").replace("\\", "/")
        if rel and rel not in have:
            bad(f"mcpServers 引用的文件不在包里: {s.get('id')} -> {a}")

if mf.get("id") != "notrat-workbuddy-pool":
    bad(f"manifest.id 异常: {mf.get('id')}")

# ---- 6. sha256 清单核对 ----
digest = hashlib.sha256(raw).hexdigest()
if SHA_FILE.exists():
    declared = SHA_FILE.read_text(encoding="utf-8").split()[0].strip()
    if declared.lower() != digest:
        bad(f"sha256 清单与实际不符: 文件={declared[:16]}… 实际={digest[:16]}…")
    else:
        print(f"sha256 matches manifest file: {digest[:16]}...")
else:
    bad("缺 .sha256 清单文件（市场提交要用）")

# ---- 结论 ----
if problems:
    print("\nFAIL: " + str(len(problems)) + " problem(s)")
    for p in problems:
        print("  - " + p)
    sys.exit(1)

print("\nOK: independent check passed (zipfile reader, byte-identical, no forbidden files)")
print("zip is installable as a directory pack: unzip -> notrat-workbuddy-pool/manifest.json")
