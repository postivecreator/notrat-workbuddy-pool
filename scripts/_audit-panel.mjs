// 面板成品静态体检：旧组件/旧色残留、未定义引用、emoji 图标
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./_paths.mjs";
import path from "node:path";
import { ROOT } from "./_paths.mjs";

const P = path.join(ROOT, "panels", "pool.tsx");
const src = readFileSync(P, "utf8");
const lines = src.split(/\r?\n/);

const stale = ["C.danger", "C.ok", "C.warn", "C.fg", "C.muted", "C.border", "C.card", "C.soft", "C.primary",
  "function Badge(", "function Kpi(", "function Row(", "function ReserveBox(props) {", "wbp-tab", "wbp-row", "wbp-scroll"];
console.log("· 旧设计系统残留：");
let found = 0;
stale.forEach((k) => {
  const hits = lines.map((l, i) => [i + 1, l]).filter(([, l]) => l.indexOf(k) >= 0);
  if (hits.length) {
    found++;
    console.log("   " + k + " ×" + hits.length + "  →  行 " + hits.slice(0, 4).map((h) => h[0]).join(","));
  }
});
if (!found) console.log("   无");

const must = ["function usePanelFill", "function Icon", "function Btn", "function Pill", "function Card",
  "function Field", "function Inp", "function Sel", "function Segmented", "function Empty", "function Banner",
  "function Stat", "const PAGE_ROOT", "const T =", "const FONT", "const MONO_FAMILY", "function PoolPanel",
  "export default PoolPanel"];
console.log("\n· 依赖定义：");
must.forEach((k) => console.log("   " + (src.indexOf(k) >= 0 ? "✓" : "✗") + " " + k));

// 用到的组件是否都有定义
const used = new Set();
[...src.matchAll(/<([A-Z][A-Za-z]*)/g)].forEach((m) => used.add(m[1]));
const missing = [...used].filter((n) => src.indexOf("function " + n + "(") < 0 && src.indexOf("const " + n + " =") < 0);
console.log("\n· JSX 用到但未定义的组件：" + (missing.join(", ") || "无"));

// Icon n="xxx" 是否都在 ICON 表里
const iconKeys = new Set([...src.matchAll(/^  ([a-zA-Z]+): </gm)].map((m) => m[1]));
const iconUsed = [...new Set([...src.matchAll(/\bn="([a-zA-Z]+)"/g)].map((m) => m[1]))];
console.log("· Icon 用到的键：" + iconUsed.join(", "));
console.log("· ICON 表缺失：" + (iconUsed.filter((k) => !iconKeys.has(k)).join(", ") || "无"));

const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
const emojiLines = lines.map((l, i) => [i + 1, l]).filter(([, l]) => emoji.test(l));
console.log("\n· emoji 当图标残留：" + (emojiLines.length ? emojiLines.map((e) => e[0]).join(",") : "无"));

const hard = [...new Set([...src.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]))];
console.log("· 硬编码十六进制色值：" + (hard.join(" ") || "无"));
console.log("\n· 总行数 " + lines.length + " · " + (Buffer.byteLength(src, "utf8") / 1024).toFixed(1) + " KB");
