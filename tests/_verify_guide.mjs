/**
 * 验证引导的「简单视图 / 高级视图 / 全绿」三种形态，以及空数据不再出现一排 0 或一排「—」。
 *
 * 2026-10-17 改版：面板默认进「简单视图」——整页只说下一步、只给一个主按钮；
 * 五个标签页收进「更多设置」。所以这里的断言跟着改成「简单视图不出现标签页」。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { requireNotratRepo } from "../scripts/_paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../panels/pool.tsx");
const NOTRAT = requireNotratRepo("测试要借它的 esbuild / react");
const req = createRequire(path.join(NOTRAT, "package.json"));
const React = req("react");
const esbuild = req("esbuild");
const REACT_DIR = path.join(NOTRAT, "node_modules/react");
const RDS_DIR = path.join(NOTRAT, "node_modules/react-dom/server");

globalThis.window = {
  electronAPI: { mcp: { callTool: () => Promise.resolve({ content: [{ type: "text", text: "{}" }] }) } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { reload: () => {} },
};
globalThis.localStorage = globalThis.window.localStorage;

// 额外导出 SetupGuide，好直接喂「全绿」状态（SSR 跑不到 effect，主面板拿不到真数据）
const src = fs.readFileSync(SRC, "utf8") + "\nexport { SetupGuide };\n";
const out = esbuild.transformSync(src, { loader: "tsx", jsx: "transform", format: "cjs", target: "es2020" });
const compiled = path.join(HERE, "_v_compiled.cjs");
fs.writeFileSync(compiled, `const React = require(${JSON.stringify(REACT_DIR)});\n` + out.code, "utf8");

const { renderToStaticMarkup } = req(RDS_DIR);
const mod = req(compiled);
const Panel = mod.default || mod.PoolPanel;
const render = (p) => renderToStaticMarkup(React.createElement(Panel, p));
const SID = "plugin-notrat-workbuddy-pool-pool";

let bad = 0;
const check = (name, ok) => {
  if (!ok) bad++;
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${name}`);
};

/* ── 简单视图（默认）：只看到「下一步 + 一个按钮」，没有标签页 ── */
const simple = render({ serverId: SID });
check("简单视图 · 有第一步「先把它打开」", simple.includes("先把它打开"));
check("简单视图 · 有一个主按钮", simple.includes(">打开<") || simple.includes("打开</button>"));
check("简单视图 · 不出现五个标签页", !simple.includes(">模型<") && !simple.includes(">设置<") && !simple.includes(">请求<"));
check("简单视图 · 不出现一行 4 个 0", !simple.includes("可用账号"));
check("简单视图 · 不出现裸统计行", !simple.includes("共 0 号"));
check("简单视图 · 有「看全部 4 步」入口", simple.includes("看全部 4 步"));
check("简单视图 · 有「更多设置」入口", simple.includes("更多设置"));
check("简单视图 · 有区域切换的日常说法", simple.includes("我的是国际版") || simple.includes("我的是国内版"));

/* ── 高级视图：五个标签页都在，且引导收成一行 ── */
const adv = render({ serverId: SID, initialAdvanced: true });
for (const t of ["账号", "模型", "请求", "接入", "设置"]) {
  check(`高级视图 · 有「${t}」标签`, adv.includes(">" + t + "<") || adv.includes(">" + t + " "));
}
check("高级视图 · 引导收成一行", adv.includes("点这里回到「账号」页") && !adv.includes("看全部 4 步"));
check("高级视图 · 有「简单视图」回退", adv.includes("简单视图"));
check("高级视图 · 标签不显示 0 计数", !adv.includes("账号 0") && !adv.includes("模型 0"));

/* ── 设置页：空用量卡不出现 ── */
const set = render({ serverId: SID, initialAdvanced: true, initialTab: "settings" });
check("设置页 · 空用量卡不出现", !set.includes("由本插件累积观测"));
check("设置页 · 有「默认值就够用」提示", set.includes("默认值就够用"));

/* ── 全绿形态：只说「已接好」 ── */
const doneProps = { started: true, accountCount: 3, creditTotal: 12480, wired: true, used: true, busy: "", onStart() {}, onRescan() {}, onGoto() {} };
const doneOpen = renderToStaticMarkup(React.createElement(mod.SetupGuide, doneProps));
const doneCompact = renderToStaticMarkup(React.createElement(mod.SetupGuide, { ...doneProps, compact: true }));
check("全绿 · 展开页说「已接好」", doneOpen.includes("已接好") && !doneOpen.includes("看全部 4 步"));
check("全绿 · compact 页也说「已接好」", doneCompact.includes("已接好"));
check("全绿 · 不出现「还差 0 步」", !doneOpen.includes("还差 0 步") && !doneCompact.includes("还差 0 步"));

/* ── 部分完成：只说当前一步 ── */
const half = renderToStaticMarkup(React.createElement(mod.SetupGuide, { ...doneProps, started: false, wired: false, used: false }));
check("部分完成 · 当前步是「先把它打开」", half.includes("先把它打开"));
check("部分完成 · 只给一个主按钮", (half.match(/<button/g) || []).length <= 2);
// SSR 会把 {a}/{b} 渲染成 0<!-- -->/<!-- -->4，所以先把注释去掉再比
check("部分完成 · 进度报 1/4（账号已找到，引擎没起）", half.replace(/<!--[\s\S]*?-->/g, "").includes("1/4"));

try { fs.unlinkSync(compiled); } catch {}
console.log(bad ? `\n${bad} 项不符` : "\n全部符合预期");
process.exit(bad ? 1 : 0);
