'use strict';
/*
 * config.js — 业务口径设置（全部可配，最终由会计在「设置」页决定）
 *
 * 本模块把计划里"必须拍板"的业务口径全部变成**可选项**：
 * 每一种口径都带 label + desc，设置页直接把 OPTIONS 渲染成单选卡片，
 * 会计按自己账套的实际情况选，工具不预设唯一答案。
 */

const store = require('./store');

const DEFAULT_ALIASES = {
  unitName: ['往来单位', '单位名称', '客户', '客户名称', '供应商', '供应商名称', '对方单位', '单位', '客商', '客商名称', '辅助核算', '往来户', '名称'],
  date: ['日期', '业务日期', '凭证日期', '记账日期', '单据日期', '发生日期', '交易日期'],
  summary: ['摘要', '摘要说明', '备注', '内容', '用途', '业务内容', '说明'],
  debit: ['借方金额', '借方', '借方发生额', '应收金额', '增加', '本期借方', '借方本币', '借方本币金额'],
  credit: ['贷方金额', '贷方', '贷方发生额', '应付金额', '减少', '本期贷方', '贷方本币', '贷方本币金额'],
  amount: ['金额', '发生额', '本期发生额', '本币金额', '原币金额'],
  direction: ['方向', '借贷方向', '借贷', '余额方向'],
  balance: ['余额', '期末余额', '结余', '当前余额', '期末数', '余额本币'],
  openingBalance: ['期初余额', '年初余额', '期初数', '上期结转', '期初'],
  subject: ['科目', '会计科目', '科目名称', '科目全称'],
  voucherNo: ['凭证号', '凭证编号', '单号', '凭证字', '凭证字号', '单据编号'],
  seq: ['序号', '行号', '编号'],
};

/** 口径选项字典：设置页直接渲染，label/desc 面向会计，不用术语堆砌 */
const OPTIONS = {
  balanceMode: {
    title: '己方账面余额怎么算',
    desc: '决定「我方余额」的数字从哪里来。选错了对账函上的余额就会系统性偏差。',
    choices: [
      {
        value: 'opening_from_file',
        label: '用导出文件里的期初余额',
        desc: '导入的明细账里带「期初余额 / 年初余额 / 上期结转」行或列时，拿它当起点，再加本期借贷。最准。识别不到会提示你补录。',
      },
      {
        value: 'cumulative',
        label: '直接累计明细账的借贷',
        desc: '余额 = 借方合计 − 贷方合计。前提是你导出的区间是完整的（从建账或年初一直导到截止日），否则会缺期初那一段。',
      },
      {
        value: 'manual_opening',
        label: '期初余额由我手工录入',
        desc: '在「单位档案」里给每个单位填期初余额，工具只做加法。最不容易出错，但要多填一次。',
      },
      {
        value: 'balance_sheet',
        label: '以科目余额表为准',
        desc: '余额直接取「科目余额表」上的期末余额列；明细账只用来做逐笔勾对。适合手上有余额表的情况。',
      },
      {
        value: 'incremental',
        label: '分次导入累加',
        desc: '先导期初余额表、再导期间明细账，每次导入都在已有余额上累加。适合数据要分几个月陆续导出补录的情况。',
      },
      {
        value: 'auto',
        label: '自动（推荐）',
        desc: '先找期初余额，找到了用它；找不到就用累计法，并在对账函和差异报告上打「口径待确认」标记提醒你核对。',
      },
    ],
  },
  signConvention: {
    title: '余额的正负号怎么表示',
    desc: '应收、应付的余额方向和记账方向相反，这里决定工具内部怎么记录。',
    choices: [
      {
        value: 'signed_by_account',
        label: '按科目自带方向（推荐）',
        desc: '应收账款 = 借 − 贷；应付账款 = 贷 − 借。出现负数说明余额方向和科目相反，报告里会单独提示你核查。',
      },
      {
        value: 'positive_with_direction',
        label: '一律存正数，方向另记',
        desc: '金额永远是正数，「谁欠谁」由应收/应付方向决定。函件措辞按方向自动切换，不会出现负数。',
      },
    ],
  },
  netting: {
    title: '同一家既是客户又是供应商怎么办',
    desc: '合规上应收应付原则上不得擅自抵销，这里决定工具的默认动作。',
    choices: [
      {
        value: 'never',
        label: '分别列示，不抵销（推荐）',
        desc: '应收、应付余额在同一张函上分栏列示，并提示你人工确认是否净额结算。',
      },
      {
        value: 'ask',
        label: '列出净额供参考，同时列示两方余额',
        desc: '除分栏列示外，额外显示一个「净额」参考数（仅参考，不进正文）。',
      },
    ],
  },
  replySignFlip: {
    title: '对方回函的金额方向',
    desc: '我方记应收的对方记应付，对方抄回来的数字常和我方方向相反，差一个正负号会全表对不上。',
    choices: [
      {
        value: 'auto',
        label: '自动识别并提示（推荐）',
        desc: '先按原方向勾对；若全表对不上、把对方金额整体反向却正好对上，则提示「疑似方向相反」并由你一键翻转。',
      },
      {
        value: 'always',
        label: '一律翻转',
        desc: '所有回函金额先整体取反再勾对。适合你的往来单位回函习惯与我方相反的情况。',
      },
      {
        value: 'never',
        label: '不翻转',
        desc: '对方回函金额按我方口径填写，直接用。',
      },
    ],
  },
  detailAttach: {
    title: '对账函是否附逐笔明细',
    desc: '明细附页会显著增加函件页数（每家 200 行约 8 页），但对方好核对。',
    choices: [
      { value: 'auto', label: '有明细就附（推荐）', desc: '该单位有逐笔明细时自动附明细页；只有余额时不附。' },
      { value: 'always', label: '总是附', desc: '即使明细为空也保留附页，页面留空行。' },
      { value: 'never', label: '不附', desc: '只出「余额对账」一页函，体量最小。' },
    ],
  },
  daxieKeepZeroYuan: {
    title: '大写金额的写法',
    desc: '元位为零时（例如 0.01 元）两种写法都有人用，按你单位习惯选。',
    choices: [
      { value: false, label: '省略「零元」：壹分', desc: '0.01 → 壹分；0.15 → 壹角伍分。' },
      { value: true, label: '保留「零元」：零元壹分', desc: '0.01 → 零元零壹分；0.15 → 零元壹角伍分。银行票据常用这种。' },
    ],
  },
  pdfEngine: {
    title: 'PDF 由哪个通道生成',
    desc: '两条通道用同一个系统浏览器内核、同一份 HTML、同一套打印样式，产物等价。差别只在速度与依赖。',
    choices: [
      { value: 'auto', label: '复用单个浏览器实例（推荐）', desc: '实测 0.24 秒/份；批量 50 家约 13 秒出齐 PDF。需要 puppeteer-core 可用，失败会自动回退到兼容模式。' },
      { value: 'cli', label: '兼容模式（每次新开浏览器）', desc: '不依赖任何第三方包，约 1.1 秒/份。适合 puppeteer-core 装不上的机器，或需要极致环境隔离的场景。' },
    ],
  },
  splitBySubject: {
    title: '同一单位多个科目',
    desc: '比如同一家既有应收账款又有预收账款。',
    choices: [
      { value: false, label: '按单位合并对账（推荐）', desc: '同一单位所有科目合并成一个余额发一张函。' },
      { value: true, label: '按科目拆开发函', desc: '每个科目一张函，函上分别写明科目名称。' },
    ],
  },
};

