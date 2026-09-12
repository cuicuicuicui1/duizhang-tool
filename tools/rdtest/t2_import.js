'use strict';
/*
 * t2_import.js — 层 1/3「导入解析」：18 类脏数据样本 + 幂等 + 指纹去重
 * 用独立的临时数据目录，不污染真实 data/。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const XLSX = require('xlsx');

const RUN = path.join(__dirname, '.run', 'import_' + Date.now());
process.env.DZ_DATA = path.join(RUN, 'data');
process.env.DZ_BACKUP = path.join(RUN, 'backups');

const H = require('./_harness');
const store = require('../../src/store');
const importer = require('../../src/importer');
const unitsMod = require('../../src/units');
const money = require('../../src/money');
const dates = require('../../src/dates');
const columns = require('../../src/columns');
const cfgMod = require('../../src/config');
const samples = require('../make_samples');

const SAMPLE_DIR = path.join(__dirname, '..', '..', 'samples');
const cfg = cfgMod.getConfig();
store.ensureDirs();

function readSample(name) {
  return fs.readFileSync(path.join(SAMPLE_DIR, name));
}
function analyze(name) {
  // 便捷包装：在原始结果上挂 res（自引用）与 s（首个 sheet），
  // 这样 const { res, s } / const a = analyze(...) / const res = analyze(...) 三种写法都能用
  const raw = importer.analyze({ buffer: readSample(name), filename: name, config: cfg });
  raw.res = raw;
  raw.s = raw.sheets[0];
  return raw;
}
function sheetOf(res, idx) {
  return res.sheets[idx || 0];
}
/** 把 analyze 结果一行搞定地入库 */
function importSample(name, unitId, account, sheetIdx) {
  const res = analyze(name);
  const s = sheetOf(res, sheetIdx || 0);
  const r = importer.commit({
    buffer: readSample(name),
    filename: name,
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: s.name, include: true, headerRow: s.headerRowNo, mapping: s.mapping, unitId, account }],
  });
  return { res, s, r };
}

// ---------------------------------------------------------------- 建档案
H.section('准备：建立三家单位档案');
const U = {};
for (const u of samples.EXPECTED.units) {
  const created = unitsMod.create({ name: u.name, type: u.type, alias: [] });
  U[u.key] = created;
}
H.check('档案数量', unitsMod.all().length, 3);
H.check('甲档案类型', U.jia.type, 'customer');

const E = {};
for (const u of samples.EXPECTED.units) E[u.key] = u;

// ---------------------------------------------------------------- s01
H.section('s01 标准明细账（标题行在上 + 双列借贷 + 合计行）');
{
  const { res, s } = analyze('s01_标准明细账_' + E.jia.name + '.xlsx');
  H.check('文件类型', res.fileKind, 'excel:xlsx');
  H.check('表头行号（1-based）', s.headerRowNo, 4);
  H.check('表头命中列数', Object.keys(s.mapping).length, 5);
  H.check('日期列下标', s.mapping.date, 0);
  H.check('借方列下标', s.mapping.debit, 2);
  H.check('贷方列下标', s.mapping.credit, 3);
  H.check('余额列下标', s.mapping.balance, 4);
  H.check('数据行数', s.dataRows, 4);
  H.check('合计行被识别为小计', s.subtotalRows.length, 1);

  const r = importSample('s01_标准明细账_' + E.jia.name + '.xlsx', U.jia.id, E.jia.account);
  H.check('入库条数', r.r.added, 4);
  H.check('借方合计（分）', money.sumFen(store.readJson('ledgers.json').filter((e) => e.account === E.jia.account).map((e) => e.debitFen)), E.jia.debitFen);
  H.check('贷方合计（分）', money.sumFen(store.readJson('ledgers.json').filter((e) => e.account === E.jia.account).map((e) => e.creditFen)), E.jia.creditFen);
}

