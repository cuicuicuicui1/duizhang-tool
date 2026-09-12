'use strict';
/*
 * make_samples.js — 生成 samples/ 下的脏数据样本
 * 每条对应计划 §5.3「必须吞下的脏数据清单」中的一类，测试脚本逐条回归。
 *   node tools/make_samples.js
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const iconv = require('iconv-lite');

const DIR = path.join(__dirname, '..', 'samples');
const Y = (v) => Math.round(v * 100); // 元 → 分

// ---------------------------------------------------------------- 主场景数据
const OUR_COMPANY = {
  name: '某市中和机电设备有限公司',
  address: '某省省某市丛台区人民路 128 号 5 层',
  phone: '0310-88886666',
  contact: '李会计',
};

const UNITS = [
  { key: 'jia', name: '某市甲辰建材有限公司', type: 'customer', account: '应收账款' },
  { key: 'yi', name: '乙顺机电设备有限公司', type: 'supplier', account: '应付账款' },
  { key: 'bing', name: '某市丙通物流有限公司', type: 'customer', account: '应收账款' },
];

const LEDGER = {
  jia: [
    ['2026-08-03', '销售开票 A-2608031', Y(150000), 0],
    ['2026-08-12', '收到货款 电汇', 0, Y(100000)],
    ['2026-08-20', '销售开票 A-2608027', Y(80000), 0],
    ['2026-08-28', '收到货款 电汇', 0, Y(60000)],
  ],
  yi: [
    ['2026-08-05', '采购入库 钢材', 0, Y(200000)],
    ['2026-08-18', '支付货款 电汇', Y(120000), 0],
    ['2026-08-25', '采购入库 备件', 0, Y(50000)],
    ['2026-08-30', '支付运费', Y(10000), 0],
  ],
  bing: [
    ['2026-08-02', '运输服务 B-0802', Y(3200), 0],
    ['2026-08-09', '运输服务 B-0809', Y(4500), 0],
    ['2026-08-15', '运输服务 B-0815', Y(2800), 0],
    ['2026-08-22', '运输服务 B-0822', Y(6000), 0],
    ['2026-08-29', '运输服务 B-0829', Y(3500), 0],
  ],
};

/** 主场景期望：己方余额（分） */
const EXPECTED = {
  ourCompany: OUR_COMPANY,
  units: UNITS.map((u) => {
    const rows = LEDGER[u.key];
    const debit = rows.reduce((a, r) => a + r[2], 0);
    const credit = rows.reduce((a, r) => a + r[3], 0);
    const balance = u.account === '应付账款' ? credit - debit : debit - credit;
    return {
      key: u.key,
      name: u.name,
      type: u.type,
      account: u.account,
      rows: rows.length,
      debitFen: debit,
      creditFen: credit,
      closingFen: balance,
    };
  }),
  cutoff: '2026-08-31',
  period: '2026-08',
  replies: {
    jia: {
      theirBalanceFen: Y(70000),
      detail: LEDGER.jia.map((r) => ({ date: r[0], summary: r[1], debitFen: r[2], creditFen: r[3] })),
      expect: '一致',
    },
    yi: {
      theirBalanceFen: Y(80000),
      detail: [
        { date: '2026-08-05', summary: '采购入库', debitFen: 0, creditFen: Y(200000) },
        { date: '2026-08-18', summary: '支付货款', debitFen: Y(120000), creditFen: 0 },
      ],
      expect: '2 笔己方有对方无（50,000 与 10,000）',
    },
    bing: {
      theirBalanceFen: Y(20000),
      detail: [{ date: '2026-08-31', summary: '运输费汇总入账（5 笔合并）', debitFen: Y(20000), creditFen: 0 }],
      expect: '5 笔己方明细 ↔ 1 笔对方合并入账，组合匹配',
      // 同一份回函用「对方口径」写（贷方）时的对照：需要勾选方向翻转
      asCounterpartyLedger: {
        theirBalanceFen: Y(20000),
        signFlip: true,
        detail: [{ date: '2026-08-31', summary: '运输费汇总入账（5 笔合并）', debitFen: 0, creditFen: Y(20000) }],
      },
    },
  },
};

