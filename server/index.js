/**
 * notrat-workbuddy-pool —— MCP server（执行宿主）
 * ==============================================
 *
 * 零依赖 stdio JSON-RPC：初始化、列工具、调工具。引擎是模块级单例，
 * 第一次用到就启动，之后各次调用共用同一套 shim / 桥 / 账号池。
 *
 * 两条纪律：
 *   1. **日志只走 stderr**。stdout 是 JSON-RPC 通道，多写一个字节都会破坏协议。
 *      Notrat 面板的「实时日志」抽屉读的就是 stderr。
 *   2. **永不回传令牌**。账号摘要与状态文档在出口统一脱敏。
 */
import path from "node:path";
import fs from "node:fs";
import { WorkBuddyEngine, REGION_PORTS, BRIDGE_PORTS, REGIONS, NOTRAT_PROVIDERS, DEFAULT_CONFIG } from "./engine.js";
import { paths, envBootstrap } from "./env.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "notrat-workbuddy-pool", version: "0.1.0" };

/* ── 日志：只写 stderr ─────────────────────────────────────────── */

function log(level, message, extra) {
  const line = `[workbuddy-pool] ${level} ${message}${extra === undefined ? "" : ` ${safeJson(extra)}`}`;
  process.stderr.write(`${line}\n`);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const logger = {
  info: (m, x) => log("INFO", String(m), x),
  warn: (m, x) => log("WARN", String(m), x),
  error: (m, x) => log("ERROR", String(m), x),
  debug: () => {},
};

/* ── 引擎单例 ──────────────────────────────────────────────────── */

let engine = null;
function getEngine() {
  if (!engine) engine = new WorkBuddyEngine({ logger });
  return engine;
}

/* ── 结果封装 ──────────────────────────────────────────────────── */

function ok(payload) {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

function fail(message, detail) {
  const text = detail === undefined ? message : `${message}\n\n${typeof detail === "string" ? detail : safeJson(detail)}`;
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * 出口脱敏：任何 `apiKey` / `token` / `accessToken` / `refreshToken` 一律遮蔽。
 *
 * 放在统一出口而不是各个工具里各写一遍——漏一处就等于令牌进了对话历史。
 * `refreshToken` 尤其重要：它能换出新令牌，比 accessToken 更敏感。
 */
const SECRET_KEYS = /^(apiKey|token|accessToken|refreshToken|authorization|secret|shimToken)$/i;
function redact(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.test(k)) out[k] = typeof v === "string" && v !== "" ? `••••••${v.slice(-4)}` : v;
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

/* ── 端口占用诊断 ────────────────────────────────────────────────
   引擎起不来最常见的原因不是 bug，是端口上已经有个服务了：
     · Notrat 里同时开了另一个积分池（多窗口 / 旧实例没退）
     · 用户另外装过 WorkBuddy 代理（比如 DSH 那套），默认端口正好相同
   两种情况处理方式完全不同，所以启动失败时探一下占用者是谁。 */
const BRIDGE_PORT_LIST = [BRIDGE_PORTS.cn, BRIDGE_PORTS.global];

async function probeBridge(port) {
  try {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 1200) : null;
    const res = await fetch("http://127.0.0.1:" + port + "/bridge/healthz", ctl ? { signal: ctl.signal } : undefined);
    if (timer) clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    /* 桥的 healthz 长这样：{ok,region,target,port} —— 有 target/region 就当自己人 */
    if (body && body.ok === true && body.target) return { port, region: body.region, target: body.target };
    return null;
  } catch {
    return null;
  }
}

async function detectPortOwner() {
  for (const port of BRIDGE_PORT_LIST) {
    const who = await probeBridge(port);
    if (who) return who;
  }
  return null;
}

/* ── 工具表 ────────────────────────────────────────────────────── */

const REGION_ARG = {
  region: {
    type: "string",
    enum: ["cn", "global"],
    description: "国内版(cn) 还是国际版(global)，默认 cn。两边的账号、模型目录、积分完全独立。",
  },
};

const TOOLS = [
  {
    name: "wb_engine",
    description:
      "引擎生命周期：info 查看状态 / start 启动 / stop 停止 / restart 重启。首次调用会自动启动（shim 起在 8120、8121，桥起在 8130、8131）。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["info", "start", "stop", "restart"], description: "默认 info" },
      },
    },
    handler: async (args) => {
      const e = getEngine();
      switch (args.action ?? "info") {
        case "start":
          return ok(redact(await e.start()));
        case "stop":
          // byUser：用户点名要停，之后任何工具都不得把它偷偷拉起来
          // （见 engine.js ensureStarted 与 assertRunning）。
          return ok(await e.stop({ byUser: true }));
        case "restart":
          return ok(redact(await e.restart()));
        default: {
          // info 也要等启动跑完再回报。
          //
          // 工具描述承诺"首次调用会自动启动"，而预热是 initialize 之后 300ms 才异步跑的，
          // 于是启动还没绑完端口时 info 会如实回 started=false —— 真值，但与承诺不符，
          // 调用方只看到"引擎没起来"。冒烟测试第 4 步就是这么抓到的：
          // 日志里 shims / bridges 都起来了，info 却报没起。
          if (e.config.autoStart !== false) await e.ensureStarted();
          return ok(redact(e.info()));
        }
      }
    },
  },
  {
    name: "wb_wiring",
    description:
      "一键接入信息：给出可填进 Notrat「自定义服务商」的 baseUrl / apiKey / 模型列表。用这个把积分池接成 Notrat 的模型服务商。baseUrl 已经带 /v1（Notrat 会直接拼 /chat/completions，少 /v1 会 404），复制粘贴即可。",
    inputSchema: {
      type: "object",
      properties: {
        ...REGION_ARG,
        includeSecret: {
          type: "boolean",
          description:
            "**只给插件面板的「复制 / 写入配置」按钮用**：为 true 时返回真实回环口令。默认 false（脱敏）。对话里一律不要传 true —— 那会把口令写进聊天记录和模型上下文，而它本来只该待在回环上。",
        },
      },
    },
    handler: async (args) => {
      const e = getEngine();
      await e.ensureStarted();
      const wiring = e.providerWiring(args.region ?? "cn");
      // 默认脱敏：工具出口的第一读者是对话，口令不该进聊天记录。
      if (args.includeSecret !== true) return ok(redact(wiring));
      // 面板路径：只放 apiKey 出来，其余字段照旧脱敏。
      // 面板是唯一能把口令填进 Notrat「自定义服务商」的地方 —— 主进程不写
      // localStorage，所以 MCP server 够不着那份配置，只能由渲染层自己填。
      return ok({ ...redact(wiring), apiKey: wiring.apiKey });
    },
  },
  {
    name: "wb_status",
    description:
      "完整状态文档：账号行（积分/签到/冷却/停用）、模型目录（倍率/上下文/可用账号数）、shim 与桥、用量与趋势、自动化、错误账本。面板的主数据源。",
    inputSchema: { type: "object", properties: { ...REGION_ARG } },
    handler: async (args) => {
      const e = getEngine();
      // 首次调用也要能拿到真数据：冷启动时 status 曾经返回空壳，
      // 面板首屏于是显示"没找到账号"——对新手是纯误导，所以这里先等启动。
      await e.ensureStarted();
      return ok(redact(await e.status(args.region ?? "cn")));
    },
  },
  {
    /* ── 开局一站式 ──────────────────────────────────────────────
       新手只需要知道三件事：引擎在跑吗？找到我的号了吗？能接上吗？
       这三个答案分别散在 wb_engine / wb_rescan / wb_status / wb_wiring 里，
       面板要串四五个调用、还要处理"引擎刚起还没扫"的中间态。这个工具把它
       合成一次：起引擎 →（一个号都没有时）扫一次 → 告诉你该用哪个区。 */
    name: "wb_bootstrap",
    description:
      "开局一站式：确保引擎在跑，没有任何账号时自动扫一次本机桌面端登录快照，然后回报该用哪个区（cn/global）、各有几个账号、能不能接。面板首屏与新手引导用这一个代替 wb_engine + wb_status + wb_rescan。只读，不发起登录。",
    inputSchema: {
      type: "object",
      properties: {
        ...REGION_ARG,
        force: { type: "boolean", description: "true = 无论如何都重扫一次（用户点了「再找一次」）" },
      },
    },
    handler: async (args) => {
      const e = getEngine();
      const want = args.region ?? "cn";
      const out = { ok: false, region: want, recommendedRegion: want, started: false, stoppedByUser: false };

      try {
        await e.start();
      } catch (err) {
        out.error = String(err?.message ?? err);
        /* 启动失败也要把已知信息带回去：面板据此显示"启动失败 + 原因"，
           而不是干等一个空状态。 */
        const info = e.info();
        out.started = !!info.started;
        out.stoppedByUser = !!info.stoppedByUser;
        out.startError = info.lastStartError ? String(info.lastStartError) : undefined;

        const msg = out.error;
        if (/EADDRINUSE|address already in use/i.test(msg)) {
          out.portBusy = true;
          const owner = await detectPortOwner();
          if (owner) {
            /* 占用者是另一个积分池：说明服务其实活着，用户别再来回点了 */
            out.reused = true;
            out.reusedPort = owner.port;
            out.hint =
              "端口 " + owner.port + " 上已经有一个积分池在跑（可能是 Notrat 的另一个窗口/面板，或旧实例）。" +
              "这个面板不用重复启动 —— 直接去聊天框选「积分池」就能用；要管理账号请回到那个窗口。";
          } else {
            out.hint =
              "端口被别的程序占了（8120/8130 国内、8121/8131 国际）。" +
              "常见是你另外装过 WorkBuddy 代理（例如 DSH 那套），它默认也用这些端口 —— 先去关掉它，再重试。";
          }
        } else {
          out.hint = "引擎没起来。看面板「实时日志」里的 workbuddy-pool stderr（状态栏插件箱 → 积分池 → 实时日志）。";
        }
        return ok(out);
      }

      let info = e.info();
      out.started = !!info.started;
      out.stoppedByUser = !!info.stoppedByUser;

      const before = { cn: e.accounts("cn").length, global: e.accounts("global").length };
      out.counts = before;

      /* 一个号都没有（或用户点名重扫）才扫盘：这是唯一会读本机快照的操作，
         不该在每次轮询里跑。 */
      const empty = before.cn === 0 && before.global === 0;
      if (args.force === true || empty) {
        try {
          const r = await e.rescan();
          out.scannedAt = Date.now();
          out.scanned = true;
          out.scanCount = r && typeof r.count === "number" ? r.count : undefined;
        } catch (err) {
          out.scanError = String(err?.message ?? err);
        }
        info = e.info();
        out.counts = { cn: e.accounts("cn").length, global: e.accounts("global").length };
      }

      /* 推荐区：用户点的区一个号都没有、另一个区有 → 直接推荐那个。
         两边都有就尊重用户选的。 */
      const c = out.counts;
      let rec = want;
      if (c[want] === 0) {
        if (c.global > 0) rec = "global";
        else if (c.cn > 0) rec = "cn";
      }
      out.recommendedRegion = rec;
      out.region = rec;

      /* 接入就绪：面板要拿它决定"能不能点一键接上"。apiKey 不出这个口。 */
      try {
        const w = e.providerWiring(rec);
        out.wiring = {
          ready: !!w.ready,
          providerId: w.providerId,
          displayName: w.displayName,
          baseUrl: w.baseUrl,
          modelCount: Array.isArray(w.models) ? w.models.length : 0,
          reason: w.ready ? undefined : w.reason,
        };
      } catch (err) {
        out.wiring = { ready: false, reason: String(err?.message ?? err) };
      }

      out.accountCount = c[rec];
      out.ok = out.started && out.wiring.ready;

      /* 给新手一句人话结论，面板直接显示，不用自己拼文案。 */
      if (!out.started) out.verdict = "引擎没起来，稍后重试或看日志";
      else if (c[rec] === 0) out.verdict = "引擎在跑，但没找到已登录的账号";
      else if (!out.wiring.ready) out.verdict = "找到 " + c[rec] + " 个账号，但桥还没就绪";
      else out.verdict = "就绪：" + c[rec] + " 个账号，" + out.wiring.modelCount + " 个模型可接";

      return ok(redact(out));
    },
  },
  {
    name: "wb_accounts",
    description: "池里的账号列表（已脱敏，不含任何令牌）。",
    inputSchema: { type: "object", properties: { ...REGION_ARG } },
    handler: async (args) => {
      const e = getEngine();
      await e.ensureStarted();
      return ok(redact(e.accounts(args.region ?? "cn")));
    },
  },
  {
    name: "wb_models",
    description: "模型目录：id、名称、上下文窗口、输出上限、是否支持图片、有几个账号能服务、是否被选择屏蔽。",
    inputSchema: {
      type: "object",
      properties: {
        ...REGION_ARG,
        visibleOnly: { type: "boolean", description: "只列未被屏蔽的模型，默认 true" },
      },
    },
    handler: async (args) => {
      const e = getEngine();
      await e.ensureStarted();
      return ok(redact(e.models(args.region ?? "cn", { visibleOnly: args.visibleOnly !== false })));
    },
  },
  {
    name: "wb_rescan",
    description: "重新扫描本机桌面端登录快照，发现新登录的账号。不发起任何登录流程，只读。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const e = getEngine();
      return ok(redact(await e.rescan()));
    },
  },
  {
    name: "wb_config_get",
    description: "读插件配置（选号分配、额度门槛、积分保留线、模型选择、自动化开关）。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ok(redact(getEngine().getConfig())),
  },
  {
    name: "wb_config_set",
    description:
      "改插件配置并立即生效。可改键：distribution(priority|round-robin|balanced)、minUsableCredits、cooldownMs、disabledAccountIds、creditReserves、automation({enabled,...})、autoStart。",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "object", description: "要合并进配置的对象，如 {\"minUsableCredits\": 100}" },
      },
      required: ["patch"],
    },
    handler: async (args) => {
      if (!args.patch || typeof args.patch !== "object" || Array.isArray(args.patch)) {
        return fail("patch must be an object");
      }
      return ok(redact(getEngine().saveConfig(args.patch)));
    },
  },
  {
    name: "wb_toggle_account",
    description: "把某个账号停用 / 启用（与自动跳过分开管理：停用是人的决定，跳过是额度的决定）。",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        disabled: { type: "boolean" },
      },
      required: ["accountId", "disabled"],
    },
    handler: async (args) => {
      if (typeof args.accountId !== "string" || args.accountId === "") return fail("accountId is required");
      return ok(redact(getEngine().setAccountDisabled(args.accountId, args.disabled === true)));
    },
  },
  {
    name: "wb_set_reserve",
    description: "设置某账号的积分保留线：余额低于该线不再派活。传 0 或 null 清除。",
    inputSchema: {
      type: "object",
      properties: { accountId: { type: "string" }, amount: { type: "number", description: "0 表示清除" } },
      required: ["accountId"],
    },
    handler: async (args) => {
      if (typeof args.accountId !== "string" || args.accountId === "") return fail("accountId is required");
      const amount = args.amount === undefined ? null : Number(args.amount);
      if (amount !== null && !Number.isFinite(amount)) return fail("amount must be a finite number");
      return ok(redact(getEngine().setCreditReserve(args.accountId, amount)));
    },
  },
  {
    name: "wb_reset_cooldowns",
    description: "清除全部限流冷却（429 / 5xx / 按模型冷却 / 熔断），并同步清掉冷却账本。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ok(getEngine().resetCooldowns()),
  },
  {
    name: "wb_automation",
    description: "积分自动化：status 看各任务状态与今日收益；run 立即跑一次（可指定账号，默认整池）。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "run"], description: "默认 status" },
        accountIds: { type: "array", items: { type: "string" }, description: "只跑这些账号（run 时可选）" },
      },
    },
    handler: async (args) => {
      const e = getEngine();
      if ((args.action ?? "status") === "run") {
        await e.ensureStarted();
        return ok(e.runAutomation(args.accountIds));
      }
      await e.ensureStarted();
      return ok(redact(e.automationStatus()));
    },
  },
  {
    name: "wb_requests",
    description: "请求记录：时间、模型、账号、结果、总耗时、排队时长、首字延迟、token 数与轮换次数。",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "最多返回几条，默认 50" } },
    },
    handler: async (args) => {
      const e = getEngine();
      const log_ = e.requestLog();
      const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Number(args.limit)) : 50;
      return ok(
        redact({
          file: log_.file,
          failures: log_.failures,
          total: log_.items.length,
          // `items` 已经是**新在前**：引擎用的是上游的 `list()`，而它内部自己
          // `reverse()` 过（注释写着 "Newest first, which is the only order a log is
          // ever read in"）。
          //
          // 这里原先写的是 `slice(-limit).reverse()` —— 对"新在前"的数组做这两步，
          // 取到的是**最旧的** limit 条、再倒成旧在前：窗口和顺序双错。
          // 日志上限 200 条，跑一阵子就到，届时用户看到的会是几百次请求里最老的一批
          // （所以这个 bug 在小样本下完全看不出来）。
          items: log_.items.slice(0, limit),
        }),
      );
    },
  },
  {
    name: "wb_performance",
    description: "按模型的排队时长（p50/p95/均值）与输出速度统计，用来「用数据选模型」。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const e = getEngine();
      return ok(redact({ queueStats: e.queueStatistics(), outputProbes: e.probeStats() }));
    },
  },
  {
    name: "wb_doctor",
    description:
      "自检：数据目录与状态文件落点（确认没有写进 ~/.dsh 或 D:\\dsh-rotakit）、端口占用、桥与 shim 是否就绪、账号发现结果、上游版本。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const e = getEngine();
      const info = e.info();

      // 状态隔离核查：这三处都不该被本插件碰
      const legacyRoots = [
        path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh"),
        path.join("D:", "dsh-rotakit"),
        path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".wb-switch"),
      ];
      const legacyTouched = legacyRoots
        .map((p) => ({ path: p, exists: fs.existsSync(p) }))
        .filter((r) => r.exists);

      let vendored = null;
      try {
        vendored = JSON.parse(fs.readFileSync(new URL("./vendor/VENDOR.json", import.meta.url), "utf8"));
      } catch {
        vendored = null;
      }

      let stateFiles = [];
      try {
        stateFiles = fs.readdirSync(path.join(paths.stateDir, ".workbuddy-xdpool")).map(String);
      } catch {
        stateFiles = [];
      }

      return ok(
        redact({
          engine: info,
          stateIsolation: {
            dataDir: paths.dataDir,
            stateDir: paths.stateDir,
            requestLogOverridden: envBootstrap.requestLogOverridden,
            /** 上游写死的那条 D:\ 路径——只作为"我们知道它的存在"的证据列出，不表示我们在用它 */
            upstreamDefaultRequestLog: envBootstrap.upstreamRequestLogDefault,
            stateFiles,
            legacyPathsPresentOnDisk: legacyTouched,
            verdict: legacyTouched.length === 0 ? "clean — nothing written outside the plugin data dir" : "CHECK: legacy paths exist",
          },
          ports: { shim: REGION_PORTS, bridge: BRIDGE_PORTS },
          regions: REGIONS,
          providers: NOTRAT_PROVIDERS,
          vendoredUpstream: vendored?.upstream ?? null,
          configDefaults: DEFAULT_CONFIG,
        }),
      );
    },
  },
];

