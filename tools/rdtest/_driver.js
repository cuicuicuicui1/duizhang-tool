'use strict';
// 带时间戳的套件编排器：定位每个子进程的开始/结束
const { spawn } = require('child_process');
const path = require('path');
const SUITES = ['t1_money.js','t2_import.js','t3_statement.js','t4_matcher.js','t5_edge.js','t6_ops.js','t7_frontend.js','t8_e2e.js'];
const ts = () => new Date().toISOString().slice(11,19);
(async () => {
  for (const f of SUITES) {
    console.log('[' + ts() + '] >>> START ' + f);
    await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(__dirname, f)], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: Object.assign({}, process.env, { RDTEST_EXIT: '0', RDTEST_FORCE_EXIT: '1' }),
      });
      c.on('exit', (code) => { console.log('[' + ts() + '] <<< EXIT ' + f + ' code=' + code); resolve(); });
      c.on('error', (e) => { console.log('[' + ts() + '] !!! ERROR ' + f + ': ' + e.message); resolve(); });
    });
  }
  console.log('[' + ts() + '] ALL DONE');
  process.exit(0);
})();
