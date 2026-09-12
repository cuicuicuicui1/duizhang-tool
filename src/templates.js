'use strict';
/*
 * templates.js — 对账函模板渲染
 * 模板是真 HTML + {{placeholder}}，会计可以在「模板设置」页看到实时预览。
 * 刻意只支持最简单的占位符替换：所有循环与条件都在 JS 里预渲染成 HTML 片段再注入，
 * 避免引入模板引擎（计划 §1 明确禁用构建工具与前端框架）。
 */

const fs = require('fs');
const path = require('path');
const money = require('./money');
const daxie = require('./daxie');

const TPL_DIR = path.join(__dirname, '..', 'templates');

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cn(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0) return String(n);
  if (v < 10) return CN_NUM[v];
  if (v < 20) return '十' + (v % 10 ? CN_NUM[v % 10] : '');
  return CN_NUM[Math.floor(v / 10)] + '十' + (v % 10 ? CN_NUM[v % 10] : '');
}

/** '2026-08-31' → '2026年08月31日' */
function dateText(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
  return iso.slice(0, 4) + '年' + iso.slice(5, 7) + '月' + iso.slice(8, 10) + '日';
}

function loadTemplate(name) {
  const p = path.join(TPL_DIR, name);
  return fs.readFileSync(p, 'utf8');
}

let _commonCss = null;
/** 共用样式内联进模板：既保证 puppeteer 打印时有样式，也保证预览自包含 */
function commonStyle() {
  if (_commonCss === null) {
    try {
      _commonCss = fs.readFileSync(path.join(TPL_DIR, 'common.css'), 'utf8');
    } catch (_) {
      _commonCss = '';
    }
  }
  return _commonCss;
}

