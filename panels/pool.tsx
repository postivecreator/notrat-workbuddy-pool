/**
 * WorkBuddy 积分池 · 主面板
 * ============================================================================
 * 挂载：manifest.contributions.ui[]
 *   { id:"wb-panel", location:"right-panel" } + { id:"wb-page", location:"page" }
 *
 * 数据通路：window.electronAPI.mcp.callTool(props.serverId, tool, args)
 *   返回 MCP 信封 { content:[{ type:"text", text:"<JSON>" }] } → unpack() 解成 payload
 *
 * ⚠️ 本文件**不 import 任何模块**：宿主只注入 React。UI 走 Notrat Panel Kit v3
 *    （由 .notrat/ui-kit/nrx-kit.tsx 注入，见下方占位符）。
 * ⚠️ 样式全部内联 + 一个 <style> 注入：Tailwind 不扫描插件源码，写工具类不会生效。
 * ⚠️ 主题色一律走 `hsl(var(--...))`：写死颜色在浅色主题下会瞎。
 *
 * 字段名全部来自对真实 payload 的探针（tests/_probe_status.mjs），不是凭印象写的 ——
 * 猜错字段名的后果是界面一片空白，而空白不报错、只会让人以为"没数据"。
 */
const { useState, useEffect, useCallback, useRef, useMemo } = React;

// ═══════════════════════════════════════════════════════════════════════════
// Notrat Panel Kit v3 ·「Studio」设计系统（被 build-panels.mjs 注入各面板顶部）
// ───────────────────────────────────────────────────────────────────────────
// 设计依据：ui-ux-pro-max（Developer Tool / IDE 方向）
//   · 主风格 Dark Mode + Minimalism，辅 Flat Design + Micro-interactions
//   · 功能色（成功 / 警告 / 错误）只表达状态；焦点环统一用 --ring（蓝）
//   · 数据（路径 / 时长 / LUFS / KB）一律等宽 mono；控件与正文走系统 sans
//   · Real-Time Monitor + Terminal：运行日志 = 一个终端窗口
//   · 空状态必须给「下一步动作」；>300ms 的异步等待必须有 spinner / 进度条
// 硬规则：
//   1) 颜色只用宿主 CSS 变量，零硬编码色值 → 自动跟随明暗主题与主题色
//      ⚠️ --status-*-bg / --status-*-border 自带 alpha（"142 76% 36% / .12"），
//         再拼一层 "hsl(var(--x) / .5)" 会变成非法值、整块底色失效。
//   2) 图标一律内联 SVG（currentColor 描边），不用 emoji 当图标
//   3) 可点元素必须有 hover / focus 态（键盘可达），禁用态降透明 + not-allowed
//   4) 间距走 4px 栅格；圆角只用 RAD.ctl|md|lg（6/8/10）；字号只用 FS.xs|sm|base|title
//      （11/12/13/15），数字另走 mono 的 13/19/26 三档。
//   5) 密集面板里**不要给卡片加阴影**：阴影表示"浮起来"，这里没有浮起来的东西。
//      层级靠 1px 发丝线（hair / hairSoft）+ 留白，不靠框套框。
//   6) 对比度：正文 ≥4.5:1。muted-foreground 落在 muted 底上只有 4.16:1，
//      压在 sunken 上的文字统一用 T.onSunken。
//   视觉验收：node scripts/preview.mjs --shot → 截图；node scripts/probe-layout.mjs → 量字号/溢出/对比度
// ═══════════════════════════════════════════════════════════════════════════

const T = {
  bg: "hsl(var(--background))",
  surface: "hsl(var(--card))",
  sunken: "hsl(var(--muted))",
  fg: "hsl(var(--foreground))",
  /* 有些主题的 muted-foreground 压在卡片上只有 4.17（樱花浅色实测）；
     往 foreground 混 20% 后仍是次要色，但稳过 AA 4.5。 */
  muted: "color-mix(in srgb, hsl(var(--muted-foreground)) 78%, hsl(var(--foreground)))",
  faint: "color-mix(in srgb, hsl(var(--muted-foreground)) 78%, hsl(var(--foreground)) / .88)",
  border: "hsl(var(--border))",
  borderSoft: "hsl(var(--border) / .55)",
  /* 密集面板只用「发丝线」分级：hair 用于区块边界，hairSoft 用于块内分隔 */
  hair: "hsl(var(--border) / .75)",
  hairSoft: "hsl(var(--border) / .45)",
  /* muted-foreground 落在 muted 底上只有 4.16:1；压在 sunken 上的字统一用它 */
  onSunken: "hsl(var(--foreground) / .72)",
  primary: "hsl(var(--primary))",
  primaryFg: "hsl(var(--primary-foreground))",
  wash: "hsl(var(--primary) / .10)",
  washBd: "hsl(var(--primary) / .30)",
  ring: "hsl(var(--ring, 215 95% 55%))",
  fill1: "var(--fill-primary)",
  fill2: "var(--fill-secondary)",
  ok: "hsl(var(--status-success-text, 142 76% 26%))",
  okBg: "hsl(var(--status-success-bg, 142 76% 36% / .12))",
  okBd: "hsl(var(--status-success-border, 142 76% 36% / .25))",
  warn: "hsl(var(--status-warning-text, 38 92% 30%))",
  warnBg: "hsl(var(--status-warning-bg, 38 92% 50% / .12))",
  warnBd: "hsl(var(--status-warning-border, 38 92% 50% / .25))",
  bad: "hsl(var(--status-error-text, 0 84% 45%))",
  badBg: "hsl(var(--status-error-bg, 0 84% 60% / .12))",
  badBd: "hsl(var(--status-error-border, 0 84% 60% / .25))"
};
const SH = { sm: "var(--shadow-sm)", md: "var(--shadow-md)", lg: "var(--shadow-lg)" };
/* 规范：120–200ms、ease-out；颜色变化保留（细粒度状态反馈），不碰布局属性 */
/* 规范：只动 transform / opacity，120–200ms、ease-out。
   颜色切换改成即时 —— 140ms 的颜色过渡在密集面板里会显得"发黏"。 */
const TR = "opacity 140ms cubic-bezier(0,0,.2,1), transform 140ms cubic-bezier(0,0,.2,1)";
const FONT = '13px/1.6 ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
/* 字号只留四档 + 一个 hero 数字档：11 元信息 / 12 次要 / 13 正文 / 15 区块标题 / 26 主数字 */
const FS = { xs: 11, sm: 12, base: 13, title: 15, hero: 26 };
/* 规范：控件 8，卡片 10–12，浮层 14–16 */
const RAD = { ctl: 8, card: 10, pop: 14 };
const MONO = '11.5px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

/* 运行时样式：只放内联样式写不了的东西（@keyframes / reduced-motion）。
   注入失败（CSP 等）静默降级，不影响功能。 */
function usePanelCss() {
  useEffect(function () {
    try {
      if (typeof document === "undefined" || document.getElementById("nrx-panel-css")) return;
      const st = document.createElement("style");
      st.id = "nrx-panel-css";
      st.textContent =
        "@keyframes nrx-spin{to{transform:rotate(360deg)}}" +
        "@keyframes nrx-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}" +
        "@media (prefers-reduced-motion: reduce){*{animation-duration:.001ms !important;transition-duration:.001ms !important}}" +
        /* 规范原话：outline: 2px solid hsl(var(--ring)); outline-offset: 2px。
           内联样式没有 :focus-visible → 统一在这里给（键盘可达、鼠标点击不闪）。 */
        ".nrx-page button:focus-visible,.nrx-page [role=button]:focus-visible,.nrx-page input:focus-visible,.nrx-page select:focus-visible,.nrx-page textarea:focus-visible,.nrx-page summary:focus-visible,.nrx-page a:focus-visible{outline:2px solid hsl(var(--ring,215 95% 55%)) !important;outline-offset:2px}" +
         /* 主按钮：浅色主题白字压在 55% 的主色上只有 4.03:1 → 底色压深；
            暗色主题的 --primary-foreground 是深字、主色更亮（60%）→ 用原色即可 5.7:1。
            一条 html.dark 覆盖，两档都过 AA。 */
         ".nrx-page .nrx-btn-primary{background:" + PRIMARY_FILL() + " !important}" +
         ".nrx-page .nrx-btn-primary:hover{background:" + PRIMARY_FILL(-9) + " !important}" +
         "html.dark .nrx-page .nrx-btn-primary{background:hsl(var(--primary)) !important}" +
         "html.dark .nrx-page .nrx-btn-primary:hover{background:hsl(var(--primary) / .88) !important}" +
        /* 打通「整页宿主」的高度链：宿主那两层壳都是普通 block（height:auto），
           面板根的 height:100% 会被解析成 auto → 撑破后被 overflow:hidden 裁掉、滚不动。
           用 :has() 精准命中「包含本面板」的页面壳，把两层变成长度可传递的 flex；
           下面 usePanelFill 还有一条不依赖 :has 的 DOM 兜底。 */
        ".notrat-plugin-page:has(.nrx-page){display:flex;flex-direction:column}" +
        ".notrat-plugin-page:has(.nrx-page)>.notrat-plugin-panel{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}" +
        ".notrat-plugin-page:has(.nrx-page)>.notrat-plugin-panel>.notrat-plugin-panel-body{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}";
      document.head.appendChild(st);
    } catch (e) { /* 静默 */ }
  }, []);
}

/* ── 铺满「整页宿主」 ───────────────────────────────────────────────────────
   宿主（Notrat PluginUiHosts / PluginSidebarPanels，chromeless 分支）是：
     .notrat-plugin-page → .notrat-plugin-panel → .notrat-plugin-panel-body → 我们的根
   中间两层是普通 block（height:auto），所以根的 height:100% 解析不出来 —— 内容长高就被
   宿主的 overflow:hidden 裁掉，表现为「整页滚不动」。修法见 usePanelCss 里的 :has 规则，
   下面再加一条 DOM 兜底（不依赖 :has 支持），卸载即还原，只动本面板所在的页面壳。 */

/* ── 宽度分档 ───────────────────────────────────────────────────────────────
   规范：面板是 Notrat 的一部分，可能被右键「移动到…」搬到 240 的右栏或 1024 的
   整页，所以版式按**容器宽度**自适应，而不是按 location 写死。
     narrow < 320：单列、表格换堆叠行（240 宽不许横向滚动）
     mid    320–700：单列 + 表格
     wide   > 700：加 1024 版心与 16px 留白，账号卡两栏（整页宿主）
   首帧宽度未知按 mid 处理，避免先渲染成窄版再跳。 */
function useWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(function () {
    const el = ref && ref.current;
    if (!el) return;
    const read = function () {
      setW(el.clientWidth || 0);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return function () {
      ro.disconnect();
    };
  }, [ref]);
  return w;
}
function bucketOf(w) {
  if (!w) return "mid";
  if (w < 320) return "narrow";
  if (w > 700) return "wide";
  return "mid";
}

const PAGE_ROOT = { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0, width: "100%", overflow: "hidden", boxSizing: "border-box" };

function usePanelFill() {
  const ref = useRef(null);
  usePanelCss();
  useEffect(function () {
    const el = ref.current;
    if (!el || typeof el.closest !== "function") return;
    const page = el.closest(".notrat-plugin-page");
    if (!page) return; /* 非整页宿主（悬浮窗 / 弹窗 / 侧栏）→ 各自容器已给高度 */
    const touched = [];
    let n = el.parentElement;
    while (n && n !== page) {
      const cls = n.classList;
      if (cls && (cls.contains("notrat-plugin-panel") || cls.contains("notrat-plugin-panel-body"))) {
        touched.push([n, n.getAttribute("style") || ""]);
        n.style.display = "flex";
        n.style.flexDirection = "column";
        n.style.flex = "1 1 auto";
        n.style.minHeight = "0";
      }
      n = n.parentElement;
    }
    return function () {
      touched.forEach(function (t) {
        if (t[1]) t[0].setAttribute("style", t[1]);
        else t[0].removeAttribute("style");
      });
    };
  }, []);
  return ref;
}

