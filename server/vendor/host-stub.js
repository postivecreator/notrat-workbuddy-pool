/**
 * host-stub —— 替代 RotaKit 的 5 个 DSH 宿主 import
 * =================================================
 *
 * 上游 `lib/index.js` 的 import 块里有 5 个只属于 DSH（DeepSeek Harness）宿主的依赖：
 *
 *   z                          @deepseek-ai/schemastery   → 只在 Config / 两个 schema 里用（11956-12007）
 *   createProvider             @earendil-works/pi-ai      → 只在 src/adapter.ts（4408-4551）
 *   openAICompletionsApi       @earendil-works/pi-ai/...  → 只在 src/adapter.ts（4408-4575）
 *   resolveRetryPolicy         @deepseek-ai/dsh-llm       → 只在 src/adapter.ts（4583）
 *   resolveImageAttachmentAccess @deepseek-ai/dsh-llm     → 只在 src/adapter.ts（4598）
 *   PiAiAdapter                @deepseek-ai/dsh-llm-pi-ai → 只在 src/adapter.ts（4593）
 *
 * 这些位置有一个共同点：**没有一处落在核心链路上**。
 *   - schema：`Config` 只在 `apply()` 里交给 `settings.installSection()`，而 `apply()` 是 Cordis 宿主入口，
 *     Notrat 这边根本不调用；
 *   - adapter：`createWorkBuddyAdapter()` 是把 shim 注册成 DSH 模型服务商的那层，Notrat 用自定义服务商替代它。
 *
 * 所以这里给它们**不会在模块加载期抛错**的替身：让 vendored 源码能原样 import、原样解析、
 * 原样保留全部核心逻辑（账号池 / shim / 目录 / 调度器 / 解密 / 协议互译），一个字符都不用改。
 *
 * 设计原则：宁可是个哑的替身，也不要为了"干净"去改写上游源码——改写会引入漂移，
 * 而漂移会在下次上游升级时变成静默的行为差异。
 */

/* ------------------------------------------------------------------ *
 * schemastery 替身：可无限链式调用的 schema 形状
 * ------------------------------------------------------------------ */

/**
 * 造一个"怎么说都好"的 schema 桩：任意属性访问、任意调用都返回自身。
 *
 * 用途：让 `z.object({...})` / `z.array(z.string())` / `z.number().step(1).min(1e3).default(6e4)`
 * 这类上游写法在模块加载期跑完且不抛错。它不校验任何东西——因为校验结果在这里没有消费者。
 */
function stubSchema() {
  // 用函数当 target，这样桩既能被"属性访问"，也能被"调用"
  const target = function schemaStub() {};

  const proxy = new Proxy(target, {
    get(_t, prop) {
      // 别让桩变成 thenable：某些 await 语境会去读 then
      if (prop === "then") return undefined;
      // JSON.stringify 的哨兵：返回空对象，别让它无限递归
      if (prop === "toJSON") return () => ({});
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.toStringTag) return "host-stub-schema";
      if (prop === "toString") return () => "[host-stub schema]";
      // 内部槽位（util.inspect 等）不透传，避免把函数 target 的真身暴露成怪东西
      if (typeof prop === "symbol") return undefined;
      return proxy;
    },
    set() {
      // `Config.meta.volatile = true` 这类写入照单全收，但什么都不留
      return true;
    },
    apply() {
      return proxy;
    },
    has() {
      return true;
    },
  });

  return proxy;
}

const z = stubSchema();

/* ------------------------------------------------------------------ *
 * pi-ai / dsh-llm 替身：被调用就明确报错
 * ------------------------------------------------------------------ */

/**
 * 造一个"一被调用就说明自己是谁"的替身。
 *
 * 与 schema 桩不同，这些函数**真的会被调用**才有意义（它们要把 shim 接到宿主 LLM 层）。
 * 所以它们不该静默返回假值——那会造出"provider 装上了但没有模型"的诡异状态，
 * 而是应当抛出能一眼看懂来龙去脉的错误。
 */
function notAvailable(name, why) {
  function fail() {
    throw new Error(
      `RotaKit host seam "${name}" is not available in the Notrat build: ${why}. ` +
        `See server/vendor/host-stub.js — this seam belongs to the DeepSeek Harness host and ` +
        `is replaced by Notrat's own custom-provider wiring (server/engine.js).`,
    );
  }
  Object.defineProperty(fail, "name", { value: name });
  return fail;
}

const createProvider = notAvailable(
  "createProvider",
  "it comes from @earendil-works/pi-ai and only createWorkBuddyAdapter() used it",
);

const openAICompletionsApi = notAvailable(
  "openAICompletionsApi",
  "it comes from @earendil-works/pi-ai/api/openai-completions.lazy and only createWorkBuddyAdapter() used it",
);

const resolveRetryPolicy = notAvailable(
  "resolveRetryPolicy",
  "it comes from @deepseek-ai/dsh-llm and only createWorkBuddyAdapter() used it",
);

const resolveImageAttachmentAccess = notAvailable(
  "resolveImageAttachmentAccess",
  "it comes from @deepseek-ai/dsh-llm and only createWorkBuddyAdapter() used it",
);

const PiAiAdapter = notAvailable(
  "PiAiAdapter",
  "it comes from @deepseek-ai/dsh-llm-pi-ai and only createWorkBuddyAdapter() used it",
);

export {
  z,
  createProvider,
  openAICompletionsApi,
  resolveRetryPolicy,
  resolveImageAttachmentAccess,
  PiAiAdapter,
  stubSchema,
  notAvailable,
};
export default z;
