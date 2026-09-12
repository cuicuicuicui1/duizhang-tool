'use strict';
/*
 * importer.js — 导入解析（xls / xlsx / csv → 标准 ledger 结构）
 *
 * 流程：loadWorkbook → analyzeSheet（表头探测/预览/脏行标注）→ commit（映射确认后入库）
 * 脏数据清单见计划 §5.3，逐条在下方 parseRow / analyzeSheet 中处理。
 *
 * MANUAL_REVIEW: 单列「金额」且无方向列时，正负号进借还是进贷取决于科目性质，
 *                工具按科目方向推断并在预览页标注提示，最终由会计在向导里确认。
 */

const crypto = require('crypto');
const path = require('path');
const XLSX = require('xlsx');
const iconv = require('iconv-lite');

const store = require('./store');
const money = require('./money');
const columns = require('./columns');
const dates = require('./dates');
const units = require('./units');
const CFG = require('./config');
const mapTemplates = require('./mapTemplates');

const SUBTOTAL_KINDS = { DATA: 'data', SUBTOTAL: 'subtotal', OPENING: 'opening', BLANK: 'blank', JUNK: 'junk' };

const DEBIT_ACCOUNT_RE = /应收|预付|其他应收|库存|现金|银行|固定资产|材料|存货|成本|费用|税|待摊|长期/;
const CREDIT_ACCOUNT_RE = /应付|预收|其他应付|短期借款|长期借款|负债|收入|收益|权益|资本|实收资本|未分配/;

/**
 * 科目性质 → 余额在借方还是贷方。
 * 关键词清单来自 config（设置页可改）：命中借方清单 → debit，命中贷方清单 → credit，
 * 两边都命中或都不命中 → null（判不准，交人工在向导里指定）。
 */
function accountSide(account, cfg) {
  const a = money.normalizeText(account || '');
  if (!a) return null;
  const debitList = (cfg && cfg.subjectSideDebit) || CFG.DEFAULTS.subjectSideDebit || [];
  const creditList = (cfg && cfg.subjectSideCredit) || CFG.DEFAULTS.subjectSideCredit || [];
  const hitD = debitList.some((k) => k && a.includes(money.normalizeText(k)));
  const hitC = creditList.some((k) => k && a.includes(money.normalizeText(k)));
  if (hitD && !hitC) return 'debit';
  if (hitC && !hitD) return 'credit';
  return null;
}

function extOf(filename) {
  return String(filename || '').toLowerCase().split('.').pop();
}

const RECEIVABLE_SUBJECT_RE = /^(应收|应付|预收|预付|其他应收|其他应付|应收账款|应付账款|预收账款|预付账款|其他应收款|其他应付款|合同资产|合同负债)$/;

/** 行级科目判定：科目列写的是往来科目就用行级科目，否则沿用向导里指定的科目 */
function pickAccount(planAccount, rowSubject) {
  const s = money.normalizeText(rowSubject).replace(/[（(].*?[)）]/g, '').trim();
  if (!s) return planAccount || '';
  if (RECEIVABLE_SUBJECT_RE.test(s)) return s;
  if (/(应收|应付|预收|预付)/.test(s) && s.length <= 12) return s;
  return planAccount || '';
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** 编码探测：BOM → UTF-8 → GBK/GB18030 兜底 */
function decodeText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.slice(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: iconv.decode(buffer, 'utf16le'), encoding: 'utf16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: iconv.decode(buffer, 'utf16be'), encoding: 'utf16be' };
  }
  const utf8 = buffer.toString('utf8');
  if (!/\uFFFD/.test(utf8)) return { text: utf8, encoding: 'utf-8' };
  return { text: iconv.decode(buffer, 'gb18030'), encoding: 'gb18030' };
}

function cellToText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return dates.parseDate(v) || '';
  return money.normalizeText(v);
}

function loadWorkbook(buffer, filename) {
  const ext = extOf(filename);
  const isText = ext === 'csv' || ext === 'txt';
  let wb;
  let encoding = '';
  if (isText) {
    const dec = decodeText(buffer);
    encoding = dec.encoding;
    wb = XLSX.read(dec.text, { type: 'string', raw: true, cellDates: true });
  } else {
    wb = XLSX.read(buffer, { type: 'buffer', raw: true, cellDates: true });
  }
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    let rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true, raw: true });
    // 裁掉尾部全空行
    let end = rows.length;
    while (end > 0 && columns.rowIsBlank(rows[end - 1])) end--;
    rows = rows.slice(0, end);
    return { name, rows, merges: (ws['!merges'] || []).length };
  });
  return { kind: isText ? ext : 'excel:' + ext, encoding, sheets, sheetNames: wb.SheetNames };
}

