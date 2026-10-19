/**
 * 共享路径解析 —— 所有脚本都从这里拿路径，不再硬编码本机目录。
 *
 * 开源后别人的机器上没有这些本地路径，
 * 所以三件事全都做成「自动探测 + 环境变量可覆盖」：
 *
 *   NOTRAT_REPO      Notrat 源码根（预览/校验脚本要从它拿 esbuild、react、主题 CSS）
 *                    默认找与本仓库同级的 ../Notrat，或 .. 下任意含 package.json 的 Notrat
 *   CHROME_PATH      headless 浏览器可执行文件（截图用）
 *                    默认扫 Playwright 的 chromium 缓存与系统安装的 Chrome/Edge
 *
 * 找不到时给出**可执行的提示**，而不是一句 ENOENT —— 这类脚本最常见的失败就是
 * "路径是对的，但那是我机器上的路径"。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 本仓库根目录（scripts/ 的上一级） */
export const ROOT = path.resolve(HERE, "..");

/* ────────── Notrat 源码根 ────────── */

function looksLikeNotratRepo(dir) {
  try {
    const pkg = path.join(dir, "package.json");
    if (!fs.existsSync(pkg)) return false;
    const j = JSON.parse(fs.readFileSync(pkg, "utf8"));
    const name = String(j?.name || "");
    /* 名字对得上，或者至少是个带 electron 的 app */
    return /notrat/i.test(name) || Boolean(j?.dependencies?.electron || j?.devDependencies?.electron);
  } catch {
    return false;
  }
}

/** Notrat 源码根；找不到返回 null（调用方决定是报错还是降级） */
export function findNotratRepo() {
  const fromEnv = process.env.NOTRAT_REPO;
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    if (looksLikeNotratRepo(abs)) return abs;
    throw new Error(
      `NOTRAT_REPO 指向的目录不是 Notrat 仓库：${abs}\n` +
        `  （需要一个含 package.json 的 Notrat 源码根。想跳过就 unset NOTRAT_REPO）`,
    );
  }
  /* 逐级往上找：常见布局是 Notrat 与本插件同级、或放在 front_project/ 之类的父目录下。
     从本仓库往上 4 层、每层试 Notrat / notrat / front_project/Notrat，比写死一串
     "第几级父目录" 更耐搬。 */
  const names = ["Notrat", "notrat", path.join("front_project", "Notrat")];
  let base = ROOT;
  for (let i = 0; i < 4; i++) {
    for (const n of names) {
      const c = path.resolve(base, n);
      if (looksLikeNotratRepo(c)) return c;
    }
    const up = path.dirname(base);
    if (up === base) break;
    base = up;
  }
  return null;
}

/** 强制要 Notrat 源码；找不到就抛带指引的错 */
export function requireNotratRepo(why) {
  const repo = findNotratRepo();
  if (repo) return repo;
  throw new Error(
    `找不到 Notrat 源码目录（${why}）。\n` +
      `  设一个环境变量指过去即可：\n` +
      `    PowerShell : $env:NOTRAT_REPO="C:\\path\\to\\Notrat"\n` +
      `    bash / zsh  : export NOTRAT_REPO=/path/to/Notrat\n` +
      `  或把 Notrat 仓库与本插件放成同级目录（../Notrat）。`,
  );
}

/* ────────── headless 浏览器 ────────── */

function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在 Playwright 缓存里找 chromium 的可执行文件 */
function findPlaywrightChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), "AppData", "Local", "ms-playwright"), // Windows
    path.join(os.homedir(), ".cache", "ms-playwright"), // Linux
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"), // macOS
  ].filter(Boolean);

  const relPaths = [
    ["chrome-win64", "chrome.exe"],
    ["chrome-win", "chrome.exe"],
    ["chrome-linux", "chrome"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ];

  for (const root of roots) {
    let dirs;
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    /* chromium-1243 这种，版本号大的优先 */
    const chromiumDirs = dirs
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of chromiumDirs) {
      for (const rel of relPaths) {
        const p = path.join(root, d, ...rel);
        if (isExecutable(p)) {
          /* macOS 的 .app 里可执行文件叫 Chromium，路径已含 */
          return p;
        }
      }
    }
  }
  return null;
}

/** 找系统安装的浏览器（Chrome 优先，Edge 兜底 —— 两者都支持 --headless=new） */
function findSystemBrowser() {
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
            "/snap/bin/chromium",
          ];
  return candidates.find(isExecutable) || null;
}

/** headless 浏览器路径；找不到返回 null */
export function findChrome() {
  const fromEnv = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROME;
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    if (isExecutable(abs)) return abs;
    throw new Error(`CHROME_PATH 指向的文件不可执行：${abs}`);
  }
  return findPlaywrightChromium() || findSystemBrowser();
}

/** 强制要浏览器；找不到就抛带指引的错 */
export function requireChrome(why = "截图") {
  const c = findChrome();
  if (c) return c;
  throw new Error(
    `找不到可用的 headless 浏览器（${why}）。任选一种：\n` +
      `  1) 装一个：npx playwright install chromium\n` +
      `  2) 用系统里的 Chrome / Edge：设 CHROME_PATH 指过去\n` +
      `     PowerShell : $env:CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"\n` +
      `     bash / zsh  : export CHROME_PATH=/usr/bin/google-chrome`,
  );
}
