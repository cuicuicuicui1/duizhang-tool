'use strict';
/*
 * t4_matcher.js — 层 1/2「勾对算法」：一致 / 未达账项 / 组合匹配 / 方向记反 / 疑似重复 /
 *                            时间性差异 / 仅余额 / 方向翻转 / draft→confirmed 闭环
 * 以及回函导入适配器（格式记忆、粘贴解析、四层降级）。
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const RUN = path.join(__dirname, '.run', 'match_' + Date.now());
process.env.DZ_DATA = path.join(RUN, 'data');
process.env.DZ_BACKUP = path.join(RUN, 'backups');

const H = require('./_harness');
const store = require('../../src/store');
const importer = require('../../src/importer');
const unitsMod = require('../../src/units');
const ledger = require('../../src/ledger');
const money = require('../../src/money');
const statementMod = require('../../src/statement');
const matcher = require('../../src/matcher');
const replyAdapter = require('../../src/replyAdapter');
const configMod = require('../../src/config');
const samples = require('../make_samples');

const SAMPLE_DIR = path.join(__dirname, '..', '..', 'samples');
const E = {};
for (const u of samples.EXPECTED.units) E[u.key] = u;
const R = samples.EXPECTED.replies;

const cfg = configMod.saveConfig({
  company: samples.EXPECTED.ourCompany,
  balanceMode: 'auto',
  matchWindowDays: 15,
  detailAttach: 'auto',
});
store.ensureDirs();

const U = {};
for (const u of samples.EXPECTED.units) U[u.key] = unitsMod.create({ name: u.name, type: u.type });

function importClean(key) {
  const name = 's01_标准明细账_' + E[key].name + '.xlsx';
  const buf = fs.readFileSync(path.join(SAMPLE_DIR, name));
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

H.section('准备：导入三家 + 生成对账函');
for (const u of samples.EXPECTED.units) importClean(u.key);

(async () => {
  const gen = await statementMod.generate({
    unitIds: [U.jia.id, U.yi.id, U.bing.id],
    cutoffDate: '2026-08-31',
    direction: 'receivable',
    period: '2026-08',
    config: cfg,
  });
  H.check('三家对账函生成成功', gen.okCount, 3);
  const stJia = gen.results.find((r) => r.unitId === U.jia.id);
  const stYi = gen.results.find((r) => r.unitId === U.yi.id);
  const stBing = gen.results.find((r) => r.unitId === U.bing.id);

  // ---------------------------------------------------------------- 场景 1
  H.section('场景 1：完全一致（甲）');
  {
    const r = matcher.runAndSave({
      statementId: stJia.statementId,
      theirBalanceFen: R.jia.theirBalanceFen,
      theirEntries: R.jia.detail,
      channel: 'manual',
      config: cfg,
    });
    const d = r.diffResult;
    H.check('余额快比无差异', d.balanceDiffFen, 0);
    H.check('结论=一致', d.status, 'draft');
    H.check('L1 全部匹配 4 笔', d.levels.l1, 4);
    H.check('无剩余', d.ourOnly.length + d.theirOnly.length, 0);
    H.check('无时间性差异', d.timeDiffs.length, 0);
    H.check('无可疑记录', d.suspects.length, 0);
    H.check('结论文案', d.summary, '双方余额一致，逐笔勾对全部匹配。');
  }

  // ---------------------------------------------------------------- 场景 2
  H.section('场景 2：未达账项（乙，2 笔己方有对方无）');
  {
    const r = matcher.runAndSave({
      statementId: stYi.statementId,
      theirBalanceFen: R.yi.theirBalanceFen,
      theirEntries: R.yi.detail,
      channel: 'manual',
      config: cfg,
    });
    const d = r.diffResult;
    H.check('我方余额 120,000', money.fenToStr(d.ourClosingFen), '120,000.00');
    H.check('对方余额 80,000', money.fenToStr(d.theirBalanceFen), '80,000.00');
    H.check('差异 40,000', d.balanceDiffFen, 4000000);
    H.check('L1 匹配 2 笔', d.levels.l1, 2);
    H.check('己方独有 2 笔', d.ourOnly.length, 2);
    H.check('对方独有 0 笔', d.theirOnly.length, 0);
    H.check('己方独有金额含 50,000', d.ourOnly.some((x) => Math.abs(x.amountFen) === 5000000), true);
    H.check('己方独有金额含 -10,000', d.ourOnly.some((x) => x.amountFen === -1000000), true);
    H.check('未匹配净影响 = 差异', d.unmatchedImpactFen, d.balanceDiffFen);
    H.check('结论=有差异', d.status, 'draft');
    H.check('提示需人工确认', d.warnings.some((w) => /人工逐项确认/.test(w)), true);
  }

  // ---------------------------------------------------------------- 场景 3
  H.section('场景 3：组合匹配（丙，5 笔己方 ↔ 1 笔对方合并入账）');
  {
    const r = matcher.runAndSave({
      statementId: stBing.statementId,
      theirBalanceFen: R.bing.theirBalanceFen,
      theirEntries: R.bing.detail,
      channel: 'manual',
      config: cfg,
    });
    const d = r.diffResult;
    H.check('余额一致', d.balanceDiffFen, 0);
    H.check('组合匹配 1 组', d.levels.l3, 1);
    H.check('组合方向 = 我方多笔合并', d.combos[0].direction, 'ours_merged');
    H.check('组合含 5 笔我方明细', d.combos[0].our.length, 5);
    H.check('L1 命中 0（金额都不同）', d.levels.l1, 0);
    H.check('无剩余未匹配', d.ourOnly.length + d.theirOnly.length, 0);
    H.check('结论=一致', /逐笔勾对全部匹配|余额一致/.test(d.summary), true);
  }

  H.section('场景 3b：同一份回函用对方口径写（贷方）+ 方向翻转');
  {
    const src = R.bing.asCounterpartyLedger;
    const noFlip = matcher.diff({
      statementId: stBing.statementId,
      theirBalanceFen: src.theirBalanceFen,
      theirEntries: src.detail,
      signFlip: false,
      config: cfg,
      autoDetectFlip: false,
    });
    H.check('不翻转时对不上（有剩余）', noFlip.ourOnly.length + noFlip.theirOnly.length > 0, true);
    H.check('不翻转时组合匹配为 0', noFlip.levels.l3, 0);
    const flipped = matcher.diff({
      statementId: stBing.statementId,
      theirBalanceFen: src.theirBalanceFen,
      theirEntries: src.detail,
      signFlip: true,
      config: cfg,
    });
    H.check('翻转后余额一致', flipped.balanceDiffFen, 0);
    H.check('翻转后组合匹配命中', flipped.levels.l3, 1);
    H.check('翻转后无剩余', flipped.ourOnly.length + flipped.theirOnly.length, 0);
  }

  // ---------------------------------------------------------------- 场景 4
  H.section('场景 4：时间性差异（在途，同金额日期相差 ≤ 窗口）');
  {
    const cu = unitsMod.create({ name: '时间性差异测试有限公司', type: 'customer' });
    const buf = buildXlsx([
      ['日期', '摘要', '借方金额', '贷方金额'],
      ['2026-08-01', '销售开票', 10000, ''],
      ['2026-08-02', '销售开票', 20000, ''],
    ]);
    importFixed(buf, 'timing.xlsx', cu.id, '应收账款');
    const g = await statementMod.generate({ unitIds: [cu.id], cutoffDate: '2026-08-31', direction: 'receivable', period: '2026-08', config: cfg });
    const d = matcher.diff({
      statementId: g.results[0].statementId,
      theirBalanceFen: 3000000,
      theirEntries: [
        { date: '2026-08-11', summary: '销售开票', debitFen: 1000000, creditFen: 0 },
        { date: '2026-08-02', summary: '销售开票', debitFen: 2000000, creditFen: 0 },
      ],
      config: cfg,
    });
    H.check('时间性差异 1 项', d.timeDiffs.length, 1);
    H.check('时间差 10 天', d.timeDiffs[0].dateGapDays, 10);
    H.check('L1 命中 1 笔', d.levels.l1, 1);
    H.check('结论=一致（金额都能对上）', d.balanceDiffFen, 0);
  }

  H.section('场景 5：金额相同但日期差超窗口 → 可疑而非直接匹配');
  {
    const cu = unitsMod.create({ name: '超窗口测试有限公司', type: 'customer' });
    const buf = buildXlsx([
      ['日期', '摘要', '借方金额'],
      ['2026-08-01', '销售开票', 5000],
    ]);
    importFixed(buf, 'far.xlsx', cu.id, '应收账款');
    const g = await statementMod.generate({ unitIds: [cu.id], cutoffDate: '2026-08-31', direction: 'receivable', period: '2026-08', config: cfg });
    const d = matcher.diff({
      statementId: g.results[0].statementId,
      theirBalanceFen: 500000,
      theirEntries: [{ date: '2026-08-30', summary: '销售开票', debitFen: 500000, creditFen: 0 }],
      config: cfg,
    });
    H.check('进入可疑而非匹配', d.suspects.some((s) => s.kind === 'same_amount_far_date'), true);
    H.check('时间性差异为 0', d.timeDiffs.length, 0);
    H.check('余额一致但带提示', d.status, 'consistent_with_notes');
  }

  // ---------------------------------------------------------------- 场景 6
  H.section('场景 6：方向记反（金额相同、借贷对调）');
  {
    const cu = unitsMod.create({ name: '方向记反测试有限公司', type: 'customer' });
    const buf = buildXlsx([
      ['日期', '摘要', '借方金额', '贷方金额'],
      ['2026-08-05', '销售开票', 8000, ''],
    ]);
    importFixed(buf, 'rev.xlsx', cu.id, '应收账款');
    const g = await statementMod.generate({ unitIds: [cu.id], cutoffDate: '2026-08-31', direction: 'receivable', period: '2026-08', config: cfg });
    const d = matcher.diff({
      statementId: g.results[0].statementId,
      theirBalanceFen: 800000,
      theirEntries: [{ date: '2026-08-05', summary: '销售开票', debitFen: 0, creditFen: 800000 }],
      config: cfg,
    });
    H.check('识别出方向相反疑似', d.suspects.some((s) => s.kind === 'reversed'), true);
    H.check('不误判为精确匹配', d.levels.l1, 0);
    H.check('给出翻转建议', !!d.flipSuggestion, true);
  }

  H.section('场景 7：疑似重复记账（同金额同摘要两次）');
  {
    const cu = unitsMod.create({ name: '重复记账测试有限公司', type: 'customer' });
    const buf = buildXlsx([
      ['日期', '摘要', '借方金额'],
      ['2026-08-03', '销售开票 A', 6000],
      ['2026-08-04', '销售开票 A', 6000],
    ]);
    importFixed(buf, 'dup2.xlsx', cu.id, '应收账款');
    const g = await statementMod.generate({ unitIds: [cu.id], cutoffDate: '2026-08-31', direction: 'receivable', period: '2026-08', config: cfg });
    const d = matcher.diff({
      statementId: g.results[0].statementId,
      theirBalanceFen: 600000,
      theirEntries: [{ date: '2026-08-03', summary: '销售开票 A', debitFen: 600000, creditFen: 0 }],
      config: cfg,
    });
    H.check('匹配掉 1 笔', d.levels.l1, 1);
    H.check('剩余 1 笔我方独有', d.ourOnly.length, 1);
    H.check('提示疑似重复', d.suspects.some((s) => s.kind === 'duplicate'), true);
  }

  // ---------------------------------------------------------------- 场景 8
  H.section('场景 8：只有余额没有明细');
  {
    const d = matcher.diff({
      statementId: stJia.statementId,
      theirBalanceFen: 7000000,
      theirEntries: [],
      config: cfg,
    });
    H.check('余额一致结论', d.status, 'consistent');
    H.check('文案提示未提供明细', /未提供明细/.test(d.summary), true);
    const d2 = matcher.diff({
      statementId: stJia.statementId,
      theirBalanceFen: 6500000,
      theirEntries: [],
      config: cfg,
    });
    H.check('余额不符 → manual', d2.status, 'manual');
    H.check('提示索取明细', /索取明细/.test(d2.summary), true);
    H.check('打 MANUAL_REVIEW 标记', d2.warnings.some((w) => /MANUAL_REVIEW/.test(w)), true);
  }

  H.section('场景 9：仅有余额的单位（科目余额表）走人工路径');
  {
    const bu = unitsMod.create({ name: '仅余额单位有限公司', type: 'customer' });
    const buf = buildXlsx([
      ['单位名称', '期初余额', '本期借方', '本期贷方', '期末余额'],
      ['仅余额单位有限公司', 0, 5000, 1000, 4000],
    ]);
    importFixed(buf, 'onlybal.xlsx', bu.id, '应收账款');
    const g = await statementMod.generate({ unitIds: [bu.id], cutoffDate: '2026-08-31', direction: 'receivable', period: '2026-08', config: cfg });
    const b = ledger.computeUnitBalance(bu.id, { cutoff: '2026-08-31', direction: 'receivable', config: configMod.saveConfig({ balanceMode: 'balance_sheet' }) });
    H.check('仅余额单位无逐笔明细', b.balanceOnly, true);
    const d = matcher.diff({ statementId: g.results[0].statementId, theirBalanceFen: 400000, theirEntries: [], config: cfg });
    H.check('仅余额 → 结论一致', d.status, 'consistent');
    H.check('提示无逐笔明细可比对', /逐笔明细/.test(d.summary), true);
  }

  // ---------------------------------------------------------------- 场景 10
  H.section('场景 10：余额一致但明细有未匹配（可能相互抵销）');
  {
    const d = matcher.diff({
      statementId: stYi.statementId,
      theirBalanceFen: 12000000,
      theirEntries: [
        { date: '2026-08-05', summary: '采购入库', creditFen: 15000000, debitFen: 0 },
        { date: '2026-08-18', summary: '支付货款', debitFen: 8000000, creditFen: 0 },
        { date: '2026-08-25', summary: '采购入库', creditFen: 5000000, debitFen: 0 },
      ],
      config: cfg,
    });
    H.check('余额一致', d.balanceDiffFen, 0);
    H.check('状态带提示', d.status, 'consistent_with_notes');
    H.check('有未匹配明细', d.ourOnly.length + d.theirOnly.length > 0, true);
  }

  H.section('方向翻转自动建议（明细借贷方向相反）');
  {
    const src = R.bing.asCounterpartyLedger;
    const d = matcher.diff({
      statementId: stBing.statementId,
      theirBalanceFen: R.bing.theirBalanceFen,
      theirEntries: src.detail,
      signFlip: false,
      config: cfg,
    });
    H.check('未翻转时对不上', d.ourOnly.length + d.theirOnly.length > 0, true);
    H.check('给出翻转建议', !!d.flipSuggestion, true);
    H.check('建议文案含「方向」', /方向/.test(d.flipSuggestion || ''), true);
    H.check('附上翻转后的待处理项数', d.flipAlternative.problems, 0);
    H.check('余额差不受翻转影响', d.balanceDiffFen, 0);
  }

  // ---------------------------------------------------------------- 确认闭环
  H.section('draft → confirmed 闭环 + 差异报告归档');
  {
    const r = matcher.runAndSave({
      statementId: stYi.statementId,
      theirBalanceFen: R.yi.theirBalanceFen,
      theirEntries: R.yi.detail,
      channel: 'manual',
      config: cfg,
    });
    H.check('初始状态 draft', r.reply.status, 'draft');
    H.check('勾对结果已挂到记录上', !!r.reply.diffResult, true);
    const rep = matcher.renderReportHtml({
      statement: { serialNo: 'X', unitName: 'U', period: '2026-08', direction: 'payable', cutoffDate: '2026-08-31', version: 1 },
      reply: {},
      diffResult: r.diffResult,
      confirmedBy: '',
      confirmedAt: '',
    });
    H.check('报告含未匹配明细', /己方有、对方无/.test(rep), true);
    H.check('报告无 NaN', /NaN/.test(rep), false);
    H.check('报告无 undefined', /undefined/.test(rep), false);

    const c = matcher.confirm({ replyId: r.reply.id, confirmedBy: '张三', decisions: [{ item: 'ourOnly', action: 'accept' }], note: '已电话确认' });
    H.check('状态转 confirmed', c.status, 'confirmed');
    H.check('记录确认人', c.confirmedBy, '张三');
    const stmt = statementMod.getStatement(stYi.statementId);
    H.check('差异报告 JSON 已归档', fs.existsSync(path.join(stmt.archivedDir, stmt.serialNo + '_差异报告.json')), true);
    H.check('差异报告 HTML 已归档', fs.existsSync(path.join(stmt.archivedDir, stmt.serialNo + '_差异报告.html')), true);
    const saved = JSON.parse(fs.readFileSync(path.join(stmt.archivedDir, stmt.serialNo + '_差异报告.json'), 'utf8'));
    H.check('归档报告含确认人', saved.confirmedBy, '张三');
    H.check('批次确认计数', matcher.confirmedCountOf(stmt.sessionId) >= 1, true);
  }

  // ---------------------------------------------------------------- 算法内核
  H.section('子集和内核单测');
  {
    const c = (arr) => arr.map((v) => ({ amount: v }));
    H.check('2 项组合', matcher.subsetSum(c([3, 7, 11]), 10, 5, 10000) !== null, true);
    H.check('3 项组合', matcher.subsetSum(c([1, 2, 3, 10]), 6, 5, 10000) !== null, true);
    H.check('无解返回 null', matcher.subsetSum(c([2, 4, 6]), 5, 5, 10000), null);
    H.check('单项不匹配（需 ≥2 项）', matcher.subsetSum(c([5]), 5, 5, 10000), null);
    H.check('预算耗尽返回 null', matcher.subsetSum(c(Array.from({ length: 19 }, () => 1)), 19, 8, 5), null);
    H.check('8 项求和能解出（100+…+800=3600）', matcher.subsetSum(c([900, 800, 700, 600, 500, 400, 300, 200, 100]), 3600, 8, 500000) !== null, true);
    H.check('超过 8 项上限时返回 null（需 9 项凑 4500）', matcher.subsetSum(c([100, 200, 300, 400, 500, 600, 700, 800, 900]), 4500, 8, 500000), null);
  }

  // ---------------------------------------------------------------- 回函适配器
  H.section('回函适配器 — 粘贴模式（第 4 层降级）');
  {
    const t1 = '日期\t摘要\t借方金额\t贷方金额\n2026-08-05\t销售开票\t1000\t\n2026-08-06\t回款\t\t500';
    const p1 = replyAdapter.entriesFromPaste(t1, { config: cfg });
    H.check('Tab 分隔被识别', p1.entries.length, 2);
    H.check('金额解析正确', p1.entries[0].debitFen, 100000);
    H.check('表头被识别', p1.headerRowNo, 1);

    const t2 = '2026-08-05,销售开票,1000\n2026-08-06,回款,-500';
    const p2 = replyAdapter.entriesFromPaste(t2, { config: cfg });
    H.check('无表头时按内容猜列', p2.entries.length, 2);
    H.check('猜出日期列', p2.mapping.date, 0);
    H.check('猜出摘要列', p2.mapping.summary, 1);
    H.check('猜出金额列', p2.mapping.amount, 2);
    H.check('负号进贷方', p2.entries[1].creditFen, 50000);

    const t3 = '2026-08-05  销售开票  1000\n2026-08-06  回款  500';
    const p3 = replyAdapter.entriesFromPaste(t3, { config: cfg });
    H.check('多空格分隔被识别', p3.entries.length, 2);

    const t4 = '1000';
    const p4 = replyAdapter.entriesFromPaste(t4, { config: cfg });
    H.check('只有一行一个数字也能吞下', p4.entries.length, 1);
  }

  H.section('回函适配器 — 文件解析与格式记忆（第 1/2 层）');
  {
    const replyRows = [
      ['往来单位对账回函'],
      ['业务日期', '对方摘要', '本期借方', '本期贷方'],
      ['2026-08-05', '采购入库', '', 200000],
      ['2026-08-18', '支付货款', 120000, ''],
    ];
    const buf = buildXlsx(replyRows);
    const a = replyAdapter.analyzeReplyFile({ buffer: buf, filename: 'reply_yi.xlsx', unitId: U.yi.id, config: cfg });
    const s = a.sheets[0];
    H.check('回函表头被识别', s.headerRowNo, 2);
    H.check('别名字典覆盖「本期贷方」', s.autoMapping.credit, 3);
    H.check('别名字典覆盖「业务日期」', s.autoMapping.date, 0);
    H.check('首次无记忆方案', s.savedMap, null);
    H.check('映射来源=自动识别', s.mappingSource, '自动识别');

    const parsed = replyAdapter.parseReplySheet({
      buffer: buf,
      filename: 'reply_yi.xlsx',
      unitId: U.yi.id,
      sheetName: s.name,
      headerRowNo: s.headerRowNo,
      mapping: s.mapping,
      config: cfg,
    });
    H.check('解析出 2 笔', parsed.entries.length, 2);
    H.check('贷方 200,000', parsed.entries[0].creditFen, 20000000);
    H.check('借方 120,000', parsed.entries[1].debitFen, 12000000);

    // 保存为该单位的回函格式
    const saved = replyAdapter.rememberFormat({
      unitId: U.yi.id,
      name: '乙公司回函格式',
      headers: s.headers,
      signature: s.signature,
      headerRowNo: s.headerRowNo,
      mapping: s.mapping,
    });
    H.check('记忆方案已保存', !!saved.id, true);
    const a2 = replyAdapter.analyzeReplyFile({ buffer: buf, filename: 'reply_yi.xlsx', unitId: U.yi.id, config: cfg });
    H.check('第二次命中记忆方案', a2.sheets[0].savedMap.name, '乙公司回函格式');
    H.check('记忆方案免去再映射', a2.sheets[0].mappingSource, '记忆方案：乙公司回函格式');

    // 导出/导入方案（会计之间共享）
    const ex = replyAdapter.exportMaps();
    H.check('导出含方案', ex.maps.length, 1);
    const im = replyAdapter.importMaps({ maps: [Object.assign({}, ex.maps[0], { unitId: U.bing.id, name: '丙公司回函格式' })] });
    H.check('导入新增 1 条', im.added, 1);
    H.check('方案总数 2', replyAdapter.allMaps().length, 2);

    // 对方账套口径：他们的贷方 = 我方的借方
    const flipBuf = buildXlsx([
      ['日期', '摘要', '本期借方', '本期贷方'],
      ['2026-08-05', '采购入库', '', 200000],
    ]);
    const fs2 = replyAdapter.analyzeReplyFile({ buffer: flipBuf, filename: 'flip.xlsx', unitId: U.yi.id, config: cfg });
    const noFlip = replyAdapter.parseReplySheet({
      buffer: flipBuf,
      filename: 'flip.xlsx',
      unitId: U.yi.id,
      sheetName: fs2.sheets[0].name,
      headerRowNo: fs2.sheets[0].headerRowNo,
      mapping: { date: 0, summary: 1, debit: 2, credit: 3 },
      config: cfg,
    });
    H.check('不翻转：对方贷方 200,000', noFlip.entries[0].creditFen, 20000000);
    const fp = replyAdapter.parseReplySheet({
      buffer: flipBuf,
      filename: 'flip.xlsx',
      unitId: U.yi.id,
      sheetName: fs2.sheets[0].name,
      headerRowNo: fs2.sheets[0].headerRowNo,
      mapping: { date: 0, summary: 1, debit: 2, credit: 3 },
      signFlip: true,
      config: cfg,
    });
    H.check('翻转后：对方贷方变我方借方 200,000', fp.entries[0].debitFen, 20000000);
    H.check('翻转后贷方清零', fp.entries[0].creditFen, 0);
  }

  H.section('数据一致性：明细缓存与直读一致');
  {
    ledger.invalidateCache();
    const a1 = ledger.allLedgers().length;
    const a2 = store.readJson('ledgers.json', []).length;
    H.check('缓存条数一致', a1, a2);
  }

  console.log('\n测试数据目录: ' + store.DATA);
  H.finish('t4_matcher');
})();

// ---------------------------------------------------------------- 工具
function buildXlsx(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S');
  const p = path.join(RUN, 'tmp_' + Math.random().toString(36).slice(2, 7) + '.xlsx');
  fs.mkdirSync(RUN, { recursive: true });
  XLSX.writeFile(wb, p);
  return fs.readFileSync(p);
}
function importFixed(buf, filename, unitId, account) {
  const a = importer.analyze({ buffer: buf, filename, config: cfg });
  return importer.commit({
    buffer: buf,
    filename,
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: a.sheets[0].name, include: true, headerRow: a.sheets[0].headerRowNo, mapping: a.sheets[0].mapping, unitId, account }],
  });
}
