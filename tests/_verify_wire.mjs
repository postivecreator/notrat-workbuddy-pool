/**
 * 接入页真数据验证：给 WirePanel 喂一份 wiring，看三步是否真的排成 1/2/3，
 * 技术解释是否收进 <details>，备选写入卡是否降到下面且默认收起。
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

// 额外把内部组件导出，便于直接喂数据
const src = fs.readFileSync(SRC, "utf8") + "\nexport { WirePanel };\n";
const out = esbuild.transformSync(src, { loader: "tsx", jsx: "transform", format: "cjs", target: "es2020" });
const compiled = path.join(HERE, "_v_wire.cjs");
fs.writeFileSync(compiled, `const React = require(${JSON.stringify(REACT_DIR)});\n` + out.code, "utf8");

const { renderToStaticMarkup } = req(RDS_DIR);
const mod = req(compiled);

const wiring = {
  ready: true,
  providerId: "notrat-workbuddy-pool",
  displayName: "积分池",
  baseUrl: "http://127.0.0.1:8130/v1",
  apiKey: "sk-loopback-1234abcd",
  models: ["glm-4.6", "glm-4.5-air"],
};

const html = renderToStaticMarkup(
  React.createElement(mod.WirePanel, {
    wiring,
    models: wiring.models.map((id) => ({ id })),
    onReload: () => {},
    setNote: () => {},
  }),
);

let bad = 0;
const check = (name, ok) => {
  if (!ok) bad++;
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${name}`);
};

const text = html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

check("手动卡标题说清要做什么", html.includes("把这三样贴进 Notrat"));
check("三步有序号", html.includes("1 地址") && html.includes("2 密码") && html.includes("3 模型名"));
check("地址已带 /v1", html.includes("127.0.0.1:8130/v1"));
check("口令默认遮住", html.includes("••••••••"));
check("补了「选模型」这一步", html.includes("点上面的模型名") && html.includes("积分池"));
check("技术解释收进 details", /<details[^>]*>[\s\S]*8120[\s\S]*<\/details>/.test(html));
check("一键写入排在最前", html.indexOf("一键写进 Notrat") >= 0 && html.indexOf("一键写进 Notrat") < html.indexOf("把这三样"));
check("一键按钮文案", html.includes("一键接上"));
check("没有把 shim 解释直接铺在正文", !/^\|[\s\S]{0,200}shim 只放行/.test(text));

console.log("\n—— 可见文案 ——");
console.log(text.slice(0, 900));
try { fs.unlinkSync(compiled); } catch {}
process.exit(bad ? 1 : 0);