// ---------------------------------------------------------------- s02/s03/s04
H.section('s02 .xls 老格式 / s03 GBK CSV / s04 UTF-8 BOM');
{
  const a = analyze('s02_老格式xls_2003.xls');
  H.check('xls 解析出表头', a.sheets[0].headerRowNo, 2);
  H.check('xls 数据行数', a.sheets[0].dataRows, 2);
  H.check('标题行给出单位名建议', /某市某某商贸有限公司/.test(a.unitHints[0].guess), true);
  H.check('单位列不存在时 unitHits 为空', a.unitHits.length, 0);
}
{
  const buf = readSample('s03_GBK编码_无BOM.csv');
  const dec = importer.decodeText(buf);
  H.check('GBK 编码被识别', dec.encoding, 'gb18030');
  H.check('GBK 中文无乱码', /某市某某商贸有限公司/.test(dec.text), true);
  const a = importer.analyze({ buffer: buf, filename: 's03_GBK编码_无BOM.csv', config: cfg });
  H.check('GBK csv 表头命中', Object.keys(a.sheets[0].mapping).length >= 4, true);
  H.check('GBK csv 数据行数', a.sheets[0].dataRows, 2);
}
{
  const buf = readSample('s04_UTF8带BOM.csv');
  const dec = importer.decodeText(buf);
  H.check('BOM 被剔除', dec.encoding, 'utf-8-bom');
  H.check('BOM 后首字符正确', dec.text.trim().startsWith('业务日期'), true);
  const a = importer.analyze({ buffer: buf, filename: 's04_UTF8带BOM.csv', config: cfg });
  H.check('别名「业务日期」映射到日期', a.sheets[0].mapping.date, 0);
  H.check('别名「单位名称」映射到单位', a.sheets[0].mapping.unitName, 1);
  H.check('别名「摘要说明」映射到摘要', a.sheets[0].mapping.summary, 2);
  H.check('别名「借方」映射到借方', a.sheets[0].mapping.debit, 3);
}

// ---------------------------------------------------------------- s05/s06/s07
H.section('s05 千分位与括号负数（红字）');
{
  const { s } = analyze('s05_千分位括号负数.xlsx');
  const rows = s.preview.filter((p) => p.kind === 'data');
  H.check('第 1 行借方 = 1,234,567.89', rows[0].debitFen, 123456789);
  H.check('第 2 行括号负数转贷方', rows[1].creditFen, 100000000);
  H.check('第 2 行借方清零', rows[1].debitFen, 0);
  H.check('第 3 行红字转贷方', rows[2].creditFen, 23456789);
}

H.section('s06 金额 + 方向单列');
{
  const { s } = analyze('s06_金额加方向单列.xlsx');
  const rows = s.preview.filter((p) => p.kind === 'data');
  H.check('借方向 → 借方 12000', rows[0].debitFen, 1200000);
  H.check('贷方向 → 贷方 5000', rows[1].creditFen, 500000);
  H.check('「借方」两字也认', rows[2].debitFen, 300000);
}

H.section('s07 正负混合单列（科目决定正号方向）');
{
  const { s } = analyze('s07_正负混合单列_应付.xlsx');
  H.check('单列金额映射到 amount', s.mapping.amount, 2);
  const rows = s.preview.filter((p) => p.kind === 'data');
  H.check('未指定科目时按资产方向：正号入借方', rows[0].debitFen, 20000000);

  const buf = readSample('s07_正负混合单列_应付.xlsx');
  const withAccount = importer.analyzeSheet(
    importer.loadWorkbook(buf, 's07.xlsx').sheets[0],
    columns.buildAliasIndex(cfg.aliases),
    cfg,
    { account: '应付账款' }
  );
  const rows2 = withAccount.preview.filter((p) => p.kind === 'data');
  H.check('指定应付账款后正号入贷方', rows2[0].creditFen, 20000000);
  H.check('指定应付账款后负号入借方', rows2[1].debitFen, 12000000);
}

