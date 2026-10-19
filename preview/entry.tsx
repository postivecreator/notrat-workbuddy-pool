/**
 * 画框预览入口：真 React + 假 MCP 数据，按《插件开发指南》实测的宿主尺寸铺画框。
 *   page(fullBleed) 1024 / right-panel 240·320·560 / popup 420
 * 非 fullBleed 的画框会画宿主标题条 —— 用来验证「壳归宿主，面板不再自画标题」。
 * 构建：node scripts/preview.mjs
 */
const React = require("react");
globalThis.React = React;
const { createRoot } = require("react-dom/client");

/* ── 假数据 ── */
const accountA = {
  id: "wb_01", label: "主号 · 138****2881", domain: "workbuddy.cn",
  cooling: false, disabled: false, restricted: false, authDead: false, reserved: false,
  expiresAt: Date.now() + 86400000 * 12, rateLimitHits: 0, serverErrorHits: 1, creditReserve: 200,
  credits: { total: 4820, packages: [{ packageName: "专业版", remain: 3820, size: 5000 }, { packageName: "赠送", remain: 1000, size: 1000 }] },
  checkin: { todayCheckedIn: true, todayCredit: 100, streakDays: 7 },
};
const accountB = {
  id: "wb_02", label: "小号 · 186****0912", domain: "workbuddy.cn",
  cooling: true, disabled: false, restricted: false, authDead: false, reserved: false,
  expiresAt: Date.now() + 86400000 * 3, rateLimitHits: 4, serverErrorHits: 0, creditReserve: 50,
  credits: { total: 1360, packages: [{ packageName: "体验包", remain: 360, size: 500 }] },
  checkin: { todayCheckedIn: false, todayCredit: 0, streakDays: 2 },
};
const accountC = {
  id: "wb_03", label: "备用 · 133****7745", domain: "workbuddy.cn",
  cooling: false, disabled: true, restricted: false, authDead: true, reserved: true,
  expiresAt: Date.now() - 86400000, rateLimitHits: 0, serverErrorHits: 0, creditReserve: 0,
  credits: { total: 120, packages: [] },
  checkin: { todayCheckedIn: false, todayCredit: 0, streakDays: 0 },
};

const models = [
  { id: "glm-4.6", contextWindow: 200000, maxOutputTokens: 32000, supportsImages: true, servableAccounts: 2, enabled: true },
  { id: "glm-4.5-air", contextWindow: 128000, maxOutputTokens: 16000, supportsImages: true, servableAccounts: 2, enabled: true },
  { id: "glm-4.5", contextWindow: 128000, maxOutputTokens: 16000, supportsImages: false, servableAccounts: 1, enabled: true },
  { id: "glm-4-flash", contextWindow: 64000, maxOutputTokens: 8000, supportsImages: false, servableAccounts: 0, enabled: true },
];

const requests = [
  { model: "glm-4.6", accountLabel: "主号", ok: true, totalMs: 1840, attempts: 1, ts: Date.now() - 20000 },
  { model: "glm-4.6", accountLabel: "小号", ok: false, totalMs: 820, attempts: 2, ts: Date.now() - 60000 },
  { model: "glm-4.5-air", accountLabel: "主号", ok: true, totalMs: 640, attempts: 1, ts: Date.now() - 120000 },
];

const payloads = {
  wb_status: {
    summary: { accounts: 3, available: 1, creditTotal: 6300, cooling: 1, disabled: 1, spent: 0, reserved: 1, rateLimitHits: 4, serverErrorHits: 1, clearable: true },
    accounts: [accountA, accountB, accountC],
    models,
    requests,
    usage: { today: 1310 },
    automation: { enabled: true, lastRunAt: Date.now() - 3600000, runs: 12 },
    trend: { days: 7, total: 4180, max: 900, points: [320, 900, 480, 120, 760, 540, 410].map((v, i) => ({ date: "10-" + (10 + i), value: v })) },
  },
  wb_engine: { started: true, stoppedByUser: false, info: {} },
  /* 开局一站式：面板首屏就靠它决定"下一步做什么" */
  wb_bootstrap: {
    ok: true, started: true, stoppedByUser: false, region: "cn", recommendedRegion: "cn",
    counts: { cn: 3, global: 0 }, accountCount: 3, scanned: true, scanCount: 3,
    wiring: { ready: true, providerId: "notrat-workbuddy-pool", displayName: "积分池", modelCount: 4 },
    verdict: "就绪：3 个账号，4 个模型可接",
  },
  wb_wiring: {
    ready: true, providerId: "notrat-workbuddy-pool", displayName: "积分池",
    baseUrl: "http://127.0.0.1:8130/v1", apiKey: "sk-loopback-1234abcd",
    models: models.map((m) => m.id), modelCount: 4,
  },
  wb_performance: { byModel: [] },
};

/* 「引擎在跑但扫不到号」——新手第一屏最可能撞上的状态，必须画出来看文案 */
const reusedPayloads = {
  wb_status: { summary: {}, accounts: [], models: [], requests: [], usage: {}, automation: {} },
  wb_engine: { started: false, stoppedByUser: false },
  wb_wiring: { ready: false },
  wb_bootstrap: {
    ok: false, started: false, portBusy: true, reused: true, reusedPort: 8130, region: "cn", recommendedRegion: "cn",
    counts: {}, hint: "端口 8130 上已经有一个积分池在跑（可能是 Notrat 的另一个窗口/面板，或旧实例）。这个面板不用重复启动 —— 直接去聊天框选「积分池」就能用；要管理账号请回到那个窗口。",
  },
};

