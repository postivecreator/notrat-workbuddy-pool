/**
 * 一键接入的回归测试：writePoolProvider 只加/改本池那一条，别的服务商不动，
 * 写完会通知界面重读配置（notrat-settings-changed —— 应用内部就是靠它同步的）。
 */
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const { requireNotratRepo } = require("../scripts/_paths.cjs");

const HERE = __dirname;
const SRC = path.resolve(HERE, "../panels/pool.tsx");
const NOTRAT = requireNotratRepo("测试要借它的 esbuild");
const req = createRequire(path.join(NOTRAT, "package.json"));
const esbuild = req("esbuild");

/* ── 假 window：带一份已经有别的服务商的配置 ── */
const store = new Map();
let fired = [];
const otherProvider = {
  id: "zhipu-official",
  name: "智谱清言",
  type: "custom",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "keepme",
  model: "glm-4.6",
  models: [{ id: "glm-4.6", name: "glm-4.6", displayName: "GLM-4.6" }],
};
store.set(
  "notrat-ai-config",
  JSON.stringify({ currentProvider: "zhipu-official", currentModel: "glm-4.6", providers: [otherProvider] }),
);

globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent(ev) {
    fired.push(ev && ev.type);
    return true;
  },
};
globalThis.Event = class Event {
  constructor(type) {
    this.type = type;
  }
};

const src = fs.readFileSync(SRC, "utf8") + "\nexport { writePoolProvider };\n";
const out = esbuild.transformSync(src, { loader: "tsx", jsx: "transform", format: "cjs", target: "es2020" });
const compiled = path.join(HERE, "_v_onclick.cjs");
const REACT_DIR = path.join(NOTRAT, "node_modules/react");
fs.writeFileSync(compiled, "const React = require(" + JSON.stringify(REACT_DIR) + ");\n" + out.code, "utf8");
const mod = req(compiled);

const wiring = {
  ready: true,
  providerId: "notrat-workbuddy-pool",
  displayName: "积分池",
  baseUrl: "http://127.0.0.1:8130/v1",
  apiKey: "sk-loopback-1234abcd",
  models: ["glm-4.6", "glm-4.5-air"],
};

let bad = 0;
const check = (name, ok, extra) => {
  if (!ok) bad++;
  console.log("  [" + (ok ? "OK  " : "FAIL") + "] " + name + (ok || !extra ? "" : "  → " + extra));
};

/* ① 正常写入 */
const r1 = mod.writePoolProvider(wiring);
const cfg1 = JSON.parse(store.get("notrat-ai-config"));
const mine1 = cfg1.providers.find((p) => p.id === "notrat-workbuddy-pool");
check("① 写入成功", r1.ok === true, r1.text);
check("① 服务商落盘", !!mine1);
check("① 模型是 {id,name,displayName} 对象", !!mine1 && typeof mine1.models[0] === "object" && mine1.models[0].id === "glm-4.6");
check("① 地址是桥 + /v1", !!mine1 && mine1.baseUrl === "http://127.0.0.1:8130/v1");
check("① 口令写进去了", !!mine1 && mine1.apiKey === "sk-loopback-1234abcd");
check("① 原有服务商没被动", cfg1.providers.length === 2 && cfg1.providers[0].apiKey === "keepme");
check("① currentProvider 没被偷偷改", cfg1.currentProvider === "zhipu-official");
check("① 通知了界面", fired.indexOf("notrat-settings-changed") >= 0, String(fired));

/* ② 再点一次：更新而不是重复添加 */
const r2 = mod.writePoolProvider(wiring);
const cfg2 = JSON.parse(store.get("notrat-ai-config"));
check("② 第二次成功", r2.ok === true, r2.text);
check("② 没有重复条目", cfg2.providers.filter((p) => p.id === "notrat-workbuddy-pool").length === 1);
check("② 文案说「已更新」", r2.text.indexOf("已更新") === 0, r2.text);

/* ③ 引擎没起（wiring 未 ready） */
const r3 = mod.writePoolProvider({ ready: false, hint: "engine not started" });
check("③ 未就绪时不写", r3.ok === false && !!r3.text);

/* ④ 模型列表还没读到 */
const r4 = mod.writePoolProvider({ ...wiring, models: [] });
check("④ 无模型时不写", r4.ok === false && r4.text.indexOf("模型") >= 0, r4.text);

/* ⑤ 配置本身坏了：不碰它 */
store.set("notrat-ai-config", "{not json");
const before = store.get("notrat-ai-config");
const r5 = mod.writePoolProvider(wiring);
check("⑤ 坏 JSON 不写", r5.ok === false && store.get("notrat-ai-config") === before, r5.text);

/* ⑥ 全新安装：自己造一份最小可用配置，并设为当前（新人装完就能直接聊） */
store.delete("notrat-ai-config");
const r6 = mod.writePoolProvider(wiring);
check("⑥ 全新安装能接上", r6.ok === true, r6.text);
const cfg6 = store.has("notrat-ai-config") ? JSON.parse(store.get("notrat-ai-config")) : null;
check("⑥ 写出了 providers", cfg6 && Array.isArray(cfg6.providers) && cfg6.providers.length === 1, JSON.stringify(cfg6));
check("⑥ 只写了本池一条", cfg6 && cfg6.providers[0].id === "notrat-workbuddy-pool");
check("⑥ 已设为当前服务商", cfg6 && cfg6.currentProvider === "notrat-workbuddy-pool");
/* 不伪造别人家的默认服务商（claude / gpt / deepseek 那些应由应用自己补） */
check(
  "⑥ 不伪造其他服务商",
  cfg6 && cfg6.providers.every((p) => p.id === "notrat-workbuddy-pool"),
  JSON.stringify((cfg6 && cfg6.providers.map((p) => p.id)) || []),
);
check("⑥ 模型形状是对象而非字符串", cfg6 && cfg6.providers[0].models.every((m) => m && typeof m === "object" && m.id));

/* ⑦ 已有配置时不许悄悄切当前模型（老用户的选择必须保住） */
store.set(
  "notrat-ai-config",
  JSON.stringify({
    currentProvider: "zhipu",
    providers: [{ id: "zhipu", name: "智谱", baseUrl: "https://x", model: "glm-4.6", models: [] }],
  }),
);
const r7 = mod.writePoolProvider(wiring);
const cfg7 = JSON.parse(store.get("notrat-ai-config"));
check("⑦ 老用户能接上", r7.ok === true, r7.text);
check("⑦ 当前服务商没被改", cfg7.currentProvider === "zhipu", cfg7.currentProvider);
check("⑦ 原有服务商还在", cfg7.providers.some((p) => p.id === "zhipu"));
check("⑦ 文案不承诺切模型", r7.text.indexOf("不会替你切当前模型") >= 0, r7.text);

console.log("\n" + (bad ? "✗ 失败 " + bad + " 项" : "✓ 全部通过"));
try { fs.unlinkSync(compiled); } catch {}
process.exit(bad ? 1 : 0);