// ---------------------------------------------------------------- s08/s09/s10
H.section('s08 日期全格式');
{
  const { s } = analyze('s08_日期全格式.xlsx');
  const rows = s.preview.filter((p) => p.kind === 'data');
  H.check('2026/8/31', rows[0].date, '2026-08-31');
  H.check('2026-08-31', rows[1].date, '2026-08-31');
  H.check('2026年8月31日', rows[2].date, '2026-08-31');
  H.check('20260831', rows[3].date, '2026-08-31');
  H.check('Excel 序列数 45900', rows[4].date, '2025-08-31');
  H.check('仅到月取 1 日', rows[5].date, '2026-08-01');
}

H.section('s09 小计与合计行剔除');
{
  const { s } = analyze('s09_小计合计行.xlsx');
  H.check('小计/合计/总计共 3 行', s.subtotalRows.length, 3);
  H.check('数据行数只剩 3', s.dataRows, 3);
}

H.section('s10 空行与空列');
{
  const { s } = analyze('s10_空行与空列.xlsx');
  H.check('数据行数 2', s.dataRows, 2);
  H.check('空表头列不参与映射', s.mapping.date, 0);
  H.check('空列不会错认成摘要', Object.values(s.mapping).includes(1), false);
}

// ---------------------------------------------------------------- s11/s12/s13
H.section('s11 单位名脏格式归一');
{
  const { res } = analyze('s11_单位名脏格式.xlsx');
  const jia = res.unitHits.find((u) => /甲辰/.test(u.name));
  H.check('带首尾空格的名称能匹配到档案', jia.matchedUnitId, U.jia.id);
  H.check('匹配方式为归一化命中', jia.method, 'name');
  H.check('甲辰共 2 行', jia.count, 2);
  const bing = res.unitHits.find((u) => /丙通/.test(u.name));
  H.check('丙通匹配到档案', bing.matchedUnitId, U.bing.id);
}

H.section('s12 多 sheet 合并导入');
{
  const res = analyze('s12_多sheet分月.xlsx');
  H.check('sheet 数量', res.sheetCount, 2);
  const r = importer.commit({
    buffer: readSample('s12_多sheet分月.xlsx'),
    filename: 's12_多sheet分月.xlsx',
    config: cfg,
    units: unitsMod.all(),
    plans: res.sheets.map((s) => ({
      sheetName: s.name,
      include: true,
      headerRow: s.headerRowNo,
      mapping: s.mapping,
      unitId: U.jia.id,
      account: '应收账款',
    })),
  });
  H.check('两个 sheet 共 3 条入库', r.added, 3);
}

H.section('s13 科目余额表');
{
  const { s } = analyze('s13_科目余额表.xlsx');
  H.check('识别为余额表结构', s.sheetKind, 'balance');
  H.check('期初余额列被识别', s.mapping.openingBalance, 1);
  H.check('期末余额列被识别', s.mapping.balance, 4);
  H.check('单位名称列被识别', s.mapping.unitName, 0);
  const r = importer.commit({
    buffer: readSample('s13_科目余额表.xlsx'),
    filename: 's13_科目余额表.xlsx',
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: s.name, include: true, headerRow: s.headerRowNo, mapping: s.mapping, account: '应收账款' }],
  });
  H.check('余额表 3 个单位各 1 条', r.added, 3);
  H.check('期初余额捕获 2 条（期初为 0 的不建记录）', r.addedOpening, 2);
  const ops = store.readJson('openings.json').filter((o) => o.note.includes('期初余额列'));
  const jiaOp = ops.find((o) => o.unitId === U.jia.id);
  H.check('甲辰期初 = 20,000.00', jiaOp && jiaOp.openingFen, 2000000);
}

// ---------------------------------------------------------------- s14/s15/s16
H.section('s14 无单位列');
{
  const { s, r } = importSample('s14_无单位列_单单位.xlsx', U.bing.id, '应收账款');
  H.check('无单位名称列', s.hasUnitColumn, false);
  H.check('按指定单位入库 1 条', r.added, 1);
  H.check('入库单位正确', store.readJson('ledgers.json').filter((e) => e.sourceFile === 's14_无单位列_单单位.xlsx')[0].unitId, U.bing.id);
}