/** 找一行里第一个非空文本（用于小计/期初判定，避开数字列） */
function firstTexts(row, n) {
  const out = [];
  for (let i = 0; i < row.length && out.length < n; i++) {
    const t = cellToText(row[i]);
    if (t) out.push(t);
  }
  return out;
}

/**
 * 余额列交叉校验（核心：不靠猜，用文件自带的余额列反查方向）
 *
 * 原理：明细账里「余额」这一列的逐行变化量，必然等于这段时间的「借方 − 贷方」。
 *   - delta === movement    → 文件余额是「借方为正」口径（asIs 成立）
 *   - delta === -movement   → 文件余额是「贷方为正」口径（swapped 成立）
 *   - 两者都不成立          → 这一行的方向或金额一定有问题，能精确定位到行号
 *
 * 重要（推演过）：**这个校验无法用来判定单列金额文件的借贷方向**。
 * 因为「科目方向判断反了」与「余额列用相反口径表示」会产出完全相同的数字关系，内部证据无法区分。
 * 所以这里只做两件事：① 报告该文件余额列按哪一方为正（信息）；② 点名与余额列对不上的行。
 * 方向本身仍由「科目关键词清单 → 导入向导里选的应收/应付」决定，并由使用者核对期末余额确认。
 *
 * @param {Array} parsed 已解析的行（含 kind/rowNo/debitFen/creditFen/balanceFen）
 * @param {number|null} openingFen 期初余额，有则作为第一个比较基准
 */
function analyzeBalanceColumn(parsed, openingFen) {
  const dataRows = parsed.filter((p) => p.kind === SUBTOTAL_KINDS.DATA);
  const hasBalance = dataRows.some((p) => typeof p.balanceFen === 'number');
  if (!hasBalance) {
    return { available: false, reason: '该文件没有可用的「余额」列，无法交叉校验（导出时勾上余额列即可启用）' };
  }
  let prev = typeof openingFen === 'number' ? openingFen : null;
  let movement = 0;
  const rel = [];
  for (const p of dataRows) {
    movement += (p.debitFen || 0) - (p.creditFen || 0);
    if (typeof p.balanceFen !== 'number') continue;
    if (prev === null) {
      prev = p.balanceFen;
      movement = 0;
      continue;
    }
    const delta = p.balanceFen - prev;
    if (movement === 0 && delta === 0) {
      prev = p.balanceFen;
      continue;
    }
    rel.push({
      rowNo: p.rowNo,
      delta,
      movement,
      diff: delta - movement,
      summary: p.summary || '',
      kind: delta === movement ? 'asIs' : delta === -movement ? 'swapped' : 'neither',
    });
    prev = p.balanceFen;
    movement = 0;
  }
  if (!rel.length) {
    return {
      available: true,
      hasOpeningSeed: typeof openingFen === 'number',
      compared: 0,
      asIs: 0,
      swapped: 0,
      verdict: 'unknown',
      convention: null,
      mismatchCount: 0,
      mismatches: [],
      reason: '余额列没有可比对的两行以上（可能只有期初一行）',
    };
  }
  const asIs = rel.filter((r) => r.kind === 'asIs').length;
  const swapped = rel.filter((r) => r.kind === 'swapped').length;
  const neither = rel.filter((r) => r.kind === 'neither').length;
  // 多数票决定这份文件余额列的口径；少数派（含两边都不吻合的）就是可疑行
  const verdict = swapped > asIs ? 'swapped' : 'asIs';
  const mismatches = rel.filter((r) => r.kind !== verdict);
  return {
    available: true,
    hasOpeningSeed: typeof openingFen === 'number',
    compared: rel.length,
    asIs,
    swapped,
    neither,
    verdict,
    convention: verdict === 'asIs' ? 'debit' : 'credit',
    conventionLabel: verdict === 'asIs' ? '借方发生额增加余额' : '贷方发生额增加余额',
    matchRate: rel.length ? Math.round(((rel.length - mismatches.length) / rel.length) * 100) : 100,
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 30),
    rel,
  };
}

