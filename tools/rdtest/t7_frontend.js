'use strict';
/*
 * t7_frontend.js — 层 6「前端渲染」：用 jsdom 无头跑真实页面
 * 覆盖：8 个 Tab 逐个切换、真实交互（列余额/载入回函/看备份/口径切换）、
 *       捕获 jsdomError + window.error + unhandledrejection，并检查页面文本无 undefined/NaN
 */

const path = require('path');
const fs = require('fs');

const RUN = path.join(__dirname, '.run', 'fe_' + Date.now());
process.env.DZ_DATA = path.join(RUN, 'data');
process.env.DZ_BACKUP = path.join(RUN, 'backups');
process.env.DZ_NO_OPEN = '1';

const H = require('./_harness');
const { startServer, jpost, jget, jput } = require('./_server');
const samples = require('../make_samples');

let JSDOM;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (e) {
  console.log('[!!] 未安装 jsdom，跳过前端渲染测试（npm i -D jsdom）');
  process.exit(0);
}

const SAMPLE_DIR = path.join(__dirname, '..', '..', 'samples');
const E = {};
for (const u of samples.EXPECTED.units) E[u.key] = u;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = await startServer();
  const B = srv.url;
  console.log('测试服务: ' + B);

  // ---------------- 造数据（让 8 个页面都有内容可渲染） ----------------
  H.section('准备：通过 HTTP 造一份真实数据');
  const U = {};
  for (const u of samples.EXPECTED.units) {
    const r = await jpost(B, '/api/units', { name: u.name, type: u.type, contact: '张经理', phone: '0310-11112222', address: '某市某区某路 1 号' });
    U[u.key] = r.data;
  }
  await jput(B, '/api/config', { company: samples.EXPECTED.ourCompany });
  let stJiaId = '';
  for (const u of samples.EXPECTED.units) {
    const name = 's01_标准明细账_' + u.name + '.xlsx';
    const content = fs.readFileSync(path.join(SAMPLE_DIR, name)).toString('base64');
    const pv = await jpost(B, '/api/import/preview', { filename: name, contentBase64: content });
    const s = pv.data.sheets[0];
    await jpost(B, '/api/import/commit', {
      filename: name,
      contentBase64: content,
      plans: [{ sheetName: s.name, include: true, headerRow: s.headerRowNo, mapping: s.mapping, unitId: U[u.key].id, account: u.account }],
    });
  }
  const gen = await jpost(B, '/api/statements/generate', { unitIds: [U.jia.id, U.yi.id, U.bing.id], cutoffDate: '2026-08-31', direction: 'receivable', period: '2026-08' });
  H.check('三家对账函已生成', gen.data.okCount, 3);
  stJiaId = gen.data.results.find((x) => x.unitId === U.jia.id).statementId;

  const d1 = await jpost(B, '/api/diff/run', {
    statementId: stJiaId,
    theirBalanceFen: samples.EXPECTED.replies.jia.theirBalanceFen,
    theirEntries: samples.EXPECTED.replies.jia.detail,
    channel: 'manual',
    replyDate: '2026-09-05',
  });
  await jpost(B, '/api/diff/confirm', { replyId: d1.data.reply.id, confirmedBy: '李会计', note: '已电话核对' });
  const d2 = await jpost(B, '/api/diff/run', {
    statementId: gen.data.results.find((x) => x.unitId === U.yi.id).statementId,
    theirBalanceFen: samples.EXPECTED.replies.yi.theirBalanceFen,
    theirEntries: samples.EXPECTED.replies.yi.detail,
    channel: 'paste',
    replyDate: '2026-09-06',
  });
  H.check('乙有差异的回函已录入', d2.data.diffResult.balanceDiffFen !== 0, true);
  await jpost(B, '/api/backup/json', {});
  await jpost(B, '/api/reply/maps', { unitId: U.jia.id, name: '甲公司回函格式', headers: ['日期', '摘要', '金额'], headerRowNo: 1, mapping: { date: 0, summary: 1, amount: 2 } });
  await jpost(B, '/api/units/' + U.jia.id + '/alias', { alias: '甲辰建材' });

  // ---------------- 起 jsdom ----------------
  const errors = [];
  const consoleErrors = [];
  const dom = await JSDOM.fromURL(B + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = function (p, o) {
        var url = String(p);
        if (url.charAt(0) === '/') url = B + url;
        return fetch(url, o);
      };
      window.confirm = function () { return true; };
      window.alert = function () {};
      window.prompt = function (_m, d) { return d === undefined ? '测试输入' : d; };
      window.URL.createObjectURL = function () { return 'blob:test'; };
      window.addEventListener('error', function (e) {
        errors.push('window.error: ' + (e.message || (e.error && e.error.message) || 'unknown'));
      });
      window.addEventListener('unhandledrejection', function (e) {
        errors.push('unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
      });
    },
  });
  const win = dom.window;
  const virtualConsole = dom.window._virtualConsole;
  void virtualConsole;
  win.addEventListener('error', function (e) {
    errors.push('late error: ' + (e.message || 'unknown'));
  });
  const origConsoleError = win.console.error;
  win.console.error = function () {
    consoleErrors.push(Array.prototype.slice.call(arguments).map(String).join(' '));
    if (origConsoleError) origConsoleError.apply(win.console, arguments);
  };

  await new Promise((r) => {
    if (win.document.readyState === 'complete') r();
    else win.addEventListener('load', () => r());
  });
  await sleep(1200);

  const doc = win.document;
  const S = win.S;

  H.section('启动与全局状态');
  H.check('页面标题正确', doc.title, '往来单位对账函工具');
  H.check('导航渲染出 8 个 Tab', doc.querySelectorAll('.nav a').length, 8);
  H.check('jsdom 脚本执行环境正常（app.js 已加载）', typeof win.api === 'function', true);
  H.check('配置已从服务端拉取', !!(S.config && S.config.company && S.config.company.name), true);
  H.check('单位列表已加载（3 家）', S.units.length, 3);
  H.check('期间已加载', S.periods.length >= 1, true);
  H.check('浏览器探测结果显示', /PDF/.test(doc.getElementById('sideBrowser').textContent), true);
  H.check('顶部显示公司名', /中和机电/.test(doc.getElementById('companyName').textContent), true);

  H.section('逐个 Tab 切换渲染（jsdom 无头）');
  const tabText = {};
  const TAB_KEYS = ['home', 'units', 'import', 'templates', 'generate', 'reply', 'archive', 'settings'];
  for (const key of TAB_KEYS) {
    const el = doc.getElementById('tab-' + key);
    H.check('存在 Tab 容器 #tab-' + key, !!el, true);
    try {
      win.showTab(key);
    } catch (e) {
      errors.push('showTab(' + key + ') 抛异常: ' + e.message);
    }
    await sleep(220);
    const body = doc.getElementById(key + 'Body');
    const text = (body && body.textContent) || '';
    tabText[key] = text;
    H.check('[' + key + '] 有内容渲染', text.trim().length > 20, true);
    H.ok('[' + key + '] 无 undefined 字样', text.indexOf('undefined') < 0, text.slice(0, 160));
    H.ok('[' + key + '] 无 NaN 字样', text.indexOf('NaN') < 0, text.slice(0, 160));
    H.ok('[' + key + '] 无 null 字样', text.indexOf('null') < 0, text.slice(0, 160));
    H.ok('[' + key + '] 无「页面渲染失败」', text.indexOf('页面渲染失败') < 0, text.slice(0, 160));
    H.ok('[' + key + '] 无 {{ 未替换占位符', text.indexOf('{{') < 0, text.slice(0, 160));
  }

  H.section('各 Tab 内容抽查');
  H.check('首页有总览 KPI', tabText.home.indexOf('总览') >= 0 && tabText.home.indexOf('往来单位') >= 0, true);
  H.check('首页有批次列表', tabText.home.indexOf('批次') >= 0, true);
  H.check('单位档案有 3 家', tabText.units.indexOf(E.jia.name) >= 0 && tabText.units.indexOf(E.bing.name) >= 0, true);
  H.check('单位档案显示别名', tabText.units.indexOf('甲辰建材') >= 0, true);
  H.check('导入页有第 1 步', tabText.import.indexOf('第 1 步') >= 0, true);
  H.check('模板页有公司信息表单', tabText.templates.indexOf('我方公司信息') >= 0, true);
  H.check('生成页列出 3 家单位', tabText.generate.indexOf(E.jia.name) >= 0 && tabText.generate.indexOf(E.bing.name) >= 0, true);
  H.check('生成页显示金额千分位', /70,000\.00|120,000\.00|20,000\.00/.test(tabText.generate), true);
  H.check('回函页有对账函下拉', tabText.reply.indexOf('选择要核对的对账函') >= 0, true);
  H.check('回函页 KPI 显示我方余额', tabText.reply.indexOf('我方账面余额') >= 0, true);
  H.check('归档页有备份入口', tabText.archive.indexOf('整包备份') >= 0, true);
  H.check('归档页列出编号 DZH-', tabText.archive.indexOf('DZH-') >= 0, true);
  H.check('设置页有口径卡片', tabText.settings.indexOf('己方账面余额怎么算') >= 0, true);
  H.check('设置页标出已选口径', tabText.settings.indexOf('已选') >= 0, true);
  H.check('设置页有别名字典', tabText.settings.indexOf('别名字典') >= 0, true);

  H.section('真实交互：列余额 / 载入回函 / 看备份 / 看方案 / 切口径');
  {
    win.showTab('generate');
    await sleep(260);
    const picks = doc.querySelectorAll('.genPick');
    H.check('生成页勾选框数量 = 3', picks.length, 3);
    win.genPickAll(false);
    H.check('全不选生效', doc.querySelectorAll('.genPick:checked').length, 0);
    win.genPickAll(true);
    H.check('全选生效', doc.querySelectorAll('.genPick:checked').length, 3);
    win.loadBalances();
    await sleep(260);
    H.check('余额列表渲染成功', doc.getElementById('genList').textContent.indexOf(E.jia.name) >= 0, true);
  }
  {
    win.showTab('reply');
    await sleep(200);
    win.loadReplies();
    await sleep(320);
    const t = doc.getElementById('reList').textContent;
    H.check('回函列表渲染', t.indexOf('已确认') >= 0 || t.indexOf('待确认') >= 0, true);
    H.check('回函列表显示确认人', t.indexOf('李会计') >= 0, true);

    const stmtIds = S.statements.map((s) => s.statementId);
    H.check('回函页可选对账函', stmtIds.length >= 3, true);
    const yiStmt = S.statements.filter((s) => s.unitName === E.yi.name)[0];
    win.pickStatement(yiStmt.statementId);
    await sleep(200);
    H.check('切换对账函后表单重建', doc.getElementById('reForm').textContent.indexOf('录入对方回函') >= 0, true);
    doc.getElementById('reBal').value = '80000';
    win.RE.theirBalanceFen = win.yuanToFen('80000');
    win.RE.theirEntries = samples.EXPECTED.replies.yi.detail;
    win.runDiff();
    await sleep(600);
    const diffText = doc.getElementById('reDiffBox').textContent;
    H.check('勾对结果渲染到页面', diffText.indexOf('差异报告') >= 0, true);
    H.check('页面显示差异金额 40,000.00', diffText.indexOf('40,000.00') >= 0, true);
    H.check('页面分类列出未匹配', diffText.indexOf('我方有、对方无') >= 0, true);
  }
  {
    win.showTab('archive');
    await sleep(200);
    win.loadBackups();
    await sleep(300);
    H.check('备份列表渲染', doc.getElementById('backupList').textContent.indexOf('备份') >= 0 || doc.querySelectorAll('#backupList tbody tr').length >= 1, true);
  }
  {
    win.showTab('settings');
    await sleep(200);
    win.loadReplyMaps();
    await sleep(300);
    H.check('回函方案列表渲染', doc.getElementById('mapList').textContent.indexOf('甲公司回函格式') >= 0, true);
    win.setOption('balanceMode', 'cumulative');
    await sleep(400);
    H.check('切换口径后配置已更新', S.config.balanceMode, 'cumulative');
    H.check('切换口径后页面重渲染无异常', doc.getElementById('settingsBody').textContent.indexOf('已选') >= 0, true);
    win.setOption('balanceMode', 'auto');
    await sleep(300);
  }

  H.section('容错：服务不可用时的表现');
  {
    const savedFetch = win.fetch;
    win.fetch = function () { return Promise.reject(new Error('模拟断连')); };
    win.showTab('units');
    await sleep(300);
    const t = doc.getElementById('unitsBody').textContent;
    H.check('接口失败不白屏（保留上次内容或提示）', t.length > 0, true);
    H.ok('接口失败不抛未捕获异常', errors.filter((e) => /模拟断连/.test(e)).length === 0, errors.join('; '));
    win.fetch = savedFetch;
    win.showTab('home');
    await sleep(200);
  }

  H.section('错误汇总');
  H.check('运行期无 window.error / 未处理 rejection', errors.length, 0);
  if (errors.length) errors.slice(0, 10).forEach((e) => console.log('    - ' + e));
  // 「模拟断连」那一段是故意制造失败的，应用按设计会把错误打到 console.error，需要排除
  const unexpected = consoleErrors.filter(function (e) { return e.indexOf('模拟断连') < 0; });
  H.check('无意外的 console.error 输出', unexpected.length, 0);
  if (unexpected.length) unexpected.slice(0, 10).forEach(function (e) { console.log('    - ' + e); });
  H.check('断连时按设计记录了错误（说明容错分支真的走到了）', consoleErrors.length >= 1, true);

  await srv.close();
  console.log('\n测试数据目录: ' + process.env.DZ_DATA);
  H.finish('t7_frontend');
})();
