/**
 * 真跑一次开局：起引擎 →（没账号才）扫盘 → 看 verdict。
 * 这是"装完就能用"的唯一硬证据；只读本机快照，不发起登录。
 * 结束时会关 stdin，server 自己 stop 引擎，不会留下后台进程。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(HERE, '..', 'server', 'index.js')], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  }
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

let n = 0;
const rpc = (method, params, ms = 90000) =>
  new Promise((res, rej) => {
    const id = ++n;
    waiters.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); rej(new Error('timeout ' + method)); } }, ms);
  });

const t0 = Date.now();
try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  const r = await rpc('tools/call', { name: 'wb_bootstrap', arguments: { region: 'cn' } });
  const text = (r.result && r.result.content && r.result.content[0] && r.result.content[0].text) || '';
  let doc = null;
  try { doc = JSON.parse(text); } catch { /* 可能是错误文本 */ }
  console.log('耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (!doc) {
    console.log('非 JSON 返回：' + text.slice(0, 400));
  } else {
    console.log(JSON.stringify({
      ok: doc.ok, started: doc.started, stoppedByUser: doc.stoppedByUser,
      counts: doc.counts, recommendedRegion: doc.recommendedRegion,
      scanned: doc.scanned, scanCount: doc.scanCount,
      wiring: doc.wiring, verdict: doc.verdict, error: doc.error, hint: doc.hint,
    }, null, 2));
  }
} catch (e) {
  console.log('调用失败：' + (e && e.message ? e.message : e));
}

/* 关 stdin → server 走 stop → 不留后台端口 */
try { child.stdin.end(); } catch { /* 已退 */ }
await new Promise((r) => setTimeout(r, 2500));
try { child.kill('SIGKILL'); } catch { /* 已退 */ }

const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-8);
console.log('\n— stderr 尾部 —');
tail.forEach((l) => console.log('  ' + l));
process.exit(0);
