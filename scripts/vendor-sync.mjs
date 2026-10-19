/**
 * vendor-sync —— 从上游仓库重新 vendor RotaKit 引擎
 * ================================================
 *
 * 做四件事：
 *   1. 拉上游 `lib/index.js` 与 `lib/protocol-compat.js`
 *   2. 把 5 行 DSH 宿主 import 换成本地 `./host-stub.js`（其余一字不动）
 *   3. 把 3 个可观测性工厂**追加**进 export 列表（纯追加，无行为改动）
 *   4. 校验产物：能 import、核心导出齐全、`createCore()` 真能造出运行时对象
 *
 * 为什么只做这两处最小改动：
 *   核心链路上**没有一处**用到那 5 个宿主依赖（见 host-stub.js 顶部注释），
 *   所以"只换 import"能 100% 保留上游行为；上游发新版时重跑本脚本即可。
 *   任何更深层的源码改写都会变成下次升级时的静默行为漂移。
 *
 * 用法：
 *   node scripts/vendor-sync.mjs                 # 拉 main
 *   node scripts/vendor-sync.mjs --ref v2.3.26   # 拉指定 tag / 分支
 *   node scripts/vendor-sync.mjs --check         # 只比对不写（CI 用）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const VENDOR_DIR = path.join(ROOT, "server", "vendor");

const UPSTREAM_REPO = "2861292267/DSH-Official-WorkBuddy-Credit-Proxy";
const UPSTREAM_RAW = `https://raw.githubusercontent.com/${UPSTREAM_REPO}`;
const UPSTREAM_API = `https://api.github.com/repos/${UPSTREAM_REPO}`;

const FILES = ["lib/index.js", "lib/protocol-compat.js"];

/** 宿主 import → 本地替身。键是上游 import 的**精确文本**；失配即报错停下。 */
const IMPORT_REWRITES = [
  { from: 'import z from "@deepseek-ai/schemastery";', to: 'import { z } from "./host-stub.js";' },
  {
    from: 'import { createProvider } from "@earendil-works/pi-ai";',
    to: 'import { createProvider } from "./host-stub.js";',
  },
  {
    from: 'import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";',
    to: 'import { openAICompletionsApi } from "./host-stub.js";',
  },
  {
    from: 'import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";',
    to: 'import { resolveImageAttachmentAccess, resolveRetryPolicy } from "./host-stub.js";',
  },
  {
    from: 'import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";',
    to: 'import { PiAiAdapter } from "./host-stub.js";',
  },
];

/**
 * 追加到 export 列表的名字。
 *
 * 为什么需要：这三个是 shim 的可观测性依赖，上游只在自己内部用
 * (`options.requests ?? createRequestLog()`)，所以没导出。而 `poolWebStatus(deps)`
 * 要求调用方传入 `requests: () => requests.list()` 这类**回调**——也就是说，
 * 想要请求记录 / 队列统计 / 输出速度进面板，就必须拿到这三个对象。
 *
 * 纯追加 export 不改任何行为，但必须确认这些名字在模块顶层真的存在，
 * 否则会产出 `undefined` 导入——所以下面逐个校验声明。
 */
const EXTRA_EXPORTS = ["createRequestLog", "createOutputProbes", "createQueueStats"];

/** 产物必须提供的导出。缺任何一个都说明上游重构了核心 API → 报错让人来看。 */
const REQUIRED_EXPORTS = [
  "createCore",
  "createWorkBuddyShim",
  "createRequestLog",
  "createOutputProbes",
  "createQueueStats",
  "WorkBuddyAccountPool",
  "WorkBuddyCatalog",
  "WorkBuddyScheduler",
  "WorkBuddyUpstreamClient",
  "poolWebStatus",
  "buildStatus",
  "automationOptions",
  "candidateAuthDirs",
  "defaultDesktopAuthDirs",
  "parseWorkBuddyAuth",
  "classifyUpstreamError",
  "WORKBUDDY_POOL_PROVIDER",
  "FALLBACK_WORKBUDDY_MODELS",
];

/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ref = argOf("--ref", "main");
const checkOnly = args.includes("--check");

const die = (msg) => {
  console.error(`\n[vendor-sync] FAIL: ${msg}\n`);
  process.exit(1);
};
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** 拉文件：先 GitHub Contents API（base64，字节精确），失败退回 raw。 */
async function fetchFile(repoPath) {
  try {
    const res = await fetch(`${UPSTREAM_API}/contents/${repoPath}?ref=${encodeURIComponent(ref)}`, {
      headers: { "User-Agent": "notrat-workbuddy-pool-vendor-sync", Accept: "application/vnd.github+json" },
    });
    if (res.ok) {
      const json = await res.json();
      if (json && typeof json.content === "string") {
        return { buf: Buffer.from(json.content, "base64"), via: "api" };
      }
    } else if (res.status !== 404) {
      console.warn(`[vendor-sync] api ${res.status} for ${repoPath}; falling back to raw`);
    }
  } catch (err) {
    console.warn(`[vendor-sync] api error for ${repoPath}: ${err.message}; falling back to raw`);
  }
  const res = await fetch(`${UPSTREAM_RAW}/${encodeURIComponent(ref)}/${repoPath}`, {
    headers: { "User-Agent": "notrat-workbuddy-pool-vendor-sync" },
  });
  if (!res.ok) die(`cannot fetch ${repoPath} (raw ${res.status})`);
  return { buf: Buffer.from(await res.arrayBuffer()), via: "raw" };
}