function mini(tpl, data) {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => {
    const v = data[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** 金额 → 展示文本 + 大写（大写非法时明确提示，不静默） */
function amountCell(fen, cfg) {
  const d = daxie.toDaxieSafe(money.absFen(fen), { keepZeroYuan: !!(cfg && cfg.daxieKeepZeroYuan) });
  return {
    text: '¥' + money.fenToStr(fen),
    daxie: d.ok ? d.text : '(金额为负或非法，无法转换大写，请人工核对)',
  };
}

/**
 * 生成对账函数据（模板占位符字典）
 */
function buildStatementData(input) {
  const { unit, balance, session, config, statement } = input;
  const cfg = config || {};
  const company = cfg.company || {};
  const cutoff = (session && session.cutoffDate) || balance.cutoff || '';
  const payable = (session && session.direction) === 'payable';

  const balanceRows = [];
  const parts = balance.parts && balance.parts.length ? balance.parts : [balance];
  const nonZero = parts.filter((p) => p.absFen !== 0 || parts.length === 1);
  const list = nonZero.length ? nonZero : parts;
  for (const p of list) {
    const a = amountCell(p.absFen, cfg);
    balanceRows.push({
      label: (p.account ? esc(p.account) : '往来款项') + '余额',
      amountText: a.text,
      daxieText: a.daxie,
      abnormal: p.directionAbnormal,
      account: p.account || '',
    });
  }
  const balanceRowsHtml = balanceRows
    .map(
      (r) =>
        '<tr><td class="lbl">' +
        r.label +
        (r.abnormal ? ' <span class="flag">余额方向异常</span>' : '') +
        '</td><td class="num">' +
        r.amountText +
        '</td></tr>' +
        '<tr><td class="lbl sub">（大写）</td><td class="num daxie">' +
        r.daxieText +
        '</td></tr>'
    )
    .join('\n');

  const periodRowsHtml =
    '<tr><td class="lbl">本期借方发生额合计</td><td class="num">' +
    '¥' + money.fenToStr(balance.periodDebitFen) +
    '</td></tr>' +
    '<tr><td class="lbl">本期贷方发生额合计</td><td class="num">' +
    '¥' + money.fenToStr(balance.periodCreditFen) +
    '</td></tr>';

  // 明细附页
  let detailSection = '';
  const attach = cfg.detailAttach || 'auto';
  const wantDetail = attach === 'always' || (attach === 'auto' && balance.hasDetail);
  if (wantDetail) {
    detailSection = renderDetailPage({
      unit,
      balance,
      cutoff,
      serialNo: statement ? statement.serialNo : '',
      config: cfg,
    });
  }

  // 待人工确认事项
  const notes = [];
  for (const p of parts) {
    for (const w of p.warnings || []) notes.push(w);
    if (p.directionAbnormal) {
      notes.push(
        'MANUAL_REVIEW: ' + (p.account || '该科目') + ' 余额方向与科目常规方向相反（' + money.fenToStr(p.signedFen) + '），请核对是否记错方向或确有反向余额。'
      );
    }
  }
  if (parts.length > 1) {
    notes.push('MANUAL_REVIEW: 该单位同时存在多个科目余额（' + parts.map((p) => p.account || '未标注科目').join('、') + '），已分别列示未作抵销，是否净额结算请人工确认。');
  }
  if (balance.balanceOnly) {
    notes.push('MANUAL_REVIEW: 该单位仅有余额数据、没有逐笔明细，无法逐笔核对，建议向对方索取明细或补充导出明细账。');
  }
  if (!balance.hasDetail && wantDetail) {
    notes.push('MANUAL_REVIEW: 明细附页为空（该单位仅导入余额）。');
  }
  const notesSection = notes.length
    ? '<div class="notes"><div class="notes-title">待人工确认事项</div><ul>' +
      notes.map((n) => '<li>' + esc(n.replace(/^MANUAL_REVIEW:\s*/, '')) + '</li>').join('') +
      '</ul></div>'
    : '';

  const directionWord = payable ? '我方欠贵公司' : '贵公司欠我方';
  const bodyParagraph =
    '为核实双方往来账目，现将我方账簿记录的本单位往来款项余额函告如下，请贵公司核对无误后在回函联签章寄回；' +
    '如有不符，请在回函联中列明差异事项及金额，以便双方及时查明处理。';

  const closingText = (balanceRows[0] || {}).amountText || '¥0.00';
  const closingDaxie = (balanceRows[0] || {}).daxieText || '';

  const traceLine = buildTraceLine(input, parts);
  return {
    commonStyle: commonStyle(),
    traceLine: esc(traceLine),
    serialNo: esc(statement ? statement.serialNo : ''),
    version: statement ? statement.version : 1,
    unitName: esc(unit.name),
    unitAddress: esc(unit.address || ''),
    unitContact: esc(unit.contact || ''),
    unitPhone: esc(unit.phone || ''),
    ourCompanyName: esc(company.name || '（请在模板设置里填写我方公司名称）'),
    ourCompanyAddress: esc(company.address || ''),
    ourCompanyPhone: esc(company.phone || ''),
    ourContact: esc(company.contact || ''),
    cutoffDateText: dateText(cutoff),
    issueDateText: dateText((statement && statement.issueDate) || new Date().toISOString().slice(0, 10)),
    periodText: session && session.period ? session.period : (cutoff ? cutoff.slice(0, 7) : ''),
    directionWord,
    directionTitle: payable ? '应付账款对账函' : '应收账款对账函',
    multiHint: parts.length > 1 ? '（该单位存在多个科目余额，已分别列示如下）' : '',
    bodyParagraph,
    balanceRowsHtml,
    periodRowsHtml,
    detailSection,
    notesSection,
    closingText,
    closingDaxie,
    detailCount: balance.detailCount || 0,
    accountText: esc(parts.map((p) => p.account).filter(Boolean).join('、')),
    logoImg: company.logoPath ? '<img class="logo" src="file:///' + esc(String(company.logoPath).replace(/\\/g, '/')) + '" alt="logo">' : '',
  };
}

/** 明细附页 */
function renderDetailPage(input) {
  const { unit, balance, cutoff, serialNo, config } = input;
  const tpl = loadTemplate('detail_page.html');
  const detail = input.__detail || ledgerDetail(balance);
  const rows = [];
  for (const p of detail.parts) {
    if (detail.parts.length > 1) {
      rows.push(
        '<tr class="acct-head"><td colspan="7">' +
          esc(p.account || '（未标注科目）') +
          '　期初：' +
          (p.openingFen === null ? '—' : money.fenToStr(p.openingFen)) +
          '</td></tr>'
      );
    }
    for (const r of p.rows) {
      rows.push(
        '<tr><td class="c">' +
          r.index +
          '</td><td class="c">' +
          esc(r.date) +
          '</td><td>' +
          esc(r.summary) +
          '</td><td class="num">' +
          (r.debitFen ? money.fenToStr(r.debitFen) : '') +
          '</td><td class="num">' +
          (r.creditFen ? money.fenToStr(r.creditFen) : '') +
          '</td><td class="num">' +
          money.fenToStr(r.runningFen) +
          '</td><td class="c">' +
          esc(r.voucherNo) +
          '</td></tr>'
      );
    }
    if (detail.parts.length > 1) {
      rows.push(
        '<tr class="acct-head"><td colspan="3">' + esc(p.account || '') + ' 小计</td><td class="num">' +
          money.fenToStr(p.debitSumFen) + '</td><td class="num">' + money.fenToStr(p.creditSumFen) +
          '</td><td class="num">' + money.fenToStr(p.closingFen) + '</td><td></td></tr>'
      );
    }
  }
  return mini(tpl, {
    unitName: esc(unit.name),
    serialNo: esc(serialNo),
    cutoffDateText: dateText(cutoff),
    ourCompanyName: esc((config && config.company && config.company.name) || ''),
    openingText: balance.openingFen === null || balance.openingFen === undefined ? '—' : money.fenToStr(balance.openingFen),
    openingSource: esc((detail.parts[0] && detail.parts[0].openingSource) || balance.openingSource || ''),
    detailRowsHtml: rows.join('\n'),
    totalDebitText: money.fenToStr(balance.debitSumFen),
    totalCreditText: money.fenToStr(balance.creditSumFen),
    closingText: money.fenToStr(balance.signedFen),
    rowCount: detail.totalRows,
  });
}

function ledgerDetail(balance) {
  return require('./ledger').detailRows(balance);
}

/** 留痕行：这份函的数据从哪来、按什么口径算、什么时候生成的、第几版 */
function buildTraceLine(input, parts) {
  const { balance, config, statement } = input;
  const tr = require('./ledger').traceOf(balance);
  const used = (parts[0] && parts[0].usedMode) || (config.balanceMode || '');
  const filesText = tr.files.length
    ? '原文件：' + tr.files.slice(0, 3).join('、') + (tr.files.length > 3 ? ' 等 ' + tr.files.length + ' 个' : '')
    : '原文件：未记录';
  const batchText = tr.batches.length ? '导入批次 ' + tr.batches.join('、') : '导入批次未记录';
  return (
    '数据来源：' + batchText + '（' + filesText + '）　余额口径：' + used +
    '　明细笔数：' + tr.count + '　生成时间：' + (statement && statement.createdAt ? statement.createdAt : '') +
    '　版本：v' + (statement ? statement.version : 1) +
    (statement && statement.pdfEngine ? '　PDF 通道：' + statement.pdfEngine : '')
  );
}

/** 渲染完整对账函（含明细附页） */
function renderStatement(input) {
  const data = buildStatementData(input);
  const name = (input.session && input.session.direction) === 'payable' ? 'payable.html' : 'receivable.html';
  const tpl = loadTemplate(name);
  return mini(tpl, data);
}

/** 渲染明细附页（单独导出用） */
function renderDetailOnly(input) {
  return renderDetailPage(input);
}

function listTemplates() {
  return fs
    .readdirSync(TPL_DIR)
    .filter((f) => f.endsWith('.html'))
    .map((f) => ({ file: f, size: fs.statSync(path.join(TPL_DIR, f)).size }));
}

module.exports = {
  esc,
  cn,
  dateText,
  mini,
  loadTemplate,
  commonStyle,
  amountCell,
  buildStatementData,
  buildTraceLine,
  renderStatement,
  renderDetailPage,
  renderDetailOnly,
  listTemplates,
};
