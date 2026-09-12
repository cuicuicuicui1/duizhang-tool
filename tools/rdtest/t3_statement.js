'use strict';
/*
 * t3_statement.js — 层 1「主场景端到端」前半段 + 余额口径六种模式 + 导出与版本
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const RUN = path.join(__dirname, '.run', 'stmt_' + Date.now());
process.env.DZ_DATA = path.join(RUN, 'data');
process.env.DZ_BACKUP = path.join(RUN, 'backups');
process.env.DZ_NO_OPEN = '1';

const H = require('./_harness');
const store = require('../../src/store');
const importer = require('../../src/importer');
const unitsMod = require('../../src/units');
const ledger = require('../../src/ledger');
const money = require('../../src/money');
const statementMod = require('../../src/statement');
const templates = require('../../src/templates');
const exporter = require('../../src/exporter');
const configMod = require('../../src/config');
const samples = require('../make_samples');

const SAMPLE_DIR = path.join(__dirname, '..', '..', 'samples');
const E = {};
for (const u of samples.EXPECTED.units) E[u.key] = u;

const cfg = configMod.saveConfig({
  company: samples.EXPECTED.ourCompany,
  balanceMode: 'auto',
  matchWindowDays: 15,
  detailAttach: 'auto',
});
store.ensureDirs();

function readSample(n) {
  return fs.readFileSync(path.join(SAMPLE_DIR, n));
}
function importClean(key) {
  const name = 's01_标准明细账_' + E[key].name + '.xlsx';
  const buf = readSample(name);
  const a = importer.analyze({ buffer: buf, filename: name, config: cfg });
  const s = a.sheets[0];
  return importer.commit({
    buffer: buf,
    filename: name,
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: s.name, include: true, headerRow: s.headerRowNo, mapping: s.mapping, unitId: U[key].id, account: E[key].account }],
  });
}

// ---------------------------------------------------------------- 建档导入
H.section('准备：建档 + 导入三家单位标准明细账');
const U = {};
for (const u of samples.EXPECTED.units) U[u.key] = unitsMod.create({ name: u.name, type: u.type });
for (const u of samples.EXPECTED.units) importClean(u.key);
H.check('明细总数', store.readJson('ledgers.json').length, 13);

H.section('余额计算（auto 模式回退累计）');
{
  const bj = ledger.computeUnitBalance(U.jia.id, { cutoff: '2026-08-31', direction: 'receivable', from: '2026-08-01', config: cfg });
  H.check('甲 余额', bj.signedFen, E.jia.closingFen);
  H.check('甲 余额文本', money.fenToStr(bj.signedFen), '70,000.00');
  H.check('甲 本期借方合计', bj.periodDebitFen, E.jia.debitFen);
  H.check('甲 有逐笔明细', bj.hasDetail, true);
  H.check('甲 口径落点', bj.parts[0].usedMode, 'cumulative');
  H.check('甲 余额口径告警（无期初）', bj.warnings.length > 0, true);

  const by = ledger.computeUnitBalance(U.yi.id, { cutoff: '2026-08-31', direction: 'payable', from: '2026-08-01', config: cfg });
  H.check('乙（应付）余额 = 贷-借', by.signedFen, E.yi.creditFen - E.yi.debitFen);
  H.check('乙 余额文本', money.fenToStr(by.signedFen), '120,000.00');
  H.check('乙 科目自然方向', by.parts[0].naturalSide, 'credit');

  const bb = ledger.computeUnitBalance(U.bing.id, { cutoff: '2026-08-31', direction: 'receivable', from: '2026-08-01', config: cfg });
  H.check('丙 余额', bb.signedFen, E.bing.closingFen);
  H.check('丙 余额文本', money.fenToStr(bb.signedFen), '20,000.00');
}

H.section('截止日之前/之后的过滤');
{
  const b = ledger.computeUnitBalance(U.jia.id, { cutoff: '2026-08-10', direction: 'receivable', config: cfg });
  H.check('截至 08-10 只含 1 笔借方', b.signedFen, 15000000);
  const b2 = ledger.computeUnitBalance(U.jia.id, { cutoff: '2026-08-31', direction: 'receivable', config: cfg });
  H.check('截至 08-31 含全部 4 笔', b2.entryCount, 4);
}

// ---------------------------------------------------------------- 六种口径
H.section('余额口径六种模式（同一份数据，不同口径不同结果）');
{
  const cu = unitsMod.create({ name: '口径测试单位有限公司', type: 'customer' });
  const rows = [
    ['日期', '摘要', '借方金额', '贷方金额'],
    ['2026-08-05', '销售', 5000, ''],
    ['2026-08-20', '回款', '', 2000],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S');
  const p = path.join(RUN, 'mode.xlsx');
  XLSX.writeFile(wb, p);
  const buf = fs.readFileSync(p);
  const a = importer.analyze({ buffer: buf, filename: 'mode.xlsx', config: cfg });
  importer.commit({
    buffer: buf,
    filename: 'mode.xlsx',
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: 'S', include: true, headerRow: a.sheets[0].headerRowNo, mapping: a.sheets[0].mapping, unitId: cu.id, account: '应收账款' }],
  });
  // 文件期初 10000
  const ops = store.readJson('openings.json', []);
  ops.push({ id: 'op_file_1', unitId: cu.id, account: '应收账款', openingFen: 1000000, source: 'file', note: '测试文件期初' });
  store.writeJson('openings.json', ops);

  const opts = { cutoff: '2026-08-31', direction: 'receivable' };
  const mk = (mode) => ledger.computeUnitBalance(cu.id, Object.assign({}, opts, { config: configMod.saveConfig({ balanceMode: mode }) }));

  H.check('opening_from_file：10000+5000-2000', mk('opening_from_file').signedFen, 1300000);
  H.check('cumulative：只算本期', mk('cumulative').signedFen, 300000);
  H.check('auto：自动用到期初', mk('auto').signedFen, 1300000);
  H.check('auto 口径落点', mk('auto').parts[0].usedMode, 'opening_from_file');
  H.check('incremental：期初累加', mk('incremental').signedFen, 1300000);

  // 手工期初
  ops.push({ id: 'op_manual_1', unitId: cu.id, account: '应收账款', openingFen: 200000, source: 'manual', note: '手工' });
  store.writeJson('openings.json', ops);
  H.check('manual_opening：2000+5000-2000', mk('manual_opening').signedFen, 500000);
  H.check('incremental：10000+2000 都加', mk('incremental').signedFen, 1500000);

  // 科目余额表口径
  const bu = unitsMod.create({ name: '余额表口径单位有限公司', type: 'customer' });
  const bals = [
    ['科目：应收账款  截止 2026-08-31'],
    ['单位名称', '期初余额', '本期借方', '本期贷方', '期末余额'],
    ['余额表口径单位有限公司', 20000, 3000, 1000, 22000],
  ];
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(bals), 'B');
  const p2 = path.join(RUN, 'bal.xlsx');
  XLSX.writeFile(wb2, p2);
  const buf2 = fs.readFileSync(p2);
  const a2 = importer.analyze({ buffer: buf2, filename: 'bal.xlsx', config: cfg });
  importer.commit({
    buffer: buf2,
    filename: 'bal.xlsx',
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: 'B', include: true, headerRow: a2.sheets[0].headerRowNo, mapping: a2.sheets[0].mapping, account: '应收账款' }],
  });
  const bs = ledger.computeUnitBalance(bu.id, Object.assign({}, opts, { config: configMod.saveConfig({ balanceMode: 'balance_sheet' }) }));
  H.check('balance_sheet：取期末余额列', bs.signedFen, 2200000);
  H.check('balance_sheet 为仅余额（无逐笔）', bs.balanceOnly, true);
  H.check('balance_sheet 本期借方取列值', bs.parts[0].periodDebitFen, 300000);
}

H.section('应收/应付同存：分别列示不抵销');
{
  const bu = unitsMod.create({ name: '兼有往来单位有限公司', type: 'both' });
  const rows = [
    ['日期', '摘要', '科目', '借方金额', '贷方金额'],
    ['2026-08-05', '销售', '应收账款', 10000, ''],
    ['2026-08-06', '采购', '应付账款', '', 4000],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S');
  const p = path.join(RUN, 'both.xlsx');
  XLSX.writeFile(wb, p);
  const buf = fs.readFileSync(p);
  const a = importer.analyze({ buffer: buf, filename: 'both.xlsx', config: cfg });
  importer.commit({
    buffer: buf,
    filename: 'both.xlsx',
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: 'S', include: true, headerRow: a.sheets[0].headerRowNo, mapping: a.sheets[0].mapping, unitId: bu.id }],
  });
  const b = ledger.computeUnitBalance(bu.id, { cutoff: '2026-08-31', direction: 'receivable', config: cfg });
  H.check('分两个科目各自的余额', b.parts.length, 2);
  H.check('应收 10000', b.parts.find((x) => x.account === '应收账款').signedFen, 1000000);
  H.check('应付 4000', b.parts.find((x) => x.account === '应付账款').signedFen, 400000);
}

// ---------------------------------------------------------------- 生成
H.section('批量生成对账函（3 家）');
let gen1;
(async () => {
  const t0 = Date.now();
  gen1 = await statementMod.generate({
    unitIds: [U.jia.id, U.yi.id, U.bing.id],
    cutoffDate: '2026-08-31',
    direction: 'receivable',
    period: '2026-08',
    config: cfg,
  });
  const ms = Date.now() - t0;
  H.check('3 家全部成功', gen1.okCount, 3);
  H.check('编号格式', /^DZH-\d{8}-000\d$/.test(gen1.results[0].serialNo), true);
  H.check('版本从 1 开始', gen1.results[0].version, 1);
  H.check('余额快照正确', gen1.results[0].balanceFen, E.jia.closingFen);
  H.check('PDF 生成成功（依赖系统 Edge）', gen1.results[0].pdfOk, true);

  const st = statementMod.getStatement(gen1.results[0].statementId);
  H.check('归档目录已建', fs.existsSync(st.archivedDir), true);
  H.check('PDF 落盘', !!(st.pdfPath && fs.existsSync(st.pdfPath)), true);
  H.check('Excel 落盘', !!(st.xlsxPath && fs.existsSync(st.xlsxPath)), true);
  H.check('PDF 有实际内容（>10KB，说明中文已内嵌字库）', fs.statSync(st.pdfPath).size > 10000, true);
  {
    const buf = fs.readFileSync(st.pdfPath);
    const m = buf.toString('latin1').match(/MediaBox *\[0 0 ([\d.]+) ([\d.]+)\]/);
    H.check('PDF 页面为 A4（595×842 磅）', !!m && Math.abs(Number(m[1]) - 595) < 2 && Math.abs(Number(m[2]) - 842) < 2, true);
    H.check('PDF 带 ToUnicode 映射（中文是真实文字而非空白）', /ToUnicode/.test(buf.toString('latin1')), true);
  }
  H.check('归档路径含单位/期间/版本', /archive[\\/]u_.+[\\/]2026-08[\\/]v1$/.test(st.archivedDir), true);
  H.check('对账函记录里存了数据来源（供归档回溯）', !!(st.dataSource && st.dataSource.batches.length), true);
  H.check('数据来源含原文件名', (st.dataSource.files || []).some((f) => /s01_标准明细账/.test(f)), true);

  H.section('重复生成 → 版本递增不覆盖');
  const g2 = await statementMod.generate({ unitIds: [U.jia.id], cutoffDate: '2026-08-31', direction: 'receivable', period: '2026-08', config: cfg });
  H.check('第二次版本 = 2', g2.results[0].version, 2);
  const st2 = statementMod.getStatement(g2.results[0].statementId);
  H.check('v1 仍在（只增不删）', fs.existsSync(st.pdfPath), true);
  H.check('v2 目录不同', st2.archivedDir !== st.archivedDir, true);
  H.check('每次生成新编号', st2.serialNo !== st.serialNo, true);

  H.section('对账函内容校验（金额/大写/抬头）');
  {
    const html = templates.renderStatement({
      unit: unitsMod.get(U.jia.id),
      balance: ledger.computeUnitBalance(U.jia.id, { cutoff: '2026-08-31', direction: 'receivable', from: '2026-08-01', config: cfg }),
      session: { period: '2026-08', cutoffDate: '2026-08-31', direction: 'receivable' },
      config: cfg,
      statement: st,
    });
    H.check('含我方公司名', html.includes(samples.EXPECTED.ourCompany.name), true);
    H.check('含对方抬头', html.includes(E.jia.name), true);
    H.check('含千分位金额', html.includes('70,000.00'), true);
    H.check('含大写金额', html.includes('柒万元整'), true);
    H.check('含截止日中文', html.includes('2026年08月31日'), true);
    H.check('含回函联', html.includes('回 函 联'), true);
    H.check('含明细附页', html.includes('往来款项明细附页'), true);
    H.check('含待人工确认区块', html.includes('待人工确认事项'), true);
    H.check('无未替换占位符', /\{\{[a-zA-Z]+\}\}/.test(html), false);
    H.check('无 NaN/undefined', /NaN|undefined/.test(html), false);
    H.check('应收措辞', html.includes('贵公司欠我方'), true);
    // 留痕（问题三）：函件自己说清数据从哪来
    H.check('留有「数据来源」', html.includes('数据来源'), true);
    H.check('留痕含导入批次', /导入批次 imp_/.test(html), true);
    H.check('留痕含原文件名', /原文件：.*\.xlsx/.test(html), true);
    H.check('留痕含余额口径', html.includes('余额口径'), true);
    H.check('留痕含版本号', /版本：v\d/.test(html), true);
    H.check('留痕含生成时间', /生成时间：\d{4}-\d{2}-\d{2}T/.test(html), true);
  }
  {
    // 应付函措辞
    const html = templates.renderStatement({
      unit: unitsMod.get(U.yi.id),
      balance: ledger.computeUnitBalance(U.yi.id, { cutoff: '2026-08-31', direction: 'payable', from: '2026-08-01', config: cfg }),
      session: { period: '2026-08', cutoffDate: '2026-08-31', direction: 'payable' },
      config: cfg,
      statement: { serialNo: 'DZH-T-1', version: 1 },
    });
    H.check('应付函标题', html.includes('应付账款对账函'), true);
    H.check('应付措辞', html.includes('我方欠贵公司'), true);
    H.check('应付余额大写', html.includes('壹拾贰万元整'), true);
  }

  H.section('批次 zip 下载');
  {
    const z = await statementMod.batchZip(gen1.session.id);
    H.check('zip 生成成功', z.ok, true);
    H.check('zip 内含 3 家 × (pdf+xlsx)', z.count >= 6, true);
    H.check('zip 有体积', z.bytes > 10000, true);
  }

  H.section('Excel 导出内容校验');
  {
    const read = XLSX.readFile(st.xlsxPath);
    H.check('有对账函工作表', read.SheetNames.includes('对账函'), true);
    H.check('有明细附页工作表', read.SheetNames.includes('明细附页'), true);
    const txt = XLSX.utils.sheet_to_csv(read.Sheets['对账函']);
    H.check('Excel 含大写', txt.includes('柒万元整'), true);
    H.check('Excel 含编号', txt.includes(st.serialNo), true);
    const csv2 = XLSX.utils.sheet_to_csv(read.Sheets['明细附页']);
    H.check('明细附页含逐笔摘要', csv2.includes('销售开票'), true);
    H.check('明细附页含合计行', csv2.includes('本期合计'), true);
    H.check('Excel 也印了留痕行', /数据来源：导入批次 imp_/.test(txt), true);
  }

  const SCALE_N = process.env.RDTEST_SKIP_SCALE === '1' ? 5 : 50;
  H.section('规模验收：' + SCALE_N + ' 家单位 × 每家 200 行（计划 §5.5 达标线：50 家 < 60 秒）');
  {
    const unitIds = [];
    for (let i = 1; i <= SCALE_N; i++) {
      const u = unitsMod.create({ name: '规模测试' + i + '号有限公司', type: 'customer' });
      unitIds.push(u.id);
      const rows = [['日期', '摘要', '借方金额', '贷方金额']];
      for (let r = 0; r < 200; r++) {
        const day = String((r % 28) + 1).padStart(2, '0');
        rows.push(['2026-08-' + day, '业务 ' + r, r % 3 === 0 ? 1000 + r : '', r % 3 === 0 ? '' : 500 + r]);
      }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S');
      const p = path.join(RUN, 'scale' + i + '.xlsx');
      XLSX.writeFile(wb, p);
      const buf = fs.readFileSync(p);
      const a = importer.analyze({ buffer: buf, filename: 'scale' + i + '.xlsx', config: cfg });
      importer.commit({
        buffer: buf,
        filename: 'scale' + i + '.xlsx',
        config: cfg,
        units: unitsMod.all(),
        plans: [{ sheetName: 'S', include: true, headerRow: a.sheets[0].headerRowNo, mapping: a.sheets[0].mapping, unitId: u.id, account: '应收账款' }],
      });
    }
    H.check('规模数据共 ' + SCALE_N + ' 家', unitIds.length, SCALE_N);
    const t0 = Date.now();
    const g = await statementMod.generate({ unitIds, cutoffDate: '2026-08-31', direction: 'receivable', period: '2026-08', config: cfg });
    const sec = (Date.now() - t0) / 1000;
    H.check(SCALE_N + ' 家全部成功', g.okCount, SCALE_N);
    H.check(SCALE_N + ' 家 × 200 行全程 < 60 秒', sec < 60, true);
    H.check('全部 PDF 成功（并发 ' + g.concurrency + '）', g.results.filter((r) => r.pdfOk).length, SCALE_N);
    console.log('  [INFO] ' + SCALE_N + ' 家 × 200 行生成耗时 ' + sec.toFixed(1) + ' 秒（引擎 ' + g.pdfEngine + (g.pdfEngine === 'puppeteer-core-shared' ? '，顺序渲染' : '，并发 ' + g.concurrency) + '）');
    const z = await statementMod.batchZip(g.session.id);
    H.check(SCALE_N + ' 家 zip 打包成功', z.ok && z.count >= SCALE_N * 2, true);
    console.log('  [INFO] zip 体积 ' + Math.round(z.bytes / 1024) + ' KB，含 ' + z.count + ' 个文件');
  }

  H.section('浏览器探测与降级路径');
  {
    const probe = exporter.probeBrowser(true);
    H.check('探测到系统浏览器', probe.ok, true);
    H.check('探测到的是 Edge 或 Chrome', /msedge\.exe|chrome\.exe/i.test(probe.path), true);
    const bad = await exporter.htmlToPdf('<html><body>x</body></html>', path.join(RUN, 'x', 'y.pdf'));
    H.check('正常 HTML 也能出 PDF', bad.ok, true);
    // 降级：把浏览器路径指到不存在的文件
    configMod.saveConfig({ browserPath: path.join(RUN, 'nope.exe') });
    const pr2 = exporter.probeBrowser(true);
    H.check('配置非法路径后探测仍能回退到系统浏览器', pr2.ok, true);
    configMod.saveConfig({ browserPath: '' });
  }

  H.section('统计与归档树');
  {
    const tree = require('../../src/archive').tree();
    H.check('归档树有单位', tree.length > 0, true);
    const jiaNode = tree.find((t) => t.unitId === U.jia.id);
    H.check('甲有期间节点', jiaNode.periods[0].period, '2026-08');
    H.check('甲有 2 个版本', jiaNode.periods[0].versions.length, 2);
    H.check('版本倒序（最新在前）', jiaNode.periods[0].versions[0].version, 2);
    const stt = require('../../src/archive').stats();
    H.check('统计：单位数 ≥ 15', stt.units >= 15, true);
    H.check('统计：对账函数 ≥ 14', stt.statements >= 14, true);
  }

  console.log('\n测试数据目录: ' + store.DATA);
  H.finish('t3_statement');
})();
