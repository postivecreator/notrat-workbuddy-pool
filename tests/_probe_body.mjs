/**
 * 一次性探针：把桥返回的**原始响应体**原样 dump 出来。
 *
 * 起因：e2e 测试里桥回了 200，但 `choices[0].message.content` 是 null ——
 * 说明形状和我假设的不一样。测试只在非 200 时 dump body，所以看不到真身。
 * 这个探针专治"不知道对面返回什么形状"。
 */
import fs from "node:fs";
import path from "node:path";
import { WorkBuddyEngine, BRIDGE_PORTS } from "../server/engine.js";
import { paths } from "../server/env.js";

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const engine = new WorkBuddyEngine({ logger: silent });
await engine.start();

const secret = fs.readFileSync(path.join(paths.stateDir, ".workbuddy-xdpool", "shim-secret-cn"), "utf8").trim();
const model = engine.models("cn")[0]?.id;

const res = await fetch(`http://127.0.0.1:${BRIDGE_PORTS.cn}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, Origin: "null" },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    max_tokens: 16,
    stream: false,
  }),
  signal: AbortSignal.timeout(120_000),
});

console.log("STATUS", res.status);
console.log("CONTENT-TYPE", res.headers.get("content-type"));
console.log("--- headers ---");
for (const [k, v] of res.headers) console.log(`  ${k}: ${v}`);

const text = await res.text();
console.log(`--- body (${text.length} chars) ---`);
console.log(text.slice(0, 2000));
console.log("--- body 前 400 字符的转义视图 ---");
console.log(JSON.stringify(text.slice(0, 400)));

await engine.stop();

// 刻意不落盘：这个探针的输出就是给人看的形状对比，写到文件里只会
// 在 tests/ 下留一个内容为 "see console" 的空壳（本人踩过一次）。