/* ── 图标：内联 SVG，24×24 线性，currentColor ── */
const ICON = {
  deck: <g><rect x="3" y="3.5" width="18" height="12" rx="2" /><path d="M12 15.5V20" /><path d="M8.5 20h7" /></g>,
  spark: <g><path d="M11.5 3l1.5 4.2 4.2 1.5-4.2 1.5L11.5 14.4 10 10.2 5.8 8.7 10 7.2 11.5 3Z" /><path d="M18.2 15.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6.6-1.7Z" /></g>,
  folder: <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h7A1.5 1.5 0 0 1 19 9.5v8A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5v-10Z" />,
  plug: <g><path d="M9 3v6M15 3v6" /><path d="M6 9h12v3a6 6 0 0 1-12 0V9Z" /><path d="M12 18v3" /></g>,
  check: <path d="M4.5 12.5l4.5 4.5L19.5 6.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  alert: <g><path d="M12 3.5 21 19H3l9-15.5Z" /><path d="M12 10v4.2M12 16.6h.01" /></g>,
  info: <g><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 8h.01" /></g>,
  chevD: <path d="M6 9.5l6 6 6-6" />,
  chevR: <path d="M9 6l6 6-6 6" />,
  chevL: <path d="M15 6l-6 6 6 6" />,
  chevU: <path d="M6 14.5l6-6 6 6" />,
  open: <g><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5.5A1.5 1.5 0 0 1 16.5 21h-11A1.5 1.5 0 0 1 4 19.5v-11A1.5 1.5 0 0 1 5.5 7H11" /></g>,
  copy: <g><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" /></g>,
  loader: <path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M6 6l2.1 2.1M15.9 15.9L18 18M18 6l-2.1 2.1M8.1 15.9L6 18" />,
  bolt: <path d="M13.5 2.5 5 13.5h5l-1 8 8.5-11h-5l1-8Z" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  play: <path d="M8 5.5l10 6.5-10 6.5v-13Z" />,
  pause: <path d="M9.5 5v14M14.5 5v14" />,
  file: <g><path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" /><path d="M13.5 3v5.5H19" /></g>,
  log: <g><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9.5l2.5 2.5L7 14.5M12.5 15H17" /></g>,
  image: <g><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5" /></g>,
  text: <g><path d="M5 6.5h14M5 12h9M5 17.5h11" /></g>,
  mic: <g><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0" /><path d="M12 17.5V21M9 21h6" /></g>,
  wave: <path d="M3 12h2.5l2-6 3 12 2.5-8 1.5 3.5H21" />,
  scissors: <g><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="6.5" cy="17.5" r="2.5" /><path d="M8.7 8.2 20 18M8.7 15.8 20 6" /></g>,
  upload: <g><path d="M12 16V4" /><path d="M7.5 8.5 12 4l4.5 4.5" /><path d="M4 16v3.5A1.5 1.5 0 0 0 5.5 21h13A1.5 1.5 0 0 0 20 19.5V16" /></g>,
  download: <g><path d="M12 4v12" /><path d="M7.5 11.5 12 16l4.5-4.5" /><path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13A1.5 1.5 0 0 0 20 19.5V17" /></g>,
  settings: <g><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1" /></g>,
  refresh: <g><path d="M20 11a8 8 0 0 0-13.7-5.2L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 13.7 5.2L20 16" /><path d="M20 20v-4h-4" /></g>,
  trash: <g><path d="M4.5 7h15" /><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" /><path d="M6.5 7l.8 12A1.5 1.5 0 0 0 8.8 20.5h6.4A1.5 1.5 0 0 0 16.7 19l.8-12" /></g>,
  plus: <path d="M12 5v14M5 12h14" />,
  clock: <g><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></g>,
  tag: <g><path d="M12.6 3.5H20v7.4l-8.6 8.6a1.5 1.5 0 0 1-2.1 0l-5.3-5.3a1.5 1.5 0 0 1 0-2.1l8.6-8.6Z" /><path d="M16.5 7.5h.01" /></g>,
  globe: <g><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5S14.4 18.1 12 20.5C9.6 18.1 8.4 15.2 8.4 12S9.6 5.9 12 3.5Z" /></g>,
  film: <g><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M8 5v14M16 5v14M3.5 12h17" /></g>,
  list: <g><path d="M8 6.5h11M8 12h11M8 17.5h11" /><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" /></g>,
  search: <g><circle cx="11" cy="11" r="6.5" /><path d="M15.8 15.8 20 20" /></g>,
  edit: <g><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="M14.5 6.5l3 3" /></g>,
  shield: <g><path d="M12 3.5 19 6v6c0 4-3 7.4-7 8.5-4-1.1-7-4.5-7-8.5V6l7-2.5Z" /><path d="M9 12l2 2 4-4" /></g>,
  wand: <g><path d="M4 20 15 9" /><path d="M17.5 3.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" /></g>,
  volume: <g><path d="M5 9.5h3l4-3.5v12l-4-3.5H5v-5Z" /><path d="M15.5 9a4 4 0 0 1 0 6" /></g>,
  grid: <g><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></g>,
  undo: <g><path d="M4 10.2h9.6a5.4 5.4 0 1 1 0 10.8H9.4" /><path d="M8.2 5.6 3.6 10.2l4.6 4.6" /></g>,
  dot: <circle cx="12" cy="12" r="3.4" />
};
function Icon(p) {
  const s = p.s || 14;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={p.w || 1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={Object.assign({ flexShrink: 0, display: "block" }, p.style || {})}>
      {ICON[p.n] || null}
    </svg>
  );
}

/* ── 交互态：内联样式写不了 :hover / :focus，用状态实现（键盘可达） ── */
function useInt() {
  const [hov, setHov] = useState(false);
  const [foc, setFoc] = useState(false);
  const [act, setAct] = useState(false);
  return {
    hov: hov, foc: foc, act: act,
    bind: {
      onMouseEnter: function () { setHov(true); },
      onMouseLeave: function () { setHov(false); setAct(false); },
      onMouseDown: function () { setAct(true); },
      onMouseUp: function () { setAct(false); },
      onFocus: function () { setFoc(true); },
      onBlur: function () { setFoc(false); }
    }
  };
}
function ringStyle() {
  /* 焦点环交给 usePanelCss 里的 :focus-visible —— 键盘可达由 CSS 保证，
     不再用 boxShadow 伪焦点（它跟着 hover 状态走，键盘用户看不到）。 */
  return {};
}

/* 主按钮底色：把主题主色压深，让白字稳过 4.5:1。
   深色主题的 --primary 更亮（60% vs 55%），所以混合比例要压到 62%
   —— 四套主题（极简浅/深、日落橙深、樱花浅）实测都 ≥4.5 才定这个值。 */
const PRIMARY_MIX = 62;
function PRIMARY_FILL(delta) {
  const pct = PRIMARY_MIX + (typeof delta === "number" ? delta : 0);
  return "color-mix(in srgb, hsl(var(--primary)) " + pct + "%, #0b1220)";
}

/* ── 按钮 ── */
const BTN_KIND = {
  /* 白字压在 HSL(215 95% 55%) 上只有 4.0:1 —— 压深到 ~44% 才过 4.5:1。 */
  primary: { background: PRIMARY_FILL(), color: T.primaryFg, border: "1px solid transparent" },
  soft: { background: T.fill2, color: T.fg, border: "1px solid " + T.hair },
  outline: { background: "transparent", color: T.fg, border: "1px solid " + T.border },
  ghost: { background: "transparent", color: T.muted, border: "1px solid transparent" },
  danger: { background: T.badBg, color: T.bad, border: "1px solid " + T.badBd }
};
function btnHover(kind) {
  if (kind === "primary") return { background: PRIMARY_FILL(-6) };
  if (kind === "soft") return { background: T.fill1, borderColor: T.border };
  if (kind === "outline") return { background: T.fill2, borderColor: T.border };
  if (kind === "danger") return { filter: "saturate(1.15)" };
  return { background: T.fill2, color: T.fg };
}
function Btn(p) {
  const it = useInt();
  const kind = p.kind || "outline";
  const size = p.size || "md";
  const off = !!(p.disabled || p.loading);
  const base = BTN_KIND[kind] || BTN_KIND.outline;
  /* 纯图标按钮（无文字子节点）：平方热区 + 由 title 兜 aria-label */
  const iconOnly = !p.children && !!(p.icon || p.loading);
  const st = Object.assign({}, {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    gap: size === "sm" ? 5 : 6,
    /* 规范：紧凑位 26–30、整页/弹窗 32–36；纯图标热区 ≥28×28 */
    minHeight: iconOnly ? 28 : size === "sm" ? 26 : size === "lg" ? 34 : 30,
    minWidth: iconOnly ? 28 : undefined,
    padding: iconOnly ? 0 : size === "sm" ? "3px 8px" : size === "lg" ? "8px 15px" : "5px 11px",
    fontSize: size === "sm" ? FS.sm : FS.base,
    fontWeight: kind === "primary" ? 600 : 500,
    fontFamily: "inherit", lineHeight: 1.2, borderRadius: RAD.ctl, whiteSpace: "nowrap",
    cursor: off ? "not-allowed" : "pointer", opacity: off ? 0.45 : 1,
    transition: TR, outline: "none", letterSpacing: ".01em"
  }, base, it.hov && !off ? btnHover(kind) : {},
    it.act && !off ? { transform: "translateY(.5px)" } : {},
    { boxShadow: it.foc ? "0 0 0 2px " + T.ring : "none" },
    p.full ? { width: "100%" } : {}, p.style || {});
  return (
    <button
      type="button"
      className={kind === "primary" ? "nrx-btn-primary" : undefined}
      title={p.title}
      aria-label={p.children ? undefined : p.title}
      disabled={off}
      onClick={p.onClick}
      style={st}
      {...it.bind}
    >
      {p.loading ? <Icon n="loader" s={size === "sm" ? 12 : 13} style={{ animation: "nrx-spin .9s linear infinite" }} /> : null}
      {!p.loading && p.icon ? <Icon n={p.icon} s={size === "sm" ? 12 : 13} /> : null}
      {p.children}
    </button>
  );
}

/* ── 状态胶囊 ── */
const PILL_TONE = {
  neutral: { background: T.fill2, color: T.muted, border: "1px solid " + T.hairSoft },
  brand: { background: T.wash, color: T.primary, border: "1px solid " + T.washBd },
  /* 注意：宿主的 --status-*-bg 已经是 "H S% L% / 0.12" 自带 alpha，
     再拼一层 / .55 会变成非法值 → 底色整块失效。这里直接用它。 */
  ok: { background: T.okBg, color: T.ok, border: "1px solid " + T.okBd },
  warn: { background: T.warnBg, color: T.warn, border: "1px solid " + T.warnBd },
  bad: { background: T.badBg, color: T.bad, border: "1px solid " + T.badBd }
};
function Pill(p) {
  return (
    <span title={p.title} style={Object.assign({
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "0 6px", height: 17, borderRadius: 999,
      fontSize: FS.xs, fontWeight: 600, lineHeight: "16px", letterSpacing: ".01em",
      whiteSpace: "nowrap"
    }, PILL_TONE[p.tone || "neutral"], p.style || {})}>
      {p.dot ? <span style={{ width: 4, height: 4, borderRadius: 999, background: "currentColor" }} /> : null}
      {p.icon ? <Icon n={p.icon} s={10} /> : null}
      {p.children}
    </span>
  );
}

/* ── 卡片 / 分区 ── */
function Card(p) {
  const coll = p.collapsible;
  const [open, setOpen] = useState(p.defaultOpen !== false);
  return (
    <section style={Object.assign({
      /* 密集面板里卡片不该有阴影：阴影表示"浮起来"，这里没有浮起来的东西 */
      border: "1px solid " + T.hair, borderRadius: RAD.card, background: T.surface,
      overflow: "hidden", display: "flex", flexDirection: "column", flexShrink: 0, minHeight: 0
    }, p.style || {})}>
      {p.title ? (
        <header
          onClick={coll ? function () { setOpen(!open); } : undefined}
          style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 11px", flexShrink: 0, borderBottom: open ? "1px solid " + T.hairSoft : "none", cursor: coll ? "pointer" : "default", userSelect: "none" }}>
          {p.icon ? <span style={{ display: "flex", width: 18, height: 18, alignItems: "center", justifyContent: "center", borderRadius: 5, background: T.wash, color: T.primary }}><Icon n={p.icon} s={11} /></span> : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: FS.sm, fontWeight: 600, letterSpacing: ".01em" }}>{p.title}</div>
            {p.desc ? <div style={{ fontSize: FS.xs, color: T.faint, marginTop: 1, lineHeight: 1.5 }}>{p.desc}</div> : null}
          </div>
          {coll ? <Icon n={open ? "chevU" : "chevD"} s={12} style={{ color: T.faint }} /> : null}
          {p.right ? <div onClick={function (e) { e.stopPropagation(); }}>{p.right}</div> : null}
        </header>
      ) : null}
      {/* 内容层自己可滚：卡片被拉伸（flex:1）时长内容不会撑破卡片；卡片自然高度时不会出现滚动条 */}
      {open ? <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: p.flush ? 0 : 11, display: "flex", flexDirection: "column", gap: 8 }}>{p.children}</div> : null}
    </section>
  );
}

