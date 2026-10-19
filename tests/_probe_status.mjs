/**
 * 探针：把 wb_status / wb_models / wb_performance 的**真实字段名**打出来。
 *
 * 面板必须按真实字段渲染。凭印象写 `row.credit` 而实际叫 `row.credits` 之类的，
 * 结果是界面上一片空白 —— 而空白不会报错，只会让人以为"没数据"。
 * 所以先把形状拿准再写 UI。
 */
import { WorkBuddyEngine } from "../server/engine.js";

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const engine = new WorkBuddyEngine({ logger: silent });
await engine.start();

/** 打印对象的键，值截断（一眼看清结构，不被长值淹没） */
function shape(label, value, depth = 0) {
  const pad = "  ".repeat(depth);
  if (Array.isArray(value)) {
    console.log(`${pad}${label}: Array(${value.length})`);
    if (value.length > 0) shape("[0]", value[0], depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    console.log(`${pad}${label}: {`);
    for (const [k, v] of Object.entries(value)) shape(k, v, depth + 1);
    console.log(`${pad}}`);
    return;
  }
  const s = typeof value === "string" ? JSON.stringify(value.slice(0, 60)) : String(value);
  console.log(`${pad}${label} = ${s}`);
}

const status = await engine.status("cn");
console.log("########## engine.status('cn') ##########");
shape("status", status);

console.log("\n########## engine.models('cn')[0] ##########");
shape("model", engine.models("cn")[0]);

console.log("\n########## engine.accounts('cn')[0] ##########");
shape("account", engine.accounts("cn")[0]);

console.log("\n########## engine.info() ##########");
shape("info", engine.info());

await engine.stop();
