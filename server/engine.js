/**
 * engine —— RotaKit 引擎的 Notrat 侧接线
 * ======================================
 *
 * 上游 `apply(ctx, config)` 做了四件事：
 *   ① 建运行时对象（createCore）
 *   ② 把配置折进 pool / catalogs / scheduler
 *   ③ 起两个回环 shim（国内 / 国际）
 *   ④ 把 shim 注册成 DSH 的模型服务商，并把状态挂到 web 路由
 *
 * 本文件做 ①②③，**原样搬**上游那几行；④ 换成 Notrat 的通道：
 *   - 模型服务商 → 由 bridge 暴露一个带 CORS 的回环端点，Notrat 侧配成「自定义服务商」
 *   - 状态 / 操作 → 由 MCP 工具直接读同一批对象（而不是挂 HTTP 路由给卡片用）
 *
 * 所以这里不重新实现任何引擎逻辑：所有行为都是上游的 pool / catalog / scheduler / shim。
 */
import "./env.js"; // ⚠️ 必须第一行：DSH_HOME / ROTAKIT_REQUEST_LOG 要在 rotakit.js 求值前设好
import fs from "node:fs";
import path from "node:path";

import {
  createCore,
  createWorkBuddyShim,
  createRequestLog,
  createOutputProbes,
  createQueueStats,
  poolWebStatus,
  buildStatus,
  automationOptions,
  candidateAuthDirs,
  defaultDesktopAuthDirs,
  WORKBUDDY_POOL_PROVIDER,
  FALLBACK_WORKBUDDY_MODELS,
} from "./vendor/rotakit.js";
import { paths } from "./env.js";
import { createBridge } from "./bridge.js";

/** shim 的固定端口 —— 与上游一致，重载不换端口。 */
export const REGION_PORTS = { cn: 8120, global: 8121 };

/**
 * 桥的固定端口。刻意避开 shim 的 8120/8121，也避开 Notrat 自己的网关端口，
 * 免得重启 Notrat 时抢端口。
 */
export const BRIDGE_PORTS = { cn: 8130, global: 8131 };

/** 面向 Notrat「自定义服务商」的两个入口。 */
export const NOTRAT_PROVIDERS = {
  cn: { id: "workbuddy-pool", name: "WorkBuddy 积分池（国内）", region: "cn" },
  global: { id: "workbuddy-pool-global", name: "WorkBuddy 积分池（国际）", region: "global" },
};

const REGIONS = ["cn", "global"];

/** 默认配置。字段与上游 Config 一一对应，语义沿用上游注释。 */
export const DEFAULT_CONFIG = {
  /** 选号分配：priority 抽干一个 / round-robin 顺序 / balanced 空闲加权随机 */
  distribution: "priority",
  /** 余额低于此值的账号跳过；余额恢复后自动回池。0 关闭。 */
  minUsableCredits: 50,
  /** 单账号限流冷却基数（毫秒） */
  cooldownMs: 60_000,
  /** 手动停用的账号 id */
  disabledAccountIds: [],
  /** 单账号积分保留线：低于该线不再派活 */
  creditReserves: {},
  /** 国内 / 国际各自的模型选择；缺省表示"全开" */
  modelSelectionCn: null,
  modelSelectionGlobal: null,
  /** 积分自动化（默认关：不主动产生上游流量） */
  automation: { enabled: false },
  /** 插件启动时是否自动起引擎 */
  autoStart: true,
  /**
   * 找到账号后是否自动把本池接成 Notrat 的服务商（默认开）。
   *
   * 这是「装完就能用」的关键一步：面板自己写不进 localStorage，必须由渲染层
   * 动手；而让新手自己找「设置 → AI → 自定义服务商」再抄三行，是这类插件最
   * 常见的掉队点。所以默认自动写一次（幂等、只动本池那一条）。
   * 不想被写的人把它关掉，面板就只剩手动按钮。
   */
  autoWire: true,
};

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

function readConfigFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.configFile, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeConfigFile(config) {
  // 临时文件 + rename：读到一半的配置比没有配置更糟
  const tmp = `${paths.configFile}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(paths.configFile), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, paths.configFile);
}

export class WorkBuddyEngine {
  constructor({ logger } = {}) {
    this.logger = logger ?? SILENT;
    this.config = { ...DEFAULT_CONFIG, ...readConfigFile() };
    this.started = false;
    this.starting = null;
    this.core = null;
    this.shims = null;
    this.bridges = null;
    this.requests = null;
    this.probes = null;
    this.queueStats = null;
    /** 最近一次 scan() 的结果，供 rescan 报告"发现了几个号"。 */
    this.lastScan = { at: null, count: null, error: null };
    this.lastStartError = null;
    /**
     * 用户显式 stop 过之后置位：此后工具不会再"顺手把它拉起来"。
     *
     * 没有这一位，`wb_engine stop` 就是半残的——下一个 `wb_status` 就把它复活了，
     * 用户没法真正把引擎停下去省资源。显式 start / restart 会清掉它。
     */
    this.stoppedByUser = false;
  }

  /* ── 配置 ─────────────────────────────────────────────────────── */

  getConfig() {
    return JSON.parse(JSON.stringify(this.config));
  }

  saveConfig(patch) {
    this.config = { ...this.config, ...patch };
    writeConfigFile(this.config);
    if (this.core) this.applyConfig();
    return this.getConfig();
  }

  /**
   * 把配置折进引擎对象。
   *
   * 这几行是从上游 `apply()` 的 `applyConfigFromSource` **原样搬来的**——
   * 包括 `?? "priority"`、`void 0` 判断、以及 legacySelection 的回落。
   * 改动这里等于改动引擎行为，所以刻意保持逐字对应。
   */
  applyConfig() {
    if (!this.core) return;
    const {
      authFile,
      authDirs,
      cooldownMs,
      distribution,
      disabledAccountIds,
      creditReserves,
      minUsableCredits,
      enabledModelIds,
      imageModelIds,
      contextBudgets,
      modelSelectionCn,
      modelSelectionGlobal,
      automation,
    } = this.config;

    // `authFile` 是上游的写法（指向一个文件，取它的目录）；这里两者都认
    const dirs = authDirs ?? (authFile === undefined ? undefined : [path.dirname(authFile)]);

    this.core.pool.applyConfig({
      ...(dirs === undefined ? {} : { authDirs: dirs }),
      ...(cooldownMs === undefined ? {} : { cooldownMs }),
      distribution: distribution ?? "priority",
      ...(disabledAccountIds === undefined ? {} : { disabledAccountIds }),
      ...(creditReserves === undefined ? {} : { creditReserves }),
      ...(minUsableCredits === undefined ? {} : { minUsableCredits }),
      ...(automation?.exhaustCooldownMs === undefined ? {} : { exhaustCooldownMs: automation.exhaustCooldownMs }),
    });

    const legacySelection = {
      ...(enabledModelIds === undefined ? {} : { enabledModelIds }),
      ...(imageModelIds === undefined ? {} : { imageModelIds }),
      ...(contextBudgets === undefined ? {} : { contextBudgets }),
    };
    this.core.catalogs.cn.applySelection(modelSelectionCn ?? legacySelection);
    this.core.catalogs.global.applySelection(modelSelectionGlobal ?? legacySelection);
    this.core.scheduler.applyConfig(automationOptions(automation));
  }

  /* ── 生命周期 ─────────────────────────────────────────────────── */

  async start() {
    // 显式启动即解除"用户停用"：start / restart 是明确的"我要它跑"。
    this.stoppedByUser = false;
    if (this.started) return this.info();
    // 并发调用共享同一次启动，避免起出两套 shim（端口会撞）
    if (this.starting) return this.starting;

    this.starting = (async () => {
      this.core = createCore(this.logger);

      // 请求记录 / 输出探针 / 队列统计：三块面板数据源。上游默认自己造，
      // 这里显式造，这样面板和引擎看到的是同一批对象。
      this.requests = createRequestLog(200, process.env.ROTAKIT_REQUEST_LOG);
      this.probes = createOutputProbes();
      this.queueStats = createQueueStats();

      this.applyConfig();

      this.shims = {
        cn: createWorkBuddyShim({
          pool: this.core.pool,
          client: this.core.client,
          catalog: this.core.catalogs.cn,
          logger: this.logger,
          region: "cn",
          requests: this.requests,
          probes: this.probes,
          queueStats: this.queueStats,
        }),
        global: createWorkBuddyShim({
          pool: this.core.pool,
          client: this.core.client,
          catalog: this.core.catalogs.global,
          logger: this.logger,
          region: "global",
          requests: this.requests,
          probes: this.probes,
          queueStats: this.queueStats,
        }),
      };

      // 收益账本：上游挂在 settings 服务上，这里落到插件自己的配置文件
      this.core.scheduler.setEarningsPersistence(async (ledger) => {
        try {
          this.config = { ...this.config, automationEarnings: ledger };
          writeConfigFile(this.config);
        } catch (err) {
          this.logger.warn?.(`workbuddy-pool: persisting the earnings ledger failed: ${err?.message ?? err}`);
        }
      });
      if (this.config.automationEarnings !== undefined) {
        this.core.scheduler.applyEarningsLedger(this.config.automationEarnings);
      }

      this.core.scheduler.start();

      // 两个 shim 都要拿到端口才算就绪
      await Promise.all([this.shims.cn.ready, this.shims.global.ready]);

      // 桥建在 shim 之后：它要转发到已知的 baseUrl
      this.bridges = {
        cn: createBridge({
          target: this.shims.cn.baseUrl(),
          secret: this.shims.cn.token(),
          port: BRIDGE_PORTS.cn,
          region: "cn",
          logger: this.logger,
        }),
        global: createBridge({
          target: this.shims.global.baseUrl(),
          secret: this.shims.global.token(),
          port: BRIDGE_PORTS.global,
          region: "global",
          logger: this.logger,
        }),
      };
      await Promise.all([this.bridges.cn.ready, this.bridges.global.ready]);

      this.started = true;
      this.lastStartError = null;
      this.logger.info?.(
        `workbuddy-pool: shims up (${this.shimInfo("cn").baseUrl}, ${this.shimInfo("global").baseUrl}); ` +
          `bridges up (${this.bridgeInfo("cn").baseUrl}, ${this.bridgeInfo("global").baseUrl})`,
      );

      // 账号发现失败不该让整个引擎起不来（可能只是没登录过桌面端）
      try {
        await this.rescan();
      } catch (err) {
        this.logger.warn?.(`workbuddy-pool: initial account scan failed: ${err?.message ?? err}`);
      }
      return this.info();
    })();

    try {
      return await this.starting;
    } catch (err) {
      this.lastStartError = String(err?.stack ?? err);
      this.starting = null;
      await this.stop().catch(() => {});
      throw err;
    }
  }

  /**
   * 停机。
   *
   * `byUser` 区分"用户点名要停"与"启动失败后的自我清理 / 进程退出"——
   * 只有前者置 stoppedByUser，后者不该把按需启动永久关掉。
   */
  async stop({ byUser = false } = {}) {
    if (byUser) this.stoppedByUser = true;
    this.starting = null;
    const wasStarted = this.started;
    this.started = false;
    if (!this.core) return { stopped: true, wasStarted };

    const closers = [];
    if (this.bridges) closers.push(...REGIONS.map((r) => this.bridges[r].close()));
    if (this.shims) closers.push(...REGIONS.map((r) => this.shims[r].close()));
    await Promise.allSettled(closers);

    this.core.scheduler.stop();
    this.logger.info?.("workbuddy-pool: engine stopped");
    return { stopped: true, wasStarted };
  }

  restart() {
    return (async () => {
      await this.stop();
      return this.start();
    })();
  }

  /**
   * 未启动就按需启动 —— MCP 工具都走这个门。
   *
   * 除非用户显式停过（`stoppedByUser`）：那之后任何工具都不得把它偷偷拉起来，
   * 否则 stop 立刻被 undo，用户根本停不下去。
   *
   * 这里**刻意不看** autoStart：autoStart 只决定"进程起来时要不要预热"，
   * 关掉它的用户仍然能靠工具按需拉起引擎（那正是 autoStart=false 的用途）。
   */
  async ensureStarted() {
    if (!this.started && !this.stoppedByUser) await this.start();
    return this;
  }

  /* ── 查询 ─────────────────────────────────────────────────────── */

  shimInfo(region) {
    try {
      return { running: true, baseUrl: this.shims[region].baseUrl() };
    } catch {
      return { running: false };
    }
  }

  bridgeInfo(region) {
    const bridge = this.bridges?.[region];
    if (!bridge) return { running: false };
    try {
      return { running: true, baseUrl: bridge.baseUrl(), port: BRIDGE_PORTS[region] };
    } catch {
      return { running: false };
    }
  }

  /**
   * 面向 Notrat「自定义服务商」的一键接入信息。
   *
   * 给的是**桥**的地址而不是 shim 的：shim 只放行回环 Origin，
   * 渲染进程直连会被 403。见 bridge.js 顶部注释。
   */
  providerWiring(region = "cn") {
    const bridge = this.bridges?.[region];
    if (!bridge || !this.started) {
      return { ready: false, region, hint: "engine not started — call wb_start first" };
    }
    const models = this.models(region);
    // ⚠️ 这里给的是**带 /v1** 的地址，不是桥根。
    //
    // Notrat 的自定义服务商把 baseUrl 当端点前缀直接用：`${baseUrl}/chat/completions`
    // （src/services/aiService.ts:1161）。而 route.baseUrl 来自
    // resolveOpenAITransportRoute() → normalizeBaseUrl()，它只去尾斜杠，
    // **不会替你补 /v1**（src/shared/openaiRouting.ts:198）。
    //
    // 所以填桥根会打到 `/chat/completions`，shim 回 404 `no such route`。
    // 实测过：把 `http://127.0.0.1:8130` 填进服务商就是这个错。
    //
    // 桥根仍然带在 `bridgeRoot` 里，供诊断（`/bridge/healthz` 在那个根上）。
    const bridgeRoot = bridge.baseUrl();
    const baseUrl = `${bridgeRoot}/v1`;
    return {
      ready: true,
      region,
      providerId: NOTRAT_PROVIDERS[region].id,
      displayName: NOTRAT_PROVIDERS[region].name,
      /** 填进 Notrat 自定义服务商的 baseUrl */
      baseUrl,
      /** 填进 apiKey。桥的口令（与 shim 同源） */
      apiKey: bridge.secret(),
      bridgeRoot,
      chatCompletionsUrl: `${baseUrl}/chat/completions`,
      modelsEndpoint: `${baseUrl}/models`,
      /** shim 本体地址，排障时用 */
      shimBaseUrl: this.shimInfo(region).baseUrl ?? null,
      models: models.map((m) => m.id),
      modelCount: models.length,
    };
  }

  models(region = "cn", { visibleOnly = true } = {}) {
    const catalog = this.core?.catalogs?.[region];
    if (!catalog) return [];
    try {
      return visibleOnly ? catalog.visible() : catalog.current();
    } catch {
      return [];
    }
  }

  selection(region = "cn") {
    try {
      return this.core.catalogs[region].currentSelection();
    } catch {
      return null;
    }
  }

  accounts(region = "cn") {
    try {
      return this.core.pool.list(region);
    } catch {
      return [];
    }
  }

  requestLog() {
    try {
      return { items: this.requests.list(), file: this.requests.file(), failures: this.requests.failures() };
    } catch {
      return { items: [], file: undefined, failures: undefined };
    }
  }

  probeStats() {
    try {
      return this.probes.list();
    } catch {
      return [];
    }
  }

  queueStatistics() {
    try {
      return this.queueStats.list();
    } catch {
      return [];
    }
  }

  automationStatus() {
    try {
      return this.core.scheduler.status();
    } catch (err) {
      return { error: String(err?.message ?? err) };
    }
  }

  /** 引擎总览（不需要启 shim 的那部分）。 */
  info() {
    const off = { running: false };
    return {
      started: this.started,
      stoppedByUser: this.stoppedByUser,
      lastStartError: this.lastStartError,
      shims: {
        cn: this.started ? this.shimInfo("cn") : off,
        global: this.started ? this.shimInfo("global") : off,
      },
      bridges: {
        cn: this.started ? this.bridgeInfo("cn") : off,
        global: this.started ? this.bridgeInfo("global") : off,
      },
      ports: { shim: REGION_PORTS, bridge: BRIDGE_PORTS },
      accounts: this.started ? { cn: this.accounts("cn").length, global: this.accounts("global").length } : null,
      models: this.started ? { cn: this.models("cn").length, global: this.models("global").length } : null,
      lastScan: this.lastScan,
      authDirs: this.authDirs(),
      config: this.getConfig(),
      paths: { dataDir: paths.dataDir, stateDir: paths.stateDir, configFile: paths.configFile },
      upstream: {
        provider: WORKBUDDY_POOL_PROVIDER,
        fallbackModels: Array.isArray(FALLBACK_WORKBUDDY_MODELS) ? FALLBACK_WORKBUDDY_MODELS.length : null,
      },
    };
  }

  /** 上游会去读哪些目录找桌面端登录快照。 */
  authDirs() {
    try {
      const configured = this.config.authDirs ?? (this.config.authFile ? [path.dirname(this.config.authFile)] : null);
      if (configured) return { configured, default: candidateAuthDirs() };
      return { configured: null, default: candidateAuthDirs(), desktop: defaultDesktopAuthDirs() };
    } catch (err) {
      return { error: String(err?.message ?? err) };
    }
  }

  /**
   * 引擎没起来时给出**能照着做**的报错，而不是让下游拿 null 的 core 抛晦涩 TypeError。
   *
   * 三种到达这里的情形，出路不同，所以分开说：
   *   - 用户显式停过              → 叫他 start 回来；
   *   - 启动失败（端口占用…）      → lastStartError 里有真因，摘第一行给他；
   *   - 其它（首次调用 / 失败后重试）→ 提示再试一次。
   */
  assertRunning(what) {
    if (this.started) return;
    if (this.stoppedByUser) {
      throw new Error(
        `the engine is stopped (stopped on request), so "${what}" has nothing to read. ` +
          `Call wb_engine with action=start to bring it back up.`,
      );
    }
    const first = this.lastStartError ? String(this.lastStartError).split("\n")[0] : null;
    throw new Error(
      `the engine is not running, so "${what}" has nothing to read. ` +
        (first ? `Last start error: ${first}` : `Call wb_engine with action=start to retry.`),
    );
  }

  /** 完整状态文档（账号行 + 模型 + shim + 账本）。面板主数据源。 */
  async status(region = "cn") {
    await this.ensureStarted();
    this.assertRunning("wb_status");
    if (!REGIONS.includes(region)) throw new Error(`unknown region "${region}"`);
    return poolWebStatus(this.deps(region), region);
  }

  /** 上游的 buildStatus：轻量总览，不查余额。 */
  async buildStatus(region = "cn", includeCredits = false) {
    await this.ensureStarted();
    this.assertRunning("wb_build_status");
    return buildStatus({
      pool: this.core.pool,
      catalog: this.core.catalogs[region],
      client: this.core.client,
      shim: this.shimInfo(region),
      includeCredits,
    });
  }

  /**
   * poolWebStatus 的依赖包。
   *
   * 上游把它传给 `registerPoolStatusRoute`（挂在 DSH web server 上）。
   * 这里同样形状，但只喂给 MCP 工具直接调用——省掉一层 HTTP 路由。
   *
   * ⚠️ 按区域构造（上游是写死的）：上游 `registerPoolStatusRoute` 传的是
   * `shim: () => shimInfo("cn")`，而 `poolWebStatus` 调 `deps.shim()` 时不带参数，
   * 于是**国际版页面显示的是国内 shim 的地址**。这里把 region 闭包进来修掉它。
   */
  deps(region = "cn") {
    return {
      pool: this.core.pool,
      catalogs: this.core.catalogs,
      client: this.core.client,
      shim: () => this.shimInfo(region),
      requests: () => this.requests.list(),
      requestLogFile: () => this.requests.file(),
      requestLogFailures: () => this.requests.failures(),
      outputProbes: () => this.probes.list(),
      queueStats: () => this.queueStats.list(),
      scheduler: () => this.core.scheduler.status(),
      runAutomation: () => this.core.scheduler.startRunAll(),
      runAutomationFor: (accountIds) => this.core.scheduler.startRunAll(accountIds),
      saveSelection: async (r, selection) => this.saveSelection(r, selection),
      setAccountDisabled: async (accountId, disabled) => this.setAccountDisabled(accountId, disabled),
      setCreditReserve: async (accountId, reserve) => this.setCreditReserve(accountId, reserve),
      resetCooldowns: () => this.resetCooldowns(),
    };
  }

  /* ── 操作 ─────────────────────────────────────────────────────── */

  async rescan() {
    await this.ensureStarted();
    this.assertRunning("wb_rescan");
    try {
      const accounts = await this.core.pool.scan();
      this.lastScan = { at: Date.now(), count: accounts.length, error: null };
      this.logger.info?.(`workbuddy-pool: discovered ${accounts.length} account(s)`);
      return { count: accounts.length, accounts: accounts.map((a) => this.toAccountSummary(a)) };
    } catch (err) {
      this.lastScan = { at: Date.now(), count: null, error: String(err?.message ?? err) };
      throw err;
    }
  }

  /** 账号摘要：**令牌一律不出现**在这个对象里。 */
  toAccountSummary(account) {
    return {
      id: account?.id,
      label: account?.label,
      region: account?.region,
      nickname: account?.credential?.nickname,
      uin: account?.credential?.uin,
      domain: account?.credential?.domain,
      expiresAt: account?.credential?.expiresAt,
    };
  }

  saveSelection(region, selection) {
    if (!REGIONS.includes(region)) throw new Error(`unknown region "${region}"`);
    const key = region === "cn" ? "modelSelectionCn" : "modelSelectionGlobal";
    const payload = {
      ...(selection?.enabledModelIds === undefined ? {} : { enabledModelIds: [...selection.enabledModelIds] }),
      ...(selection?.imageModelIds === undefined ? {} : { imageModelIds: [...selection.imageModelIds] }),
      ...(selection?.contextBudgets === undefined ? {} : { contextBudgets: { ...selection.contextBudgets } }),
    };
    this.config = { ...this.config, [key]: payload };
    writeConfigFile(this.config);
    if (this.core) this.core.catalogs[region].applySelection(payload);
    return this.getConfig();
  }

  setAccountDisabled(accountId, disabled) {
    const currentIds = this.config.disabledAccountIds ?? [];
    const next = disabled
      ? currentIds.includes(accountId)
        ? currentIds
        : [...currentIds, accountId]
      : currentIds.filter((id) => id !== accountId);
    return this.saveConfig({ disabledAccountIds: next });
  }

  setCreditReserve(accountId, reserve) {
    const reserves = { ...(this.config.creditReserves ?? {}) };
    if (reserve === null || reserve === undefined || reserve === 0) delete reserves[accountId];
    else reserves[accountId] = reserve;
    return this.saveConfig({ creditReserves: reserves });
  }

  resetCooldowns() {
    this.core?.pool.resetCooldowns();
    return { reset: true, at: Date.now() };
  }

  /** 立即跑积分自动化。不传 accountIds 就跑整个池。 */
  runAutomation(accountIds) {
    if (!this.core) throw new Error("engine not started");
    if (Array.isArray(accountIds) && accountIds.length > 0) this.core.scheduler.startRunAll(accountIds);
    else this.core.scheduler.startRunAll();
    return { started: true, at: Date.now(), accountIds: accountIds ?? null };
  }
}

export { REGIONS, paths };