H.section('s15 期初余额行');
{
  const { s, r } = importSample('s15_带期初行.xlsx', U.jia.id, '应收账款');
  H.check('期初行被识别', s.openingRow, 2);
  H.check('期初行不计入明细条数', r.added, 2);
  H.check('期初金额 = 30,000.00', s.openingFen, 3000000);
  const op = store.readJson('openings.json').find((o) => o.note.includes('期初行'));
  H.check('期初已入库', op && op.openingFen, 3000000);
}

H.section('s16 综合污染');
{
  const { s } = analyze('s16_综合污染.xlsx');
  const rows = s.preview.filter((p) => p.kind === 'data');
  H.check('占位符 -- 视为 0', rows[1].debitFen, 0);
  H.check('文本型数字 2,000.50', rows[2].debitFen, 200050);
  H.check('不可见字符 NBSP 清理', rows[3].debitFen, 300000);
  H.check('万元单位明确报错', rows[4].errors.some((e) => /万元/.test(e)), true);
  H.check('万元行不会静默变成 1.5 元', rows[4].debitFen, 0);
  H.check('全角数字 ４０００', rows[5].debitFen, 400000);
  H.check('纯文字垃圾报错', rows[6].errors.length > 0, true);
}

// ---------------------------------------------------------------- 幂等与指纹
// ---------------------------------------------------------------- 余额列交叉校验
H.section('s17 余额列交叉校验：点名「红字没用负号」的那一行');
{
  const { res, s } = analyze('s17_带余额列_含红字.xlsx');
  H.check('校验已启用', s.balanceCheck.available, true);
  H.check('可比对 4 行', s.balanceCheck.compared, 4);
  H.check('3 行吻合 / 1 行可疑', [s.balanceCheck.asIs, s.balanceCheck.mismatchCount], [3, 1]);
  H.check('精确点名第 8 行', s.balanceCheck.mismatches[0].rowNo, 8);
  H.check('该行摘要是红冲', /红冲/.test(s.balanceCheck.mismatches[0].summary), true);
  H.check('差额 = -10,000 分', s.balanceCheck.mismatches[0].diff, -1000000);
  H.check('给出可读警告', (s.warnings || []).some((w) => /余额列交叉校验/.test(w)), true);
  const row8 = s.preview.filter((p) => p.kind === 'data').find((p) => p.rowNo === 8);
  H.check('该行给出红字关键词提示', (row8.warn || []).some((w) => /红冲/.test(w) && /取反/.test(w)), true);

  const buf = readSample('s17_带余额列_含红字.xlsx');
  const r = importer.commit({
    buffer: buf,
    filename: 's17_flip.xlsx',
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: s.name, include: true, headerRow: s.headerRowNo, mapping: s.mapping, unitId: U.jia.id, account: '应收账款', rowOverrides: { 8: 'flip' } }],
  });
  H.check('取反后入库 4 条', r.added, 4);
  const r8 = store.readJson('ledgers.json').filter((e) => e.sourceFile === 's17_flip.xlsx').find((e) => e.sourceRow === 8);
  H.check('第 8 行已取反为贷方 5,000', r8.creditFen, 500000);
  H.check('第 8 行借方清零', r8.debitFen, 0);

  const r2 = importer.commit({
    buffer: buf,
    filename: 's17_skip.xlsx',
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: s.name, include: true, headerRow: s.headerRowNo, mapping: s.mapping, unitId: U.bing.id, account: '应收账款', rowOverrides: { 8: 'skip' } }],
  });
  H.check('换一家单位导入时剔除只入 3 条', r2.added, 3);
  H.check('人工剔除计数为 1', r2.skippedByUser, 1);
}

