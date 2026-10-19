// 组装 notrat-workbuddy-pool 面板：把 Notrat Panel Kit v3 注入 _body.tsx → pool.tsx
//   用法：node scripts/assemble-panel.mjs [--write]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { findNotratRepo } from "./_paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(here, "..");
const KIT_PATH = process.env.NRX_KIT || join(PLUGIN, "..", ".notrat", "ui-kit", "nrx-kit.tsx");
const BODY = join(PLUGIN, "panels", "_body.tsx");
const OUT = join(PLUGIN, "panels", "pool.tsx");

if (!existsSync(KIT_PATH)) {
  console.error("✗ 找不到 Panel Kit：" + KIT_PATH);
  process.exit(1);
}
if (!existsSync(BODY)) {
  console.error("✗ 找不到面板主体：" + BODY);
  process.exit(1);
}

const KIT = readFileSync(KIT_PATH, "utf8").trimEnd();
let code = readFileSync(BODY, "utf8");
const hits = code.split("//__NRX_KIT__").length - 1;
if (hits !== 1) {
  console.error("✗ 占位符 //__NRX_KIT__ 必须只出现一次（当前 " + hits + "）");
  process.exit(1);
}
code = code.replace("//__NRX_KIT__", KIT);

const NOTRAT_REPO = findNotratRepo();
if (!NOTRAT_REPO) {
  console.error("✗ 找不到 Notrat 源码（装配面板要借它的 esbuild）。");
  console.error('  设 NOTRAT_REPO 指过去，例如 $env:NOTRAT_REPO="C:\\path\\to\\Notrat"');
  process.exit(1);
}
const req = createRequire(join(NOTRAT_REPO, "package.json"));
let esbuild;
try {
  esbuild = req("esbuild");
} catch (e) {
  console.error("✗ 找不到 esbuild：" + e.message);
  process.exit(1);
}

try {
  esbuild.transformSync(code, { loader: "tsx", jsx: "transform", format: "cjs", target: "es2020" });
} catch (e) {
  console.error("✗ 编译失败，未落盘：");
  console.error(String(e && e.message).split("\n").slice(0, 18).join("\n"));
  process.exit(1);
}

if (process.argv.includes("--write")) {
  writeFileSync(OUT, code, "utf8");
  console.log("✓ 已写入 " + OUT + "（" + (Buffer.byteLength(code, "utf8") / 1024).toFixed(1) + " KB）");
} else {
  console.log("✓ 编译通过（dry-run，加 --write 才落盘）");
}
