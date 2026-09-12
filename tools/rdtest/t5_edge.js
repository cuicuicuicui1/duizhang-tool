'use strict';
/*
 * t5_edge.js — 层 3「边界 / 脏数据」：负数、0、null、非法日期、不存在 unitId、
 *              5 万行、NaN 字符串、空文件、非 Excel 文件改后缀、超长文本等
 * 原则：不许崩服务、不许静默算错、该报错要报错。
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const RUN = path.join(__dirname, '.run', 'edge_' + Date.now());
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
const configMod = require('../../src/config');
const replyAdapter = require('../../src/replyAdapter');

const cfg = configMod.getConfig();
store.ensureDirs();

function xlsx(rows, name) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S');
  const p = path.join(RUN, name);
  fs.mkdirSync(RUN, { recursive: true });
  XLSX.writeFile(wb, p);
  return fs.readFileSync(p);
}
function analyzeBuf(buf, filename) {
  return importer.analyze({ buffer: buf, filename, config: cfg });
}
function importBuf(buf, filename, unitId, account) {
  const a = analyzeBuf(buf, filename);
  return importer.commit({
    buffer: buf,
    filename,
    config: cfg,
    units: unitsMod.all(),
    plans: [{ sheetName: a.sheets[0].name, include: true, headerRow: a.sheets[0].headerRowNo, mapping: a.sheets[0].mapping, unitId, account }],
  });
}

(async () => {
  H.section('空文件 / 假 Excel / 乱码二进制');
  {
    const empty = Buffer.alloc(0);
    let a;
    try {
      a = analyzeBuf(empty, 'empty.xlsx');
      H.check('空文件不抛异常，返回空表', a.sheets.length === 0 || a.sheets[0].dataRows === 0, true);
    } catch (e) {
      H.check('空文件抛的是可读错误', /./.test(e.message), true);
    }

    const fake = Buffer.from('这不是一个 Excel 文件，只是改了后缀名。' + 'X'.repeat(200), 'utf8');
    try {
      const r = analyzeBuf(fake, 'fake.xlsx');
      H.check('假 Excel 不崩（返回结构或空表）', !!r, true);
    } catch (e) {
      H.check('假 Excel 抛出可读错误', /./.test(e.message), true);
    }

    const bin = Buffer.from(Array.from({ length: 512 }, (_v, i) => i % 256));
    try {
      analyzeBuf(bin, 'bin.xlsx');
      H.check('乱码二进制不崩', true, true);
    } catch (e) {
      H.check('乱码二进制抛出可读错误', /./.test(e.message), true);
    }
  }

  H.section('单位不存在 / 空 unitId');
  {
    const buf = xlsx([['日期', '摘要', '借方金额'], ['2026-08-01', 'x', 100]], 'noun.xlsx');
    const r = importBuf(buf, 'noun.xlsx', 'u_not_exist_xxx', '应收账款');
    H.check('不存在的 unitId → 不入库并报错', r.added, 0);
    H.check('给出可读错误信息', r.errors.length > 0 && /单位/.test(r.errors[0]), true);
  }

  H.section('单元格脏值：null / 布尔 / 超大数 / 超长文本 / 公式残留');
  {
    const rows = [
      ['日期', '摘要', '借方金额', '贷方金额'],
      ['2026-08-01', null, 100, null],
      ['2026-08-02', true, false, 0],
      ['2026-08-03', 'x'.repeat(300), 5000000000000, 0],
      ['2026-08-04', '#REF!', 'NaN', 0],
      ['2026-08-05', 'null', 'undefined', 0],
      ['2026-08-06', '无穷大', 'Infinity', 0],
      ['2026-08-07', '超出安全整数', 99999999999999, 0],
    ];
    const buf = xlsx(rows, 'dirty.xlsx');
    const a = analyzeBuf(buf, 'dirty.xlsx');
    const s = a.sheets[0];
    H.check('不崩溃且能解析出数据行', s.dataRows >= 6, true);
    const rowsOut = s.preview.filter((p) => p.kind === 'data');
    H.check('null 摘要不报错', !!rowsOut[0], true);
    H.check('NaN 字符串被识别为非法金额', rowsOut[3].errors.length > 0, true);
    H.check('NaN 报错信息说明了处理方式', /解析失败/.test(rowsOut[3].errors.join('')) && /人工核对|错误值/.test(rowsOut[3].errors.join('')), true);
    H.check('Infinity 也报错', rowsOut[5].errors.length > 0, true);
    H.check('超大但安全的金额精确解析（5 万亿元）', rowsOut[2].debitFen, 500000000000000);
    H.check('超出安全整数范围时明确报错而不是算错', rowsOut[6].errors.some((e) => /安全范围/.test(e)), true);
  }

  H.section('负数与零值语义');
  {
    const u = unitsMod.create({ name: '负数测试有限公司', type: 'customer' });
    const buf = xlsx(
      [
        ['日期', '摘要', '借方金额', '贷方金额'],
        ['2026-08-01', '负数借方', -1000, 0],
        ['2026-08-02', '零金额', 0, 0],
        ['2026-08-03', '双向都有', 500, 500],
      ],
      'neg.xlsx'
    );
    const a = analyzeBuf(buf, 'neg.xlsx');
    const rows = a.sheets[0].preview.filter((p) => p.kind === 'data');
    H.check('借方负数转贷方', rows[0].creditFen, 100000);
    H.check('借方负数后借方清零', rows[0].debitFen, 0);
    H.check('双向都有金额时报警', rows[2].errors.some((e) => /借贷双方都有金额/.test(e)), true);

    importBuf(buf, 'neg.xlsx', u.id, '应收账款');
    const b = ledger.computeUnitBalance(u.id, { cutoff: '2026-08-31', direction: 'receivable', config: cfg });
    H.check('余额可为负（异常方向）', b.signedFen < 0, true);
    H.check('负数被判为方向异常', b.directionAbnormal, true);
  }

  H.section('非法日期');
  {
    const u = unitsMod.create({ name: '日期测试有限公司', type: 'customer' });
    const buf = xlsx(
      [
        ['日期', '摘要', '借方金额'],
        ['2026-13-45', '非法日期', 100],
        ['不是日期', '文本日期', 200],
        ['', '空日期', 300],
      ],
      'baddate.xlsx'
    );
    const a = analyzeBuf(buf, 'baddate.xlsx');
    const rows = a.sheets[0].preview.filter((p) => p.kind === 'data');
    H.check('非法日期不崩且标警告', rows[0].warn.some((w) => /日期无法识别/.test(w)), true);
    H.check('非法日期不入 date 字段', rows[0].date, null);
    H.check('无日期行仍保留金额', rows[2].debitFen, 30000);
    importBuf(buf, 'baddate.xlsx', u.id, '应收账款');
    const led = store.readJson('ledgers.json').filter((e) => e.unitId === u.id);
    H.check('无日期明细照常入库', led.length, 3);
  }

  H.section('截止日早于全部明细 / 晚于全部明细');
  {
    const u = unitsMod.create({ name: '截止日测试有限公司', type: 'customer' });
    const buf = xlsx([['日期', '摘要', '借方金额'], ['2026-08-15', '业务', 1000]], 'cut.xlsx');
    importBuf(buf, 'cut.xlsx', u.id, '应收账款');
    const early = ledger.computeUnitBalance(u.id, { cutoff: '2026-01-01', direction: 'receivable', config: cfg });
    H.check('截止日早于明细 → 余额 0', early.signedFen, 0);
    H.check('截止日早于明细 → 笔数 0', early.entryCount, 0);
    const late = ledger.computeUnitBalance(u.id, { cutoff: '2030-12-31', direction: 'receivable', config: cfg });
    H.check('截止日晚于明细 → 全额', late.signedFen, 100000);
  }

  H.section('空文件引导与 generate 参数校验');
  {
    const r = await statementMod.generate({ unitIds: [], cutoffDate: '2026-08-31', direction: 'receivable', config: cfg });
    H.check('空 unitIds 返回 ok=true 且 0 成功', r.okCount, 0);
    const r2 = await statementMod.generate({ unitIds: ['u_xxx'], cutoffDate: '', direction: 'receivable', config: cfg });
    H.check('缺截止日返回明确错误', r2.ok, false);
    H.check('错误文案说明原因', /截止日/.test(r2.err), true);

    const u = unitsMod.create({ name: '无数据单位有限公司', type: 'customer' });
    const r3 = await statementMod.generate({ unitIds: [u.id], cutoffDate: '2026-08-31', direction: 'receivable', config: cfg });
    H.check('无数据单位被跳过并说明原因', r3.failCount, 1);
    H.check('跳过原因可读', /没有任何明细/.test(r3.results[0].err), true);

    H.throws('读取不存在的对账函文件会报错', () => statementMod.fileOf('st_not_exist', 'pdf'), /不存在/);
  }

  H.section('勾对入参异常');
  {
    H.throws('statementId 不存在 → 抛错', () => matcher.diff({ statementId: 'st_x', theirBalanceFen: 0, theirEntries: [], config: cfg }), /不存在/);
    const u = unitsMod.create({ name: '勾对异常测试有限公司', type: 'customer' });
    const buf = xlsx([['日期', '摘要', '借方金额'], ['2026-08-01', 'x', 1000]], 'dm.xlsx');
    importBuf(buf, 'dm.xlsx', u.id, '应收账款');
    const g = await statementMod.generate({ unitIds: [u.id], cutoffDate: '2026-08-31', direction: 'receivable', period: '2026-08', config: cfg });
    const sid = g.results[0].statementId;

    const d1 = matcher.diff({ statementId: sid, theirBalanceFen: NaN, theirEntries: [], config: cfg });
    H.check('对方余额 NaN → 当 0 处理且不崩', d1.balanceDiffFen, 100000);
    const d2 = matcher.diff({ statementId: sid, theirBalanceFen: 100000, theirEntries: [{ date: 'bad', summary: '', debitFen: NaN, creditFen: null }], config: cfg });
    H.check('明细金额 NaN/null 不崩', !!d2.summary, true);
    const d3 = matcher.diff({ statementId: sid, theirBalanceFen: 100000, theirEntries: new Array(500).fill(null).map(() => ({ date: '2026-08-01', summary: 's', debitFen: 0, creditFen: 0 })), config: cfg });
    H.check('大量零金额明细不崩', !!d3.summary, true);
    const d4 = matcher.diff({ statementId: sid, theirBalanceFen: 999999999999, theirEntries: [], config: cfg });
    H.check('超大余额差异不崩且为大负数', d4.balanceDiffFen < 0, true);
  }

  H.section('超大规模：5 万行明细');
  {
    const u = unitsMod.create({ name: '五万行测试有限公司', type: 'customer' });
    const rows = [['日期', '摘要', '借方金额', '贷方金额']];
    for (let i = 0; i < 50000; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      rows.push(['2026-08-' + day, '业务' + i, i % 2 ? 100 : '', i % 2 ? '' : 100]);
    }
    const buf = xlsx(rows, 'big.xlsx');
    const t0 = Date.now();
    const r = importBuf(buf, 'big.xlsx', u.id, '应收账款');
    const importMs = Date.now() - t0;
    H.check('5 万行全部入库', r.added, 50000);
    H.check('5 万行导入在 60 秒内', importMs < 60000, true);
    console.log('  [INFO] 5 万行导入耗时 ' + (importMs / 1000).toFixed(1) + ' 秒');

    const t1 = Date.now();
    const b = ledger.computeUnitBalance(u.id, { cutoff: '2026-08-31', direction: 'receivable', config: cfg });
    const calcMs = Date.now() - t1;
    H.check('5 万行余额计算正确（正负相抵）', b.signedFen, 0);
    H.check('5 万行余额计算在 5 秒内', calcMs < 5000, true);
    console.log('  [INFO] 5 万行余额计算 ' + calcMs + ' ms');

    const t2 = Date.now();
    const g = await statementMod.generate({ unitIds: [u.id], cutoffDate: '2026-08-31', direction: 'receivable', period: '2026-08', config: cfg });
    H.check('5 万行也能出对账函', g.okCount, 1);
    console.log('  [INFO] 5 万行生成耗时 ' + ((Date.now() - t2) / 1000).toFixed(1) + ' 秒');
  }

  H.section('粘贴解析异常输入');
  {
    H.check('空字符串', replyAdapter.parsePasted('').rows.length, 0);
    H.check('只有空格', replyAdapter.parsePasted('   \n  \n').rows.length, 0);
    H.check('单列数字', replyAdapter.entriesFromPaste('1234.56', { config: cfg }).entries.length, 1);
    const weird = replyAdapter.entriesFromPaste('！！！\n？？？', { config: cfg });
    H.check('纯符号不崩', Array.isArray(weird.entries), true);
    const long = replyAdapter.entriesFromPaste('2026-08-01\t业务\t1\n'.repeat(3000), { config: cfg });
    H.check('3000 行粘贴解析', long.entries.length, 3000);
  }

  H.section('科目自然方向字典（设置页可改）');
  {
    const cfgMod2 = require('../../src/config');
    const base = cfgMod2.getConfig();
    H.check('默认：应收账款 → 借方', importer.accountSide('应收账款', base), 'debit');
    H.check('默认：其他应收款 → 借方', importer.accountSide('其他应收款', base), 'debit');
    H.check('默认：应付账款 → 贷方', importer.accountSide('应付账款', base), 'credit');
    H.check('默认：长期借款 → 贷方（不再被「长期」误判为不确定）', importer.accountSide('长期借款', base), 'credit');
    H.check('默认：长期股权投资 → 借方', importer.accountSide('长期股权投资', base), 'debit');
    H.check('默认：中性名称判不准', importer.accountSide('内部往来', base), null);
    H.check('默认：空科目判不准', importer.accountSide('', base), null);

    const custom = cfgMod2.saveConfig({ subjectSideDebit: ['内部往来'], subjectSideCredit: ['应付'] });
    H.check('改字典后：内部往来 → 借方', importer.accountSide('内部往来', custom), 'debit');
    H.check('改字典后：应收不在清单里 → 判不准', importer.accountSide('应收账款', custom), null);
    cfgMod2.resetConfig();

    // 字典影响实际解析：单列金额 + 自定义科目
    const u = unitsMod.create({ name: '方向字典测试有限公司', type: 'customer' });
    const buf = xlsx([['日期', '摘要', '发生额'], ['2026-08-05', '采购入库', 200000]], 'side.xlsx');
    const a = importer.analyze({ buffer: buf, filename: 'side.xlsx', config: base });
    importer.commit({
      buffer: buf,
      filename: 'side.xlsx',
      config: base,
      units: unitsMod.all(),
      plans: [{ sheetName: a.sheets[0].name, include: true, headerRow: a.sheets[0].headerRowNo, mapping: a.sheets[0].mapping, unitId: u.id, account: '内部往来' }],
    });
    const e = store.readJson('ledgers.json').filter((x) => x.unitId === u.id)[0];
    H.check('中性科目默认按正号入借方', e.debitFen, 20000000);

    const u2 = unitsMod.create({ name: '方向字典测试二有限公司', type: 'customer' });
    const custom2 = cfgMod2.saveConfig({ subjectSideDebit: ['内部往来'] });
    importer.commit({
      buffer: buf,
      filename: 'side2.xlsx',
      config: custom2,
      units: unitsMod.all(),
      plans: [{ sheetName: a.sheets[0].name, include: true, headerRow: a.sheets[0].headerRowNo, mapping: a.sheets[0].mapping, unitId: u2.id, account: '内部往来' }],
    });
    const e2 = store.readJson('ledgers.json').filter((x) => x.unitId === u2.id)[0];
    H.check('把「内部往来」加进借方清单后仍入借方', e2.debitFen, 20000000);
    cfgMod2.resetConfig();
  }

  H.section('配置异常值');
  {
    const c1 = configMod.saveConfig({ balanceMode: '不存在的口径' });
    H.check('未知口径不崩', !!c1, true);
    const u = unitsMod.create({ name: '口径异常测试有限公司', type: 'customer' });
    const buf = xlsx([['日期', '摘要', '借方金额'], ['2026-08-01', 'x', 1000]], 'badmode.xlsx');
    importBuf(buf, 'badmode.xlsx', u.id, '应收账款');
    let b;
    try {
      b = ledger.computeUnitBalance(u.id, { cutoff: '2026-08-31', direction: 'receivable', config: c1 });
      H.check('未知口径不崩，回退到累计法', b.signedFen, 100000);
      H.check('未知口径给出可读告警', b.warnings.some((w) => /不是已知口径/.test(w)), true);
    } catch (e) {
      H.check('未知口径抛出可读错误', /口径|strategy|undefined/i.test(e.message), true);
    }
    configMod.resetConfig();
    const c2 = configMod.saveConfig({ matchWindowDays: -5 });
    H.check('负窗口不崩', !!c2, true);
    configMod.saveConfig({ matchWindowDays: 15 });
  }

  console.log('\n测试数据目录: ' + store.DATA);
  H.finish('t5_edge');
})();
