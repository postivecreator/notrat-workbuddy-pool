/**
 * MCP 冒烟测试 —— 真的走 stdio JSON-RPC
 * ====================================
 * 起一个真的子进程，按协议握手，然后调关键工具。断言的是**协议层**能通，
 * 不是业务逻辑（那是 _engine_probe.mjs 的事）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "../server/index.js");

const OUT = path.join(HERE, "_smoke_out.txt");
const lines = [];
let failures = 0;
// 实时落盘：跑挂或被超时打断时也要能看到进度到哪一步
const say = (s) => {
  lines.push(s);
  console.log(s);
  try {
    fs.writeFileSync(OUT, lines.join("\n"), "utf8");
  } catch {
    /* 落盘失败不该影响测试 */
  }
};
function check(label, condition, detail) {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  say(`  [${mark}] ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });

let stderr = "";
child.stderr.on("data", (d) => {
  stderr += d.toString();
});

const pending = new Map();
let nextId = 1;
let buffer = "";
child.stdout.on("data", (d) => {
  buffer += d.toString();
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      say(`  !! 非 JSON 输出（会污染协议）: ${line.slice(0, 120)}`);
      failures += 1;
      continue;
    }
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    }
  }
});

function rpc(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

/** 取 tools/call 的文本载荷并解析回对象。 */
function payloadOf(msg) {
  const text = msg?.result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

try {
  say("=== 1. initialize ===");
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  check("initialize 有 result", !!init.result, JSON.stringify(init.result?.serverInfo ?? init.error));
  check("声明了 tools 能力", !!init.result?.capabilities?.tools);

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  say("\n=== 2. tools/list ===");
  const list = await rpc("tools/list", {});
  const tools = list.result?.tools ?? [];
  check("工具数 > 10", tools.length > 10, `${tools.length} 个`);
  const names = tools.map((t) => t.name);
  const expected = [
    "wb_engine",
    "wb_wiring",
    "wb_status",
    "wb_accounts",
    "wb_models",
    "wb_rescan",
    "wb_config_get",
    "wb_config_set",
    "wb_toggle_account",
    "wb_set_reserve",
    "wb_reset_cooldowns",
    "wb_automation",
    "wb_requests",
    "wb_performance",
    "wb_doctor",
  ];
  const missing = expected.filter((n) => !names.includes(n));
  check("关键工具齐全", missing.length === 0, missing.length ? `缺 ${missing.join(", ")}` : `${expected.length} 个全在`);
  check(
    "每个工具都有 inputSchema",
    tools.every((t) => t.inputSchema && t.inputSchema.type === "object"),
  );
  say(`  工具: ${names.join(", ")}`);

  say("\n=== 3. wb_doctor（环境自检）===");
  const doc = await rpc("tools/call", { name: "wb_doctor", arguments: {} });
  const docData = payloadOf(doc);
  check("wb_doctor 返回对象", docData && typeof docData === "object", doc.result?.isError ? "isError" : "");
  check(
    "状态隔离判定为 clean",
    docData?.stateIsolation?.verdict?.startsWith("clean"),
    docData?.stateIsolation?.verdict,
  );
  check(
    "legacy 路径（~/.dsh、D:\\dsh-rotakit、~/.wb-switch）均未被创建",
    (docData?.stateIsolation?.legacyPathsPresentOnDisk ?? []).length === 0,
    JSON.stringify(docData?.stateIsolation?.legacyPathsPresentOnDisk),
  );
  check("读到了上游 vendor 元数据", !!docData?.vendoredUpstream?.package, docData?.vendoredUpstream?.package);
  say(`  数据目录: ${docData?.stateIsolation?.dataDir}`);
  say(`  状态文件: ${(docData?.stateIsolation?.stateFiles ?? []).join(", ")}`);

  say("\n=== 4. wb_engine info（会触发自动启动）===");
  const eng = await rpc("tools/call", { name: "wb_engine", arguments: { action: "info" } }, 120_000);
  const engData = payloadOf(eng);
  check("引擎已启动", engData?.started === true, `started=${engData?.started} err=${engData?.lastStartError ?? "-"}`);
  check("cn shim 在 8120", engData?.shims?.cn?.baseUrl === "http://127.0.0.1:8120", engData?.shims?.cn?.baseUrl);
  check("global shim 在 8121", engData?.shims?.global?.baseUrl === "http://127.0.0.1:8121", engData?.shims?.global?.baseUrl);
  check("cn 桥在 8130", engData?.bridges?.cn?.baseUrl === "http://127.0.0.1:8130", engData?.bridges?.cn?.baseUrl);
  check(
    "global 桥在 8131",
    engData?.bridges?.global?.baseUrl === "http://127.0.0.1:8131",
    engData?.bridges?.global?.baseUrl,
  );
  say(`  账号: cn=${engData?.accounts?.cn} global=${engData?.accounts?.global}`);
  say(`  模型: cn=${engData?.models?.cn} global=${engData?.models?.global}`);

  say("\n=== 5. wb_wiring（一键接入）===");
  const wiring = payloadOf(await rpc("tools/call", { name: "wb_wiring", arguments: { region: "cn" } }, 120_000));
  check("wiring ready", wiring?.ready === true);
  // baseUrl 必须**带 /v1**。
  //
  // 先前这里断言的是桥根 `http://127.0.0.1:8130` —— 等于把错的形状钉成了"正确"，
  // 于是测试全绿而真实接入 404。教训：断言要照着**消费方怎么用**来写，
  // 不能照着"我产出了什么"来写。
  check(
    "baseUrl 带 /v1（Notrat 直接拼 /chat/completions，不补 /v1）",
    wiring?.baseUrl === "http://127.0.0.1:8130/v1",
    wiring?.baseUrl,
  );
  check("baseUrl 指向桥（8130）而不是 shim（8120）", String(wiring?.baseUrl).includes(":8130"), wiring?.baseUrl);
  check("另给了桥根供诊断（healthz 在那个根上）", wiring?.bridgeRoot === "http://127.0.0.1:8130", wiring?.bridgeRoot);
  check(
    "apiKey 在出口被脱敏（不含真值）",
    typeof wiring?.apiKey === "string" && (wiring.apiKey === "" || wiring.apiKey.includes("•")),
    JSON.stringify(wiring?.apiKey),
  );
  check("带到模型列表", Array.isArray(wiring?.models) && wiring.models.length > 0, `${wiring?.modelCount} 个`);
  check(
    "wiring.models 是模型 id 的字符串数组（面板写配置时依赖这个形状）",
    Array.isArray(wiring?.models) && wiring.models.every((m) => typeof m === "string"),
    JSON.stringify((wiring?.models || []).slice(0, 2)),
  );
  say(`  ${wiring?.displayName} → ${wiring?.chatCompletionsUrl}`);

  // includeSecret 是面板「复制 / 写入配置」按钮的唯一通路：默认不给真值，显式点名才给。
  // 两条都钉住 —— 只测默认脱敏的话，哪天面板拿不到真口令（按钮点了没反应、
  // 写进配置的 apiKey 就是那串圆点）不会有测试报红。
  const wiringSecret = payloadOf(
    await rpc("tools/call", { name: "wb_wiring", arguments: { region: "cn", includeSecret: true } }, 120_000),
  );
  check(
    "includeSecret=true 时 apiKey 是真值（面板要拿它填服务商）",
    typeof wiringSecret?.apiKey === "string" &&
      wiringSecret.apiKey.length > 0 &&
      !wiringSecret.apiKey.includes("•"),
    `${String(wiringSecret?.apiKey).length} 字符`,
  );
  check(
    "默认出口与面板出口给的确实是两个东西（证明确实脱敏了，不是碰巧一样）",
    wiring?.apiKey !== wiringSecret?.apiKey,
    `${JSON.stringify(wiring?.apiKey)} vs ${String(wiringSecret?.apiKey).length} 字符真值`,
  );

  say("\n=== 6. wb_status（面板主数据源）===");
  const st = payloadOf(await rpc("tools/call", { name: "wb_status", arguments: { region: "cn" } }, 120_000));
  check("status.ok", st?.ok === true);
  check("有账号行", Array.isArray(st?.accounts) && st.accounts.length > 0, `${st?.accounts?.length} 行`);
  check("有模型行", Array.isArray(st?.models) && st.models.length > 0, `${st?.models?.length} 行`);
  check("summary 有 available 计数", typeof st?.summary?.available === "number", `available=${st?.summary?.available}`);
  check("summary 有积分合计", typeof st?.summary?.creditTotal === "number", `creditTotal=${st?.summary?.creditTotal}`);
  const acc = st?.accounts?.[0];
  if (acc) say(`  账号: ${acc.label}  余额=${acc.credits?.total}  冷却=${acc.cooling}  签到=${acc.checkin?.todayCheckedIn}`);
  check(
    "状态文档里没有 accessToken",
    !JSON.stringify(st).includes("accessToken") && !JSON.stringify(st).includes("refreshToken"),
  );

  say("\n=== 7. 桥的 CORS 预检 + 口令（直连 HTTP 验证）===");
  const preflight = await fetch("http://127.0.0.1:8130/v1/chat/completions", {
    method: "OPTIONS",
    headers: { Origin: "https://example.invalid", "Access-Control-Request-Method": "POST" },
  });
  check("OPTIONS 预检被放行（204/200）", preflight.status === 204 || preflight.status === 200, `status=${preflight.status}`);
  check(
    "回显了 Origin（而不是 *）",
    preflight.headers.get("access-control-allow-origin") === "https://example.invalid",
    preflight.headers.get("access-control-allow-origin"),
  );
  check(
    "声明允许 Authorization 头",
    (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase().includes("authorization"),
    preflight.headers.get("access-control-allow-headers"),
  );

  const noAuth = await fetch("http://127.0.0.1:8130/v1/models", {
    headers: { Origin: "https://example.invalid" },
  });
  check("无口令的真实请求被 401 拒绝", noAuth.status === 401, `status=${noAuth.status}`);

  const health = await fetch("http://127.0.0.1:8130/bridge/healthz");
  check("桥自己的健康检查免口令", health.ok, `status=${health.status}`);

  say("\n=== 8. 错误处理 ===");
  const unknown = await rpc("tools/call", { name: "wb_no_such_tool", arguments: {} });
  check("未知工具回错误", !!unknown.error, JSON.stringify(unknown.error?.message));
  const bad = await rpc("tools/call", { name: "wb_config_set", arguments: { patch: "not-an-object" } });
  check("非法参数回 isError 而不是崩溃", bad.result?.isError === true);
  const stillAlive = await rpc("tools/call", { name: "wb_config_get", arguments: {} });
  check("server 在错误后仍存活", !!payloadOf(stillAlive), "后续调用正常");
} catch (err) {
  failures += 1;
  say(`\n!! 冒烟失败: ${err?.stack ?? err}`);
} finally {
  try {
    child.stdin.end();
    await new Promise((r) => setTimeout(r, 1500));
    child.kill();
  } catch {
    /* ignore */
  }

  say("\n=== stderr（server 日志）尾 20 行 ===");
  for (const line of stderr.trim().split("\n").slice(-20)) say(`  ${line}`);

  say(`\n=== 结论：${failures === 0 ? "全部通过" : `${failures} 项失败`} ===`);
  fs.writeFileSync(OUT, lines.join("\n"), "utf8");
  process.exit(failures === 0 ? 0 : 1);
}
