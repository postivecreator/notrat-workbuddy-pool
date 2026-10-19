const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, requireNotratRepo } = require("../scripts/_paths.cjs");
const NOTRAT = requireNotratRepo("测试要借它的 esbuild");
const req = createRequire(path.join(NOTRAT, "package.json"));
const esbuild = req("esbuild");
const src = fs.readFileSync(path.join(ROOT, "panels", "pool.tsx"), "utf8");
try {
  const r = esbuild.transformSync(src, { loader: "tsx", jsx: "transform", format: "cjs", target: "es2020" });
  console.log("COMPILE OK, out chars:", r.code.length);
  const bad = [...src.matchAll(/\uFFFD/g)].length;
  console.log("U+FFFD count:", bad);
} catch (e) {
  console.log("COMPILE FAIL");
  console.log(String(e.message).split("\n").slice(0, 20).join("\n"));
  process.exit(1);
}
