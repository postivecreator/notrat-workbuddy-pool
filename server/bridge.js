/**
 * bridge —— 回环桥：给 shim 补上 CORS 并转发
 * ==========================================
 *
 * 为什么必须有这一层（不是可选装饰）：
 *
 * RotaKit 的 shim 硬校验来源——`hostIsLoopback()` 要求 Host 指向回环，
 * `originIsLoopback()` 要求**存在**的 Origin 也是回环（无 Origin 的客户端放行，
 * 因为非浏览器客户端本来就不发）。Notrat 的渲染进程跑在自定义 app 源下，
 * 它发的请求会带一个非回环 Origin → shim 直接 403 `origin_not_allowed`。
 *
 * 这不是 shim 的 bug：它服务的是 DSH 宿主自己的 web server，同源调用，
 * 那条校验是防 DNS-rebinding 的正确做法。跨到 Notrat 就必须补一层。
 *
 * 桥做的事很小，但每一件都必要：
 *   1. 应答 CORS 预检（shim 不批预检，因为它不需要跨域）
 *   2. 回显/放行 Origin
 *   3. 转发时**不带 Origin**——Node 侧发请求本来就没有，于是天然满足 shim 的回环校验
 *   4. 把真实的 shim 口令注入到 Authorization，对外只暴露桥自己的口令
 *   5. SSE 原样流式透传（不缓冲——缓冲会把流式回复变成"等全部生成完才吐"）
 *
 * 桥只绑 127.0.0.1，且要求 Bearer 口令（与 shim 同源口令），所以它不是
 * 一个"本机任何人都能用的开放代理"。
 */
import http from "node:http";

/** 单次请求体上限。上游 shim 用 64MB，这里保持一致，免得桥比后端更早拒绝。 */
const BODY_LIMIT = 64 * 1024 * 1024;

/** 不该转发给后端的逐跳头 + 会干扰后端校验的头。 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "origin", // 关键：故意丢掉，让 shim 的回环校验通过
  "referer",
  "content-length", // 由 fetch 按实际 body 重算
  "authorization", // 由桥换成真实口令
]);

const ALLOW_HEADERS = "authorization, content-type, accept, x-requested-with, openai-beta, anthropic-version, anthropic-beta";
const ALLOW_METHODS = "GET, POST, OPTIONS";

function corsHeaders(req) {
  // 回显来源而不是 `*`：`*` 在带 Authorization 的请求下会被浏览器拒绝。
  const origin = req.headers.origin ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": ALLOW_METHODS,
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Max-Age": "86400",
    // 面板里若用 fetch 读不到 body 的话就没有意义了，显式暴露一下
    "Access-Control-Expose-Headers": "content-type, x-request-id",
    Vary: "Origin",
  };
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 起一座桥。
 *
 * @param {object} opts
 * @param {string} opts.target   shim 的 baseUrl，如 http://127.0.0.1:8120
 * @param {string} opts.secret   对外口令（同时用于访问 shim）
 * @param {number} opts.port     监听端口（固定，重载不换端口）
 * @param {string} opts.region   "cn" | "global"，只用于日志
 * @param {object} opts.logger
 */
export function createBridge({ target, secret, port, region, logger = {} }) {
  const base = target.replace(/\/+$/, "");

  function jsonError(res, status, code, message, extra = {}) {
    const payload = JSON.stringify({ error: { message, type: "bridge_error", code, ...extra } });
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      ...corsHeaders(res.__req ?? { headers: {} }),
    });
    res.end(payload);
  }

  function bearerOk(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m) return false;
    return constantTimeEqual(m[1], secret);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > BODY_LIMIT) {
          reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async function handle(req, res) {
    res.__req = req;

    // ── 预检：shim 不会批，所以桥自己批 ──────────────────────────────
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    const cors = corsHeaders(req);
    const url = req.url ?? "/";

    // 桥自己的健康检查不要求口令，方便面板/自检确认桥活着
    if (req.method === "GET" && (url === "/bridge/healthz" || url === "/bridge/healthz/")) {
      const payload = JSON.stringify({ ok: true, region, target: base, port });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...cors });
      res.end(payload);
      return;
    }

    // CORS 预检已经放行，但真实请求仍要口令——否则本机任何进程都能白用你的积分
    if (!bearerOk(req)) {
      const payload = JSON.stringify({
        error: { message: "missing or invalid Authorization bearer", type: "bridge_error", code: "unauthorized" },
      });
      res.writeHead(401, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "WWW-Authenticate": "Bearer",
        ...cors,
      });
      res.end(payload);
      return;
    }

    // ── 组装转发头 ────────────────────────────────────────────────
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      if (v === undefined) continue;
      forwardHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    forwardHeaders["authorization"] = `Bearer ${secret}`;

    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        const raw = await readBody(req);
        if (raw.length > 0) body = raw;
      } catch (err) {
        jsonError(res, err.statusCode ?? 400, "body_read_failed", String(err.message ?? err));
        return;
      }
    }

    // ── 转发 ──────────────────────────────────────────────────────
    let upstream;
    try {
      upstream = await fetch(`${base}${url}`, {
        method: req.method,
        headers: forwardHeaders,
        body,
        // 关键：不要跟随重定向、不要自己重试——shim 的错误语义（含 429/402）
        // 必须原样到达客户端，否则账号轮换的意义就没了
        redirect: "manual",
      });
    } catch (err) {
      jsonError(res, 502, "upstream_unreachable", `cannot reach the shim at ${base}: ${err?.message ?? err}`);
      return;
    }

    // ── 回传：状态、头、body（流式，不缓冲） ───────────────────────
    const outHeaders = { ...cors };
    for (const [k, v] of upstream.headers) {
      const lower = k.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === "content-encoding" || lower === "content-length") continue;
      if (lower === "access-control-allow-origin") continue; // 用桥自己的
      outHeaders[k] = v;
    }

    res.writeHead(upstream.status, outHeaders);

    if (!upstream.body) {
      res.end();
      return;
    }

    try {
      // Node 18+ 的 fetch body 是可读流；用 for await 逐块写，SSE 才会实时到客户端
      for await (const chunk of upstream.body) {
        if (res.writableEnded || res.destroyed) break;
        if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
      }
    } catch (err) {
      logger.warn?.(`workbuddy-bridge[${region}]: stream aborted: ${err?.message ?? err}`);
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error?.(`workbuddy-bridge[${region}]: unhandled: ${err?.stack ?? err}`);
      if (!res.headersSent) jsonError(res, 500, "bridge_internal", String(err?.message ?? err));
      else if (!res.writableEnded) res.end();
    });
  });

  // 只绑回环，不接受来自局域网的连接
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    ready,
    port,
    region,
    baseUrl: () => `http://127.0.0.1:${port}`,
    secret: () => secret,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

export { BODY_LIMIT, ALLOW_HEADERS, ALLOW_METHODS };