/**
 * 科目自然方向字典：只有「单列金额 + 无方向列」的明细账才需要它判断正数进借还是进贷。
 * 命中规则是「科目名包含任一关键词」；两边都命中或都不命中都判为「不确定」，
 * 由导入向导里指定的方向兜底，并在预览页标出来。
 * 关键词刻意不放「长期」这类含糊词 —— 否则「长期借款」会同时命中借贷两边而判不准。
 */
const DEFAULT_SIDES = {
  debit: ['应收', '预付', '库存', '现金', '银行', '固定资产', '材料', '存货', '成本', '费用', '税', '待摊', '在途物资', '长期股权投资', '长期应收款', '累计摊销'],
  credit: ['应付', '预收', '短期借款', '长期借款', '负债', '收入', '收益', '权益', '资本', '未分配', '累计折旧', '坏账准备', '递延收益'],
};

const DEFAULTS = {
  company: { name: '', address: '', phone: '', contact: '', logoPath: '' },
  serialRule: 'DZH-{yyyymmdd}-{seq4}',
  serialScope: 'perDay',
  matchWindowDays: 15,
  balanceMode: 'auto',
  signConvention: 'signed_by_account',
  netting: 'never',
  replySignFlip: 'auto',
  detailAttach: 'auto',
  daxieKeepZeroYuan: false,
  splitBySubject: false,
  subTotalRows: true,
  pdfConcurrency: 4,
  pdfEngine: 'auto',
  port: 3210,
  browserPath: '',
  aliases: DEFAULT_ALIASES,
  subjectSideDebit: DEFAULT_SIDES.debit,
  subjectSideCredit: DEFAULT_SIDES.credit,
  redWordKeywords: ['红冲', '冲销', '红字', '冲回', '退回', '退货', '折让'],
};

function getConfig() {
  const saved = store.readJson('config.json', {});
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  for (const k of Object.keys(DEFAULTS)) {
    if (saved && Object.prototype.hasOwnProperty.call(saved, k) && saved[k] !== undefined) {
      if (k === 'aliases') {
        cfg.aliases = Object.assign({}, DEFAULT_ALIASES, saved.aliases || {});
      } else if (k === 'company') {
        cfg.company = Object.assign({}, DEFAULTS.company, saved.company || {});
      } else {
        cfg[k] = saved[k];
      }
    }
  }
  return cfg;
}

function saveConfig(patch) {
  const cur = getConfig();
  const next = Object.assign({}, cur, patch || {});
  if (patch && patch.aliases) next.aliases = Object.assign({}, cur.aliases, patch.aliases);
  if (patch && patch.company) next.company = Object.assign({}, cur.company, patch.company);
  store.writeJson('config.json', next);
  return next;
}

function resetConfig() {
  store.writeJson('config.json', JSON.parse(JSON.stringify(DEFAULTS)));
  return getConfig();
}

module.exports = { DEFAULTS, OPTIONS, DEFAULT_ALIASES, DEFAULT_SIDES, getConfig, saveConfig, resetConfig };
