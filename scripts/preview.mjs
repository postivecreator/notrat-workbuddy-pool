/**
 * 构建预览：esbuild 打包真 React 面板 → 按宿主实测尺寸铺画框 → 套宿主真实主题 token
 *   node scripts/preview.mjs           → preview/out/preview-<theme>.html
 *   node scripts/preview.mjs --shot    → 再用 chromium headless 截图
 *
 * 主题 token 直接从 Notrat 的 src/styles/index.css 抽（只取 -- 变量声明），
 * 因此五套主题 × 浅/深都能验，不用手抄色值。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { requireNotratRepo, requireChrome } from "./_paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const NOTRAT = requireNotratRepo("预览要读 Notrat 的主题 CSS 与 esbuild");
const NM = path.join(NOTRAT, "node_modules");
const req = createRequire(path.join(NOTRAT, "package.json"));
const esbuild = req("esbuild");

const OUT_DIR = path.join(PLUGIN, "preview", "out");
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ── 1. 打包 ── */
await esbuild.build({
  entryPoints: [path.join(PLUGIN, "preview", "entry.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  jsx: "transform",
  alias: {
    react: path.join(NM, "react"),
    "react-dom/client": path.join(NM, "react-dom", "client.js"),
    "react-dom": path.join(NM, "react-dom"),
    scheduler: path.join(NM, "scheduler"),
  },
  outfile: path.join(OUT_DIR, "bundle.js"),
  logLevel: "silent",
});

/* ── 2. 从 index.css 抽主题 token（只取自定义属性，避免带上全局样式） ── */
const css = fs.readFileSync(path.join(NOTRAT, "src/styles/index.css"), "utf8");
const blocks = [];
const re = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = re.exec(css))) {
  const sel = m[1].trim().split("\n").pop().trim();
  const body = m[2];
  if (!body.includes("--")) continue;
  const vars = body
    .split(/;\s*\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("--"));
  if (vars.length) blocks.push({ sel, decls: vars.join(";") });
}
const pick = (test) => blocks.filter((b) => test(b.sel));

const base = pick((s) => s === ":root" || s === ":root:not(.dark)");
const darkBase = pick((s) => s === ":root.dark" || s === ".dark");
const themeLight = {};
const themeDark = {};
for (const b of blocks) {
  const mm = b.sel.match(/^:root\.theme-([a-z-]+):not\(\.dark\)$/);
  if (mm) (themeLight[mm[1]] = themeLight[mm[1]] || []).push(b);
  const md = b.sel.match(/^:root\.theme-([a-z-]+)\.dark$/);
  if (md) (themeDark[md[1]] = themeDark[md[1]] || []).push(b);
}

const declOf = (arr) => arr.map((b) => b.decls).join(";");
const cssFor = (theme, mode) => {
  const isDark = mode === "dark";
  const parts = [`html{${declOf(base)}}`];
  if (isDark) parts.push(`html.dark{${declOf(darkBase)}}`);
  if (themeLight[theme]) parts.push(`html.theme-${theme}{${declOf(themeLight[theme])}}`);
  if (isDark && themeDark[theme]) parts.push(`html.theme-${theme}.dark{${declOf(themeDark[theme])}}`);
  return parts.join("\n");
};

/* ── 3. 生成 4 套主题的预览页（极简浅/深 + 日落橙深 + 樱花浅） ── */
const THEMES = [
  ["minimalist", "light"],
  ["minimalist", "dark"],
  ["sunset", "dark"],
  ["sakura", "light"],
];

const page = (theme, mode) => {
  const cls = "theme-" + theme + (mode === "dark" ? " dark" : "");
  return `<!doctype html>
<html lang="zh-CN" class="${cls}">
<head>
<meta charset="utf-8">
<title>积分池面板 · ${cls}</title>
<style>
  ${cssFor(theme, mode)}
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    background: ${mode === "dark" ? "hsl(var(--sidebar-background))" : "hsl(var(--muted))"};
    color: hsl(var(--foreground));
    font: 13px/1.6 ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  details > summary { list-style: none; }
  details > summary::-webkit-details-marker { display: none; }
</style>
</head>
<body><div id="root"></div><script src="./bundle.js"></script></body>
</html>`;
};

const written = [];
for (const [theme, mode] of THEMES) {
  const name = "preview-" + theme + "-" + mode + ".html";
  fs.writeFileSync(path.join(OUT_DIR, name), page(theme, mode), "utf8");
  written.push(name);
}
console.log("✓ " + written.map((n) => "preview/out/" + n).join("\n✓ "));

/* ── 4. 截图 ── */
if (process.argv.includes("--shot")) {
  const CHROME = requireChrome("截图");
  for (const [theme, mode] of THEMES) {
    const file = path.join(OUT_DIR, "shot-" + theme + "-" + mode + ".png");
    const url = "file:///" + path.join(OUT_DIR, "preview-" + theme + "-" + mode + ".html").replace(/\\/g, "/");
    execFileSync(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--allow-file-access-from-files",
        "--force-device-scale-factor=1.5",
        "--window-size=1500,1900",
        "--screenshot=" + file,
        "--virtual-time-budget=3000",
        url,
      ],
      { stdio: "pipe" },
    );
    console.log("✓ " + file);
  }
}