function cleanSheet(unit) {
  return [
    [OUR_COMPANY.name + '  往来明细账'],
    ['科目：' + unit.account + '    期间：2026-08-01 至 2026-08-31'],
    [],
    ['日期', '摘要', '借方金额', '贷方金额', '余额'],
    ...LEDGER[unit.key].map((r) => [r[0], r[1], r[2] ? r[2] / 100 : '', r[3] ? r[3] / 100 : '', '']),
    ['合计', '', LEDGER[unit.key].reduce((a, r) => a + r[2], 0) / 100, LEDGER[unit.key].reduce((a, r) => a + r[3], 0) / 100, ''],
  ];
}

// ---------------------------------------------------------------- 样本定义
function build() {
  const files = [];

  // s01 标准明细账（三家单位各一个文件，无单位名称列）
  for (const u of UNITS) {
    files.push({
      file: 's01_标准明细账_' + u.name + '.xlsx',
      kind: 'xlsx',
      sheets: { '明细账': cleanSheet(u) },
      note: '前 3 行标题/期间说明/空行，双列借贷，末尾合计行',
    });
  }

  // s02 老版 .xls（2003 格式）
  files.push({
    file: 's02_老格式xls_2003.xls',
    kind: 'xls',
    sheets: {
      Sheet1: [
        ['某市某某商贸有限公司 明细账'],
        ['日期', '摘要', '借方金额', '贷方金额'],
        ['2026/8/1', '销售开票', 12000, 0],
        ['2026/8/15', '收到货款', 0, 5000],
      ],
    },
    note: '.xls BIFF8 老格式',
  });

  // s03 GBK 编码 CSV（无 BOM）
  files.push({
    file: 's03_GBK编码_无BOM.csv',
    kind: 'csv',
    encoding: 'gbk',
    text: [
      '日期,往来单位,摘要,借方金额,贷方金额',
      '2026-08-01,某市某某商贸有限公司,销售开票,12000.00,0',
      '2026-08-15,某市某某商贸有限公司,收到货款,0,5000.00',
    ].join('\r\n'),
    note: 'GBK/GB18030 编码，Node 原生读会乱码',
  });

  // s04 UTF-8 带 BOM
  files.push({
    file: 's04_UTF8带BOM.csv',
    kind: 'csv',
    encoding: 'utf8bom',
    text: [
      '业务日期,单位名称,摘要说明,借方,贷方',
      '2026-08-03,某市某某商贸有限公司,销售开票,8000,0',
    ].join('\r\n'),
    note: 'UTF-8 BOM，别名为「业务日期/单位名称/摘要说明/借方/贷方」',
  });

  // s05 千分位 + 括号负数 + 红字（颜色丢失）
  files.push({
    file: 's05_千分位括号负数.xlsx',
    kind: 'xlsx',
    sheets: {
      '明细账': [
        ['日期', '摘要', '借方金额', '贷方金额'],
        ['2026-08-01', '销售开票', '1,234,567.89', '0.00'],
        ['2026-08-10', '收到货款', '(1,000,000.00)', '0.00'],
        ['2026-08-20', '销售退回（红字）', '(234,567.89)', '0.00'],
      ],
    },
    note: '千分位、括号负数、红字负数（颜色读不到，依赖括号）',
  });

  // s06 金额 + 方向单列
  files.push({
    file: 's06_金额加方向单列.xlsx',
    kind: 'xlsx',
    sheets: {
      '明细账': [
        ['日期', '摘要', '方向', '金额'],
        ['2026-08-01', '销售开票', '借', 12000],
        ['2026-08-15', '收到货款', '贷', 5000],
        ['2026-08-20', '销售开票', '借方', 3000],
      ],
    },
    note: '金额单列 + 方向列（借/贷/借方/贷方）',
  });

  // s07 正负混合单列（应付账款科目 → 正号应入贷方）
  files.push({
    file: 's07_正负混合单列_应付.xlsx',
    kind: 'xlsx',
    sheets: {
      '明细账': [
        ['日期', '摘要', '发生额'],
        ['2026-08-05', '采购入库', 200000],
        ['2026-08-18', '支付货款', -120000],
      ],
    },
    note: '单列发生额正负混合；科目为应付账款时正号入贷方',
  });

  // s08 日期全格式
  files.push({
    file: 's08_日期全格式.xlsx',
    kind: 'xlsx',
    sheets: {
      '明细账': [
        ['日期', '摘要', '借方金额'],
        ['2026/8/31', '斜杠格式', 100],
        ['2026-08-31', '横杠格式', 200],
        ['2026年8月31日', '中文格式', 300],
        ['20260831', '紧凑数字', 400],
        [45900, 'Excel序列数', 500],
        ['2026-08', '仅到月', 600],
      ],
    },
    note: '斜杠/横杠/中文/紧凑/Excel 序列数/仅月，6 种日期形态',
  });

  // s09 小计与合计行
  files.push({
    file: 's09_小计合计行.xlsx',
    kind: 'xlsx',
    sheets: {
      '明细账': [
        ['日期', '摘要', '借方金额', '贷方金额'],
        ['2026-08-05', '8月第1笔', 1000, 0],
        ['2026-08-15', '8月第2笔', 2000, 0],
        ['小计', '', 3000, 0],
        ['2026-08-25', '8月第3笔', 500, 0],
        ['合计', '', 3500, 0],
        ['总计', '', 3500, 0],
      ],
    },
    note: '中间「小计」+ 末尾「合计」「总计」都要剔除',
  });

  // s10 空行空列
  files.push({
    file: 's10_空行与空列.xlsx',
    kind: 'xlsx',
    sheets: {
      '明细账': [
        ['日期', '', '摘要', '借方金额', '贷方金额'],
        ['2026-08-05', '', '第一笔', 1000, 0],
        ['', '', '', '', ''],
        ['2026-08-06', '', '第二笔', 2000, 0],
        ['', '', '', '', ''],
        ['', '', '', '', ''],
      ],
    },
    note: '某列整体为空 + 中间全空行 + 尾部空行',
  });

  // s11 单位名带空格与全角括号
  files.push({
    file: 's11_单位名脏格式.xlsx',
    kind: 'xlsx',
    sheets: {
      '明细账': [
        ['日期', '往来单位', '摘要', '借方金额'],
        ['2026-08-05', '  某市甲辰建材有限公司  ', '销售开票', 1000],
        ['2026-08-06', '某市甲辰建材有限公司', '销售开票', 2000],
        ['2026-08-07', '某市丙通物流有限公司', '运输服务', 3000],
      ],
    },
    note: '首尾空格全角字符，归一化后应匹配到同一档案',
  });

  // s12 多 sheet（按月份）
  files.push({
    file: 's12_多sheet分月.xlsx',
    kind: 'xlsx',
    sheets: {
      '2026-07': [
        ['日期', '摘要', '借方金额', '贷方金额'],
        ['2026-07-10', '7月销售', 5000, 0],
      ],
      '2026-08': [
        ['日期', '摘要', '借方金额', '贷方金额'],
        ['2026-08-10', '8月销售', 8000, 0],
        ['2026-08-20', '8月回款', 0, 3000],
      ],
    },
    note: '按月份分 sheet，需多选合并导入',
  });

  // s13 科目余额表（每单位一行，仅余额）
  files.push({
    file: 's13_科目余额表.xlsx',
    kind: 'xlsx',
    sheets: {
      '应收账款余额表': [
        ['科目：应收账款    截止 2026-08-31'],
        ['单位名称', '期初余额', '本期借方', '本期贷方', '期末余额'],
        ['某市甲辰建材有限公司', 20000, 210000, 160000, 70000],
        ['某市丙通物流有限公司', 0, 20000, 0, 20000],
        ['某市某某商贸有限公司', 5000, 1000, 2000, 4000],
      ],
    },
    note: '科目余额表：有单位名称列、期初/期末余额列，无逐笔日期',
  });

  // s14 无单位列（整表属于单一单位）
  files.push({
    file: 's14_无单位列_单单位.xlsx',
    kind: 'xlsx',
    sheets: {
      '明细账': [
        ['科目：应收账款'],
        ['日期', '摘要', '借方金额', '贷方金额'],
        ['2026-08-05', '销售开票', 1000, 0],
      ],
    },
    note: '没有单位名称列，需在向导里指定固定单位',
  });

  // s15 带期初余额行
  files.push({
    file: 's15_带期初行.xlsx',
    kind: 'xlsx',
    sheets: {
      '明细账': [
        ['日期', '摘要', '借方金额', '贷方金额', '余额'],
        ['2026-08-01', '期初余额', '', '', 30000],
        ['2026-08-05', '销售开票', 10000, '', ''],
        ['2026-08-20', '收到货款', '', 5000, ''],
      ],
    },
    note: '含「期初余额」行，balanceMode=opening_from_file 时应识别为 30,000',
  });

  // s16 综合污染
  files.push({
    file: 's16_综合污染.xlsx',
    kind: 'xlsx',
    sheets: {
      '明细账': [
        ['日期', '摘要', '借方金额', '贷方金额'],
        ['2026-08-05', '正常', 1000, 0],
        ['2026-08-06', '空占位符', '--', 0],
        ['2026-08-07', '文本型数字', '2,000.50', 0],
        ['2026-08-08', '不可见字符', '3000\u00A0', 0],
        ['2026-08-09', '万元陷阱', '1.5万元', 0],
        ['2026-08-10', '全角数字', '４０００', 0],
        ['2026-08-11', '纯文字垃圾', '待确认', 0],
        ['', '', '', ''],
      ],
    },
    note: '占位符/文本型数字/不可见字符/万元/全角/纯文字垃圾',
  });


  // s17 带逐行余额列（含一行「红字没用负号」的冲销）—— 余额列交叉校验的靶子
  files.push({
    file: 's17_带余额列_含红字.xlsx',
    kind: 'xlsx',
    sheets: {
      '明细账': [
        ['某市某某商贸有限公司  应收账款明细账'],
        ['科目：应收账款    期间：2026-08-01 至 2026-08-31'],
        [],
        ['日期', '摘要', '借方金额', '贷方金额', '余额'],
        ['2026-08-01', '期初余额', '', '', 50000],
        ['2026-08-05', '销售开票 A-2608051', 20000, '', 70000],
        ['2026-08-12', '收到货款 电汇', '', 10000, 60000],
        ['2026-08-18', '销售退回（红冲）', 5000, '', 55000],
        ['2026-08-25', '销售开票 A-2608025', 8000, '', 63000],
      ],
    },
    note: '第 8 行是「红字未用负号」的坑：金额是正的 5000，但余额反而减少 5000；余额列交叉校验应点名这一行',
  });

  // s18 单列金额 + 逐行余额（贷方科目口径），验证校验不会误报
  files.push({
    file: 's18_单列金额带余额_应付.xlsx',
    kind: 'xlsx',
    sheets: {
      '明细账': [
        ['日期', '摘要', '发生额', '余额'],
        ['2026-08-01', '期初余额', '', 80000],
        ['2026-08-05', '采购入库 钢材', 20000, 100000],
        ['2026-08-18', '支付货款 电汇', -30000, 70000],
      ],
    },
    note: '单列「发生额」+ 逐行余额；余额按贷方为正表示，校验应报「全部吻合」而不是误报',
  });

  return files;
}

