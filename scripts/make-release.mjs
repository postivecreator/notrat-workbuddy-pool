/**
 * 打发布包：把插件打成可分发的**目录型 zip**，并在打完的那一刻自检。
 *
 * 为什么是这个形状（不是随便压一下）：
 *   宿主装目录型包的位置是 `~/.notrat/plugins/<manifest.id>/`，插件靠
 *   `${pluginDir}/server/index.js` 找自己的服务端 —— 所以**目录名必须等于 id**。
 *   把文件放在 zip 的**根**、并让 zip 自己叫 `notrat-workbuddy-pool.zip`，
 *   用户双击解压（Win/mac 都用 zip 文件名建目录）得到的正好是那个正确的目录名。
 *   如果压成 `xxx-0.2.0.zip`，解压出来就是 `xxx-0.2.0/`，插件起不来。
 *
 * 为什么不用外部 zip 命令：
 *   这台机器上唯一的 zip 来自 MiKTeX，换台机器就没了；而且条目名大小写/分隔符
 *   不可控（宿主会因为反斜杠条目名在 mac/linux 上整包报废）。这里自己写
 *   store/deflate 两种记录，条目名一律正斜杠 + UTF-8，可复现（固定时间戳）。
 *
 * 自检（任何一条不过就 exit 1，不产出"看起来成功"的包）：
 *   1. 结构：manifest.json 在根；条目数 1..200；路径长度 ≤200；无绝对路径 / .. / ~
 *   2. 清单：manifest 里引用的 sourceFile、mcpServers args 指向的文件都在包里
 *   3. 禁入：状态文件 / 凭据 / 预览产物 / 测试与脚本 一个都不能有
 *   4. 内容：逐文件扫令牌样式、本机绝对路径、U+FFFD 编码损坏
 *   5. 回读：解包回来与源文件逐字节相同（证明写出的 zip 没坏）
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(ROOT, "dist");
const ZIP_NAME = "notrat-workbuddy-pool.zip"; // ⚠️ 名字即目录名，别加版本号
const ZIP_PATH = path.join(DIST, ZIP_NAME);

/* ══════════════ 1. 收文件：白名单目录 + 硬性禁入 ══════════════ */

/** 进包的目录（递归全收，将来加文件不会漏） */
const INCLUDE_DIRS = ["panels", "server", "assets"];
/** 进包的根文件 */
const INCLUDE_FILES = ["manifest.json", "README.md", "LICENSE", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md"];

/** 任何层级出现这些目录名 → 整支跳过 */
const DENY_DIRS = new Set(["preview", "tests", "scripts", "dist", "node_modules", ".git", "data", "_archive", ".notrat"]);
/** 这些文件名 → 不进包（状态 / 凭据 / 垃圾） */
const DENY_FILE_RE = [
  /^\.env(\..*)?$/i,
  /^config\.json$/i,
  /^state\.json$/i,
  /\.state\.json$/i,
  /^auth\.json$/i,
  /\.token$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.log$/i,
  /\.bak$/i,
  /~$/,
  /^_r\.txt$/,
  /^out\.txt$/,
  /^\.gitignore$/,
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
];

function walk(dir, rel, acc) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const relPath = rel ? rel + "/" + name : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      if (DENY_DIRS.has(name)) continue;
      walk(abs, relPath, acc);
      continue;
    }
    if (!st.isFile()) continue;
    if (DENY_FILE_RE.some((re) => re.test(name))) continue;
    acc.push({ relPath, abs, size: st.size });
  }
  return acc;
}

const entries = [];
for (const f of INCLUDE_FILES) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) {
    console.error(`✗ 缺必需文件：${f}`);
    process.exit(1);
  }
  entries.push({ relPath: f, abs, size: fs.statSync(abs).size });
}
for (const d of INCLUDE_DIRS) {
  const abs = path.join(ROOT, d);
  if (!fs.existsSync(abs)) {
    console.error(`✗ 缺必需目录：${d}`);
    process.exit(1);
  }
  walk(abs, d, entries);
}
entries.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));

/* ══════════════ 2. 内容扫描：令牌 / 本机路径 / 编码损坏 ══════════════ */