const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

/* ── JSON-RPC 传输 ─────────────────────────────────────────────── */

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message, data) {
  write({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

async function dispatch(method, params, id) {
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "notifications/initialized":
    case "initialized":
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      return;
    case "tools/call": {
      const name = params?.name;
      const tool = TOOL_INDEX.get(name);
      if (!tool) {
        replyError(id, -32602, `unknown tool "${name}"`);
        return;
      }
      try {
        const result = await tool.handler(params?.arguments ?? {});
        reply(id, result);
      } catch (err) {
        // 工具异常不该杀掉 server：回一个 isError 结果，让模型自己决定下一步
        logger.error(`tool ${name} threw: ${err?.stack ?? err}`);
        reply(id, fail(`${name} failed: ${err?.message ?? err}`, err?.stack));
      }
      return;
    }
    default:
      replyError(id, -32601, `method not found: ${method}`);
  }
}

/* ── 启动 ──────────────────────────────────────────────────────── */

log("INFO", `boot — data=${paths.dataDir}`);
log("INFO", `boot — state isolation: DSH_HOME=${process.env.DSH_HOME}`);
log("INFO", `boot — request log=${process.env.ROTAKIT_REQUEST_LOG ?? "(disabled by user)"}`);

// stdin 按行读：MCP 是 newline-delimited JSON，不是 SSE
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      logger.warn(`dropped a non-JSON line: ${err?.message ?? err}`);
      continue;
    }
    // 通知没有 id，不该回包
    if (message.id === undefined || message.id === null) {
      dispatch(message.method, message.params, null).catch((err) => logger.error(`dispatch: ${err?.stack ?? err}`));
      continue;
    }
    dispatch(message.method, message.params, message.id).catch((err) => {
      logger.error(`dispatch: ${err?.stack ?? err}`);
      replyError(message.id, -32603, String(err?.message ?? err));
    });
  }
});

process.stdin.on("end", async () => {
  log("INFO", "stdin closed — shutting down");
  try {
    if (engine) await engine.stop();
  } catch (err) {
    logger.warn(`stop on shutdown failed: ${err?.message ?? err}`);
  }
  process.exit(0);
});

// 引擎预热：Notrat 一装好就能用（默认开着 autoStart，可在配置里关）
//
// 刻意延迟到 initialize 之后：MCP 握手必须秒回，不能等 shim 绑端口。
setTimeout(() => {
  const e = getEngine();
  if (e.config.autoStart === false) {
    log("INFO", "autoStart is off — the engine stays down until a tool asks for it");
    return;
  }
  e.start()
    .then((info) => {
      log("INFO", `prewarmed — cn=${info.accounts?.cn ?? "?"} account(s), global=${info.accounts?.global ?? "?"}`);
    })
    .catch((err) => log("WARN", `prewarm failed (tools will retry): ${err?.message ?? err}`));
}, 300);

process.on("uncaughtException", (err) => log("ERROR", `uncaughtException: ${err?.stack ?? err}`));
process.on("unhandledRejection", (err) => log("ERROR", `unhandledRejection: ${err?.stack ?? err}`));
