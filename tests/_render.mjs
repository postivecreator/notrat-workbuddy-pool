/**
 * 面板渲染冒烟：用 react-dom/server 真渲染一遍，证明组件不会在首帧炸掉。
 * ===========================================================================
 * 覆盖：插件未启用 / 五个标签页各自的空数据首帧。字段名写错、可选链缺失、
 * 空数组上 .map 崩溃，这些都会在这里变成一条 FAIL。
 *
 * 不覆盖：交互（点按钮、轮询、剪贴板）—— 那要真宿主。
 *
 * 跑法：node tests/_render.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { requireNotratRepo } from "../scripts/_paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../panels/pool.tsx");
const NOTRAT = requireNotratRepo("测试要借它的 esbuild / react");
const req = createRequire(path.join(NOTRAT, "package.json"));

const esbuild = req("esbuild");
const REACT_DIR = path.join(NOTRAT, "node_modules/react");
const RDS_DIR = path.join(NOTRAT, "node_modules/react-dom/server");

// ── 最小浏览器替身（面板只在 effect / 回调里碰 DOM，SSR 不跑 effect） ──
globalThis.window = {
  electronAPI: {
    mcp: { callTool: () => Promise.resolve({ content: [{ type: "text", text: "{}" }] }) },
  },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { reload: () => {} },
};
globalThis.localStorage = globalThis.window.localStorage;

// ── 编译面板 → CJS，并在**同一模块作用域**注入 React（宿主就是这么干的） ──
const code = fs.readFileSync(SRC, "utf8");
const out = esbuild.transformSync(code, { loader: "tsx", jsx: "transform", format: "cjs", target: "es2020" });

const compiled = path.join(HERE, "_render_compiled.cjs");
fs.writeFileSync(compiled, `const React = require(${JSON.stringify(REACT_DIR)});\n` + out.code, "utf8");

const wrapper = path.join(HERE, "_render_wrapper.cjs");
fs.writeFileSync(
  wrapper,
  [
    `const React = require(${JSON.stringify(REACT_DIR)});`,
    `const { renderToStaticMarkup } = require(${JSON.stringify(RDS_DIR)});`,
    `const mod = require(${JSON.stringify(compiled)});`,
    `const Panel = mod.default || mod.PoolPanel;`,
    `module.exports = function render(props) {`,
    `  return renderToStaticMarkup(React.createElement(Panel, props));`,
    `};`,
  ].join("\n"),
  "utf8",
);

const { default: render } = await import(pathToFileURL(wrapper).href);

const SID = "plugin-notrat-workbuddy-pool-pool";
const cases = [
  ["无 serverId（插件未启用）", { serverId: "" }],
  ["账号页 · 空数据首帧", { serverId: SID, initialTab: "accounts" }],
  ["模型页 · 空数据首帧", { serverId: SID, initialTab: "models" }],
  ["请求页 · 空数据首帧", { serverId: SID, initialTab: "requests" }],
  ["接入页 · 未就绪", { serverId: SID, initialTab: "wire" }],
  ["设置页 · 空数据首帧", { serverId: SID, initialTab: "settings" }],
];

let failed = 0;
for (const [name, props] of cases) {
  try {
    const html = render(props);
    const ok = typeof html === "string" && html.length > 0;
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}  (${html.length} 字符)`);
    if (!ok) failed++;
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}`);
    console.log("         " + String((e && e.message) || e).split("\n").slice(0, 8).join("\n         "));
  }
}

for (const f of [compiled, wrapper]) {
  try {
    fs.unlinkSync(f);
  } catch {
    /* 已删 */
  }
}

console.log(`\n=== ${cases.length} 个场景，${failed === 0 ? "全部通过" : failed + " 个失败"} ===`);
process.exit(failed ? 1 : 0);