const SECRET_PATTERNS = [
  { re: /[A-Za-z]:[\\/]{1,2}Users[\\/](?!<|%|\$)[^\\/\s"'<>]+/g, what: "本机绝对路径（Windows 用户目录）" },
  { re: /\/home\/[a-z0-9._-]+\//gi, what: "本机绝对路径（Linux home）" },
  { re: /\/Users\/[a-z0-9._-]+\//gi, what: "本机绝对路径（macOS home）" },
  { re: /\bsk-[A-Za-z0-9_-]{12,}\b/g, what: "疑似 sk- 形式的密钥" },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, what: "疑似 GitHub token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, what: "疑似 GitHub PAT" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, what: "疑似 AWS Access Key" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, what: "疑似 Slack token" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, what: "私钥块" },
  { re: /"(accessToken|refreshToken|apiKey|secret|password)"\s*:\s*"[^"]{16,}"/gi, what: "内嵌的凭据字面量" },
];

const textIssues = [];
const fileData = [];
for (const e of entries) {
  const buf = fs.readFileSync(e.abs);
  e.buf = buf;
  e.sha = crypto.createHash("sha256").update(buf).digest("hex");
  const isText = !/\.(png|jpe?g|gif|webp|ico|zip|pdf|woff2?|ttf)$/i.test(e.relPath);
  if (!isText) continue;
  let text;
  try {
    text = buf.toString("utf8");
  } catch {
    continue;
  }
  if (text.indexOf("\uFFFD") >= 0) {
    textIssues.push({ file: e.relPath, what: `含 ${(text.match(/\uFFFD/g) || []).length} 处 U+FFFD（编码损坏）` });
  }
  for (const p of SECRET_PATTERNS) {
    const hits = text.match(p.re);
    if (hits && hits.length) {
      const sample = hits[0].length > 70 ? hits[0].slice(0, 70) + "…" : hits[0];
      textIssues.push({ file: e.relPath, what: `${p.what}：${sample}` });
    }
  }
}

/* ══════════════ 3. 清单引用必须能在包里解析 ══════════════ */

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const have = new Set(entries.map((e) => e.relPath));
const missingRefs = [];

for (const ui of manifest?.contributions?.ui || []) {
  const p = ui?.content?.sourceFile;
  if (typeof p === "string" && p && !have.has(p.replace(/\\/g, "/").replace(/^\.?\//, ""))) {
    missingRefs.push(`ui[${ui.id}].content.sourceFile = ${p}`);
  }
}
for (const mcp of manifest?.mcpServers || []) {
  const args = [mcp.command, ...(mcp.args || [])].filter((x) => typeof x === "string");
  for (const a of args) {
    if (a.indexOf("${pluginDir}") < 0) continue;
    const rel = a.replace("${pluginDir}", "").replace(/^[\\/]+/, "").replace(/\\/g, "/");
    if (rel && !have.has(rel)) missingRefs.push(`mcpServers[${mcp.id}].args → ${a}`);
  }
}

/* ══════════════ 4. 写 zip（store + deflate，可复现） ══════════════ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/* 固定时间戳 → 同样的源文件永远得到同样的字节（可复现构建） */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const locals = [];
const centrals = [];
let offset = 0;

for (const e of entries) {
  const nameBuf = Buffer.from(e.relPath, "utf8");
  const raw = e.buf;
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(raw);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
  lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(DOS_TIME, 10);
  lh.writeUInt16LE(DOS_DATE, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18);
  lh.writeUInt32LE(raw.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(DOS_TIME, 12);
  cd.writeUInt16LE(DOS_DATE, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(body.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(offset, 42);

  locals.push(lh, nameBuf, body);
  centrals.push(cd, nameBuf);
  offset += lh.length + nameBuf.length + body.length;
}

const cdBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zipBuf = Buffer.concat([...locals, cdBuf, eocd]);
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(ZIP_PATH, zipBuf);
const zipSha = crypto.createHash("sha256").update(zipBuf).digest("hex");
fs.writeFileSync(ZIP_PATH + ".sha256", `${zipSha}  ${ZIP_NAME}\n`);

/* ══════════════ 5. 回读：证明写出来的包能正确解开 ══════════════ */

function readZip(buf) {
  /* 找 EOCD */
  let eocdAt = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0) throw new Error("找不到 EOCD（zip 结构损坏）");
  const total = buf.readUInt16LE(eocdAt + 10);
  const cdSize = buf.readUInt32LE(eocdAt + 12);
  const cdOff = buf.readUInt32LE(eocdAt + 16);

  const out = [];
  let p = cdOff;
  const cdEnd = cdOff + cdSize;
  while (p < cdEnd) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("中央目录项签名错");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const body = buf.slice(dataOff, dataOff + csize);
    const raw = method === 8 ? zlib.inflateRawSync(body) : body;
    out.push({ name, method, utf8: !!(flags & 0x0800), crc, csize, usize, raw });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (out.length !== total) throw new Error(`条目数不符：EOCD=${total}，实际=${out.length}`);
  return out;
}

const problems = [];
let reread = [];
try {
  reread = readZip(zipBuf);
} catch (e) {
  problems.push(`回读失败：${e.message}`);
}

const srcByName = new Map(entries.map((e) => [e.relPath, e]));
if (reread.length) {
  if (reread.length !== entries.length) problems.push(`回读条目数（${reread.length}）与源（${entries.length}）不符`);
  for (const r of reread) {
    const src = srcByName.get(r.name);
    if (!src) {
      problems.push(`回读出现源里没有的条目：${r.name}`);
      continue;
    }
    if (r.crc !== crc32(src.buf)) problems.push(`CRC 不符：${r.name}`);
    if (r.raw.length !== src.buf.length || !r.raw.equals(src.buf)) problems.push(`内容不符（逐字节）：${r.name}`);
    if (!r.utf8) problems.push(`条目名未标 UTF-8：${r.name}`);
    if (r.name.indexOf("\\") >= 0) problems.push(`条目名含反斜杠：${r.name}`);
  }
}

/* ══════════════ 6. 结构 / 禁入 断言 ══════════════ */

const names = entries.map((e) => e.relPath);

if (!names.includes("manifest.json")) problems.push("根目录缺 manifest.json");

/* 宿主硬限制（installOfficialPluginZip 里写死的） */
if (entries.length < 1 || entries.length > 200) problems.push(`条目数 ${entries.length} 超出 1..200`);
for (const n of names) {
  if (n.length > 200) problems.push(`路径过长（>200）：${n}`);
  if (n.startsWith("/")) problems.push(`绝对路径：${n}`);
  if (n.includes("../")) problems.push(`含 ../：${n}`);
  if (n.startsWith("~")) problems.push(`以 ~ 开头：${n}`);
}

/* 禁入：状态 / 凭据 / 预览产物 —— 这类东西进包等于把用户的账号和布局一起发出去 */
const FORBIDDEN_IN_ZIP = [
  { re: /^preview\//, why: "预览产物" },
  { re: /^tests\//, why: "测试" },
  { re: /^scripts\//, why: "开发脚本" },
  { re: /(^|\/)data\//, why: "运行期数据目录" },
  { re: /(^|\/)config\.json$/, why: "插件配置（可能含账号选择/保留线）" },
  { re: /(^|\/)state\.json$/, why: "运行状态" },
  { re: /\.state\.json$/, why: "运行状态" },
  { re: /(^|\/)auth\.json$/, why: "登录凭据" },
  { re: /\.token$|\.pem$|\.p12$/, why: "密钥/证书" },
  { re: /\.log$/, why: "日志" },
  { re: /\.bak$|~$/, why: "备份文件" },
  { re: /\.png$|\.jpe?g$/, why: "截图" },
];
for (const n of names) {
  for (const f of FORBIDDEN_IN_ZIP) {
    if (f.re.test(n)) problems.push(`禁入文件（${f.why}）：${n}`);
  }
}

if (manifest.id !== "notrat-workbuddy-pool") problems.push(`manifest.id 异常：${manifest.id}`);
if (missingRefs.length) problems.push(...missingRefs.map((m) => `清单引用的文件不在包里：${m}`));

/* ══════════════ 7. 报告 ══════════════ */

const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const kb = (n) => (n / 1024).toFixed(1) + "K";

console.log(`\n${manifest.name}  v${manifest.version}  →  dist/${ZIP_NAME}\n`);
console.log(pad("条目", 44) + pad("原始", 10) + pad("压缩后", 10) + "方式");
console.log("─".repeat(72));
for (const r of reread.length ? reread : entries.map((e) => ({ name: e.relPath, usize: e.buf.length, csize: e.buf.length, method: 0 }))) {
  console.log(pad(r.name, 44) + pad(kb(r.usize), 10) + pad(kb(r.csize), 10) + (r.method === 8 ? "deflate" : "store"));
}
console.log("─".repeat(72));
const rawTotal = entries.reduce((a, e) => a + e.buf.length, 0);
console.log(`${entries.length} 个文件 · 原始 ${kb(rawTotal)} · 压缩包 ${kb(zipBuf.length)} · sha256 ${zipSha.slice(0, 16)}…`);

const textProblems = textIssues.filter((t) => t.what.indexOf("U+FFFD") >= 0);
const secretProblems = textIssues.filter((t) => t.what.indexOf("U+FFFD") < 0);

if (secretProblems.length) {
  console.log("\n✗ 内容扫描（凭据/路径）：");
  secretProblems.forEach((t) => console.log(`   ${t.file} → ${t.what}`));
  problems.push(...secretProblems.map((t) => `${t.file}: ${t.what}`));
} else {
  console.log("\n✓ 内容扫描：无令牌样式、无本机绝对路径、无内嵌凭据");
}
if (textProblems.length) {
  console.log("\n✗ 编码检查：");
  textProblems.forEach((t) => console.log(`   ${t.file} → ${t.what}`));
  problems.push(...textProblems.map((t) => `${t.file}: ${t.what}`));
} else {
  console.log("✓ 编码检查：无 U+FFFD");
}

if (problems.length) {
  console.log(`\n✗ 打包未通过（${problems.length} 项）：`);
  problems.forEach((p) => console.log("   · " + p));
  process.exit(1);
}

console.log("✓ 结构：manifest.json 在根 / 条目数合规 / 无绝对路径与 ..");
console.log("✓ 清单：sourceFile 与 mcpServers 引用的文件全部在包内");
console.log("✓ 禁入：无状态文件、无凭据、无预览产物、无测试与开发脚本");
console.log("✓ 回读：解包回来与源文件逐字节一致（CRC 全部匹配）");
console.log(`\n✅ 可用于分发：dist/${ZIP_NAME}`);
console.log(`   sha256 同时写入 dist/${ZIP_NAME}.sha256`);
console.log(`   ⚠️ 分发时别改文件名 —— 解压出来的目录名必须等于 manifest.id`);
