'use strict';
/*
 * run_all.js — 六层测试一把跑完
 *   node tools/rdtest/run_all.js            全部跑
 *   node tools/rdtest/run_all.js --quick    跳过 50 家规模测试（省 1 分钟）
 *   node tools/rdtest/run_all.js t1 t4      只跑指定几个
 */

const path = require('path');
const { spawnSync } = require('child_process');

const SUITES = [
  { file: 't1_money.js', name: '层2 金额与大写内核', layer: 2 },
  { file: 't2_import.js', name: '层1/3 导入解析与脏数据样本', layer: 1 },
  { file: 't3_statement.js', name: '层1/4 余额口径·生成·导出', layer: 1 },
  { file: 't4_matcher.js', name: '层1/2 回函勾对算法与适配器', layer: 1 },
  { file: 't5_edge.js', name: '层3 边界与脏数据', layer: 3 },
  { file: 't6_ops.js', name: '层5 运维操作与 HTTP 接口', layer: 5 },
  { file: 't7_frontend.js', name: '层6 前端渲染（jsdom）', layer: 6 },
  { file: 't8_e2e.js', name: '层1 主场景端到端', layer: 1 },
];

function main() {
  const args = process.argv.slice(2);
  const quick = args.indexOf('--quick') >= 0;
  const only = args.filter((a) => !a.startsWith('--'));
  const list = only.length ? SUITES.filter((s) => only.some((o) => s.file.indexOf(o) === 0 || s.name.indexOf(o) >= 0)) : SUITES;

  if (quick) process.env.RDTEST_SKIP_SCALE = '1';

  console.log('================================================');
  console.log(' 往来单位对账函工具 — 全量测试');
  console.log(' 用例来源：计划 §9 六层测试方案');
  console.log(' 模式：' + (quick ? '快速（跳过 50 家规模用例）' : '完整') + '，共 ' + list.length + ' 个套件');
  console.log('================================================');

  const results = [];
  const t0 = Date.now();
  for (const s of list) {
    console.log('\n>>> ' + s.name + '  (' + s.file + ')');
    // 实测：个别套件打印完全部结果后进程不退场（HTTP 服务套件更常见）。
    // 改为管道捕获输出 + 15 分钟硬超时看门狗；通过与否从输出里的「失败 0」判定，
    // 不依赖子进程的退出码 —— 否则看门狗强杀后退出码必然非 0，会把全过的套件误判为失败。
    const r = spawnSync(process.execPath, [path.join(__dirname, s.file)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { RDTEST_EXIT: '0', RDTEST_FORCE_EXIT: '1' }),
      timeout: 6 * 60 * 1000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = String(r.stdout || '') + String(r.stderr || '');
    process.stdout.write(out);
    if (r.signal) console.log('  [INFO] 套件进程未按时退场，已由看门狗强杀（结果以上方输出为准）');
    const ok = /失败 0/.test(out) && /通过 \d+ \/ 共 \d+/.test(out);
    results.push({ name: s.name, file: s.file, ok, status: r.status, signal: r.signal });
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\n================================================');
  console.log(' 汇总（用时 ' + sec + ' 秒）');
  console.log('================================================');
  let fail = 0;
  for (const r of results) {
    console.log(' ' + (r.ok ? '[OK]  ' : '[!!]  ') + r.name + (r.ok ? '' : '  （退出码 ' + r.status + '）'));
    if (!r.ok) fail++;
  }
  console.log('------------------------------------------------');
  console.log(' 套件 ' + results.length + ' 个，通过 ' + (results.length - fail) + ' 个，失败 ' + fail + ' 个');
  console.log('================================================');
  if (fail) process.exit(1);
}

main();