const emptyPayloads = {
  wb_status: { summary: {}, accounts: [], models: [], requests: [], usage: {}, automation: {} },
  wb_engine: { started: true, stoppedByUser: false, info: {} },
  wb_wiring: { ready: false, hint: "还没有账号，接不上" },
  wb_bootstrap: {
    ok: false, started: true, stoppedByUser: false, region: "cn", recommendedRegion: "cn",
    counts: { cn: 0, global: 0 }, accountCount: 0, scanned: true, scanCount: 0,
    wiring: { ready: false, reason: "no account" },
    verdict: "引擎在跑，但没找到已登录的账号",
  },
};

globalThis.window.electronAPI = {
  mcp: {
    callTool: function (sid, tool) {
      if (sid === "slow") return new Promise(function () {});
      const bag = sid === "empty" ? emptyPayloads : sid === "reused" ? reusedPayloads : payloads;
      return Promise.resolve({ content: [{ type: "text", text: JSON.stringify(bag[tool] || {}) }] });
    },
  },
};
globalThis.window.addEventListener = function () {};
globalThis.window.removeEventListener = function () {};
globalThis.window.dispatchEvent = function () {
  return true;
};
globalThis.window.localStorage = {
  getItem: function (k) {
    if (k === "notrat-ai-config") {
      return JSON.stringify({
        currentProvider: "zhipu",
        providers: [{ id: "zhipu", name: "智谱清言", type: "custom", baseUrl: "https://x", apiKey: "k", models: [] }],
      });
    }
    return null;
  },
  setItem: function () {},
};

const mod = require("../panels/pool.tsx");
const Panel = mod.default || mod.PoolPanel;

/* ── 画框：尺寸取自插件开发指南「每个位置一张」 ── */
const FRAMES = [
  { key: "page", label: "page · fullBleed 1024", w: 1024, h: 660, fullBleed: true },
  { key: "rp240", label: "right-panel 240", w: 240, h: 560, hostTitle: "积分池" },
  { key: "rp320", label: "right-panel 320", w: 320, h: 560, hostTitle: "积分池" },
  { key: "rp560", label: "right-panel 560", w: 560, h: 560, hostTitle: "积分池" },
  { key: "popup", label: "popup 420", w: 420, h: 520, hostTitle: "积分池" },
  { key: "models320", label: "right-panel 320 · 模型页", w: 320, h: 520, hostTitle: "积分池", tab: "models" },
  { key: "wire320", label: "right-panel 320 · 接入页", w: 320, h: 520, hostTitle: "积分池", tab: "wire" },
  { key: "simple240", label: "right-panel 240 · 简单视图", w: 240, h: 480, hostTitle: "积分池", simple: true },
  { key: "loading", label: "right-panel 320 · 首屏加载中", w: 320, h: 420, hostTitle: "积分池", slow: true },
  { key: "noconn", label: "right-panel 320 · 连接器未就绪", w: 320, h: 340, hostTitle: "积分池", noServer: true },
  { key: "empty", label: "right-panel 320 · 扫过了没账号（新手态）", w: 320, h: 480, hostTitle: "积分池", empty: true, simple: true },
  { key: "reused", label: "right-panel 320 · 已有实例在跑", w: 320, h: 300, hostTitle: "积分池", reused: true, simple: true },
];

function HostFrame(f) {
  return React.createElement(
    "article",
    { className: "pv-item", style: { display: "flex", flexDirection: "column", gap: 6 } },
    React.createElement("div", { style: { fontSize: 11, opacity: 0.55, letterSpacing: ".04em" } }, f.label),
    React.createElement(
      "div",
      {
        className: "pv-host",
        style: {
          width: f.w,
          height: f.h,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderRadius: 10,
          border: "1px solid hsl(var(--border))",
          background: "hsl(var(--card))",
        },
      },
      /* 宿主标题条：非 fullBleed 由宿主画（面板不该再画一层） */
      f.hostTitle
        ? React.createElement(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "0 10px",
                height: 32,
                flexShrink: 0,
                borderBottom: "1px solid hsl(var(--border))",
                background: "hsl(var(--sidebar-background))",
                fontSize: 12,
                fontWeight: 600,
              },
            },
            f.hostTitle,
            React.createElement("span", { style: { marginLeft: "auto", opacity: 0.4, fontSize: 11 } }, "⋯"),
          )
        : null,
      React.createElement(
        "div",
        {
          className: "pv-viewport",
          style: { flex: "1 1 auto", minHeight: 0, minWidth: 0, overflow: "auto", display: "flex", flexDirection: "column" },
        },
        React.createElement(Panel, {
          serverId: f.noServer ? "" : f.slow ? "slow" : f.empty ? "empty" : f.reused ? "reused" : "fake",
          initialAdvanced: !f.simple,
          initialTab: f.tab || "accounts",
          ctx: { app: { locale: "zh" } },
        }),
      ),
    ),
  );
}

function App() {
  return React.createElement(
    "div",
    { style: { display: "flex", flexWrap: "wrap", gap: 20, padding: 22, alignItems: "flex-start" } },
    FRAMES.map((f, i) => React.createElement(HostFrame, Object.assign({ key: i }, f))),
  );
}

createRoot(document.getElementById("root")).render(React.createElement(App));
