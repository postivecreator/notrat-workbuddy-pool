/* 一次跑完所有面板测试，只打印结论 + 失败行 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = require('./_paths.cjs').ROOT;
const DIR = path.join(ROOT, 'tests');
const cases = ['_compile.cjs', '_guide_states.cjs', '_verify_wire.mjs', '_verify_onclick.cjs', '_verify_bootstrap.mjs', '_render.mjs'];

let bad = 0;
for (const f of cases) {
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { encoding: 'utf8', cwd: ROOT });
  const out = (r.stdout || '') + (r.stderr || '');
  const failedLines = out.split(/\r?\n/).filter((l) => /FAIL|✗|Error|错误/.test(l));
  const ok = r.status === 0 && failedLines.length === 0;
  if (!ok) bad++;
  console.log((ok ? '✓ ' : '✗ ') + f + (ok ? '' : '  exit=' + r.status));
  if (!ok) failedLines.slice(0, 8).forEach((l) => console.log('    ' + l.trim()));
}
console.log(bad ? '\n' + bad + ' 个测试文件失败' : '\n全部测试通过（' + cases.length + ' 个文件）');
process.exit(bad ? 1 : 0);