/* ── 表单 ── */
function Field(p) {
  return (
    <label style={{ display: "block", minWidth: 0 }}>
      {p.label ? (
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: T.muted, letterSpacing: ".02em" }}>{p.label}</span>
          {p.hint ? <span style={{ fontSize: FS.xs, color: T.faint }}>{p.hint}</span> : null}
        </div>
      ) : null}
      {p.children}
    </label>
  );
}
function useFieldStyle() {
  const it = useInt();
  return {
    bind: it.bind,
    style: Object.assign({
      width: "100%", boxSizing: "border-box", padding: "6px 9px", fontSize: FS.base, fontFamily: "inherit",
      lineHeight: 1.45, borderRadius: 7, background: T.bg, color: T.fg, border: "1px solid " + T.border,
      outline: "none", transition: TR, boxShadow: "none"
    }, it.hov && !it.foc ? { background: T.fill2 } : {}, it.foc ? { borderColor: T.primary, boxShadow: "0 0 0 3px " + T.ring } : {})
  };
}
function Inp(p) {
  const f = useFieldStyle();
  return <input type={p.type || "text"} value={p.value} placeholder={p.placeholder} min={p.min} max={p.max} step={p.step}
    title={p.title} disabled={p.disabled} onChange={p.onChange} onKeyDown={p.onKeyDown}
    style={Object.assign({}, f.style, p.mono ? { fontFamily: MONO, fontSize: 12 } : {}, p.style || {})} {...f.bind} />;
}
function Area(p) {
  const f = useFieldStyle();
  return <textarea rows={p.rows || 4} value={p.value} placeholder={p.placeholder} readOnly={p.readOnly}
    onChange={p.onChange} onKeyDown={p.onKeyDown} spellCheck={false}
    style={Object.assign({}, f.style, { resize: "vertical", minHeight: 64, lineHeight: 1.6, fontFamily: p.mono ? MONO : "inherit" }, p.style || {})} {...f.bind} />;
}
function Sel(p) {
  const f = useFieldStyle();
  return <select value={p.value} onChange={p.onChange} title={p.title}
    style={Object.assign({}, f.style, { cursor: "pointer" }, p.style || {})} {...f.bind}>{p.children}</select>;
}
function Check(p) {
  const it = useInt();
  return (
    <label style={Object.assign({
      display: "flex", alignItems: "center", gap: 8, padding: "6px 9px", borderRadius: 8, fontSize: FS.base,
      cursor: "pointer", border: "1px solid " + (p.checked ? T.washBd : T.borderSoft), transition: TR,
      background: p.checked ? T.wash : it.hov ? T.fill2 : "transparent"
    }, p.style || {})} {...it.bind}>
      <input type="checkbox" checked={!!p.checked} onChange={function (e) { p.onChange(e.target.checked); }}
        style={{ accentColor: T.primary, width: 14, height: 14, cursor: "pointer", margin: 0 }} />
      <span style={{ color: p.checked ? T.fg : T.muted }}>{p.label}{p.hint ? <span style={{ color: T.faint, marginLeft: 6, fontSize: 11 }}>{p.hint}</span> : null}</span>
    </label>
  );
}
/* 分段控件（模式切换） */
function SegItem(p) {
  const it = useInt();
  const on = p.on;
  return (
    <button type="button" title={p.title} disabled={p.disabled} onClick={function () { p.onChange(p.value); }} {...it.bind}
      style={Object.assign({
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
        padding: "3px 9px", minHeight: 26, borderRadius: 6, border: "1px solid transparent",
        fontSize: FS.sm, fontFamily: "inherit", cursor: p.disabled ? "not-allowed" : "pointer", transition: TR, lineHeight: 1.3,
        background: on ? T.surface : "transparent", color: on ? T.fg : T.onSunken, fontWeight: on ? 600 : 500,
        boxShadow: "none", opacity: p.disabled ? 0.5 : 1
      }, !on && it.hov ? { background: T.fill2, color: T.fg } : {}, ringStyle(it))}>
      {p.icon ? <Icon n={p.icon} s={11} /> : null}
      {p.label}
    </button>
  );
}
function Segmented(p) {
  return (
    <div style={Object.assign({ display: "inline-flex", gap: 2, padding: 2, borderRadius: RAD.card, background: T.sunken, border: "1px solid " + T.hairSoft }, p.style || {})}>
      {(p.items || []).map(function (it) {
        return <SegItem key={it.value} value={it.value} label={it.label} icon={it.icon} title={it.title} disabled={it.disabled}
          on={it.value === p.value} onChange={p.onChange} />;
      })}
    </div>
  );
}

/* ── 标签栏：下划线式（IDE 惯例）。胶囊组在 380px 里换行后像积木 ── */
function TabItem(p) {
  const it = useInt();
  const on = p.on;
  return (
    <button
      type="button"
      title={p.title}
      onClick={function () { p.onChange(p.value); }}
      {...it.bind}
      style={{
        flex: "1 1 0", minWidth: 0, padding: "7px 2px 6px", border: "none",
        background: "transparent", font: "inherit", cursor: "pointer",
        fontSize: FS.sm, fontWeight: on ? 600 : 500,
        color: on ? T.fg : it.hov ? T.fg : T.muted,
        transition: TR, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        /* inset 下划线：不占布局、不引起跳动 */
        boxShadow: on ? "inset 0 -2px 0 0 " + T.primary : "none",
        outline: it.foc ? "2px solid hsl(var(--primary) / .45)" : "none",
        outlineOffset: -2
      }}
    >
      {p.label}
    </button>
  );
}
function TabBar(p) {
  return (
    <div style={Object.assign({ display: "flex", alignItems: "stretch", borderBottom: "1px solid " + T.hair }, p.style || {})}>
      {(p.items || []).map(function (it) {
        return (
          <TabItem key={it.value} value={it.value} label={it.label} title={it.title}
            on={it.value === p.value} onChange={p.onChange} />
        );
      })}
    </div>
  );
}

/* ── 反馈 ── */
function Empty(p) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 9, padding: "26px 18px", textAlign: "center" }}>
      <div style={{ width: 44, height: 44, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", background: T.wash, color: T.primary, border: "1px solid " + T.washBd }}>
        <Icon n={p.icon || "spark"} s={20} w={1.6} />
      </div>
      <div style={{ fontSize: FS.base, fontWeight: 600 }}>{p.title}</div>
      {p.desc ? <div style={{ fontSize: FS.sm, color: T.muted, lineHeight: 1.7, maxWidth: 300 }}>{p.desc}</div> : null}
      {p.children}
    </div>
  );
}
function Banner(p) {
  const tone = p.tone === "ok"
    ? { b: T.okBd, bg: T.okBg, c: T.ok, i: "check" }
    : p.tone === "warn" ? { b: T.warnBd, bg: T.warnBg, c: T.warn, i: "alert" }
      : p.tone === "info" ? { b: T.borderSoft, bg: T.sunken, c: T.muted, i: "info" }
        : { b: T.badBd, bg: T.badBg, c: T.bad, i: "alert" };
  return (
    <div role={p.tone === "bad" ? "alert" : undefined} style={Object.assign({ display: "flex", gap: 7, alignItems: "flex-start", padding: "7px 9px", borderRadius: RAD.ctl, border: "1px solid " + tone.b, background: tone.bg }, p.style || {})}>
      <span style={{ color: tone.c, marginTop: 1 }}><Icon n={p.icon || tone.i} s={13} /></span>
      <div style={{ flex: 1, minWidth: 0, fontSize: FS.sm, lineHeight: 1.6, color: T.fg }}>{p.children}</div>
      {p.right}
    </div>
  );
}
function Progress(p) {
  const v = Math.max(0, Math.min(100, Number(p.value) || 0));
  const color = p.tone === "ok" ? T.ok : p.tone === "warn" ? T.warn : p.tone === "bad" ? T.bad : T.primary;
  return (
    <div style={Object.assign({ display: "flex", flexDirection: "column", gap: 4 }, p.style || {})}>
      <div style={{ height: p.thick ? 6 : 4, borderRadius: 999, background: T.sunken, overflow: "hidden" }}>
        <div style={{ width: v + "%", height: "100%", borderRadius: 999, background: color, transition: "width var(--duration-base, .2s) var(--ease-standard, ease)" }} />
      </div>
      {p.label ? <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, color: T.faint }}>
        <span>{p.label}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{v}%</span>
      </div> : null}
    </div>
  );
}
function Stat(p) {
  const color = p.tone === "ok" ? T.ok : p.tone === "warn" ? T.warn : p.tone === "bad" ? T.bad : T.fg;
  const hero = !!p.hero;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: hero ? 1 : 2, minWidth: 0, ...(p.style || {}) }}>
      <span style={{ fontSize: FS.xs, color: T.faint, letterSpacing: ".02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.label}</span>
      <span
        style={{ fontFamily: MONO_FAMILY, fontSize: hero ? FS.hero : FS.base, fontWeight: hero ? 600 : 500, color, fontVariantNumeric: "tabular-nums", letterSpacing: hero ? "-.03em" : 0, lineHeight: hero ? 1.15 : 1.45, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        title={typeof p.value === "string" ? p.value : undefined}
      >{p.value}</span>
    </div>
  );
}
function Step(p) {
  const done = p.done, active = !done && p.active;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 0" }}>
      <span style={{
        width: 22, height: 22, flexShrink: 0, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 11, fontWeight: 700, fontVariantNumeric: "tabular-nums",
        border: "1px solid " + (done ? "transparent" : active ? T.primary : T.border),
        background: done ? T.primary : active ? T.wash : "transparent",
        color: done ? T.primaryFg : active ? T.primary : T.faint, transition: TR
      }}>
        {done ? <Icon n="check" s={12} w={2.4} /> : p.n}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: FS.base, fontWeight: done || active ? 600 : 500, color: done || active ? T.fg : T.muted }}>{p.label}</div>
        {p.desc ? <div style={{ fontSize: 11, color: T.faint, marginTop: 1, wordBreak: "break-all" }}>{p.desc}</div> : null}
      </div>
      {p.right}
    </div>
  );
}