function classifyRow(row, mapping) {
  if (columns.rowIsBlank(row)) return SUBTOTAL_KINDS.BLANK;
  const texts = firstTexts(row, 2);
  for (const t of texts) {
    if (columns.isSubtotalText(t)) return SUBTOTAL_KINDS.SUBTOTAL;
  }
  const summaryText = mapping.summary !== undefined ? cellToText(row[mapping.summary]) : '';
  const anyText = texts.join(' ');
  if (columns.isOpeningText(summaryText) || columns.isOpeningText(anyText)) return SUBTOTAL_KINDS.OPENING;
  return SUBTOTAL_KINDS.DATA;
}

/**
 * 单行 → 标准分录
 * @returns {{kind:string, entry?:Object, opening?:Object, errors:string[], warn:string[]}}
 */
function parseRow(row, mapping, ctx) {
  const errors = [];
  const warn = [];
  const kind = classifyRow(row, mapping);

  const getFen = (idx, label) => {
    if (idx === undefined || idx === null) return { fen: 0, ok: true };
    const raw = row[idx];
    const r = money.parseToFen(raw);
    if (!r.ok) errors.push(label + '解析失败：' + (r.err || ''));
    if (r.warn) warn.push(label + '：' + r.warn);
    return r;
  };

  if (kind === SUBTOTAL_KINDS.BLANK) return { kind, errors, warn };
  if (kind === SUBTOTAL_KINDS.SUBTOTAL) return { kind, errors, warn };
  if (kind === SUBTOTAL_KINDS.OPENING) {
    let fen = null;
    let source = '';
    if (mapping.openingBalance !== undefined) {
      const r = money.parseToFen(row[mapping.openingBalance]);
      if (r.ok) {
        fen = r.fen;
        source = 'openingBalance列';
      }
    }
    if (fen === null && mapping.balance !== undefined) {
      const r = money.parseToFen(row[mapping.balance]);
      if (r.ok) {
        fen = r.fen;
        source = 'balance列(期初行)';
      }
    }
    if (fen === null && (mapping.debit !== undefined || mapping.credit !== undefined)) {
      const d = getFen(mapping.debit, '借方').fen || 0;
      const c = getFen(mapping.credit, '贷方').fen || 0;
      fen = d - c;
      source = '期初行借贷相减';
    }
    const dateIso = mapping.date !== undefined ? dates.parseDate(row[mapping.date]) : null;
    return { kind, errors, warn, opening: { fen: fen === null ? null : fen, source, date: dateIso } };
  }

  // ---- 正常数据行 ----
  const dateIso = mapping.date !== undefined ? dates.parseDate(row[mapping.date]) : null;
  if (mapping.date !== undefined && !dateIso) {
    const raw = cellToText(row[mapping.date]);
    if (raw) warn.push('日期无法识别：' + raw);
  }

  let debitFen = 0;
  let creditFen = 0;
  let dirLabel = '';
  let conflict = false;
  let viaAmount = false;
  // 这一行有没有用负号/括号表示负数（用来识别「红字只靠颜色」的情况）
  const rawAmountCells = [mapping.debit, mapping.credit, mapping.amount]
    .filter((c) => c !== undefined)
    .map((c) => cellToText(row[c]).replace(/[\s\u00A0]/g, ''))
    .filter(Boolean);
  const rawNeg = rawAmountCells.some((t) => /^[-－(（]/.test(t) || /[-－]+$/.test(t));

  const hasDebit = mapping.debit !== undefined;
  const hasCredit = mapping.credit !== undefined;
  const hasAmount = mapping.amount !== undefined;

  if (hasDebit || hasCredit) {
    if (hasDebit) debitFen = getFen(mapping.debit, '借方').fen || 0;
    if (hasCredit) creditFen = getFen(mapping.credit, '贷方').fen || 0;
    if (debitFen < 0 && creditFen < 0) {
      errors.push('借贷双方均为负数，双向异常');
    }
    if (debitFen < 0 && creditFen === 0) {
      // 借方负数 = 贷方红字冲销
      creditFen = Math.abs(debitFen);
      debitFen = 0;
      dirLabel = '借方负数转贷方';
    } else if (creditFen < 0 && debitFen === 0) {
      debitFen = Math.abs(creditFen);
      creditFen = 0;
      dirLabel = '贷方负数转借方正数';
    }
    if (debitFen > 0 && creditFen > 0) {
      conflict = true;
      errors.push('同一行借贷双方都有金额，请人工确认');
    }
  } else if (hasAmount) {
    const amt = getFen(mapping.amount, '金额').fen || 0;
    let dirRaw = mapping.direction !== undefined ? cellToText(row[mapping.direction]) : '';
    let dir = '';
    if (/借/.test(dirRaw)) dir = 'debit';
    else if (/贷/.test(dirRaw)) dir = 'credit';
    if (dir === 'debit') {
      debitFen = Math.abs(amt);
    } else if (dir === 'credit') {
      creditFen = Math.abs(amt);
    } else {
      // 无方向列：优先级 = 余额列交叉校验推断出的方向 > 科目关键词清单 > 向导里选的应收/应付方向
      viaAmount = true;
      const inferred = ctx.inferredSide || null;
      const byName = accountSide(ctx.account, ctx.cfg);
      const side = inferred || byName;
      const positiveIsDebit = side ? side === 'debit' : ctx.direction !== 'payable';
      dirLabel = inferred
        ? '单列金额·方向按余额列反查（正号入' + (inferred === 'credit' ? '贷方' : '借方') + '）'
        : byName
          ? '单列金额·正号入' + (byName === 'credit' ? '贷方' : '借方') + '（按科目名）'
          : '单列金额·正号入' + (positiveIsDebit ? '借方' : '贷方') + '（按向导选的方向）';
      if (amt >= 0) {
        if (positiveIsDebit) debitFen = amt;
        else creditFen = amt;
      } else if (positiveIsDebit) {
        creditFen = -amt;
      } else {
        debitFen = -amt;
      }
      if (!side) warn.push('单列金额且科目方向判不出来，已按向导里选的「' + (positiveIsDebit ? '应收→正号入借方' : '应付→正号入贷方') + '」处理，请在下方核对');
    }
    if (amt < 0 && dirRaw) dirLabel = '金额含负号且带方向列，已取绝对值按方向列处理';
  } else if (mapping.balance !== undefined) {
    // 科目余额表：只有一列余额
  } else {
    errors.push('该行没有任何可识别的金额列');
  }

  // 红字关键词提示：摘要像冲销、金额却是正数且没有负号 —— 「红字只靠颜色」时最容易出错的一种。
  // 借贷双列与单列金额都适用（不自动取反，只提示，由使用者在预览页决定）。
  {
    const redWords = (ctx.cfg && ctx.cfg.redWordKeywords) || [];
    const summaryForRed = mapping.summary !== undefined ? cellToText(row[mapping.summary]) : '';
    const hitWord = redWords.filter((w) => w && summaryForRed.indexOf(w) >= 0)[0];
    const positiveMovement = debitFen + creditFen > 0;
    const hasDirectionColumn = mapping.direction !== undefined && !!cellToText(row[mapping.direction]);
    if (hitWord && positiveMovement && !rawNeg && !hasDirectionColumn) {
      warn.push('摘要含「' + hitWord + '」但金额写成了正数且未用括号/负号（形如红冲但方向只靠颜色表示），请确认是否需要「借贷取反」');
    }
  }

  const summary = mapping.summary !== undefined ? cellToText(row[mapping.summary]) : '';
  const unitNameRaw = mapping.unitName !== undefined ? cellToText(row[mapping.unitName]) : '';
  const subject = mapping.subject !== undefined ? cellToText(row[mapping.subject]) : '';
  const voucherNo = mapping.voucherNo !== undefined ? cellToText(row[mapping.voucherNo]) : '';
  const balanceFen = (() => {
    if (mapping.balance === undefined) return null;
    const r = money.parseToFen(row[mapping.balance]);
    if (!r.ok || r.empty) return null;
    return r.fen;
  })();

  if (!dateIso && !debitFen && !creditFen && balanceFen === null) {
    return { kind: SUBTOTAL_KINDS.JUNK, errors: [], warn };
  }

  return {
    kind,
    errors,
    warn,
    entry: {
      date: dateIso,
      summary,
      debitFen,
      creditFen,
      balanceFen,
      unitNameRaw,
      subject,
      voucherNo,
      direction: debitFen && creditFen ? 'both' : debitFen ? 'debit' : creditFen ? 'credit' : 'none',
      conflict,
      dirLabel,
      viaAmount,
    },
  };
}

function analyzeSheet(sheet, aliasIndex, cfg, opts) {
  const rows = sheet.rows;
  const warnings = [];
  const det = columns.detectHeaderRow(rows, aliasIndex, (opts && opts.maxScan) || 10);
  const headerRow = det.rowIndex;
  const headers = headerRow >= 0 ? rows[headerRow].map((c) => cellToText(c)) : rows[0] ? rows[0].map(c => cellToText(c)) : [];
  const mapping = det.mapping || {};

  if (headerRow < 0) {
    warnings.push('未能在前 10 行找到表头（命中列不足 2 个），请在下方手工指定表头行与列对应关系');
  }

  const parsed = [];
  const subtotalRows = [];
  let openingRow = null;
  let openingFen = null;
  let openingSource = '';
  const unitNameCount = new Map();
  let dataRows = 0;
  let errorRows = 0;

  const start = headerRow >= 0 ? headerRow + 1 : 0;
  for (let i = start; i < rows.length; i++) {
    const r = parseRow(rows[i], mapping, { account: (opts && opts.account) || '', cfg });
    if (r.kind === SUBTOTAL_KINDS.BLANK) continue;
    if (r.kind === SUBTOTAL_KINDS.SUBTOTAL) {
      subtotalRows.push(i + 1);
      parsed.push({ rowNo: i + 1, kind: r.kind, cells: rows[i].map(cellToText) });
      continue;
    }
    if (r.kind === SUBTOTAL_KINDS.OPENING) {
      openingRow = i + 1;
      if (r.opening && r.opening.fen !== null) {
        openingFen = r.opening.fen;
        openingSource = r.opening.source;
      }
      parsed.push({ rowNo: i + 1, kind: r.kind, cells: rows[i].map(cellToText), note: '期初行：' + (openingSource || '未取到金额') });
      continue;
    }
    if (r.kind === SUBTOTAL_KINDS.JUNK) continue;
    dataRows++;
    if (r.errors.length) errorRows++;
    if (r.entry && r.entry.unitNameRaw) {
      const k = r.entry.unitNameRaw;
      unitNameCount.set(k, (unitNameCount.get(k) || 0) + 1);
    }
    const preview = {
      rowNo: i + 1,
      kind: r.kind,
      cells: rows[i].map(cellToText),
      date: r.entry ? r.entry.date : null,
      summary: r.entry ? r.entry.summary : '',
      debitFen: r.entry ? r.entry.debitFen : 0,
      creditFen: r.entry ? r.entry.creditFen : 0,
      balanceFen: r.entry ? r.entry.balanceFen : null,
      unitNameRaw: r.entry ? r.entry.unitNameRaw : '',
      viaAmount: r.entry ? !!r.entry.viaAmount : false,
      dirLabel: r.entry ? r.entry.dirLabel || '' : '',
      errors: r.errors,
      warn: r.warn,
    };
    parsed.push(preview);
  }

  // 期初余额「列」的存在性：表头里有 期初余额 列
  if (openingFen === null && mapping.openingBalance !== undefined) {
    const firstData = parsed.find((p) => p.kind === SUBTOTAL_KINDS.DATA);
    if (firstData) {
      openingSource = 'openingBalance列(首行)';
      openingFen = null; // commit 阶段按首行取
    }
  }

  // ---- 余额列交叉校验：定位「与文件自带余额列对不上」的行（红字读错、金额截断、漏行都会在这里现形）----
  const balanceCheck = analyzeBalanceColumn(parsed, openingFen);
  if (balanceCheck.available && balanceCheck.mismatchCount > 0) {
    warnings.push(
      '余额列交叉校验：有 ' + balanceCheck.mismatchCount + ' 行与文件自带的「余额」列对不上（首个在第 ' +
        balanceCheck.mismatches[0].rowNo + ' 行）。最常见的原因是红字没用负号/括号表示（颜色读不到），也可能是金额被截断或漏行 —— 请在下方逐行核对并按需取反。'
    );
  }

  const sheetUnits = Array.from(unitNameCount.entries()).map(([name, count]) => ({ name, count }));
  const kindOfSheet = mapping.date === undefined && mapping.balance !== undefined ? 'balance' : 'ledger';

  // 表头上方的标题行：常见「XX公司 往来明细账」，用来给向导预选单位（仅建议，不自动绑定）
  const preHeader = [];
  const scanEnd = headerRow < 0 ? Math.min(rows.length, 10) : headerRow;
  for (let i = 0; i < scanEnd; i++) {
    const t = cellToText(rows[i][0]);
    if (t) preHeader.push({ rowNo: i + 1, text: t });
  }

  return {
    name: sheet.name,
    rowCount: rows.length,
    headerRowNo: headerRow < 0 ? -1 : headerRow + 1,
    headerRow,
    headers,
    mapping,
    mappingLabels: headerRow >= 0 ? columns.headerLabels(rows[headerRow], mapping) : {},
    detected: headerRow >= 0,
    candidates: det.candidates.map((c) => ({ rowIndex: c.rowIndex, hits: c.hits })),
    sheetKind: kindOfSheet,
    dataRows,
    errorRows,
    subtotalRows,
    openingRow,
    openingFen,
    openingSource,
    sheetUnits,
    balanceCheck,
    // 列映射模板建议：按表头签名匹配模板库（开源共享的「XX软件导出」适配层）。
    // 只给建议不强改 —— 套用由用户在向导里点，套用后仍走预览/校验/人工核对全流程。
    templateSuggestions: mapTemplates.suggest(headers).slice(0, 3),
    preHeader,
    hasUnitColumn: mapping.unitName !== undefined,
    preview: parsed.slice(0, 60),
    previewTotal: parsed.length,
    warnings,
  };
}

function analyze({ buffer, filename, config, maxScan, direction }) {
  const cfg = config || {};
  const loaded = loadWorkbook(buffer, filename);
  const aliasIndex = columns.buildAliasIndex(cfg.aliases || {});
  const sheets = loaded.sheets.map((s) => analyzeSheet(s, aliasIndex, cfg, { maxScan, direction: direction || 'receivable' }));
  const allUnits = new Map();
  for (const s of sheets) for (const u of s.sheetUnits) allUnits.set(u.name, (allUnits.get(u.name) || 0) + u.count);
  const unitHits = Array.from(allUnits.keys()).map((name) => {
    const hit = units.findByName(name);
    return {
      name,
      count: allUnits.get(name),
      matchedUnitId: hit.unit ? hit.unit.id : null,
      matchedUnitName: hit.unit ? hit.unit.name : '',
      method: hit.method,
    };
  });

  // 标题行里疑似单位名：给向导做「预选建议」，最终仍由会计确认
  const unitHints = [];
  for (const s of sheets) {
    for (const p of s.preHeader || []) {
      const guess = guessUnitFromTitle(p.text);
      if (!guess) continue;
      const hit = units.findByName(guess);
      unitHints.push({
        sheetName: s.name,
        rowNo: p.rowNo,
        text: p.text,
        guess,
        matchedUnitId: hit.unit ? hit.unit.id : null,
        matchedUnitName: hit.unit ? hit.unit.name : '',
        method: hit.method,
      });
    }
  }

  return {
    fileKind: loaded.kind,
    encoding: loaded.encoding,
    fileHash: sha1(buffer).slice(0, 12),
    filename,
    sizeBytes: buffer.length,
    sheets: sheets.map((s) => Object.assign({}, s, { preview: s.preview.slice(0, 20) })),
    sheetCount: sheets.length,
    unitHits,
    unitHints,
    warnings: sheets.reduce((a, s) => a.concat(s.warnings), []),
  };
}

/** 从标题行文本里抠出疑似单位名（形如「XX有限公司 往来明细账」） */
function guessUnitFromTitle(text) {
  if (!text) return '';
  let t = money.normalizeText(text);
  t = t.replace(/[（(].*?[)）]/g, ' ');
  const m = t.match(/[\u4e00-\u9fa5A-Za-z0-9()（）·]{2,40}?(有限公司|股份公司|有限责任公司|公司|厂|商行|中心|事务所|医院|学校|集团|合作社|经营部|门市部|超市|酒店|宾馆|物流|建材|贸易)/);
  if (m) return m[0].trim();
  // 兜底：切掉常见后缀词
  const cut = t.split(/往来|明细账|余额表|对账单|科目|期间|截止|导出|单位：|账套/)[0].trim();
  return cut.length >= 4 ? cut : '';
}

/**
 * commit — 按确认后的 plans 解析入库
 * @param {{buffer:Buffer, filename:string, plans:Array, config:Object, force:boolean, dryRun:boolean}} input
 */
function commit(input) {
  const cfg = input.config || {};
  const loaded = loadWorkbook(input.buffer, input.filename);
  const aliasIndex = columns.buildAliasIndex(cfg.aliases || {});
  const sync = Array.isArray(input.units) ? input.units : units.all();
  const fileHash = sha1(input.buffer).slice(0, 12);

  const ledgerFile = store.readJson('ledgers.json', []);
  const existingFp = new Set(ledgerFile.map((e) => e.fingerprint).filter(Boolean));
  const openingFile = store.readJson('openings.json', []);

  const batch = store.nextId('imp');
  const toAdd = [];
  const toAddOpening = [];
  const unitsCreated = [];
  const warnings = [];
  const errors = [];
  let dupSkipped = 0;
  let subtotalSkipped = 0;
  let skippedByUser = 0;
  let openingFound = 0;
  let occMap = new Map();

  const unitCache = new Map();
  const resolveUnit = (nameRaw, fallbackId, defaultType) => {
    if (!nameRaw && fallbackId) {
      const u = sync.find((x) => x.id === fallbackId) || units.get(fallbackId);
      return u || null;
    }
    if (!nameRaw) return null;
    const key = units.normalizeName(nameRaw);
    if (unitCache.has(key)) return unitCache.get(key);
    let hit = sync.find((x) => units.normalizeName(x.name) === key);
    if (!hit) hit = sync.find((x) => (x.alias || []).some((a) => units.normalizeName(a) === key));
    if (hit) {
      unitCache.set(key, hit);
      return hit;
    }
    const created = units.ensureByName(nameRaw, defaultType);
    if (created.created) {
      unitsCreated.push({ id: created.unit.id, name: created.unit.name });
      sync.push(created.unit);
    }
    unitCache.set(key, created.unit);
    return created.unit;
  };

  for (const plan of input.plans || []) {
    if (plan.include === false) continue;
    const sheet = loaded.sheets.find((s) => s.name === plan.sheetName);
    if (!sheet) {
      errors.push('找不到工作表：' + plan.sheetName);
      continue;
    }
    const headerRow = plan.headerRow === undefined || plan.headerRow === null ? -1 : Number(plan.headerRow) - 1;
    const mapping = plan.mapping || {};
    const account = plan.account || '';
    const start = headerRow >= 0 ? headerRow + 1 : 0;
    const defaultType = plan.direction === 'payable' ? 'supplier' : 'customer';

    for (let i = start; i < sheet.rows.length; i++) {
      const r = parseRow(sheet.rows[i], mapping, { account, cfg, direction: plan.direction });
      if (r.kind === SUBTOTAL_KINDS.BLANK || r.kind === SUBTOTAL_KINDS.JUNK) continue;
      if (r.kind === SUBTOTAL_KINDS.SUBTOTAL) {
        subtotalSkipped++;
        continue;
      }
      const unitRow = mapping.unitName !== undefined ? cellToText(sheet.rows[i][mapping.unitName]) : '';
      const unit = resolveUnit(unitRow, plan.unitId, defaultType);
      if (!unit) {
        errors.push('第 ' + (i + 1) + ' 行：无法确定往来单位（既没有单位名称列，也没有指定固定单位）');
        continue;
      }
      if (r.kind === SUBTOTAL_KINDS.OPENING) {
        const fen = pickOpeningFen(r, mapping, sheet.rows[i]);
        if (fen !== null) {
          openingFound++;
          toAddOpening.push({
            id: store.nextId('op'),
            unitId: unit.id,
            account,
            date: (r.opening && r.opening.date) || null,
            openingFen: fen,
            source: 'file',
            importBatch: batch,
            note: '导入自动识别：' + (r.opening ? r.opening.source : ''),
          });
        }
        continue;
      }
      if (!r.entry) continue;
      const ov = (plan.rowOverrides || {})[String(i + 1)];
      if (ov === 'skip') {
        skippedByUser++;
        continue;
      }
      if (ov === 'flip') {
        const t = r.entry.debitFen;
        r.entry.debitFen = r.entry.creditFen;
        r.entry.creditFen = t;
      }
      if (r.errors.length) {
        errors.push('第 ' + (i + 1) + ' 行：' + r.errors.join('；'));
      }
      // 科目列里写的是往来科目时，按行取科目 → 同一单位自动拆成应收/应付两个科目
      const rowSubject = mapping.subject !== undefined ? cellToText(sheet.rows[i][mapping.subject]) : '';
      const rowAccount = pickAccount(account, rowSubject);
      const fpBase = [unit.id, r.entry.date || '', r.entry.debitFen, r.entry.creditFen, r.entry.summary, rowAccount].join('|');
      const occ = (occMap.get(fpBase) || 0) + 1;
      occMap.set(fpBase, occ);
      const fingerprint = sha1(fpBase + '#' + occ).slice(0, 20);
      if (!input.force && existingFp.has(fingerprint)) {
        dupSkipped++;
        continue;
      }
      toAdd.push({
        id: store.nextId('e'),
        unitId: unit.id,
        account: rowAccount,
        date: r.entry.date,
        summary: r.entry.summary,
        debitFen: r.entry.debitFen,
        creditFen: r.entry.creditFen,
        balanceFen: r.entry.balanceFen,
        subject: r.entry.subject,
        voucherNo: r.entry.voucherNo,
        direction: r.entry.direction,
        sheetName: sheet.name,
        importBatch: batch,
        sourceRow: i + 1,
        sourceFile: input.filename,
        fingerprint,
        occ,
      });
    }

    // 期初余额「列」：科目余额表每行一个单位，逐行取；同一单位在同一批次只记第一条
    if (mapping.openingBalance !== undefined) {
      const seen = new Set();
      for (let i = start; i < sheet.rows.length; i++) {
        const v = money.parseToFen(sheet.rows[i][mapping.openingBalance]);
        if (!v.ok || v.fen === 0) continue;
        const unitRow = mapping.unitName !== undefined ? cellToText(sheet.rows[i][mapping.unitName]) : '';
        const unit = resolveUnit(unitRow, plan.unitId, defaultType);
        if (!unit) continue;
        const key = unit.id + '|' + account;
        if (seen.has(key)) continue;
        seen.add(key);
        toAddOpening.push({
          id: store.nextId('op'),
          unitId: unit.id,
          account,
          date: null,
          openingFen: v.fen,
          source: 'file',
          importBatch: batch,
          note: '导入自动识别：期初余额列（第 ' + (i + 1) + ' 行）',
        });
        openingFound++;
      }
    }
  }

  if (input.dryRun) {
    return {
      dryRun: true,
      batch,
      fileHash,
      wouldAdd: toAdd.length,
      wouldAddOpening: toAddOpening.length,
      dupSkipped,
      subtotalSkipped,
      unitsCreated,
      errors,
      warnings,
    };
  }

  store.backup('导入前');
  store.writeJson('ledgers.json', ledgerFile.concat(toAdd));
  store.writeJson('openings.json', openingFile.concat(toAddOpening));

  // 原件留档：{importBatch}/{原始文件名}
  try {
    const dir = path.join(store.DATA, 'imports', batch);
    require('fs').mkdirSync(dir, { recursive: true });
    const safe = String(input.filename || 'file').replace(/[\\/:*?"<>|]/g, '_');
    require('fs').writeFileSync(path.join(dir, safe), input.buffer);
  } catch (e) {
    warnings.push('原件留档失败：' + e.message);
  }

  store.log(
    '[OK] 导入批次 ' + batch + '：新增明细 ' + toAdd.length + ' 条，期初 ' + toAddOpening.length +
      ' 条，跳过重复 ' + dupSkipped + ' 条，小计行 ' + subtotalSkipped + ' 行，人工剔除 ' + skippedByUser + ' 行'
  );

  return {
    batch,
    fileHash,
    added: toAdd.length,
    addedOpening: toAddOpening.length,
    dupSkipped,
    subtotalSkipped,
    skippedByUser,
    openingFound,
    unitsCreated,
    unitIds: Array.from(new Set(toAdd.map((e) => e.unitId))),
    errors,
    warnings,
  };
}

function pickOpeningFen(r, mapping, row) {
  if (mapping.openingBalance !== undefined) {
    const v = money.parseToFen(row[mapping.openingBalance]);
    if (v.ok && v.fen !== 0) return v.fen;
  }
  if (r.opening && r.opening.fen !== null && r.opening.fen !== 0) return r.opening.fen;
  if (mapping.balance !== undefined) {
    const v = money.parseToFen(row[mapping.balance]);
    if (v.ok && v.fen !== 0) return v.fen;
  }
  return null;
}

module.exports = {
  SUBTOTAL_KINDS,
  accountSide,
  pickAccount,
  loadWorkbook,
  decodeText,
  analyze,
  analyzeSheet,
  commit,
  parseRow,
  classifyRow,
  cellToText,
  sha1,
};
