// 直接渲染 SetupGuide 组件，验证「四个阶段各自只说一句话、只给一个主按钮」。
// 做法：从 pool.tsx 抽出 Kit（到 MONO_FAMILY 为止）+ SetupGuide 函数体，单独编译。
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, requireNotratRepo } = require("../scripts/_paths.cjs");
const NOTRAT = requireNotratRepo("测试要借它的 esbuild / react");
const req = createRequire(path.join(NOTRAT, "package.json"));
const esbuild = req("esbuild");
const React = req("react");
const { renderToStaticMarkup } = req("react-dom/server");

const src = fs.readFileSync(path.join(ROOT, "panels", "pool.tsx"), "utf8");

// 1) Kit 段：文件开头 → MONO_FAMILY 声明那行
const kitEnd = src.indexOf("const MONO_FAMILY");
if (kitEnd < 0) throw new Error("kit end not found");
let kit = src.slice(0, kitEnd);
// 把 fmtInt 等工具函数从主文件里抠出来（它们在 Kit 段之后）
const fmtStart = src.indexOf("function fmtInt(n) {");
const fmtEnd = src.indexOf("function fmtAgo(ts) {");
if (fmtStart > 0 && fmtEnd > fmtStart) kit += "\n" + src.slice(fmtStart, fmtEnd);

// 2) SetupGuide 段
const gStart = src.indexOf("function SetupGuide(props) {");
const gEnd = src.indexOf("/* ═══════════════════════════════ 账号卡");
if (gStart < 0 || gEnd < 0) throw new Error("guide not found");
const guide = src.slice(gStart, gEnd);

// 3) fmtInt / TR 等已在 kit 里；补 MONO_FAMILY
const mod = kit + '\nconst MONO_FAMILY = "monospace";\n' + guide + "\nexport default SetupGuide;\n";

const out = esbuild.transformSync(mod, { loader: "tsx", jsx: "transform", format: "cjs", target: "es2020" }).code;
const m = { exports: {} };
const fakeDoc = { getElementById: () => null, createElement: () => ({ setAttribute() {}, style: {}, textContent: "" }), head: { appendChild() {} }, addEventListener() {}, removeEventListener() {} };
const fn = new Function("React", "module", "exports", "window", "document", out);
fn(React, m, m.exports, {}, fakeDoc);
const Guide = m.exports.default;

const fail = [];
function run(name, props) {
  const html = renderToStaticMarkup(React.createElement(Guide, Object.assign({ busy: false, onStart() {}, onRescan() {}, onGoto() {} }, props)));
  const txt = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "\n").split("\n").map((x) => x.trim()).filter(Boolean);
  const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((x) => x[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean);
  console.log("\n════ " + name);
  console.log("  文字：" + txt.join(" · "));
  console.log("  按钮：" + buttons.join(" / "));
  return { txt, buttons, html };
}

// ① 全新
const s1 = run("① 全新安装（什么都没做）", { started: false, accountCount: 0, creditTotal: 0, wired: false, used: false });
if (s1.txt.join("").indexOf("先把它打开") < 0) fail.push("① 没说清第一步");
if (s1.buttons[0] !== "打开") fail.push("① 主按钮不是「打开」，而是 " + s1.buttons[0]);
if (s1.txt.length > 12) fail.push("① 首屏文字过多：" + s1.txt.length);

// ② 引擎起了，没账号
const s2 = run("② 引擎已启动，还没找到账号", { started: true, accountCount: 0, creditTotal: 0, wired: false, used: false });
if (s2.txt.join("").indexOf("找到你的账号") < 0) fail.push("② 没进到第二步");
if (s2.buttons[0] !== "找账号") fail.push("② 主按钮不是「找账号」");

// ③ 有号，没接入
const s3 = run("③ 找到 2 个号（12480 积分），还没接入", { started: true, accountCount: 2, creditTotal: 12480, wired: false, used: false });
if (s3.txt.join("").indexOf("让 Notrat 用上它") < 0) fail.push("③ 没进到第三步");
if (s3.buttons[0] !== "一键接上") fail.push("③ 主按钮不是「一键接上」，而是 " + s3.buttons[0]);
if (s3.buttons.length !== 3) fail.push("③ 应该只有「一键接上」+ 手动退路 + 看全部，实际 " + s3.buttons.length + " 个按钮");
if ((s3.buttons[1] || "").indexOf("自己填") < 0) fail.push("③ 手动退路丢了：" + s3.buttons[1]);
// 积分总数在简单视图的 Stat 行里（不在引导卡内），这里只断言引导卡进了第三步

// ④ 接好了，没用过
const s4 = run("④ 接好了，还没发过消息", { started: true, accountCount: 2, creditTotal: 12480, wired: true, used: false });
if (s4.txt.join("").indexOf("开始聊天") < 0) fail.push("④ 没进到第四步");

// ⑤ 全绿
const s5 = run("⑤ 全部完成", { started: true, accountCount: 2, creditTotal: 12480, wired: true, used: true });
if (s5.txt.join("").indexOf("已接好") < 0) fail.push("⑤ 全绿没收成一行");
if (s5.html.indexOf("<button") >= 0) fail.push("⑤ 全绿后不该还有按钮");

// ⑥ compact（高级视图里）
const s6 = run("⑥ 高级视图里（compact）", { started: true, accountCount: 0, creditTotal: 0, wired: false, used: false, compact: true });
if (s6.buttons.length !== 1) fail.push("⑥ compact 应该只有一个按钮");

console.log("\n" + (fail.length ? "✗ 失败：\n  " + fail.join("\n  ") : "✓ 全部通过"));
process.exit(fail.length ? 1 : 0);