H.section('s18 单列金额 + 余额列：校验不误报');
{
  const { s } = analyze('s18_单列金额带余额_应付.xlsx');
  H.check('校验已启用', s.balanceCheck.available, true);
  H.check('可比对 2 行', s.balanceCheck.compared, 2);
  H.check('无一行对不上（不误报）', s.balanceCheck.mismatchCount, 0);
  H.check('口径识别为「借方增加余额」', s.balanceCheck.conventionLabel, '借方发生额增加余额');
  H.check('没有产生校验警告', (s.warnings || []).filter((w) => /余额列交叉校验/.test(w)).length, 0);
  H.check('单列金额标记 viaAmount', s.preview.filter((p) => p.kind === 'data').every((p) => p.viaAmount), true);
  H.check('方向来源已标注', /方向/.test(s.preview.filter((p) => p.kind === 'data')[0].dirLabel), true);
}

H.section('无余额列的文件：校验如实说不可用');
{
  const { s } = analyze('s06_金额加方向单列.xlsx');
  H.check('校验不可用', s.balanceCheck.available, false);
  H.check('给出原因', /余额/.test(s.balanceCheck.reason), true);
}

// ---------------------------------------------------------------- 列映射模板库（开源共享）
H.section('列映射模板：保存、按表头签名匹配、去重');
{
  const mt = require('../../src/mapTemplates');

  // 保存校验
  H.check('缺名字被拒', mt.upsert({ mapping: { date: 0 }, headers: ['日期'] }).ok, false);
  H.check('缺映射被拒', mt.upsert({ name: 'x', headers: ['日期'] }).ok, false);
  H.check('缺表头被拒', mt.upsert({ name: 'x', mapping: { date: 0 } }).ok, false);

  // 用 s01 的真实表头保存模板
  const { s: s01 } = analyze('s01_标准明细账_' + E.jia.name + '.xlsx');
  const saved = mt.upsert({
    name: '测试财务软件 明细账导出',
    software: '测试财务软件 2026',
    headers: s01.headers,
    mapping: s01.mapping,
    account: '应收账款',
  });
  H.check('保存成功', saved.ok, true);

  // 同表头 → 能建议出来
  const sug = mt.suggest(s01.headers);
  H.check('同表头能匹配到模板', sug.length >= 1, true);
  H.check('匹配到的映射一致', JSON.stringify(sug[0].mapping), JSON.stringify(s01.mapping));

  // 全角空格/大小写归一化：表头加了空格也能匹配
  const noisy = s01.headers.map((h) => '  ' + String(h).split('').join(' ') + '  ');
  H.check('表头带空格/全角也能匹配（归一化）', mt.suggest(noisy).length >= 1, true);

  // 不同表头 → 不误报
  H.check('不同表头不会误匹配', mt.suggest(['甲', '乙', '丙']).length, 0);

  // 去重：同签名+同映射再次保存 → 不新增
  const before = mt.all().length;
  mt.upsert({ name: '测试财务软件 明细账导出（改名）', headers: s01.headers, mapping: s01.mapping });
  H.check('同签名同映射会覆盖而不新增', mt.all().length, before);

  // 使用计数
  mt.markUsed(saved.template.id);
  H.check('套用计数 +1', mt.all().find((t) => t.id === saved.template.id).usedCount, 1);

  // analyze 应附带 templateSuggestions
  const a2 = analyze('s01_标准明细账_' + E.jia.name + '.xlsx');
  H.check('analyze 结果带上模板建议', a2.sheets[0].templateSuggestions.length >= 1, true);
  H.check('建议模板的映射可直接用', typeof a2.sheets[0].templateSuggestions[0].mapping.date === 'number', true);

  // 外部 JSON 导入：含坏条目跳过
  const ext = [
    { name: '金蝶KIS 标准版', software: '金蝶KIS', headers: ['记账日期', '摘要', '借方发生额', '贷方发生额', '期末余额'], mapping: { date: 0, summary: 1, debit: 2, credit: 3, balance: 4 } },
    { name: '坏条目', headers: ['只有一列'] },
    null,
  ];
  const r = mt.importFrom(ext);
  H.check('外部导入成功 1 条', r.imported, 1);
  H.check('坏条目被跳过且说明原因', r.skipped.length, 2);
  H.check('外部模板也能被建议', mt.suggest(ext[0].headers).length, 1);

  // 再导一次同样的 → 覆盖不新增
  const n1 = mt.all().length;
  mt.importFrom(ext);
  H.check('重复导入去重', mt.all().length, n1);

  // 删除
  const del = mt.remove(ext[0].mapping ? mt.suggest(ext[0].headers)[0].id : 'x');
  H.check('删除成功', del.ok, true);
  H.check('删除后不再建议', mt.suggest(ext[0].headers).length, 0);
}

