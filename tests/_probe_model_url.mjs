/**
 * 验证 baseUrl 该不该带 /v1
 * ========================
 *
 * 问题：拉模型列表会不会因为没有 /v1 而挂？
 *
 * 做法：把 Notrat 源码里的拼接规则**逐字抄过来**，对两种 baseUrl 各算一次真实 URL，
 *       再真打出去看状态码。答案不是推理，是事实。
 *
 * ## 抄自哪里
 *
 * 模型列表 URL —— 四处，规则完全相同（`endsWith("/v1") ? b + "/models" : b + "/v1/models"`）：
 *   - src/services/aiService.ts:3237   fetchProviderModels（模型选择器主路径）
 *   - src/components/Sidebar/Sidebar.tsx:9174   侧栏「刷新模型」
 *   - src/services/aiService.ts:3418   fetchOpenAICompatibleModels（已 deprecated）
 *   - src-electron/main/index.ts:1170  buildModelUrlCandidatesForProvider（主进程）
 *
 * 对话 URL —— src/services/aiService.ts:1161：`${route.baseUrl}/chat/completions`
 *   而 route.baseUrl = normalizeBaseUrl(baseUrl)（src/shared/openaiRouting.ts:198）
 *   **只去尾斜杠，不去重 /v1**。
 *
 * ## 端口
 *
 * 优先用应用里正在跑的桥；桥不在（ECONNREFUSED）才自己起引擎，跑完停掉。
 * 这样它既能和实例共存，也能在实例没跑时独立工作。
 */
import fs from "node:fs";
import { WorkBuddyEngine, BRIDGE_PORTS } from "../server/engine.js";
import { paths } from "../server/env.js";

const BRIDGE = `http://127.0.0.1:${BRIDGE_PORTS.cn}`;
const SECRET_FILE = paths.stateDir + "/.workbuddy-xdpool/shim-secret-cn";

/* ── 抄 Notrat 的拼接逻辑 ─────────────────────────────────────────── */

/** src/shared/openaiRouting.ts:normalizeBaseUrl（只去尾斜杠） */
const normalizeBaseUrl = (b) => String(b ?? "").trim().replace(/\/+$/, "");

/** aiService.ts:3231-3254 里 custom 会走到的两条分支 */
function notratModelsUrl(baseUrl) {
  const clean = normalizeBaseUrl(baseUrl);
  return clean.endsWith("/v1") ? `${clean}/models` : `${clean}/v1/models`;
}

/** aiService.ts:1161 */
const notratChatUrl = (baseUrl) => `${normalizeBaseUrl(baseUrl)}/chat/completions`;

/* ── 引擎：按需自起 ──────────────────────────────────────────────── */

const silent = { info() {}, warn() {}, error() {}, debug() {} };
let engine = null;
let secret = null;

async function ensureBridge() {
  secret = fs.readFileSync(SECRET_FILE, "utf8").trim();
  try {
    const r = await fetch(`${BRIDGE}/bridge/healthz`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      console.log(`[setup] 复用应用里正在跑的桥 ${BRIDGE}`);
      return;
    }
  } catch {
    /* 桥不在，自己起 */
  }
  console.log("[setup] 桥不在，自起一个引擎（跑完会停掉）");
  engine = new WorkBuddyEngine({ logger: silent });
  await engine.start();
  console.log(`[setup] 引擎就绪 ${BRIDGE}`);
}

const HEADERS = () => ({ Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Origin: "null" });

/* ── 跑 ──────────────────────────────────────────────────────────── */

let bad = 0;
const check = (l, ok, d) => {
  if (!ok) bad += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${l}${d === undefined ? "" : ` — ${d}`}`);
};

try {
  await ensureBridge();

  for (const baseUrl of [BRIDGE, `${BRIDGE}/v1`]) {
    const tag = baseUrl.endsWith("/v1") ? "带 /v1" : "不带 /v1";
    console.log(`\n=== baseUrl ${tag}：${baseUrl} ===`);

    /* ── 模型列表 ── */
    const mUrl = notratModelsUrl(baseUrl);
    const m = await fetch(mUrl, { headers: HEADERS() });
    let ids = [];
    try {
      ids = (JSON.parse(await m.text()).data || []).map((x) => x.id);
    } catch {}
    console.log(`  拉模型 → ${mUrl}`);
    check("模型列表 200", m.status === 200, `status=${m.status} · ${ids.length} 个`);
    check("Notrat 拼出的确实是 /v1/models（没重复 /v1）", new URL(mUrl).pathname === "/v1/models", new URL(mUrl).pathname);

    /* ── 对话端点 ── */
    const cUrl = notratChatUrl(baseUrl);
    console.log(`  对话   → ${cUrl}`);
    if (new URL(cUrl).pathname === "/v1/chat/completions") {
      console.log("  （上一轮已实测 /v1/chat/completions → 200 + 真回复 \"OK\"，这里不重打以免重复计费）");
      check("对话端点拼出 /v1/chat/completions", true, "已知可用");
    } else {
      // 不带 /v1 会打到 /chat/completions —— 在路由层被拒，不产生上游费用
      const r = await fetch(cUrl, {
        method: "POST",
        headers: HEADERS(),
        body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "x" }], max_tokens: 4 }),
      });
      const txt = await r.text();
      check(
        "这就是你遇到的 404（路由层拒绝，不花积分）",
        r.status === 404,
        `status=${r.status} ${JSON.stringify(txt.slice(0, 88))}`,
      );
    }
  }

  console.log(
    "\n=== 结论 ===\n" +
      "  模型列表：**两种填法都对**。Notrat 四处拼接全带 endsWith(\"/v1\") 去重 ——\n" +
      "            缺了它会自动补 /v1，已经带了它不会重复加。所以「只填桥根」也能拉到模型。\n" +
      "  对话：    **只有带 /v1 才对**。它只去尾斜杠、不去重，桥根会拼成 /chat/completions → 404。\n" +
      "  ⇒ 要两个都成立，baseUrl 必须带 /v1。\n" +
      `  ${bad === 0 ? "以上均通过。" : `${bad} 项失败。`}`,
  );
} catch (e) {
  bad += 1;
  console.log(`\n!! 异常: ${e?.stack ?? e}`);
} finally {
  if (engine) await engine.stop().catch(() => {});
  process.exit(bad === 0 ? 0 : 1);
}
