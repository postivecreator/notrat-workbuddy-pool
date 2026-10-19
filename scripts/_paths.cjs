/**
 * 共享路径解析（CommonJS 版，给 tests/*.cjs 与 scripts/*.cjs 用）。
 *
 * 与 _paths.mjs 同一套规则，逻辑刻意保持一致；两份分开是因为 .cjs 不能同步
 * import ESM。改动时两边一起改。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function looksLikeNotratRepo(dir) {
  try {
    const pkg = path.join(dir, "package.json");
    if (!fs.existsSync(pkg)) return false;
    const j = JSON.parse(fs.readFileSync(pkg, "utf8"));
    const name = String((j && j.name) || "");
    return /notrat/i.test(name) || Boolean((j.dependencies || {}).electron || (j.devDependencies || {}).electron);
  } catch {
    return false;
  }
}

function findNotratRepo() {
  const fromEnv = process.env.NOTRAT_REPO;
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    if (looksLikeNotratRepo(abs)) return abs;
    throw new Error(
      `NOTRAT_REPO 指向的目录不是 Notrat 仓库：${abs}\n` +
        `  （需要一个含 package.json 的 Notrat 源码根。想跳过就 unset NOTRAT_REPO）`,
    );
  }
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

function requireNotratRepo(why) {
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

function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findPlaywrightChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), "AppData", "Local", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
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
    const chromiumDirs = dirs
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of chromiumDirs) {
      for (const rel of relPaths) {
        const p = path.join(root, d, ...rel);
        if (isExecutable(p)) return p;
      }
    }
  }
  return null;
}

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

function findChrome() {
  const fromEnv = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROME;
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    if (isExecutable(abs)) return abs;
    throw new Error(`CHROME_PATH 指向的文件不可执行：${abs}`);
  }
  return findPlaywrightChromium() || findSystemBrowser();
}

function requireChrome(why) {
  const c = findChrome();
  if (c) return c;
  throw new Error(
    `找不到可用的 headless 浏览器（${why || "截图"}）。任选一种：\n` +
      `  1) 装一个：npx playwright install chromium\n` +
      `  2) 用系统里的 Chrome / Edge：设 CHROME_PATH 指过去`,
  );
}

module.exports = { ROOT, findNotratRepo, requireNotratRepo, findChrome, requireChrome };
