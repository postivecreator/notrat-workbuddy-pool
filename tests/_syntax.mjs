/**
 * 语法自检 —— 每个 server 侧模块都得能真的被 import
 * =================================================
 * 起因：一个把 ASCII 直引号写进中文描述里的错误，让 MCP server 起不来，
 * 而冒烟测试只报"initialize 超时"——离真正的原因（一个 SyntaxError）隔了三层。
 * 所以这里做最笨也最有效的事：逐个 import，看谁抛。
 *
 * 不走 `node --check`：它不认 ESM 的 import.meta / 顶层 await。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "../server");

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) files.push(full);
  }
})(SERVER);

const lines = [];
let failures = 0;

// vendor/rotakit.js 体量 540KB，import 一次要几百毫秒，但值得——它是最该被验证的那个
for (const file of files.sort()) {
  const rel = path.relative(SERVER, file).replace(/\\/g, "/");
  const started = Date.now();
  try {
    await import(`${pathToFileURL(file).href}?syntaxcheck=${Date.now()}`);
    lines.push(`  [PASS] ${rel}  (${Date.now() - started}ms)`);
  } catch (err) {
    failures += 1;
    lines.push(`  [FAIL] ${rel}`);
    lines.push(`         ${String(err?.message ?? err).split("\n")[0]}`);
    const frame = String(err?.stack ?? "")
      .split("\n")
      .find((l) => l.includes(rel.replace("/", path.sep)) || l.includes(rel));
    if (frame) lines.push(`         ${frame.trim()}`);
  }
}

lines.push("");
lines.push(`=== ${files.length} 个模块，${failures === 0 ? "全部通过" : `${failures} 个失败`} ===`);

const out = lines.join("\n");
console.log(out);
fs.writeFileSync(path.join(HERE, "_syntax_out.txt"), out, "utf8");
process.exit(failures === 0 ? 0 : 1);