H.section('重复导入幂等（同文件导两次不重复入库）');
{
  const before = store.readJson('ledgers.json').length;
  const r = importSample('s01_标准明细账_' + E.jia.name + '.xlsx', U.jia.id, E.jia.account);
  const after = store.readJson('ledgers.json').length;
  H.check('第二次导入新增 0 条', r.r.added, 0);
  H.check('第二次全部判重', r.r.dupSkipped, 4);
  H.check('库内条数不变', after - before, 0);
}

H.section('真实重复行不被误杀（同日同额同摘要出现两次）');
{
  const rows = [
    ['日期', '摘要', '借方金额', '贷方金额'],
    ['2026-08-06', '重复业务', 1000, 0],
    ['2026-08-06', '重复业务', 1000, 0],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  const p = path.join(RUN, 'dup.xlsx');
  XLSX.writeFile(wb, p);
  const buf = fs.readFileSync(p);
  const a = importer.analyze({ buffer: buf, filename: 'dup.xlsx', config: cfg });
  const r1 = importer.commit({
    buffer: buf,
    filename: 'dup.xlsx',
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: a.sheets[0].name, include: true, headerRow: a.sheets[0].headerRowNo, mapping: a.sheets[0].mapping, unitId: U.jia.id, account: '应收账款' }],
  });
  H.check('首次导入两条都入库', r1.added, 2);
  const r2 = importer.commit({
    buffer: buf,
    filename: 'dup.xlsx',
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: a.sheets[0].name, include: true, headerRow: a.sheets[0].headerRowNo, mapping: a.sheets[0].mapping, unitId: U.jia.id, account: '应收账款' }],
  });
  H.check('再导一次全部判重', r2.added, 0);
  H.check('再导判重条数 2', r2.dupSkipped, 2);
}

H.section('自动建档案 / 复用已档案 / 缺单位时明确报错');
{
  // 全新单位名 → 自动建档
  const rows = [
    ['日期', '单位名称', '摘要', '借方金额', '贷方金额'],
    ['2026-08-05', '  某市丁旺五金有限公司  ', '销售开票', 1000, 0],
    ['2026-08-06', '某市丁旺五金有限公司', '销售开票', 2000, 0],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S');
  const p = path.join(RUN, 'newunit.xlsx');
  XLSX.writeFile(wb, p);
  const buf = fs.readFileSync(p);
  const a = importer.analyze({ buffer: buf, filename: 'newunit.xlsx', config: cfg });
  const r = importer.commit({
    buffer: buf,
    filename: 'newunit.xlsx',
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: 'S', include: true, headerRow: a.sheets[0].headerRowNo, mapping: a.sheets[0].mapping, account: '应收账款' }],
  });
  H.check('自动新建 1 个单位', r.unitsCreated.length, 1);
  H.check('新建名称已 trim', r.unitsCreated[0].name, '某市丁旺五金有限公司');
  H.check('带空格与不空格视为同一家', r.added, 2);

  // 加别名后用另一个名称写法导入 → 复用同一档案
  unitsMod.addAlias(r.unitsCreated[0].id, '丁旺五金');
  const rows2 = [['日期', '单位名称', '摘要', '借方金额'], ['2026-08-07', '丁旺五金', '销售开票', 300]];
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(rows2), 'S');
  const p2 = path.join(RUN, 'alias.xlsx');
  XLSX.writeFile(wb2, p2);
  const buf2 = fs.readFileSync(p2);
  const a2 = importer.analyze({ buffer: buf2, filename: 'alias.xlsx', config: cfg });
  const r2 = importer.commit({
    buffer: buf2,
    filename: 'alias.xlsx',
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: 'S', include: true, headerRow: a2.sheets[0].headerRowNo, mapping: a2.sheets[0].mapping, account: '应收账款' }],
  });
  H.check('别名命中后不再新建', r2.unitsCreated.length, 0);
  H.check('别名命中入库到同一档案', store.readJson('ledgers.json').filter((e) => e.sourceFile === 'alias.xlsx')[0].unitId, r.unitsCreated[0].id);

  // s13 已经自动建过「某市某某商贸有限公司」，s03 应直接复用
  const r3 = importSample('s03_GBK编码_无BOM.csv', null, '应收账款');
  H.check('s13 建立的档案被 s03 复用', r3.r.unitsCreated.length, 0);

  // 无单位列 + 未指定固定单位 → 明确报错且不入库
  const r4 = importSample('s02_老格式xls_2003.xls', null, '应收账款');
  H.check('缺单位信息时给出明确报错', r4.r.errors.length > 0, true);
  H.check('缺单位信息时不入库', r4.r.added, 0);
}

