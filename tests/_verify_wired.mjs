/**
 * 验证 readWired：本机配置里有本池的服务商时，引导的第 3 步该变绿。
 * 用桩 localStorage 喂三种形状：没有 / 有但 providerId 对不上 / 对得上。
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

let store = null;
globalThis.window = {
  electronAPI: { mcp: { callTool: () => Promise.resolve({ content: [{ type: "text", text: "{}" }] }) } },
  localStorage: {
    getItem: (k) => (k === "notrat-ai-config" ? store : null),
    setItem: () => {},
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { reload: () => {} },
};
globalThis.localStorage = globalThis.window.localStorage;

const src = fs.readFileSync(SRC, "utf8") + "\nexport { readWired };\n";
const out = esbuild.transformSync(src, { loader: "tsx", jsx: "transform", format: "cjs", target: "es2020" });
const compiled = path.join(HERE, "_v_wired.cjs");
fs.writeFileSync(compiled, `const React = require(${JSON.stringify(REACT_DIR)});\n` + out.code, "utf8");
const mod = req(compiled);

let bad = 0;
const check = (name, ok) => {
  if (!ok) bad++;
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${name}`);
};

// 1. 没有配置
store = null;
check("无配置 → 未接入", mod.readWired("notrat-workbuddy-pool") === false);

// 2. 有配置但只有别的服务商
store = JSON.stringify({ providers: [{ id: "openai", baseUrl: "https://api.openai.com/v1" }] });
check("只有别的服务商 → 未接入", mod.readWired("notrat-workbuddy-pool") === false);

// 3. 有本池服务商（providerId 已知）
store = JSON.stringify({
  providers: [{ id: "notrat-workbuddy-pool", baseUrl: "http://127.0.0.1:8130/v1" }],
});
check("有本池服务商 → 已接入", mod.readWired("notrat-workbuddy-pool") === true);

// 4. wiring 还没回来（providerId 未知）→ 按端口兜底
check("providerId 未知 → 按 8130 端口认出来", mod.readWired(undefined) === true);

// 5. 坏 JSON 不该抛
store = "{不是 json";
let threw = false;
try { mod.readWired("notrat-workbuddy-pool"); } catch (e) { threw = true; }
check("坏 JSON 不抛异常", !threw);

// 6. 配置形状不对（providers 不是数组）
store = JSON.stringify({ providers: "oops" });
check("形状不对 → 未接入", mod.readWired("notrat-workbuddy-pool") === false);

try { fs.unlinkSync(compiled); } catch {}
console.log(bad ? `\n${bad} 项不符` : "\n全部符合预期");
process.exit(bad ? 1 : 0);
