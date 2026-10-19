/**
 * 宿主画框体检：读 plugin-panel-preview.mjs 生成的预览页，在真浏览器里量
 *   · 每个位置画框的宽高与官方判定（红=横向溢出 / 黄=超高）
 *   · 面板内部的横向滚动容器（规范：240px 下不许有）
 *   · 字号档位与最小字号、对比度不足的文本、过小的可点区、图标按钮是否有 aria-label
 *
 * 用法：node scripts/probe-host.mjs [theme]   theme 形如 minimalist:light / sunset:dark
 * 前置：先跑 Notrat 的 plugin-panel-preview.mjs 生成 preview/out/host-preview.html
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireChrome } from "./_paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../preview/out");
const HTML = path.join(OUT, "host-preview.html");
if (!fs.existsSync(HTML)) {
  console.error("✗ 先跑 plugin-panel-preview.mjs 生成 preview/out/host-preview.html");
  process.exit(1);
}

const CHROME = requireChrome("宿主画框体检");
const theme = process.argv[2] || "minimalist:light";
const userDir = path.join(OUT, "_ph-" + Date.now());

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--remote-debugging-port=0",
    "--user-data-dir=" + userDir,
    "--window-size=1500,2400",
    "file:///" + HTML.replace(/\\/g, "/"),
  ],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readPort() {
  const f = path.join(userDir, "DevToolsActivePort");
  for (let i = 0; i < 80; i++) {
    try {
      const t = fs.readFileSync(f, "utf8").split(/\r?\n/)[0].trim();
      if (t) return Number(t);
    } catch {
      /* 等 */
    }
    await sleep(200);
  }
  throw new Error("DevToolsActivePort 未就绪");
}
const port = await readPort();
let wsUrl = "";
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
    const p = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (p) {
      wsUrl = p.webSocketDebuggerUrl;
      break;
    }
  } catch {
    /* 等 */
  }
  await sleep(200);
}
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
const pend = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
};
const send = (method, params) => {
  const my = ++id;
  ws.send(JSON.stringify({ id: my, method, params }));
  return new Promise((r) => pend.set(my, r));
};
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};

await sleep(1200);
const applied = await evalJs(`(() => {
  const sel = document.getElementById("pv-theme");
  if (!sel) return "no-select";
  sel.value = ${JSON.stringify(theme)};
  sel.dispatchEvent(new Event("change"));
  return document.documentElement.className;
})()`);
await sleep(500);

const EXPR = String.raw`(() => {
  const parseColor = (c) => {
    if (!c) return null;
    const cs = c.match(/color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/);
    if (cs) return { r: +cs[1] * 255, g: +cs[2] * 255, b: +cs[3] * 255, a: cs[4] === undefined ? 1 : +cs[4] };
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.85) return c;
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  const frames = [];
  document.querySelectorAll(".pv-frame").forEach((frame) => {
    const art = frame.closest(".pv-item") || frame.parentElement;
    const h3 = art ? art.querySelector("h3") : null;
    const label = (h3 ? h3.textContent : frame.getAttribute("data-loc") || "?").trim();
    const vp = frame.querySelector(".pv-viewport");
    const badge = frame.querySelector(".pv-badge");
    const host = frame.querySelector(".pv-host") || frame;
    const fr = host.getBoundingClientRect();
    const out = {
      label, hostW: Math.round(fr.width), hostH: Math.round(fr.height),
      badge: badge ? badge.textContent.trim() : "",
      innerHScroll: [], minFont: 99, fonts: {}, lowContrast: [], smallTargets: [], noAria: 0,
    };
    if (!vp) { frames.push(out); return; }

    for (const el of vp.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;

      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 &&
          (cs.overflowX === "auto" || cs.overflowX === "scroll") && el !== vp) {
        out.innerHScroll.push({ tag: el.tagName, sw: el.scrollWidth, cw: el.clientWidth });
      }

      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (own) {
        const fsz = Math.round(parseFloat(cs.fontSize) * 10) / 10;
        out.fonts[fsz] = (out.fonts[fsz] || 0) + 1;
        out.minFont = Math.min(out.minFont, fsz);
        const fg = parseColor(cs.color);
        if (fg) {
          const bg = bgOf(el);
          const L1 = lum(fg), L2 = lum(bg);
          const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
          const need = fsz >= 18 || (fsz >= 14 && Number(cs.fontWeight) >= 700) ? 3 : 4.5;
          if (ratio < need - 0.01) {
            out.lowContrast.push({ t: el.textContent.trim().slice(0, 14), fs: fsz, r: Math.round(ratio * 100) / 100 });
          }
        }
      }

      if (el.tagName === "BUTTON") {
        const txt = (el.textContent || "").trim();
        const iconOnly = !txt;
        const need = iconOnly ? 28 : 26;
        if (box.height < need - 0.5 || (iconOnly && box.width < 27.5)) {
          out.smallTargets.push({ t: txt.slice(0, 10) || el.getAttribute("title") || "icon", w: Math.round(box.width), h: Math.round(box.height), need });
        }
        if (iconOnly && !el.getAttribute("aria-label") && !el.getAttribute("title")) out.noAria++;
      }
    }
    frames.push(out);
  });
  return frames;
})()`;

const frames = await evalJs(EXPR);

const focusInfo = await evalJs(`(() => {
  const btn = document.querySelector(".pv-viewport button");
  if (!btn) return "no-button";
  btn.focus();
  const cs = getComputedStyle(btn);
  return JSON.stringify({ outline: cs.outlineWidth + " " + cs.outlineStyle + " " + cs.outlineColor, shadow: cs.boxShadow });
})()`);

ws.close();
try { chrome.kill("SIGKILL"); } catch { /* 已退 */ }
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* 锁着 */ }

const lines = [];
lines.push("主题 " + theme + "（html.class = " + applied + "）");
lines.push("焦点环（首个按钮 focus 后）: " + focusInfo);
let red = 0, warn = 0;
for (const f of frames) {
  if (/✗/.test(f.badge)) red++;
  if (/△/.test(f.badge)) warn++;
  lines.push("\n■ " + f.label + "  " + f.hostW + "×" + f.hostH + "  " + f.badge);
  const sizes = Object.entries(f.fonts).sort((a, b) => Number(b[0]) - Number(a[0])).map(([k, v]) => k + "×" + v);
  lines.push("   字号: " + (sizes.join("  ") || "—") + "  | 最小 " + (f.minFont === 99 ? "—" : f.minFont + "px"));
  lines.push("   内部横向滚动: " + (f.innerHScroll.length ? JSON.stringify(f.innerHScroll) : "无"));
  lines.push("   过小热区: " + (f.smallTargets.length ? JSON.stringify(f.smallTargets.slice(0, 4)) : "无") + (f.noAria ? " | 图标按钮缺 aria-label: " + f.noAria : ""));
  lines.push("   对比度不足: " + (f.lowContrast.length ? f.lowContrast.length + " 处 → " + JSON.stringify(f.lowContrast.slice(0, 5)) : "无"));
}
lines.push("\n合计：红 " + red + " 个，黄 " + warn + " 个，共 " + frames.length + " 个画框");
const text = lines.join("\n");
fs.writeFileSync(path.join(OUT, "host-" + theme.replace(":", "-") + ".txt"), text, "utf8");
console.log(text);