function writeFile(spec) {
  const target = path.join(DIR, spec.file);
  if (spec.kind === 'csv') {
    let buf;
    const text = spec.text;
    if (spec.encoding === 'gbk') buf = iconv.encode(text, 'gb18030');
    else if (spec.encoding === 'utf8bom') buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    else buf = Buffer.from(text, 'utf8');
    fs.writeFileSync(target, buf);
    return { file: spec.file, bytes: buf.length, note: spec.note };
  }

  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(spec.sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  const bookType = spec.kind === 'xls' ? 'biff8' : 'xlsx';
  XLSX.writeFile(wb, target, { bookType });
  return { file: spec.file, bytes: fs.statSync(target).size, note: spec.note };
}

function main() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  const specs = build();
  const written = specs.map(writeFile);
  fs.writeFileSync(path.join(DIR, '_expected.json'), JSON.stringify(EXPECTED, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(DIR, '_manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), files: written }, null, 2),
    'utf8'
  );
  console.log('[OK] 已生成样本 ' + written.length + ' 个 -> samples/');
  for (const w of written) console.log('     ' + w.file + '  (' + w.bytes + ' bytes)  ' + w.note);
}

if (require.main === module) main();
module.exports = { build, EXPECTED, UNITS, LEDGER, OUR_COMPANY, main };
