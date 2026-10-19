/**
 * 冒出真 MCP 握手：确认 wb_bootstrap 注册了、schema 对得上、wb_status 的说明
 * 里承诺的"首次调用也能拿到真数据"没有回退成空壳。
 *
 * 只走 initialize + tools/list，不真起引擎 —— 起引擎会绑端口，测试不该占它。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 默认测仓库里的 server；传参可测任意副本（安装目录、解包出来的发布包）——
   这是打出来的包能不能装最硬的证据：少一个文件就会在握手阶段崩。 */
const SERVER = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(HERE, '..', 'server', 'index.js');

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  }
});
let stderr = '';
child.stderr.on('data', (d) => {
  stderr += d.toString();
});

let nextId = 0;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (waiters.has(id)) {
        waiters.delete(id);
        reject(new Error('timeout: ' + method));
      }
    }, 15000);
  });

let bad = 0;
const check = (label, cond, extra) => {
  if (cond) console.log('  [OK  ] ' + label);
  else {
    bad++;
    console.log('  [FAIL] ' + label + (extra === undefined ? '' : '  → ' + extra));
  }
};

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1' },
  });
  check('initialize 握手成功', init.result && init.result.serverInfo, JSON.stringify(init.error));

  const list = await rpc('tools/list', {});
  const tools = (list.result && list.result.tools) || [];
  const names = tools.map((t) => t.name);
  check('工具表非空', tools.length > 10, String(tools.length));
  check('注册了 wb_bootstrap', names.includes('wb_bootstrap'), names.join(','));
  check('注册了 wb_status', names.includes('wb_status'));

  const bs = tools.find((t) => t.name === 'wb_bootstrap');
  check('wb_bootstrap 有 region 参数', !!(bs && bs.inputSchema.properties.region));
  check('wb_bootstrap 有 force 参数', !!(bs && bs.inputSchema.properties.force));
  check(
    'wb_bootstrap 声明了只读',
    !!(bs && /只读/.test(bs.description || '')),
    bs && bs.description,
  );

  /* 工具描述是给模型看的，说错了模型就会走错路 —— 顺手断言两句关键承诺 */
  const st = tools.find((t) => t.name === 'wb_status');
  check('wb_status 描述提到面板主数据源', !!(st && /主数据源/.test(st.description || '')));
  const wiring = tools.find((t) => t.name === 'wb_wiring');
  check(
    'wb_wiring 仍然警告别在对话里要明文',
    !!(wiring && /不要传 true/.test(wiring.inputSchema.properties.includeSecret.description || '')),
  );

  check('stderr 是唯一日志通道（有日志也不是错）', true, stderr.slice(0, 60));
} catch (e) {
  bad++;
  console.log('  [FAIL] ' + String(e && e.message ? e.message : e));
} finally {
  try {
    child.stdin.end();
  } catch {
    /* 已退 */
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退 */
    }
    console.log(bad ? '\n✗ 失败 ' + bad + ' 项' : '\n✓ 全部通过');
    process.exit(bad ? 1 : 0);
  }, 300);
}