/** 改 import。index.js 必须 5 条全中，否则说明上游改写了 import 块。 */
function rewriteImports(source, repoPath) {
  let out = source;
  const applied = [];
  for (const { from, to } of IMPORT_REWRITES) {
    if (!out.includes(from)) continue;
    out = out.split(from).join(to);
    applied.push(from);
  }
  if (repoPath === "lib/index.js" && applied.length !== IMPORT_REWRITES.length) {
    const missing = IMPORT_REWRITES.filter((r) => !applied.includes(r.from)).map((r) => r.from);
    die(
      `expected ${IMPORT_REWRITES.length} host imports in ${repoPath}, rewrote ${applied.length}.\n` +
        `  not found:\n${missing.map((m) => `    ${m}`).join("\n")}\n` +
        `  Upstream's import block changed. Re-read lib/index.js and update IMPORT_REWRITES.`,
    );
  }
  const leftover = out.match(/from\s+"(@deepseek-ai|@earendil-works)\/[^"]+"/g);
  if (leftover) die(`${repoPath} still imports host packages:\n${leftover.map((l) => `    ${l}`).join("\n")}`);
  return out;
}

/** 把额外名字追加进最终 export 列表，并确认每个名字在顶层有声明。 */
function addExtraExports(source, names, repoPath) {
  if (names.length === 0) return source;

  const declRe = (n) => new RegExp(`^(?:function|var|const|let|class)\\s+${n}\\b`, "m");
  const missing = names.filter((n) => !declRe(n).test(source));
  if (missing.length) {
    die(
      `${repoPath} has no top-level declaration for: ${missing.join(", ")}\n` +
        `  Upstream renamed or removed them. Update EXTRA_EXPORTS and engine.js.`,
    );
  }

  // 定位最后一条 `export { ... };` 并追加名字
  const matches = [...source.matchAll(/^export \{([^}]*)\};?\s*$/gm)];
  if (matches.length === 0) die(`${repoPath}: found no top-level "export { ... }" statement to extend`);
  const last = matches[matches.length - 1];

  const existing = last[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const toAdd = names.filter((n) => !existing.includes(n));
  if (toAdd.length === 0) return source;

  const merged = [...existing, ...toAdd].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const replacement = `export { ${merged.join(", ")} };`;
  const start = last.index;
  const end = start + last[0].length;
  console.info(`[vendor-sync] extending export list with: ${toAdd.join(", ")}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

/** 产物来源头注释（保留上游许可与署名）。 */
function withProvenanceHeader(source, repoPath, meta) {
  return (
    [
      "/* ------------------------------------------------------------------",
      " * VENDORED — DO NOT EDIT BY HAND.",
      " *",
      ` * Source : https://github.com/${UPSTREAM_REPO}/${repoPath}`,
      ` * Ref    : ${meta.ref}`,
      ` * SHA256 : ${meta.sha256}`,
      ` * Pkg    : ${meta.pkgName}@${meta.pkgVersion}`,
      ` * Synced : ${meta.syncedAt}`,
      " *",
      " * Adapted by notrat-workbuddy-pool. Exactly two mechanical changes:",
      " *   1. the 5 DSH host imports were repointed at ./host-stub.js;",
      " *   2. three internal observability factories were added to the export",
      " *      list (pure addition) so the Notrat panel can read them.",
      " * The engine logic below is upstream's, byte for byte.",
      " *",
      " * RotaKit is MIT, adapted from XDTrees/dsh-workbuddy-xdpool (MIT, author",
      " * XDTrees). At-rest credential decryption ported from",
      " * dingminhua/dsh-connect-workbuddy (MIT); shim hardening and error mapping",
      " * informed by corrinehu/dsh-workbuddy-connect (MIT).",
      " *",
      " * Regenerate with: node scripts/vendor-sync.mjs",
      " * ------------------------------------------------------------------ */",
      "",
    ].join("\n") + source.replace(/^\uFEFF/, "")
  );
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log(`[vendor-sync] upstream ${UPSTREAM_REPO} @ ${ref}`);
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  let pkgName = "dsh-rotakit";
  let pkgVersion = "unknown";
  try {
    const { buf } = await fetchFile("package.json");
    const pkg = JSON.parse(buf.toString("utf8"));
    pkgName = pkg.name ?? pkgName;
    pkgVersion = pkg.version ?? pkgVersion;
  } catch (err) {
    console.warn(`[vendor-sync] could not read upstream package.json: ${err.message}`);
  }

  const syncedAt = new Date().toISOString();
  const written = [];

  for (const repoPath of FILES) {
    const { buf, via } = await fetchFile(repoPath);
    const rawSha = sha256(buf);
    let source = rewriteImports(buf.toString("utf8"), repoPath);
    if (repoPath === "lib/index.js") source = addExtraExports(source, EXTRA_EXPORTS, repoPath);

    const targetName = repoPath === "lib/index.js" ? "rotakit.js" : path.basename(repoPath);
    const targetPath = path.join(VENDOR_DIR, targetName);
    const body = withProvenanceHeader(source, repoPath, { ref, sha256: rawSha, pkgName, pkgVersion, syncedAt });

    const changed = !fs.existsSync(targetPath) || fs.readFileSync(targetPath, "utf8") !== body;
    if (!checkOnly) fs.writeFileSync(targetPath, body, "utf8");
    written.push({ repoPath, targetName, rawSha, via, bytes: Buffer.byteLength(body), changed });
    console.log(
      `[vendor-sync] ${repoPath} -> ${targetName}  ${(buf.length / 1024).toFixed(0)}KB  via=${via}` +
        `  sha256=${rawSha.slice(0, 12)}${changed ? "  (updated)" : "  (current)"}`,
    );
  }

  // ── 校验 1：能 import ─────────────────────────────────────────────
  const entry = path.join(VENDOR_DIR, "rotakit.js");
  let mod;
  try {
    mod = await import(`file://${entry.replace(/\\/g, "/")}?v=${Date.now()}`);
  } catch (err) {
    die(`vendored engine failed to import: ${err.stack || err.message}`);
  }

  // ── 校验 2：核心导出齐全 ──────────────────────────────────────────
  const missing = REQUIRED_EXPORTS.filter((n) => mod[n] === undefined);
  if (missing.length) {
    die(
      `vendored engine is missing required exports: ${missing.join(", ")}\n` +
        `  Upstream restructured its API — read the new source before updating REQUIRED_EXPORTS.`,
    );
  }
  console.log(`[vendor-sync] import OK — ${REQUIRED_EXPORTS.length}/${REQUIRED_EXPORTS.length} required exports present`);

  // ── 校验 3：createCore() 真能造出运行时对象 ────────────────────────
  try {
    const core = mod.createCore({ warn() {}, info() {}, error() {} });
    for (const key of ["client", "pool", "catalogs", "scheduler"]) {
      if (!core[key]) die(`createCore() returned no "${key}"`);
    }
    if (!core.catalogs.cn || !core.catalogs.global) die("createCore() catalogs lacks cn/global");
    console.log("[vendor-sync] createCore() OK — client / pool / catalogs{cn,global} / scheduler");
  } catch (err) {
    die(`createCore() threw: ${err.stack || err.message}`);
  }

  // ── 校验 4：可观测性工厂可用（面板依赖） ──────────────────────────
  try {
    const log = mod.createRequestLog(5);
    log.add({ at: Date.now(), region: "cn", model: "probe", outcome: "ok" });
    if (typeof log.list !== "function" || log.list().length !== 1) die("createRequestLog().list() is not usable");
    const probes = mod.createOutputProbes();
    probes.observe("cn", "probe", 100, 10, 100);
    if (typeof probes.list !== "function") die("createOutputProbes().list() is not usable");
    const qs = mod.createQueueStats();
    qs.observe("cn", "probe", 100, 10, 100);
    if (typeof qs.list !== "function") die("createQueueStats().list() is not usable");
    console.log("[vendor-sync] observability factories OK — requestLog / outputProbes / queueStats");
  } catch (err) {
    die(`observability factories unusable: ${err.stack || err.message}`);
  }

  const metaPath = path.join(VENDOR_DIR, "VENDOR.json");
  const meta = {
    upstream: {
      repo: UPSTREAM_REPO,
      url: `https://github.com/${UPSTREAM_REPO}`,
      ref,
      package: `${pkgName}@${pkgVersion}`,
      license: "MIT",
      authors: ["XDTrees (upstream original)", "dingminhua", "corrinehu", "2861292267 (RotaKit adaptation)"],
    },
    syncedAt,
    files: Object.fromEntries(
      written.map((w) => [w.targetName, { from: w.repoPath, sha256: w.rawSha, bytes: w.bytes }]),
    ),
    adaptation: {
      hostImportsRepointed: IMPORT_REWRITES.map((r) => r.from),
      extraExports: EXTRA_EXPORTS,
      rationale:
        "None of the repointed seams sit on the engine's core path (see server/vendor/host-stub.js). " +
        "The extra exports are a pure addition so the Notrat panel can read request/queue/probe data.",
    },
  };
  if (!checkOnly) fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  console.log(`[vendor-sync] wrote ${path.relative(ROOT, metaPath)}`);
  console.log("[vendor-sync] done.\n");
}

main().catch((err) => die(err.stack || err.message));
