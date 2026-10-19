/**
 * 端到端活体测试 —— 真打穿上游
 * ==============================
 *
 * 证明那条唯一要紧的断言：**Notrat 侧发出的请求能被 WorkBuddy 上游回答**。
 * 中间两层（桥 8130 → shim 8120 → 上游）任何一层不通，这里就红。
 *
 * 这会真的发出请求并花掉你账号里极少量的积分。不做这一步，
 * "能接入 Notrat" 就只是推理，不是事实 —— 所以它必须真跑。
 *
 * ## 为什么用 `stream: true`
 *
 * 上游的 chat 路径**固定回 SSE**：`rotakit.js` 里 chat 分支直接
 * `body.pipe(res)` + `Content-Type: text/event-stream`，注释写明
 * "The upstream is always asked to stream (the pool's rotation needs the headers early)"。
 * 非流式缓冲只对 Responses / Anthropic 两条协议生效。
 *
 * 巧合的是这正是 Notrat 的真实行为：`aiService.ts:1112` 发 `stream: true`，
 * 然后用 `getReader()` 按 SSE 逐块读。所以这里必须按同一条路测，
 * 而不是按"我以为是标准 OpenAI"的那种请求测。
 *
 * ## 另外钉住三件容易悄悄退化的事
 *
 *   1. **渲染进程直连 shim 必须 403** —— 这是桥存在的理由。若有人放宽
 *      `originIsLoopback`，这条会红，提醒他那等于拆掉一道 CSRF 防线。
 *   2. **桥在 `Origin: null` 下可用** —— 打包版 Notrat 从 `file://` 加载，
 *      带的就是 `null` 源；只测 localhost 会漏掉真正会出事的那种情况。
 *   3. **`stop` 是粘的** —— 用户停过之后，任何工具都不得把它偷偷拉起来。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkBuddyEngine, BRIDGE_PORTS, REGION_PORTS } from "../server/engine.js";
import { paths } from "../server/env.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "_e2e_live_out.txt");
const lines = [];
let failures = 0;

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
  if (!condition) failures += 1;
  say(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}
/** 断言失败时把原始响应体打出来 —— 上一次就是漏了这个，只看到 "null" 无从下手。 */
function dumpRaw(label, text, n = 700) {
  say(`  · ${label} 原始响应体（前 ${n} 字符）: ${JSON.stringify(text.slice(0, n))}`);
}

/** 解析 SSE：累加 content / reasoning_content，取 usage 与 finish_reason。 */
function parseSse(text) {
  const out = { content: "", reasoning: "", usage: null, finish: null, model: null, chunks: 0, malformed: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      out.malformed += 1;
      continue;
    }
    out.chunks += 1;
    if (out.model === null && j.model) out.model = j.model;
    const choice = j.choices?.[0];
    const d = choice?.delta;
    if (typeof d?.content === "string") out.content += d.content;
    if (typeof d?.reasoning_content === "string") out.reasoning += d.reasoning_content;
    if (choice?.finish_reason) out.finish = choice.finish_reason;
    if (j.usage) out.usage = j.usage;
  }
  return out;
}

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const engine = new WorkBuddyEngine({ logger: silent });

