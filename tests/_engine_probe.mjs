/**
 * 引擎实跑探针 —— 在本机真实启动，报告它看到了什么
 * =================================================
 * 不做断言（那是 _engine_test.mjs 的事），这里只负责把真实情况打印出来：
 *   - shim 有没有拿到端口
 *   - 账号发现找到了几个号（读的是本机桌面端登录快照）
 *   - 模型目录拉到了什么
 *   - poolWebStatus 的文档形状（面板要照着渲染）
 *   - 状态文件到底落在哪（验证没有漏到 ~/.dsh 或 D:\ ）
 */
import fs from "node:fs";
import path from "node:path";
import { WorkBuddyEngine } from "../server/engine.js";
import { paths, envBootstrap } from "../server/env.js";

const lines = [];
const say = (...a) => {
  const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2))).join(" ");
  lines.push(s);
  console.log(s);
};

const logger = {
  info: (m) => say("  [info]", String(m)),
  warn: (m) => say("  [warn]", String(m)),
  error: (m) => say("  [error]", String(m)),
};

function shape(value, depth = 0, maxDepth = 3) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (depth >= maxDepth) return `[${value.length} items]`;
    return `[${shape(value[0], depth + 1, maxDepth)}${value.length > 1 ? `, …${value.length}` : ""}]`;
  }
  if (typeof value === "object") {
    if (depth >= maxDepth) return "{…}";
    const keys = Object.keys(value);
    return `{ ${keys.slice(0, 24).map((k) => `${k}: ${shape(value[k], depth + 1, maxDepth)}`).join(", ")} }`;
  }
  if (typeof value === "string") return `"${value.length > 60 ? `${value.slice(0, 60)}…` : value}"`;
  return String(value);
}

const engine = new WorkBuddyEngine({ logger });

try {
  say("=== 环境引导 ===");
  say(shape(envBootstrap));

  say(`\n=== 数据目录 ===`);
  say(`  dataDir    ${paths.dataDir}`);
  say(`  stateDir   ${paths.stateDir}`);
  say(`  configFile ${paths.configFile}`);
  say(`  reqLog     ${process.env.ROTAKIT_REQUEST_LOG ?? "(disabled)"}`);

  say("\n=== 启动引擎 ===");
  const info = await engine.start();
  say(shape(info));

  say("\n=== 账号（本机桌面端登录快照）===");
  say(`  cn     ${engine.accounts("cn").length} 个`);
  say(`  global ${engine.accounts("global").length} 个`);
  for (const region of ["cn", "global"]) {
    for (const a of engine.accounts(region).slice(0, 8)) {
      const s = engine.toAccountSummary(a);
      say(`  [${region}] ${s.label ?? "(no label)"}  nick=${s.nickname ?? "-"}  domain=${s.domain ?? "-"}`);
    }
  }

  say("\n=== 模型目录 ===");
  for (const region of ["cn", "global"]) {
    let models = engine.models(region);
    say(`  [${region}] visible=${models.length}  total=${engine.models(region, { visibleOnly: false }).length}`);
    for (const m of models.slice(0, 10)) {
      say(`    - ${m.id}  mult=${m.multiplier ?? "-"}  ctx=${m.contextWindow ?? "-"}  image=${m.supportsImages ?? m.image ?? "-"}`);
    }
  }

  say("\n=== 一键接入信息（Notrat 自定义服务商）===");
  for (const region of ["cn", "global"]) {
    const w = engine.providerWiring(region);
    say(`  [${region}] ${shape({ ...w, apiKey: w.apiKey ? `"${String(w.apiKey).slice(0, 8)}…（已脱敏）"` : w.apiKey })}`);
  }

  say("\n=== poolWebStatus 文档形状（面板主数据源）===");
  for (const region of ["cn", "global"]) {
    try {
      const st = await engine.status(region);
      say(`  [${region}] ${shape(st, 0, 2)}`);
      if (st?.accounts?.length) say(`  [${region}] account row: ${shape(st.accounts[0], 0, 2)}`);
      if (st?.models?.length) say(`  [${region}] model row  : ${shape(st.models[0], 0, 2)}`);
    } catch (err) {
      say(`  [${region}] status() failed: ${err?.message ?? err}`);
    }
  }

  say("\n=== 可观测性 ===");
  say(`  requests  ${engine.requestLog().items.length} 条  file=${engine.requestLog().file ?? "-"}`);
  say(`  probes    ${engine.probeStats().length} 条`);
  say(`  queueStats ${engine.queueStatistics().length} 条`);
  say(`  automation ${shape(engine.automationStatus(), 0, 2)}`);

  say("\n=== 状态文件落点（验证未越界）===");
  for (const dir of [paths.dataDir, paths.stateDir]) {
    say(`  ${dir}`);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { recursive: true }).map(String);
    } catch (err) {
      entries = [`(unreadable: ${err.message})`];
    }
    for (const e of entries.slice(0, 30)) say(`    ${e}`);
  }
  const legacy = path.join(process.env.USERPROFILE ?? "", ".dsh", ".workbuddy-xdpool");
  say(`  legacy ~/.dsh/.workbuddy-xdpool exists: ${fs.existsSync(legacy)}`);
  say(`  legacy D:\\dsh-rotakit exists: ${fs.existsSync(path.join("D:", "dsh-rotakit"))}`);
} catch (err) {
  say(`\n!! 引擎启动失败: ${err?.stack ?? err}`);
} finally {
  try {
    await engine.stop();
    say("\n=== 已停止 ===");
  } catch (err) {
    say(`stop() failed: ${err?.message ?? err}`);
  }
  fs.writeFileSync(new URL("./_engine_probe_out.txt", import.meta.url), lines.join("\n"), "utf8");
}