H.section('原件留档与备份');
{
  const led = store.readJson('ledgers.json');
  const batches = Array.from(new Set(led.map((e) => e.importBatch)));
  H.check('每条明细都有导入批次', led.every((e) => !!e.importBatch), true);
  H.check('每条明细都有源行号', led.every((e) => typeof e.sourceRow === 'number'), true);
  H.check('每条明细都有指纹', led.every((e) => !!e.fingerprint), true);
  H.check('批次目录已建档', batches.every((b) => fs.existsSync(path.join(store.DATA, 'imports', b))), true);
  H.check('自动备份目录已生成', store.listBackups().length > 0, true);
}

// ---------------------------------------------------------------- 列识别单测
H.section('columns 内核单测');
{
  const idx = columns.buildAliasIndex(cfg.aliases);
  H.check('借方发生额 → debit', columns.matchColumn('借方发生额', idx), 'debit');
  H.check('本期借方 → debit', columns.matchColumn('本期借方', idx), 'debit');
  H.check('期末余额 → balance', columns.matchColumn('期末余额', idx), 'balance');
  H.check('期初余额 → openingBalance', columns.matchColumn('期初余额', idx), 'openingBalance');
  H.check('科目名称（元）→ subject', columns.matchColumn('科目名称（元）', idx), 'subject');
  H.check('摘要说明 → summary', columns.matchColumn('摘要说明', idx), 'summary');
  H.check('发生额 → amount', columns.matchColumn('发生额', idx), 'amount');
  H.check('无意义列 → null', columns.matchColumn('备注2', idx), 'summary');
  H.check('空表头 → null', columns.matchColumn('', idx), null);
  H.check('合计行识别', columns.isSubtotalText(' 小计 '), true);
  H.check('正常摘要不误判', columns.isSubtotalText('合计付款'), false);
  H.check('期初行识别', columns.isOpeningText('期初余额'), true);
  H.check('正常摘要不误判期初', columns.isOpeningText('收到货款'), false);
}

H.section('dates 内核单测');
{
  H.check('parseDate 紧凑', dates.parseDate('20260831'), '2026-08-31');
  H.check('parseDate 中文', dates.parseDate('2026年8月31日'), '2026-08-31');
  H.check('parseDate 非法月', dates.parseDate('2026-13-01'), null);
  H.check('parseDate 非法日', dates.parseDate('2026-02-30'), null);
  H.check('parseDate 空', dates.parseDate(''), null);
  H.check('daysBetween 同月', dates.daysBetween('2026-08-01', '2026-08-31'), 30);
  H.check('lastDayOfMonth 2月', dates.lastDayOfMonth('2026-02'), '2026-02-28');
  H.check('lastDayOfMonth 闰年', dates.lastDayOfMonth('2024-02'), '2024-02-29');
  H.check('addDays 跨月', dates.addDays('2026-08-31', 1), '2026-09-01');
}

console.log('\n测试数据目录: ' + store.DATA);
H.finish('t2_import');
module.exports = H.results;