try {
  /* ── 1. 起引擎 ─────────────────────────────────────────────── */
  say("=== 1. 启动引擎 ===");
  const info = await engine.start();
  check("引擎已启动", info.started === true);
  check("账号发现到了", (info.accounts?.cn ?? 0) > 0, `cn=${info.accounts?.cn} global=${info.accounts?.global}`);
  check("模型目录非空", (info.models?.cn ?? 0) > 0, `cn=${info.models?.cn}`);

  const models = engine.models("cn");
  // 优先挑 flash：便宜、快、少思考，适合冒烟级别的活体验证
  const model = models.find((m) => /flash/i.test(m.id))?.id ?? models[0]?.id;
  check("拿到一个可用模型 id", typeof model === "string" && model.length > 0, model);
  if (!model) throw new Error("没有模型可用，后续无法进行");

  /* ── 2. 口令来源 ───────────────────────────────────────────── */
  say("\n=== 2. 桥口令 ===");
  const secretFile = path.join(paths.stateDir, ".workbuddy-xdpool", "shim-secret-cn");
  check("口令文件落在插件数据目录内", fs.existsSync(secretFile), secretFile.replace(paths.dataDir, "<dataDir>"));
  const secret = fs.readFileSync(secretFile, "utf8").trim();
  check("口令非空", secret.length > 0, `${secret.length} 字符`);

  /* ── 3. 负向对照：直连 shim 必须被拒 ────────────────────────── */
  say("\n=== 3. 负向对照：直连 shim（应该被拒）===");
  const direct = await fetch(`http://127.0.0.1:${REGION_PORTS.cn}/v1/models`, {
    headers: { Authorization: `Bearer ${secret}`, Origin: "null" },
    signal: AbortSignal.timeout(10_000),
  }).catch((e) => ({ status: 0, _err: e.message }));
  check(
    "带 Origin: null 直连 shim 被 403 拒绝（这就是桥存在的理由）",
    direct.status === 403,
    `status=${direct.status}${direct._err ? ` err=${direct._err}` : ""}`,
  );

  /* ── 4. 主路径：经桥发真实流式对话（Notrat 就是这么发的）──── */
  say("\n=== 4. 经桥发真实流式请求（Origin: null = 打包版 file://）===");
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${BRIDGE_PORTS.cn}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
      Origin: "null",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Answer with the single word PONG and nothing else. Do not explain." }],
      // 池里是推理模型，思考计入 max_tokens。预算太小会得到
      // finish_reason=length 且 content 全空（上游 README 实测过）。
      max_tokens: 4096,
      stream: true,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const elapsed = Date.now() - t0;
  const text = await res.text();
  const body = parseSse(text);

  check("桥返回 200", res.status === 200, `status=${res.status} ${elapsed}ms`);
  check("content-type 是 SSE（上游 chat 路径的既定行为）", String(res.headers.get("content-type")).includes("event-stream"));
  check("SSE 分片数 > 0", body.chunks > 0, `${body.chunks} 片`);
  check("没有畸形分片", body.malformed === 0, `${body.malformed} 片解析失败`);
  check("回显了请求的模型", body.model === model, `${body.model} vs ${model}`);

  const visible = body.content.trim();
  check("拿到非空可见回复（= 上游真的回答了）", visible.length > 0, JSON.stringify(visible));
  check("回复里出现 PONG", /PONG/i.test(visible), JSON.stringify(visible));
  check("finish_reason 是正常收束", body.finish === "stop" || body.finish === "tool_calls", String(body.finish));
  check(
    "usage 有 token 数（说明是真实推理而非空壳）",
    (body.usage?.total_tokens ?? 0) > 0,
    JSON.stringify(body.usage ?? null),
  );
  if (visible.length === 0) {
    dumpRaw("思考内容", body.reasoning, 500);
    dumpRaw("完整流", text);
  }
  say(`  模型=${body.model} 可见回复=${JSON.stringify(visible)} 思考长度=${body.reasoning.length} tokens=${body.usage?.total_tokens ?? "?"}`);

  /* ── 5. 兼容性变更探测器：chat 路径 stream:false 仍回 SSE ───── */
  say("\n=== 5. 变更探测器：chat 路径 stream:false 的形状 ===");
  const nsRes = await fetch(`http://127.0.0.1:${BRIDGE_PORTS.cn}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, Origin: "null" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: false }),
    signal: AbortSignal.timeout(30_000),
  });
  const nsType = String(nsRes.headers.get("content-type"));
  check(
    "chat 路径即使 stream:false 也回 text/event-stream（上游刻意如此）",
    nsType.includes("event-stream"),
    nsType,
  );
  say("  · 这条专门用来抓变更：一旦上游改成回 JSON，说明行为变了，");
  say("    那时要重新确认「指向本池的非流式 OpenAI 客户端」是否突然能用了。");
  await nsRes.body?.cancel().catch(() => {}); // 立即断开，不为探测多烧上游算力

  /* ── 6. 请求被记进账本（可观测性的凭据）────────────────────── */
  say("\n=== 6. 请求记录 ===");
  const log = engine.requestLog();
  // `items` 是**新在前**（上游 `list()` 内部已 reverse）。先前这里取 items[len-1]，
  // 拿到的是最旧那条，于是把正确的账本误判成"模型记错了"—— 断言写错方向，
  // 比不写更糟：它会让下一个改动者去"修"一个根本不存在的 bug。
  const newest = log.items?.[0];
  check("账本里出现了这次请求", !!newest, newest ? JSON.stringify({ model: newest.model, account: newest.account }) : "无");
  check("最新一条的模型就是本次请求的模型", newest?.model === model, `${newest?.model} vs ${model}`);
  check(
    "items 确实是新在前（顺序契约）",
    log.items.length < 2 || (log.items[0].startedAt ?? 0) >= (log.items[1].startedAt ?? 0),
    log.items.slice(0, 3).map((i) => i.startedAt).join(" >= "),
  );

  /* ── 7. stop 是粘的 ────────────────────────────────────────── */
  say("\n=== 7. stop 语义 ===");
  await engine.stop({ byUser: true });
  check("stop 之后 started=false", engine.info().started === false);
  check("info 如实标出是用户停的", engine.info().stoppedByUser === true);
  await engine.ensureStarted();
  check("ensureStarted 不会把它偷偷拉起来", engine.info().started === false, "stop 没被 undo");
  const after = await engine.start();
  check("显式 start 能恢复", after.started === true && engine.info().stoppedByUser === false);

  say(`\n=== 结论：${failures === 0 ? "全部通过（链路真的通了）" : `${failures} 项失败`} ===`);
} catch (err) {
  failures += 1;
  say(`\n!! 测试异常终止: ${err?.stack ?? err}`);
} finally {
  await engine.stop().catch(() => {});
  fs.writeFileSync(OUT, lines.join("\n"), "utf8");
  process.exit(failures === 0 ? 0 : 1);
}