/* ── 运行日志（终端观感） ── */
function LogBox(p) {
  const ref = useRef(null);
  const lines = Array.isArray(p.lines) ? p.lines : String(p.text || "").split("\n").filter(Boolean);
  useEffect(function () {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length, p.text]);
  function toneOf(l) {
    if (/^[✓✅]/.test(l)) return T.ok;
    if (/^[⚠]/.test(l)) return T.warn;
    if (/^[⏹✗]/.test(l)) return T.bad;
    if (/^[▸]/.test(l)) return T.fg;
    return T.muted;
  }
  return (
    <div style={Object.assign({
      border: "1px solid " + T.borderSoft, borderRadius: 10, background: T.sunken, overflow: "hidden", display: "flex", flexDirection: "column", flexShrink: 0, minHeight: 0
    }, p.style || {})}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 10px", borderBottom: "1px solid " + T.borderSoft }}>
        <Icon n="log" s={12} style={{ color: T.faint }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: T.muted }}>{p.title || "运行日志"}</span>
        <span style={{ flex: 1 }} />
        {p.busy ? <Icon n="loader" s={12} style={{ color: T.warn, animation: "nrx-spin .9s linear infinite" }} /> : null}
        {p.right}
      </div>
      <div ref={ref} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 10px", font: MONO, display: "flex", flexDirection: "column", gap: 2 }}>
        {lines.length ? lines.map(function (l, i) {
          return <div key={i} style={{ color: toneOf(l), whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{l}</div>;
        }) : <div style={{ color: T.faint }}>{p.placeholder || "运行日志会显示在这里…"}</div>}
      </div>
    </div>
  );
}

const MONO_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

/* ═══════════════════════════════ 数据通路 ═══════════════════════════════ */

function unpack(res) {
  try {
    if (res == null) return { error: "无返回" };
    if (res && res.error && res.result == null) return { error: String(res.error) };
    const r = res && res.result != null ? res.result : res;
    let text = "";
    if (typeof r === "string") text = r;
    else if (r && typeof r === "object") {
      if (typeof r.content === "string") text = r.content;
      else if (Array.isArray(r.content)) {
        text = r.content.map((c) => (typeof c === "string" ? c : c && c.text ? c.text : "")).join("");
      } else if (typeof r.text === "string") text = r.text;
    }
    if (!text) return { error: "空返回" };
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

/** 调 MCP 工具。永不抛：失败也返回 { error }，由 UI 决定怎么显示。 */
function call(serverId, tool, args) {
  const mcp = window.electronAPI && window.electronAPI.mcp;
  if (!mcp || !mcp.callTool) return Promise.resolve({ error: "electronAPI.mcp 不可用" });
  return Promise.resolve(mcp.callTool(serverId, tool, args || {})).then(unpack, (e) => ({
    error: String((e && e.message) || e),
  }));
}

/* ═══════════════════════════════ 格式化 ═══════════════════════════════ */

function fmtInt(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("zh-CN");
}
function fmtMs(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return "—";
  const v = Number(ms);
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}
function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtAgo(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
  if (s < 3) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分前`;
  return `${Math.round(m / 60)} 小时前`;
}

const OUTCOME = {
  ok: { tone: "ok", label: "成功" },
  "client-cancelled": { tone: "neutral", label: "已取消" },
  rate_limited: { tone: "warn", label: "限流" },
  exhausted: { tone: "warn", label: "额度尽" },
  failed: { tone: "bad", label: "失败" },
};
function outcomeOf(o) {
  return OUTCOME[o] || { tone: "neutral", label: o || "—" };
}

/* ═══════════════════════════════ 小部件 ═══════════════════════════════ */

/** 14 天消耗迷你柱状图。没有数据时整块不渲染（调用方判断）。 */
function TrendBars(props) {
  const points = Array.isArray(props.points) ? props.points : [];
  const max = Math.max(1, Number(props.max) || 0);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 32 }}>
      {points.map((p, i) => (
        <div
          key={p.date || i}
          title={`${p.date || ""} · ${fmtInt(p.used)}`}
          style={{
            flex: "1 1 0",
            minWidth: 2,
            height: `${Math.max(3, (Number(p.used) / max) * 100)}%`,
            borderRadius: 2,
            background: Number(p.used) > 0 ? T.primary : T.borderSoft,
            opacity: Number(p.used) > 0 ? 0.72 : 1,
          }}
        />
      ))}
    </div>
  );
}

/** 一行「标签 + 等宽值 + 复制」。口令/地址这类要精确复制的信息用它。 */
function CopyRow(props) {
  const [copied, setCopied] = useState(false);
  const value = props.value || "";
  const copy = useCallback(() => {
    if (!value) return;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(value).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        },
        () => setCopied(false),
      );
    } catch {
      /* 剪贴板不可用时用户仍可手动选中 */
    }
  }, [value]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        borderRadius: RAD.ctl,
        border: "1px solid " + T.hair,
        background: T.bg,
      }}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 46, flexShrink: 0 }}>
        <span style={{ fontSize: FS.xs, color: T.faint, letterSpacing: ".02em" }}>{props.label}</span>
        {props.hint ? <span style={{ fontSize: FS.xs, color: T.faint, opacity: 0.8 }}>{props.hint}</span> : null}
      </span>
      <span
        title={value}
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          fontFamily: MONO_FAMILY,
          fontSize: 11,
          color: T.fg,
          lineHeight: 1.5,
          whiteSpace: props.wrap ? "normal" : "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          wordBreak: props.wrap ? "break-all" : "normal",
        }}
      >
        {value || "—"}
      </span>
      {props.extra}
      <Btn size="sm" kind={copied ? "primary" : "soft"} icon={copied ? "check" : "copy"} onClick={copy} disabled={!value}>
        {copied ? "已复制" : "复制"}
      </Btn>
    </div>
  );
}

/** 数字设置行：标签 + 输入 + 应用。 */
function NumRow(props) {
  return (
    <Field label={props.label} hint={props.hint}>
      <div style={{ display: "flex", gap: 6 }}>
        <Inp
          value={props.value}
          mono
          disabled={props.disabled}
          onChange={(e) => props.setValue(e.target.value.replace(/[^\d]/g, ""))}
          style={{ flex: "1 1 auto" }}
        />
        <Btn size="sm" kind="soft" disabled={props.disabled || props.value === ""} onClick={() => props.onApply(Number(props.value))}>
          应用
        </Btn>
      </div>
    </Field>
  );
}

/** 账号行内的积分保留线设置。 */
function ReserveBox(props) {
  const [v, setV] = useState(props.value == null ? "" : String(props.value));
  useEffect(() => {
    setV(props.value == null ? "" : String(props.value));
  }, [props.value]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, flex: "1 1 auto", minWidth: 150 }}>
      <span style={{ fontSize: FS.xs, color: T.faint, flexShrink: 0 }}>保留线</span>
      <Inp
        value={v}
        mono
        disabled={props.disabled}
        placeholder="0"
        onChange={(e) => setV(e.target.value.replace(/[^\d]/g, ""))}
        style={{ width: 64, flex: "0 0 auto", padding: "4px 7px", fontSize: FS.sm, textAlign: "right" }}
      />
      <Btn size="sm" kind="soft" disabled={props.disabled || v === ""} onClick={() => props.onSet(Number(v))}>
        设
      </Btn>
    </div>
  );
}

/* ═══════════════════════════════ 新手引导 ═══════════════════════════════ */

/**
 * 本机 AI 配置里有没有本池的服务商 —— 只读判断，绝不写。
 * 拿不到 providerId（wiring 还没回来）时按桥端口兜底认。
 */
function readWired(providerId) {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    const raw = window.localStorage.getItem("notrat-ai-config");
    if (!raw) return false;
    const cfg = JSON.parse(raw);
    if (!cfg || !Array.isArray(cfg.providers)) return false;
    return cfg.providers.some(function (p) {
      if (!p) return false;
      if (providerId) return p.id === providerId;
      return typeof p.baseUrl === "string" && /:813[01]\b/.test(p.baseUrl);
    });
  } catch (e) {
    return false;
  }
}

/* 自动接上只试一次：失败（比如配置被改坏）就别每次开面板都撞一遍 ——
   原因留在提示里，让用户自己决定是重试还是手动填。手动接成功会清掉标记。 */
const AUTOWIRE_SKIP_KEY = "nwb.autowire.skip";
function autoWireSkipped() {
  try {
    return window.localStorage.getItem(AUTOWIRE_SKIP_KEY) === "1";
  } catch (e) {
    return false;
  }
}
function markAutoWireSkipped() {
  try {
    window.localStorage.setItem(AUTOWIRE_SKIP_KEY, "1");
  } catch (e) {
    /* 记不住也没关系，最多下次再试一遍 */
  }
}
function clearAutoWireSkipped() {
  try {
    window.localStorage.removeItem(AUTOWIRE_SKIP_KEY);
  } catch (e) {
    /* 同上 */
  }
}

/* ═══════════════ 写进 Notrat：面板唯一会改应用数据的地方 ═══════════════ */

const AI_CONFIG_KEY = "notrat-ai-config";

/** 让正在跑的界面立刻重读 AI 配置 —— 应用内部就是靠这个事件同步的，所以不用重开窗口。 */
function notifyAiConfigChanged() {
  try {
    window.dispatchEvent(new Event("notrat-settings-changed"));
  } catch (e) {
    /* 老版本没有这个事件也没关系：下次重开窗口一样会读到 */
  }
}

/**
 * 把本池写成 Notrat 的一个自定义服务商：读现状 → 合并本池 → 写回 → 通知界面。
 *
 * 只动 id 等于本池的那一条，别的服务商原样保留；先在内存里拼完再一次性 setItem，
 * 中途失败不会留下半截配置。
 */
function writePoolProvider(wiring) {
  const w = wiring;
  if (!w || w.ready !== true) {
    return { ok: false, text: "还没拿到接入信息 —— 等状态灯变绿，或点右上角刷新再来一次。" };
  }
  const modelIds = Array.isArray(w.models) ? w.models.slice() : [];
  if (!modelIds.length) {
    return { ok: false, text: "服务商能接，但还没读到模型列表 —— 等状态灯变绿后点刷新，再点一次。" };
  }
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return { ok: false, text: "这个环境没有 localStorage，只能用下面的复制按钮手工填。" };
    }

    const raw = window.localStorage.getItem(AI_CONFIG_KEY);
    /**
     * 全新安装：应用还没把 AI 配置落过盘。
     *
     * 这里以前是直接拒绝（"先去设置保存一次再回来"）—— 等于把"从没用过 AI 的
     * 新人"挡在门外，而这批人恰恰最需要它自动配好。应用读配置走的是
     * `{ ...DEFAULT_AI_CONFIG, ...parsed, providers }` 合并，缺的字段会自己补；
     * 所以我们给一份最小可用的就行，不需要（也不该）伪造整套默认服务商。
     */
    let cfg;
    const fresh = !raw;
    if (fresh) {
      cfg = { providers: [] };
    } else {
      try {
        cfg = JSON.parse(raw);
      } catch (e) {
        return { ok: false, text: "现有 AI 配置不是合法 JSON —— 不碰它，用复制按钮手工填。" };
      }
      if (!cfg || !Array.isArray(cfg.providers)) {
        return { ok: false, text: "现有 AI 配置里没有 providers 数组 —— 不碰它，用复制按钮手工填。" };
      }
    }

    // ⚠️ 模型 id 是字符串数组，而 Notrat 的 AIModel 形状是 { id, name, displayName }。
    // 把字符串直接塞进 models，会得到一堆字段全 undefined 的空模型项。
    const provider = {
      id: w.providerId,
      name: w.displayName,
      type: "custom",
      baseUrl: w.baseUrl,
      apiKey: w.apiKey,
      model: modelIds[0],
      models: modelIds.map(function (id) {
        return { id: id, name: id, displayName: id };
      }),
      supportsStream: true,
      supportsVision: true,
    };

    const idx = cfg.providers.findIndex(function (p) {
      return p && p.id === provider.id;
    });
    const had = idx >= 0;
    const next = Object.assign({}, cfg, { providers: cfg.providers.slice() });
    if (had) next.providers[idx] = Object.assign({}, next.providers[idx], provider);
    else next.providers = next.providers.concat([provider]);

    /* 只在"本来一个服务商都没有"时顺手设为当前 —— 那正是新人想要的；
       已有配置的人不许被悄悄切模型。 */
    if (fresh) next.currentProvider = provider.id;

    window.localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(next));
    notifyAiConfigChanged();
    clearAutoWireSkipped();
    return {
      ok: true,
      text:
        (had ? "已更新" : "已添加") +
        "服务商「" + provider.name + "」（" + provider.models.length + " 个模型）。" +
        (fresh
          ? "你之前没有配过服务商，所以它已经被设为当前模型 —— 直接在聊天框发消息就能用。"
          : "回到聊天框，点上面的模型名，选它就直接走积分池 —— 不会替你切当前模型。"),
    };
  } catch (e) {
    return { ok: false, text: "写入失败：" + String((e && e.message) || e) };
  }
}

/**
 * 「端口上已经有一个积分池在跑」。
 *
 * 多窗口、插件重载后旧实例没退、或者用户本来就在另一个窗口开着面板时会发生。
 * 这不是错误 —— 但新手看到「未启动 + 打开」会反复点一个永远打不开的按钮，
 * 所以这里直接说清楚：不用再起一个，直接去用。
 */
function ReuseNotice(p) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        padding: "10px 11px",
        borderRadius: RAD.card,
        border: "1px solid " + T.washBd,
        background: T.wash,
      }}
    >
      <span style={{ color: T.primary, display: "flex", flexShrink: 0, marginTop: 1 }}>
        <Icon n="info" s={14} />
      </span>
      <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 7 }}>
        <span style={{ fontSize: FS.sm, lineHeight: 1.6, color: T.fg }}>
          {p.hint || "端口上已经有一个积分池在跑 —— 这个面板不用再启动一次。"}
        </span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {p.onReload ? (
            <Btn size="sm" kind="soft" icon="refresh" onClick={p.onReload}>
              刷新看看
            </Btn>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 一打开面板只回答一个问题：「我现在该做什么」。
 *
 * 新手不该先看到五个标签页和一堆数字。这里只摆**当前这一步**：一句话说清要干什么，
 * 一个主按钮直接做，底下一排小圆点表示进度。想看全貌再点「看全部 4 步」。
 */
function SetupGuide(props) {
  const started = !!props.started;
  const accounts = Number(props.accountCount) || 0;
  const creditTotal = Number(props.creditTotal) || 0;
  const wired = !!props.wired;
  const used = !!props.used;
  const [open, setOpen] = useState(false);

  const steps = [
    {
      key: "engine",
      label: "先把它打开",
      desc: started ? "已经在跑了，这一步不用管" : "点下面的按钮就行，之后它会一直在后台待着",
      done: started,
      cta: "打开",
      icon: "play",
    },
    {
      key: "accounts",
      label: "找到你的账号",
      desc: accounts
        ? creditTotal > 0 ? "已经找到 " + accounts + " 个，共 " + fmtInt(creditTotal) + " 积分" : "已经找到 " + accounts + " 个"
        : props.scanned
          /* 扫过了还是没有 —— 说明原因就那两种，直接写清楚，别让人瞎猜 */
          ? "本机没读到可用的登录。只认桌面版：装好 WorkBuddy / CodeBuddy 电脑版并登录，再点「再找一次」；只用网页版登录是读不到的。"
          : "先打开 WorkBuddy 或 CodeBuddy 电脑版登录一下，再回来点扫描",
      done: accounts > 0,
      cta: props.scanned && !accounts ? "再找一次" : "找账号",
      icon: "refresh",
    },
    {
      key: "wire",
      label: "让 Notrat 用上它",
      desc: wired ? "已经接好了" : "点一下就行：面板直接把地址和密码写进 Notrat，不用碰设置",
      done: wired,
      cta: "一键接上",
      icon: "plug",
    },
    {
      key: "use",
      label: "开始聊天",
      desc: used ? "已经在用了，随便问点什么吧" : "在聊天框上面那个模型下拉里，选带「积分池」字样的那一项",
      done: used,
      cta: "看看怎么选",
      icon: "open",
    },
  ];

  const doneCount = steps.filter(function (x) { return x.done; }).length;
  const allDone = doneCount === steps.length;
  const idx = steps.findIndex(function (x) { return !x.done; });
  const current = idx >= 0 ? steps[idx] : null;

  const runCta = function () {
    if (!current) return;
    if (current.key === "engine") props.onStart();
    /* 用户点"找账号/再找一次"= 明确要求重扫，不要被"没账号才扫"的省事逻辑挡住 */
    else if (current.key === "accounts") props.onRescan(true);
    else if (current.key === "wire") {
      if (props.onWire) props.onWire();
      else props.onGoto("wire");
    } else props.onGoto("models");
  };

  /* 全绿：收成一行，别再占一张卡 */
  if (allDone) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "7px 10px",
          borderRadius: RAD.card,
          border: "1px solid " + T.okBd,
          background: T.okBg,
        }}
      >
        <span style={{ color: T.ok, display: "flex", flexShrink: 0 }}>
          <Icon n="check" s={13} w={2.5} />
        </span>
        <span style={{ fontSize: 12, color: T.fg, minWidth: 0 }}>
          已接好 —— {fmtInt(accounts)} 个账号在池子里，随时可以切过去用
        </span>
      </div>
    );
  }

  /* 别的标签页只留一行入口，不铺开 */
  if (props.compact) {
    return (
      <button
        type="button"
        onClick={function () { props.onGoto("accounts"); }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          textAlign: "left",
          padding: "7px 10px",
          borderRadius: 9,
          border: "1px solid " + T.washBd,
          background: T.wash,
          font: "inherit",
          fontSize: 12,
          color: T.fg,
          cursor: "pointer",
          transition: TR,
        }}
      >
        <span style={{ color: T.primary, display: "flex", flexShrink: 0 }}>
          <Icon n="spark" s={13} />
        </span>
        <span style={{ flex: "1 1 auto", minWidth: 0 }}>
          还差 {steps.length - doneCount} 步就能用 —— 点这里回到「账号」页
        </span>
        <Icon n="chevR" s={12} style={{ color: T.faint, flexShrink: 0 }} />
      </button>
    );
  }

  /* 新手态：只说下一步，只给一个按钮。其余三步折起来 */
  return (
    <Card style={{ padding: 0 }}>
      <div style={{ padding: "13px 12px 10px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
          <span
            style={{
              display: "flex",
              width: 30,
              height: 30,
              flexShrink: 0,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: RAD.card,
              background: T.wash,
              color: T.primary,
            }}
          >
            <Icon n={current.icon} s={15} />
          </span>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <div style={{ fontSize: FS.title, fontWeight: 650, letterSpacing: ".01em", lineHeight: 1.3 }}>
              {current.label}
            </div>
            <div style={{ fontSize: FS.sm, color: T.muted, marginTop: 3, lineHeight: 1.6 }}>{current.desc}</div>
          </div>
        </div>

        <Btn
          kind="primary"
          size="lg"
          full
          icon={current.icon}
          loading={!!props.busy}
          disabled={!!props.busy}
          onClick={runCta}
        >
          {current.cta}
        </Btn>

        <div style={{ display: "flex", alignItems: "center", gap: 5, minHeight: 18 }}>
          {steps.map(function (x, i) {
            return (
              <span
                key={x.key}
                title={x.label}
                style={{
                  width: 18,
                  height: 3,
                  borderRadius: 999,
                  flexShrink: 0,
                  background: x.done ? T.primary : i === idx ? T.washBd : T.border,
                  transition: TR,
                }}
              />
            );
          })}
          <span style={{ fontSize: FS.xs, color: T.faint, marginLeft: 3, fontVariantNumeric: "tabular-nums" }}>
            {doneCount}/{steps.length}
          </span>
          <span style={{ flex: "1 1 auto" }} />
          {current.key === "wire" ? (
            <button
              type="button"
              onClick={function () { props.onGoto("wire"); }}
              style={{
                border: "none",
                background: "transparent",
                padding: "5px 0",
                minHeight: 26,
                font: "inherit",
                fontSize: FS.xs,
                color: T.muted,
                cursor: "pointer",
                textDecoration: "underline",
                textUnderlineOffset: 3,
              }}
            >
              想自己填地址和密码？
            </button>
          ) : null}
          <button
            type="button"
            onClick={function () { setOpen(!open); }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              border: "none",
              background: "transparent",
              padding: "5px 0",
              minHeight: 26,
              font: "inherit",
              fontSize: FS.xs,
              color: T.muted,
              cursor: "pointer",
            }}
          >
            {open ? "收起" : "看全部 " + steps.length + " 步"}
            <Icon n={open ? "chevU" : "chevD"} s={10} />
          </button>
        </div>
      </div>

      {open ? (
        <div
          style={{
            borderTop: "1px solid " + T.hairSoft,
            padding: "8px 12px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 1,
          }}
        >
          {steps.map(function (x, i) {
            return <Step key={x.key} n={i + 1} label={x.label} desc={x.desc} done={x.done} active={i === idx} />;
          })}
        </div>
      ) : null}
    </Card>
  );
}

/* ═══════════════════════════════ 账号卡 ═══════════════════════════════ */

function AccountCard(props) {
  const a = props.account;
  const busy = props.busy;
  const act = props.act;
  const credits = a.credits || {};
  const checkin = a.checkin || {};
  const packages = Array.isArray(credits.packages) ? credits.packages.slice(0, 3) : [];

  /* 一条 3px 竖线表达"这个号还能不能用"，比堆四个胶囊省眼睛 */
  const broken = !!a.authDead || !!credits.error;
  const degraded = !broken && (!!a.cooling || !!a.restricted || !!a.reserved);
  const accent = broken ? T.bad : degraded ? T.warn : a.disabled ? T.faint : T.ok;

  return (
    <section
      style={{
        border: "1px solid " + T.hair,
        borderLeft: "3px solid " + accent,
        borderRadius: RAD.card,
        background: T.surface,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 11px 9px" }}>
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
            <span style={{ fontSize: FS.base, fontWeight: 600 }}>{a.label || a.id}</span>
            {a.cooling ? <Pill tone="warn">冷却中</Pill> : null}
            {a.disabled ? <Pill tone="neutral">已停用</Pill> : null}
            {a.restricted ? <Pill tone="warn">受限</Pill> : null}
            {a.authDead ? <Pill tone="bad">需重新登录</Pill> : null}
            {a.reserved ? <Pill tone="warn">低于保留线</Pill> : null}
            {credits.error ? <Pill tone="bad">读不到余额</Pill> : null}
          </div>

          {/* 一眼要看的只有「签没签」；域名 / 令牌 / 限流次数收进细节 */}
          <div style={{ fontSize: FS.xs, color: T.muted, marginTop: 4, lineHeight: 1.6 }}>
            {checkin.todayCheckedIn ? "今日已签到" : "今日未签到"}
            {checkin.todayCredit ? " · 本轮 +" + fmtInt(checkin.todayCredit) : ""}
            {checkin.streakDays ? " · 连登 " + fmtInt(checkin.streakDays) + " 天" : ""}
          </div>

          {packages.length ? (
            <div style={{ fontFamily: MONO_FAMILY, fontSize: FS.xs, color: T.faint, marginTop: 4, lineHeight: 1.6 }}>
              {packages.map(function (p, i) {
                return (i ? " · " : "") + p.packageName + " " + fmtInt(p.remain) + "/" + fmtInt(p.size);
              }).join("")}
            </div>
          ) : null}

          <details style={{ marginTop: 3 }}>
            <summary style={{ cursor: "pointer", fontSize: FS.xs, color: T.faint }}>细节</summary>
            <div style={{ fontFamily: MONO_FAMILY, fontSize: FS.xs, color: T.faint, marginTop: 3, lineHeight: 1.7 }}>
              {a.domain || "—"} · 令牌 {fmtDate(a.expiresAt)} 到期
              {a.rateLimitHits ? " · 限流 " + a.rateLimitHits : ""}
              {a.serverErrorHits ? " · 网关错 " + a.serverErrorHits : ""}
            </div>
          </details>
        </div>

        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div
            style={{
              fontFamily: MONO_FAMILY,
              fontSize: 19,
              fontWeight: 600,
              lineHeight: 1.1,
              letterSpacing: "-.02em",
              fontVariantNumeric: "tabular-nums",
              color: broken ? T.bad : T.fg,
            }}
          >
            {fmtInt(credits.total)}
          </div>
          <div style={{ fontSize: FS.xs, color: T.faint, marginTop: 1 }}>积分</div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          padding: "6px 11px",
          borderTop: "1px solid " + T.hairSoft,
        }}
      >
        <Btn
          size="sm"
          kind="ghost"
          icon={a.disabled ? "play" : "pause"}
          title={a.disabled ? "重新让这个号参与分配" : "只是不参与分配；额度用尽本来就会自动跳过，一般不用手动停"}
          disabled={!!busy}
          onClick={() =>
            act(
              a.disabled ? "启用账号" : "停用账号",
              "wb_toggle_account",
              { accountId: a.id, disabled: !a.disabled },
              a.disabled ? "已启用" : "已停用（不影响自动跳过）",
            )
          }
        >
          {a.disabled ? "启用" : "停用"}
        </Btn>
        <ReserveBox
          value={a.creditReserve}
          disabled={!!busy}
          onSet={(amount) => act("设置保留线", "wb_set_reserve", { accountId: a.id, amount }, "保留线设为 " + amount)}
        />
      </div>
    </section>
  );
}

/* ═══════════════════════════════ 接入页 ═══════════════════════════════ */

function WirePanel(props) {
  const w = props.wiring;
  const [showKey, setShowKey] = useState(false);

  if (!w || w.ready !== true) {
    return (
      <Empty
        icon="plug"
        title="还没拿到接入信息"
        desc={w && w.hint ? w.hint : "它可能还在启动。等上面那个圆点变绿，再点下面的按钮。"}
      >
        <Btn size="sm" kind="soft" icon="refresh" onClick={props.onReload}>
          重新读取
        </Btn>
      </Empty>
    );
  }

  const key = w.apiKey || "";
  const modelIds = (props.models || []).map((m) => m.id);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <SparkWrite wiring={w} onDone={props.onReload} setNote={props.setNote} />

      <Card title="手动填：把这三样贴进 Notrat" icon="plug" desc="不想让面板代写就走这条：设置 → AI → 自定义服务商 → 新建，照抄下面三行">
        <CopyRow label="1 地址" value={w.baseUrl} hint="连后面的 /v1 一起复制" wrap />
        <CopyRow
          label="2 密码"
          value={showKey ? key : key ? `${"•".repeat(8)}${key.slice(-4)}` : ""}
          extra={<Btn size="sm" kind="ghost" onClick={() => setShowKey(!showKey)}>{showKey ? "隐藏" : "显示"}</Btn>}
        />
        <CopyRow label="3 模型名" value={modelIds.length ? modelIds.join(", ") : "（还没读到，稍后刷新）"} wrap />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Btn size="sm" kind="soft" icon="refresh" onClick={props.onReload}>
            重新读取
          </Btn>
          <Btn
            size="sm"
            kind="ghost"
            icon="copy"
            onClick={() => {
              try {
                navigator.clipboard.writeText(modelIds.join(", "));
              } catch {
                /* 手动选中 */
              }
            }}
          >
            复制模型列表
          </Btn>
        </div>
        <Banner tone="info">
          保存后回到聊天框，点上面的模型名，选带「积分池」的那一项 —— 之后发消息就用它了。
        </Banner>
      </Card>

      <details style={{ marginTop: 2 }}>
        <summary style={{ cursor: "pointer", fontSize: 11, color: T.muted }}>看不懂这个地址？（技术说明）</summary>
        <div style={{ fontSize: 11, color: T.faint, lineHeight: 1.75, marginTop: 4 }}>
          给的是<b style={{ fontWeight: 600 }}>桥</b>的地址（端口固定，填一次就够），不是 shim 的 8120/8121 —— shim 只放行回环 Origin，渲染进程直连会被 403。
        </div>
      </details>

    </div>
  );
}

/**
 * 实验性：直接把服务商写进 Notrat 的 AI 配置（localStorage `notrat-ai-config`）。
 *
 * 面板从外部写它不是官方通道，所以只做"读现状 → 合并本池 → 写回"，绝不覆盖别人的
 * provider；写完后 dispatch `notrat-settings-changed` —— 应用内部正是靠这个事件
 * 重读 AI 配置的，所以界面会立刻刷新，不用重开窗口。
 */
function SparkWrite(props) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const w = props.wiring;

  const run = useCallback(() => {
    setBusy(true);
    setMsg(null);
    const r = writePoolProvider(w);
    setMsg({ kind: r.ok ? "ok" : "err", text: r.text });
    setBusy(false);
    if (r.ok && props.onDone) props.onDone();
  }, [props, w]);

  const remove = useCallback(() => {
    try {
      const KEY = AI_CONFIG_KEY;
      const raw = window.localStorage.getItem(KEY);
      if (!raw) return setMsg({ kind: "err", text: "没有配置可改。" });
      const cfg = JSON.parse(raw);
      if (!cfg || !Array.isArray(cfg.providers)) return setMsg({ kind: "err", text: "配置里没有 providers。" });
      const before = cfg.providers.length;
      cfg.providers = cfg.providers.filter((p) => p && p.id !== w.providerId);
      window.localStorage.setItem(KEY, JSON.stringify(cfg));
      /* 移除后要让跑的界面立刻重读，否则设置里还挂着这条已删的服务商 */
      notifyAiConfigChanged();
      /* 手动移除 = 明确说"别自动接"。留标记，避免下次开面板又给加回来
         —— 用户撤掉的东西被系统偷偷恢复，是最伤信任的一种"贴心"。 */
      markAutoWireSkipped();
      setMsg({
        kind: "ok",
        text:
          before === cfg.providers.length
            ? "本池的服务商本来就不在里面。"
            : "已移除本池写入的服务商。之后不会再自动接上；想用就点上面的「一键接上」。",
      });
    } catch (e) {
      setMsg({ kind: "err", text: `移除失败：${String((e && e.message) || e)}` });
    }
  }, [w]);

  return (
    <Card title="一键写进 Notrat（推荐）" icon="wand" desc="点一下就多一个「积分池」服务商，不用手抄地址和密码" defaultOpen={true}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Btn size="sm" kind="primary" icon="download" loading={busy} disabled={busy} onClick={run}>
          一键接上
        </Btn>
        <Btn size="sm" kind="ghost" icon="trash" disabled={busy} onClick={remove}>
          移除
        </Btn>
      </div>
      <div style={{ fontSize: 11, color: T.faint, lineHeight: 1.7 }}>
        写完会通知界面重读配置，模型下拉立刻能看到它；只添加 / 更新本池这一条，别的服务商不动。
        如果「设置 → AI」那一页正开着，关掉重开一次才会显示最新内容。
      </div>
      {msg ? <Banner tone={msg.kind === "err" ? "bad" : "ok"}>{msg.text}</Banner> : null}
    </Card>
  );
}

/* ═══════════════════════════════ 设置页 ═══════════════════════════════ */

function SettingsPanel(props) {
  const cfg = props.status || {};
  const [distribution, setDistribution] = useState(cfg.distribution || "priority");
  const [minCredits, setMinCredits] = useState("50");
  const [cooldownMs, setCooldownMs] = useState("60000");

  useEffect(() => {
    if (cfg.distribution) setDistribution(cfg.distribution);
  }, [cfg.distribution]);

  const auto = props.automation || {};
  const usage = props.usage || {};

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Banner tone="info">
        这一页都是可选调参，<b style={{ fontWeight: 600 }}>默认值就够用</b>，看不懂可以先不管。
      </Banner>
      <Card title="选号与门槛" icon="grid" desc="额度用尽会自动跳过，不用手动停用">
        <Field label="分配方式">
          <Sel
            value={distribution}
            onChange={(e) => {
              setDistribution(e.target.value);
              props.act("改分配", "wb_config_set", { patch: { distribution: e.target.value } }, "已生效");
            }}
          >
            <option value="priority">优先（抽干一个再用下一个）</option>
            <option value="round-robin">轮询（按顺序）</option>
            <option value="balanced">均衡（空闲越久权重越高）</option>
          </Sel>
        </Field>
        <NumRow
          label="额度门槛"
          value={minCredits}
          setValue={setMinCredits}
          hint="余额低于此值跳过，0 关闭 · 一般不用改"
          disabled={!!props.busy}
          onApply={(n) => props.act("设额度门槛", "wb_config_set", { patch: { minUsableCredits: n } }, `门槛 ${n}`)}
        />
        <NumRow
          label="冷却基数"
          value={cooldownMs}
          setValue={setCooldownMs}
          hint="被限流后先等多久（毫秒），一般不用改"
          disabled={!!props.busy}
          onApply={(n) => props.act("设冷却基数", "wb_config_set", { patch: { cooldownMs: n } }, `冷却基数 ${n}ms`)}
        />
      </Card>

      <Card
        title="积分自动化"
        icon="bolt"
        desc="签到 / 活跃 / 任务 / 连登 / 猫猫"
        right={<Pill tone={auto.enabled ? "ok" : "neutral"} dot>{auto.enabled ? "已开启" : "默认关闭"}</Pill>}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Btn
            size="sm"
            kind={auto.enabled ? "soft" : "primary"}
            icon={auto.enabled ? "pause" : "play"}
            disabled={!!props.busy}
            onClick={() =>
              props.act(
                auto.enabled ? "关闭自动化" : "开启自动化",
                "wb_config_set",
                { patch: { automation: { enabled: !auto.enabled } } },
                auto.enabled ? "已关闭" : "已开启 —— 会产生真实的上游流量",
              )
            }
          >
            {auto.enabled ? "关闭" : "开启"}
          </Btn>
          <Btn
            size="sm"
            kind="soft"
            icon="bolt"
            disabled={!!props.busy}
            onClick={() => props.act("跑一次自动化", "wb_automation", { action: "run" }, "已开始跑一轮")}
          >
            立即跑一轮
          </Btn>
          <span style={{ fontSize: 11, color: T.faint }}>
            今日收益 {fmtInt(auto.earningsToday)}
            {auto.runInProgress ? " · 正在跑" : ""}
          </span>
        </div>
        <div style={{ fontSize: 11, color: T.faint, lineHeight: 1.7 }}>
          默认关着。开启后到点会真的去打上游接口领积分 —— 这是外部动作，所以必须你点头。
        </div>
      </Card>

      {usage.remaining || usage.today || usage.last7 || usage.month ? (
        <Card title="用量" icon="wave" desc="由本插件累积观测，从装上那天开始算">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))", gap: 10 }}>
            <Stat label="剩余" value={fmtInt(usage.remaining)} />
            <Stat label="今日" value={fmtInt(usage.today)} />
            <Stat label="7 天" value={fmtInt(usage.last7)} />
            <Stat label="本月" value={fmtInt(usage.month)} />
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════ 主面板 ═══════════════════════════════ */

/* 首屏骨架：静态行、固定高度——等待 <300ms 时不会有转圈闪一下 */
function PanelSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ border: "1px solid " + T.hair, borderRadius: RAD.card, padding: 11, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ height: 26, width: 96, borderRadius: 4, background: T.hairSoft }} />
        <div style={{ height: 10, width: "62%", borderRadius: 4, background: T.hairSoft }} />
        <div style={{ height: 10, width: "44%", borderRadius: 4, background: T.hairSoft }} />
      </div>
      <div style={{ border: "1px solid " + T.hair, borderRadius: RAD.card, padding: 11, display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ height: 12, width: "38%", borderRadius: 4, background: T.hairSoft }} />
        <div style={{ height: 28, borderRadius: 6, background: T.hairSoft }} />
        <div style={{ height: 28, borderRadius: 6, background: T.hairSoft }} />
      </div>
      <span style={{ fontSize: FS.xs, color: T.faint, textAlign: "center" }}>正在读取账号与积分…</span>
    </div>
  );
}

/* 模型目录：宽 = 表格，窄 = 堆叠行（240px 下不横向滚动） */
function ModelList(props) {
  const list = props.models || [];
  const narrow = !!props.narrow;
  if (!list.length) {
    return (
      <div style={{ padding: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: FS.sm, color: T.muted, textAlign: "center" }}>
          {props.allCount ? "没有匹配「" + (props.query || "") + "」的模型" : "目录为空 —— 引擎可能还没拉到上游模型表"}
        </span>
        {props.allCount ? (
          <Btn size="sm" kind="subtle" icon="x" onClick={props.onClearQuery}>
            清空筛选
          </Btn>
        ) : null}
      </div>
    );
  }

  if (narrow) {
    return (
      <div style={{ display: "flex", flexDirection: "column" }}>
        {list.map(function (m) {
          return (
            <div
              key={m.id}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                padding: "7px 11px",
                borderTop: "1px solid " + T.hairSoft,
              }}
            >
              <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: MONO_FAMILY,
                    fontSize: FS.xs,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={m.id}
                >
                  {m.id}
                </div>
                <div style={{ fontSize: FS.xs, color: T.faint, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                  {m.contextWindow ? Math.round(m.contextWindow / 1000) + "K 上下文" : "上下文 —"}
                  {" · 输出 " + (m.maxOutputTokens ? Math.round(m.maxOutputTokens / 1000) + "K" : "—")}
                  {m.supportsImages ? " · 图片" : ""}
                  {!m.enabled ? " · 已关" : ""}
                </div>
              </div>
              <span
                style={{
                  flexShrink: 0,
                  fontFamily: MONO_FAMILY,
                  fontSize: FS.xs,
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                  color: m.servableAccounts ? T.fg : T.warn,
                }}
              >
                {m.servableAccounts ? m.servableAccounts + " 号可接" : "无可用"}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: FS.sm, tableLayout: "fixed" }}>
        <thead>
          <tr style={{ color: T.onSunken, background: T.sunken }}>
            <th style={{ textAlign: "left", padding: "7px 11px", fontWeight: 500 }}>模型</th>
            <th style={{ textAlign: "right", padding: "7px 6px", fontWeight: 500, width: 56 }}>上下文</th>
            <th style={{ textAlign: "right", padding: "7px 6px", fontWeight: 500, width: 48 }}>输出</th>
            <th style={{ textAlign: "right", padding: "7px 11px", fontWeight: 500, width: 64 }} title="现在有几个账号能接这个模型；0 表示都不可用">
              能接
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map(function (m) {
            return (
              <tr key={m.id} style={{ borderTop: "1px solid " + T.hairSoft }}>
                <td
                  style={{
                    padding: "6px 11px",
                    fontFamily: MONO_FAMILY,
                    fontSize: FS.xs,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={m.id}
                >
                  {m.id}
                  {!m.enabled ? <span style={{ color: T.faint }}>（已关）</span> : null}
                  {m.supportsImages ? <span style={{ color: T.faint }}> · 图片</span> : null}
                </td>
                <td style={{ padding: "6px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {m.contextWindow ? Math.round(m.contextWindow / 1000) + "K" : "—"}
                </td>
                <td style={{ padding: "6px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {m.maxOutputTokens ? Math.round(m.maxOutputTokens / 1000) + "K" : "—"}
                </td>
                <td
                  style={{
                    padding: "6px 11px",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    fontWeight: 600,
                    color: m.servableAccounts ? T.fg : T.warn,
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.servableAccounts ? fmtInt(m.servableAccounts) : "无"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PoolPanel(props) {
  const serverId = props && props.serverId;
  const rootRef = usePanelFill();
  /* 容器宽度决定版式（不是 location）：见 useWidth 注释 */
  const vw = useWidth(rootRef);
  const bucket = bucketOf(vw);

  const [region, setRegion] = useState("cn");
  // initialTab 只给自测/深链用，正常挂载时 props 里没有这个键
  const [tab, setTab] = useState((props && props.initialTab) || "accounts");
  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState(null);
  const [wiring, setWiring] = useState(null);
  const [perf, setPerf] = useState(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null); // { kind:"ok"|"err", text }
  const [tick, setTick] = useState(0);
  /* 开局那一次问到的汇总（引擎/账号/能不能接）。只用于引导文案与"扫过了没有"，
     真实数据仍走 status —— 两者职责不同：boot 回答"我现在该做什么"。 */
  const [boot, setBoot] = useState(null);
  const [syncedAt, setSyncedAt] = useState(0);
  const [query, setQuery] = useState("");
  // 默认只给新手看「下一步」；点「更多设置」才露出全部标签页。
  // initialAdvanced 只给自测/深链用，正常挂载时 props 里没有这个键。
  const [advanced, setAdvanced] = useState(!!(props && props.initialAdvanced));
  const aliveRef = useRef(true);

  const reload = useCallback(
    async (opts) => {
      if (!serverId) return;

      /**
       * 开局一次问齐三件事：引擎在跑吗 / 找到我的号了吗 / 能接吗。
       *
       * 冷启动时引擎是异步起来的（initialize 后 300ms 预热），先问 status 会拿到
       * 空壳 —— 新手首屏于是显示"没找到账号"，而真相是"还没扫"。wb_bootstrap
       * 把这段中间态吃掉了，顺便告诉我们该用哪个区。
       */
      let effRegion = region;
      if (opts && opts.bootstrap) {
        const b = await call(serverId, "wb_bootstrap", { region, force: !!opts.force });
        if (!aliveRef.current) return;
        if (b && !b.error) {
          setBoot(b);
          const here = (b.counts && b.counts[region]) || 0;
          const rec = b.recommendedRegion;
          /* 只在这一个区确实空、另一个区有号时才自动切 —— 别抢用户的选择 */
          if (rec && rec !== region && here === 0) {
            effRegion = rec;
            setRegion(rec);
            const n = (b.counts && b.counts[rec]) || 0;
            if (n > 0) {
              setNote({
                kind: "ok",
                text: "当前区没有账号，已自动切到" + (rec === "global" ? "国际版" : "国内版") + "（" + n + " 个）",
              });
            }
          }
        }
      }

      const wantStatus = !opts || opts.status !== false;
      if (wantStatus) {
        const s = await call(serverId, "wb_status", { region: effRegion });
        if (!aliveRef.current) return;
        if (s && s.error) setNote({ kind: "err", text: `状态读取失败：${s.error}` });
        else {
          setStatus(s);
          setSyncedAt(Date.now());
          // 成功一次就撤掉之前的错误：启动/重载时的瞬时失败（例如 MCP 配置还没
          // 登记完）恢复后，错误条不应继续粘在面板上。
          setNote((n) => (n && n.kind === "err" ? null : n));
        }
      }
      const e = await call(serverId, "wb_engine", { action: "info" });
      if (aliveRef.current && e && !e.error) setInfo(e);
      if (opts && opts.wiring) {
        const w = await call(serverId, "wb_wiring", { region: effRegion, includeSecret: true });
        if (aliveRef.current && w && !w.error) setWiring(w);
      }
      if (opts && opts.perf) {
        const p = await call(serverId, "wb_performance", {});
        if (aliveRef.current && p && !p.error) setPerf(p);
      }
    },
    [serverId, region],
  );

  // 首次 + 切区域 + 手动 tick 时全量拉一次
  useEffect(() => {
    aliveRef.current = true;
    reload({ bootstrap: true, wiring: true, perf: true });
    return () => {
      aliveRef.current = false;
    };
  }, [reload, tick]);

  // 轮询：池是后台服务，"哪个号在冷却"需要一眼可见，所以常态刷。
  // 8 秒是权衡：足够跟上限流恢复，又不至于把 MCP 通道刷爆。
  useEffect(() => {
    const id = setInterval(() => {
      if (!aliveRef.current) return;
      reload({ status: true });
    }, 8000);
    return () => clearInterval(id);
  }, [reload]);

  /** 跑一个会改状态的动作：标忙、调工具、报结果、刷新 */
  const act = useCallback(
    async (label, tool, args, okText) => {
      if (!serverId) return;
      setBusy(label);
      setNote(null);
      const r = await call(serverId, tool, args);
      if (!aliveRef.current) return;
      setBusy("");
      if (r && r.error) setNote({ kind: "err", text: `${label}失败：${r.error}` });
      else setNote({ kind: "ok", text: okText || `${label}完成` });
      setTick((t) => t + 1);
    },
    [serverId],
  );

  /* ── 自动接上：引擎在跑 + 找到账号 + 还没接 → 自动写一次 ────────────────
     这是「装完就能用」的最后一环。默认开（配置 autoWire:false 可关），
     只试一次：失败留标记，成功后再也不碰 —— 用户在设置里改过的东西不会被覆盖。 */
  const autoWireRef = useRef(false);
  useEffect(() => {
    if (autoWireRef.current || !serverId) return;
    const accts = status && Array.isArray(status.accounts) ? status.accounts.length : 0;
    if (!(info && info.started) || accts < 1) return;
    if (info.config && info.config.autoWire === false) return;
    if (readWired((wiring && wiring.providerId) || undefined)) return;
    if (autoWireSkipped()) return;
    autoWireRef.current = true;
    (async function () {
      const fresh = await call(serverId, "wb_wiring", { region, includeSecret: true });
      if (!aliveRef.current) return;
      if (!fresh || fresh.error) {
        markAutoWireSkipped();
        return;
      }
      const r = writePoolProvider(fresh);
      if (!aliveRef.current) return;
      if (r.ok) {
        setWiring(fresh);
        setNote({
          kind: "ok",
          text: "已自动接好（" + (fresh.displayName || "积分池") + "）。去聊天框上面的模型下拉选它就能用。",
        });
        setTick(function (t) { return t + 1; });
      } else {
        markAutoWireSkipped();
        setNote({ kind: "err", text: r.text });
      }
    })();
  }, [serverId, status, info, wiring, region]);

  if (!serverId) {
    return (
      <div ref={rootRef} className="nrx-page" style={Object.assign({}, PAGE_ROOT, { font: FONT, color: T.fg, background: T.bg })}>
        <Empty icon="plug" title="插件 MCP server 未启动" desc="props.serverId 为空 —— 检查插件是否启用，然后重开这个面板。">
          <Btn size="sm" kind="soft" icon="refresh" onClick={() => window.location.reload()}>
            重载界面
          </Btn>
        </Empty>
      </div>
    );
  }

  const summary = (status && status.summary) || {};
  const accounts = (status && status.accounts) || [];
  const models = (status && status.models) || [];
  const requests = (status && status.requests) || [];
  const automation = (status && status.automation) || {};
  const usage = (status && status.usage) || {};
  const trend = status && status.trend;
  const started = !!(info && info.started);
  const stoppedByUser = !!(info && info.stoppedByUser);

  const visibleModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => String(m.id || "").toLowerCase().indexOf(q) >= 0);
  }, [models, query]);

  // 引导要判断的「接入没接入」：读设置页持有的那份配置，只读。
  const wired = useMemo(function () {
    return readWired(wiring && wiring.providerId);
  }, [wiring, tick]);

  const used = requests.length > 0 || Number(usage.today) > 0;
  /* 端口上跑着"另一个自己"：本面板不再启动引擎，也别再劝新手点「打开」。
     一旦本实例真起来了（started），这个标记就没意义。 */
  const reused = !!(boot && boot.reused) && !started;

  // 计数只在有东西时才显示：「账号 0」对新人是纯粹的劝退。
  const tabLabel = function (name, n) {
    return n > 0 ? `${name} ${n}` : name;
  };

  /* 一键接上：把本池写进 Notrat 的 AI 配置，写完让界面立刻重读（不用重开窗口） */
  const oneClickWire = useCallback(
    async function () {
      if (!serverId) return;
      setBusy("接入");
      setNote(null);
      let w = wiring;
      if (!w || w.ready !== true) {
        const fresh = await call(serverId, "wb_wiring", { region, includeSecret: true });
        if (fresh && !fresh.error) {
          w = fresh;
          if (aliveRef.current) setWiring(fresh);
        }
      }
      const r = writePoolProvider(w);
      if (!aliveRef.current) return;
      setBusy("");
      setNote({ kind: r.ok ? "ok" : "err", text: r.text });
      if (r.ok) setTick(function (t) { return t + 1; });
    },
    [serverId, region, wiring],
  );

  /* ══════════ 简单视图：新手只看到「下一步 + 一个按钮」 ══════════ */
  if (!advanced) {
    return (
      <div
        ref={rootRef}
        className="nrx-page"
        style={Object.assign({}, PAGE_ROOT, { font: FONT, color: T.fg, background: T.bg })}
      >
        <header
          role="toolbar"
          aria-label="积分池操作"
          aria-busy={!!busy}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 11px",
            borderBottom: "1px solid " + T.hair,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              flexShrink: 0,
              background: started ? T.ok : stoppedByUser ? T.faint : T.warn,
              boxShadow: started ? "0 0 0 3px " + T.okBg : "none",
            }}
          />
          {/* 壳归宿主：标题条由宿主画；面板只留状态与动作（否则双标题） */}
          <Pill tone={started ? "ok" : stoppedByUser ? "neutral" : "warn"} dot>
            {started ? "已启动" : stoppedByUser ? "已停止" : "未启动"}
          </Pill>
          {busy ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: T.warn }}>
              <Icon n="loader" s={12} style={{ animation: "nrx-spin .9s linear infinite" }} />
              {busy}…
            </span>
          ) : null}
          <span style={{ flex: "1 1 auto" }} />
          {/* 这里刻意不放「停止」：新手视图里一个误触就把已接好的池停掉。
              要管后台服务，去「更多设置」—— 那里的人知道自己在干什么。 */}
          <Btn
            size="sm"
            kind="ghost"
            icon="refresh"
            title="刷新"
            disabled={!!busy}
            onClick={() => setTick((t) => t + 1)}
          />
        </header>

        <div
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            padding: bucket === "narrow" ? 10 : bucket === "wide" ? 16 : 12,
            /* 整页宿主（>700）收成 1024 版心，右栏/侧栏自然铺满 */
            maxWidth: bucket === "wide" ? 1024 : "none",
            margin: bucket === "wide" ? "0 auto" : 0,
            width: "100%",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {reused ? (
            <ReuseNotice hint={boot.hint} onReload={() => setTick(function (t) { return t + 1; })} />
          ) : (
            <SetupGuide
            started={started}
            accountCount={accounts.length}
            creditTotal={summary.creditTotal}
            wired={wired}
            used={used}
            busy={busy}
            compact={false}
            scanned={!!(boot && (boot.scanned === true || typeof boot.scanCount === "number"))}
            onStart={() => act("启动引擎", "wb_engine", { action: "start" })}
            onRescan={() => act("重新扫描", "wb_rescan", {}, "已重新扫描本机登录态")}
            onWire={oneClickWire}
            onGoto={function (t) {
              setAdvanced(true);
              setTab(t);
            }}
          />
          )}

          {!started && info && info.lastStartError ? (
            <Banner tone="bad">上次启动失败：{String(info.lastStartError).split("\n")[0]}</Banner>
          ) : null}

          {note ? (
            <Banner tone={note.kind === "err" ? "bad" : "ok"} right={<Btn size="sm" kind="ghost" icon="x" title="关闭提示" onClick={() => setNote(null)} />}>
              {note.text}
            </Banner>
          ) : null}

          {accounts.length ? (
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", padding: "2px 4px" }}>
              <Stat label="可用账号" value={fmtInt(summary.available) + " / " + fmtInt(summary.accounts)} />
              <Stat label="积分合计" value={fmtInt(summary.creditTotal)} />
              <Stat label="今日消耗" value={fmtInt(usage.today)} />
            </div>
          ) : null}

          <span style={{ flex: "1 1 auto", minHeight: 8 }} />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, flexWrap: "wrap" }}>
            <Btn size="sm" kind="ghost" icon="settings" onClick={() => setAdvanced(true)}>
              更多设置
            </Btn>
            <span style={{ fontSize: FS.xs, color: T.faint }}>·</span>
            <button
              type="button"
              onClick={() => setRegion(region === "cn" ? "global" : "cn")}
              style={{
                border: "none",
                background: "transparent",
                padding: "4px 0",
                minHeight: 26,
                font: "inherit",
                fontSize: FS.xs,
                color: T.muted,
                cursor: "pointer",
                textDecoration: "underline",
                textUnderlineOffset: 3,
              }}
              title="国内版是 WorkBuddy，国际版是 CodeBuddy；两边的账号和积分互不相通"
            >
              {region === "cn" ? "我的是国际版 CodeBuddy" : "我的是国内版 WorkBuddy"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const TABS = [
    { value: "accounts", label: tabLabel("账号", accounts.length) },
    { value: "models", label: tabLabel("模型", models.length) },
    { value: "requests", label: tabLabel("请求", requests.length) },
    { value: "wire", label: "接入" },
    { value: "settings", label: "设置" },
  ];

  return (
    <div
      ref={rootRef}
      className="nrx-page"
      style={Object.assign({}, PAGE_ROOT, { font: FONT, color: T.fg, background: T.bg })}
    >
      {/* ── 头部：第一行状态，第二行操作（挤一行必换行） ───────── */}
      <header
        role="toolbar"
        aria-label="积分池操作"
        aria-busy={!!busy}
        style={{ flexShrink: 0, borderBottom: "1px solid " + T.hair }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 11px 0" }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              flexShrink: 0,
              background: started ? T.ok : stoppedByUser ? T.faint : T.warn,
              boxShadow: started ? "0 0 0 3px " + T.okBg : "none",
            }}
          />
          {/* 壳归宿主：标题条由宿主画；面板只留状态与动作（否则双标题） */}
          <Pill tone={started ? "ok" : stoppedByUser ? "neutral" : "warn"}>
            {started ? "已启动" : stoppedByUser ? "已停止" : "未启动"}
          </Pill>
          {busy ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: FS.xs, color: T.muted }}>
              <Icon n="loader" s={11} style={{ animation: "nrx-spin .9s linear infinite" }} />
              {busy}
            </span>
          ) : null}
          <span style={{ flex: "1 1 auto" }} />
          <Btn
            size="sm"
            kind="ghost"
            icon="refresh"
            title="立即刷新"
            disabled={!!busy}
            onClick={() => setTick((t) => t + 1)}
          />
          <Btn
            size="sm"
            kind="ghost"
            icon="chevL"
            title="收起，只留下一步"
            onClick={() => setAdvanced(false)}
          >
            简单视图
          </Btn>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 11px 8px" }}>
          <Segmented
            value={region}
            onChange={setRegion}
            items={[
              { value: "cn", label: "国内", title: "WorkBuddy 国内版账号（与「国际」的账号和积分互不相通）" },
              { value: "global", label: "国际", title: "CodeBuddy 国际版账号（与「国内」的账号和积分互不相通）" },
            ]}
          />
          <span style={{ flex: "1 1 auto" }} />
          <Btn
            size="sm"
            kind={started ? "outline" : "primary"}
            icon={started ? "stop" : "play"}
            disabled={!!busy}
            title={started ? "停掉后台引擎（会断开服务商）" : "在本机起一个端口，供 Notrat 当服务商用"}
            onClick={() => act(started ? "停止引擎" : "启动引擎", "wb_engine", { action: started ? "stop" : "start" })}
          >
            {started ? "停止" : "启动"}
          </Btn>
        </div>
      </header>

      {/* ── 内容区 ─────────────────────────────────────────────── */}
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          padding: bucket === "narrow" ? 10 : bucket === "wide" ? 16 : 12,
          /* 整页宿主（>700）收成 1024 版心，右栏/侧栏自然铺满 */
          maxWidth: bucket === "wide" ? 1024 : "none",
          margin: bucket === "wide" ? "0 auto" : 0,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {reused ? (
          <ReuseNotice hint={boot.hint} onReload={() => setTick(function (t) { return t + 1; })} />
        ) : (
          <SetupGuide
          started={started}
          accountCount={accounts.length}
          creditTotal={summary.creditTotal}
          wired={wired}
          used={used}
          busy={busy}
          compact={true}
          scanned={!!(boot && (boot.scanned === true || typeof boot.scanCount === "number"))}
          onStart={() => act("启动引擎", "wb_engine", { action: "start" })}
          onRescan={() => act("重新扫描", "wb_rescan", {}, "已重新扫描本机登录态")}
          onGoto={setTab}
        />
        )}

        {!started && info && info.lastStartError ? (
          <Banner tone="bad">上次启动失败：{String(info.lastStartError).split("\n")[0]}</Banner>
        ) : null}

        {note ? (
          <Banner
            tone={note.kind === "err" ? "bad" : "ok"}
            right={
              <Btn size="sm" kind="ghost" icon="x" title="关闭提示" onClick={() => setNote(null)} />
            }
          >
            {note.text}
          </Banner>
        ) : null}

        {/* ── 概览：没账号没请求时不摆 4 个 0 ───────────────────── */}
        {accounts.length || used ? (
        <Card>
          {/* 主数字只有一个：积分合计。其余三个降为脚注 */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
            <span
              style={{
                fontFamily: MONO_FAMILY,
                fontSize: FS.hero,
                fontWeight: 600,
                lineHeight: 1.05,
                letterSpacing: "-.03em",
                fontVariantNumeric: "tabular-nums",
                color: T.fg,
              }}
            >
              {fmtInt(summary.creditTotal)}
            </span>
            <span style={{ fontSize: FS.xs, color: T.faint }}>积分合计</span>
            <span style={{ flex: "1 1 auto" }} />
            <span style={{ fontSize: FS.xs, color: T.muted, whiteSpace: "nowrap" }}>
              {fmtInt(summary.available)}/{fmtInt(summary.accounts)} 个可用
            </span>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 16,
              paddingTop: 8,
              borderTop: "1px solid " + T.hairSoft,
            }}
          >
            <Stat label="今日消耗" value={fmtInt(usage.today)} />
            <Stat label="冷却中" value={fmtInt(summary.cooling)} tone={summary.cooling ? "warn" : undefined} />
            <Stat label="停用" value={fmtInt(summary.disabled)} />
          </div>

          <details>
            <summary style={{ cursor: "pointer", fontSize: FS.xs, color: T.muted, listStyle: "revert" }}>技术细节</summary>
            <div style={{ fontFamily: MONO_FAMILY, fontSize: FS.xs, color: T.faint, lineHeight: 1.7, marginTop: 4 }}>
              共 {fmtInt(summary.accounts)} 号 · 额度不足 {fmtInt(summary.spent)} · 保留线命中{" "}
              {fmtInt(summary.reserved)} · 限流 {fmtInt(summary.rateLimitHits)} · 网关错 {fmtInt(summary.serverErrorHits)}
            </div>
          </details>

          {trend && Number(trend.total) > 0 ? (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: FS.xs, color: T.faint, marginBottom: 5 }}>
                <span>近 {fmtInt(trend.days)} 天消耗</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>合计 {fmtInt(trend.total)}</span>
              </div>
              <TrendBars points={trend.points} max={trend.max} />
            </div>
          ) : null}
        </Card>
        ) : null}

        {/* ── 标签页 ───────────────────────────────────────────── */}
        {status ? (
          <>
            <TabBar value={tab} onChange={setTab} items={TABS} />

        {/* ══════════ 账号 ══════════ */}
        {tab === "accounts" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Btn size="sm" kind="soft" icon="refresh" disabled={!!busy} onClick={() => act("重新扫描", "wb_rescan", {}, "已重新扫描本机登录态")}>
                重新扫描
              </Btn>
              <Btn
                size="sm"
                kind="soft"
                icon="undo"
                disabled={!!busy || !summary.clearable}
                onClick={() => act("清除冷却", "wb_reset_cooldowns", {}, "冷却已清零")}
              >
                清除冷却
              </Btn>
              <span style={{ flex: "1 1 auto" }} />
              <span style={{ fontSize: FS.xs, color: T.faint }}>更新于 {fmtAgo(syncedAt)}</span>
            </div>

            {accounts.length === 0 ? (
              <Empty
                icon="shield"
                title="没有发现账号"
                desc="本池只读桌面客户端留在本机的登录快照 —— 只用网页版登录的话读不到。请在 WorkBuddy / CodeBuddy 桌面端登录后点「重新扫描」。浏览器里登录过不算。"
              >
                <Btn size="sm" kind="primary" icon="refresh" disabled={!!busy} onClick={() => act("重新扫描", "wb_rescan", {}, "已重新扫描本机登录态")}>
                  重新扫描
                </Btn>
              </Empty>
            ) : null}

            {/* >700 才两栏（整页）；右栏/侧栏永远单列 */}
            <div
              style={{
                display: bucket === "wide" ? "grid" : "flex",
                gridTemplateColumns: bucket === "wide" ? "repeat(auto-fit, minmax(320px, 1fr))" : undefined,
                flexDirection: bucket === "wide" ? undefined : "column",
                alignItems: bucket === "wide" ? "start" : undefined,
                gap: 8,
              }}
            >
              {accounts.map((a) => (
                <AccountCard key={a.id} account={a} busy={busy} act={act} />
              ))}
            </div>
          </div>
        ) : null}

        {/* ══════════ 模型 ══════════ */}
        {tab === "models" ? (
          <Card
            title="模型目录"
            icon="grid"
            desc={`${models.length} 个模型 · 最后一列是「现在有几个号能接」`}
            flush
            right={
              <Inp
                value={query}
                placeholder="筛选模型…"
                onChange={(e) => setQuery(e.target.value)}
                style={{ width: 120, padding: "4px 8px", fontSize: FS.sm }}
              />
            }
          >
            <ModelList models={visibleModels} allCount={models.length} narrow={bucket === "narrow"} query={query} onClearQuery={() => setQuery("")} />
          </Card>
        ) : null}

        {/* ══════════ 请求 ══════════ */}
        {tab === "requests" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {perf && Array.isArray(perf.queueStats) && perf.queueStats.length ? (
              <Card title="按模型的排队时长" icon="clock" desc="p50 越小越快">
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {perf.queueStats.slice(0, 6).map((q) => (
                    <div key={q.model} style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                      <span
                        style={{
                          flex: "1 1 auto",
                          minWidth: 0,
                          fontFamily: MONO_FAMILY,
                          fontSize: FS.xs,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {q.model}
                      </span>
                      <span style={{ fontFamily: MONO_FAMILY, fontSize: FS.xs, color: T.muted, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                        p50 {fmtMs(q.p50Ms ?? q.p50 ?? q.medianMs)} · p95 {fmtMs(q.p95Ms ?? q.p95)} · n={fmtInt(q.count ?? q.samples)}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}

            <Card title="最近请求" icon="log" desc={`${requests.length} 条（新在前）`} flush>
              <div style={{ maxHeight: 380, overflowY: "auto" }}>
                {requests.length === 0 ? (
                  <div style={{ padding: 16, fontSize: FS.sm, color: T.faint, textAlign: "center", lineHeight: 1.8 }}>
                    还没有请求。
                    <br />
                    把池接进「设置 → AI → 自定义服务商」之后，随便问一句话就会出现在这里。
                  </div>
                ) : null}
                {requests.slice(0, 60).map((r, i) => {
                  const o = outcomeOf(r.outcome);
                  return (
                    <div
                      key={`${r.startedAt}-${i}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "7px 12px",
                        borderTop: i ? `1px solid ${T.borderSoft}` : "none",
                        minWidth: 0,
                      }}
                    >
                      <span style={{ fontFamily: MONO_FAMILY, fontSize: FS.xs, color: T.faint, flexShrink: 0 }}>{fmtTime(r.startedAt)}</span>
                      <Pill tone={o.tone}>{o.label}</Pill>
                      <span
                        style={{
                          flex: "1 1 auto",
                          minWidth: 0,
                          fontFamily: MONO_FAMILY,
                          fontSize: FS.xs,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.model}
                      </span>
                      <span style={{ fontSize: FS.xs, color: T.faint, flexShrink: 0, maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.accountLabel}
                      </span>
                      <span style={{ fontFamily: MONO_FAMILY, fontSize: FS.xs, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                        {fmtMs(r.totalMs)}
                      </span>
                      {r.attempts > 1 ? <Pill tone="warn">换号 {r.attempts - 1}</Pill> : null}
                    </div>
                  );
                })}
              </div>
            </Card>

            {status && status.requestLog && status.requestLog.failures ? (
              <Banner tone="bad">请求日志落盘失败 {status.requestLog.failures} 次（磁盘只读？）</Banner>
            ) : null}
          </div>
        ) : null}

        {/* ══════════ 接入 ══════════ */}
        {tab === "wire" ? (
          <WirePanel
            wiring={wiring}
            models={models}
            onReload={() => setTick((t) => t + 1)}
            setNote={setNote}
          />
        ) : null}

        {/* ══════════ 设置 ══════════ */}
        {tab === "settings" ? (
          <SettingsPanel status={status} automation={automation} usage={usage} busy={busy} act={act} />
        ) : null}
          </>
        ) : (
          <PanelSkeleton />
        )}
      </div>
    </div>
  );
}

export default PoolPanel;
