'use strict';
/*
 * replyAdapter.js — 回函导入适配器（对方回函格式我们控制不了，所以这里做四层降级）
 *
 * 第 1 层 自动识别：复用 columns.js 别名字典 + 表头行探测
 * 第 2 层 格式记忆：把「这家单位回函长什么样」存成映射方案（data/replyMaps.json），
 *                  下次同一单位回函自动套用，不用再点一遍
 * 第 3 层 手工映射：极简模式——只指定「哪列是金额」也能跑；表头认不出就手工点表头行与列
 * 第 4 层 粘贴模式：会计从任意表格里复制几行直接粘进来，自动嗅探分隔符（Tab / 逗号 / 分号 / 多空格）
 *         兜底：只剩一个余额 → 只录余额，走「仅余额」勾对路径，报告标 MANUAL_REVIEW
 *
 * 另：别名字典本身在「设置」页可增删（对方习惯写「发生额」「往来款」就加进去），
 *     映射方案还能导出成 *.map.json 在会计之间共享。
 */

const path = require('path');
const store = require('./store');
const money = require('./money');
const dates = require('./dates');
const columns = require('./columns');
const importer = require('./importer');

const STD_KEYS = ['date', 'summary', 'debit', 'credit', 'amount', 'direction', 'balance', 'unitName', 'voucherNo', 'subject'];

function allMaps() {
  return store.readJson('replyMaps.json', []);
}

function listMaps(filter) {
  const f = filter || {};
  let list = allMaps();
  if (f.unitId) list = list.filter((m) => m.unitId === f.unitId);
  return list;
}

function signatureOf(headers) {
  return (headers || []).map((h) => columns.normalizeHeader(h)).filter(Boolean).join('|');
}

/** 保存映射方案（同单位同签名覆盖旧的） */
function saveMap(input) {
  const list = allMaps();
  const sig = input.signature || signatureOf(input.headers);
  const i = list.findIndex((m) => m.unitId === input.unitId && m.signature === sig);
  const rec = {
    id: i >= 0 ? list[i].id : store.nextId('rm'),
    unitId: input.unitId,
    name: input.name || '未命名方案',
    signature: sig,
    headers: input.headers || [],
    headerRowNo: input.headerRowNo || 1,
    mapping: input.mapping || {},
    source: input.source || 'manual',
    usedCount: i >= 0 ? list[i].usedCount || 0 : 0,
    createdAt: i >= 0 ? list[i].createdAt : store.isoNow(),
    updatedAt: store.isoNow(),
  };
  if (i >= 0) list[i] = rec;
  else list.push(rec);
  store.writeJson('replyMaps.json', list);
  return rec;
}

function removeMap(id) {
  const list = allMaps();
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) throw new Error('方案不存在');
  store.writeJson('replyMaps.json', next);
  return { ok: true, removed: 1 };
}

function touchMap(id) {
  const list = allMaps();
  const i = list.findIndex((m) => m.id === id);
  if (i >= 0) {
    list[i].usedCount = (list[i].usedCount || 0) + 1;
    list[i].lastUsedAt = store.isoNow();
    store.writeJson('replyMaps.json', list);
  }
}

/** 找该单位的记忆方案：签名完全命中优先，其次该单位唯一方案 */
function findMap(unitId, signature) {
  const mine = listMaps({ unitId });
  if (!mine.length) return null;
  if (signature) {
    const exact = mine.find((m) => m.signature === signature);
    if (exact) return exact;
  }
  return mine.length === 1 ? mine[0] : null;
}

function exportMaps() {
  return { tool: 'duizhang', kind: 'replyMaps', version: 1, exportedAt: store.isoNow(), maps: allMaps() };
}

function importMaps(payload) {
  if (!payload || !Array.isArray(payload.maps)) throw new Error('文件格式不对：缺少 maps 数组');
  const list = allMaps();
  let added = 0;
  let updated = 0;
  for (const m of payload.maps) {
    const i = list.findIndex((x) => x.unitId === m.unitId && x.signature === m.signature);
    if (i >= 0) {
      list[i] = Object.assign({}, list[i], m, { id: list[i].id, updatedAt: store.isoNow() });
      updated++;
    } else {
      list.push(Object.assign({ id: store.nextId('rm'), createdAt: store.isoNow() }, m));
      added++;
    }
  }
  store.writeJson('replyMaps.json', list);
  return { added, updated };
}

// ---------------------------------------------------------------- 粘贴解析
function sniffDelimiter(line) {
  const tabs = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  const semis = (line.match(/;/g) || []).length;
  const pipes = (line.match(/\|/g) || []).length;
  const multiSpace = (line.match(/ {2,}/g) || []).length;
  const best = Math.max(tabs, commas, semis, pipes, multiSpace);
  if (best === 0) return null;
  if (tabs === best) return '\t';
  if (commas === best) return ',';
  if (semis === best) return ';';
  if (pipes === best) return '|';
  return / {2,}/;
}

/** 多行文本 → 二维数组（自动嗅探分隔符） */
function parsePasted(text) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\u00A0|\u3000/g, ' ').trim())
    .filter((l) => l !== '');
  if (!lines.length) return { rows: [], delimiter: null, warnings: ['粘贴内容为空'] };
  const delim = sniffDelimiter(lines[0]);
  const rows = lines.map((l) => {
    if (delim === null) return [l];
    if (typeof delim === 'string') return l.split(delim).map((c) => c.trim());
    return l.split(/ {2,}/).map((c) => c.trim());
  });
  return { rows, delimiter: delim === null ? '无分隔符（单列）' : String(delim), warnings: [] };
}

/** 粘贴内容 → 分录（先自动找表头，找不到按「日期 摘要 金额」位置猜） */
function entriesFromPaste(text, opts) {
  const o = opts || {};
  const cfg = o.config || require('./config').getConfig();
  const parsed = parsePasted(text);
  const rows = parsed.rows;
  if (!rows.length) return { entries: [], warnings: ['没有可解析的行'], rows: [] };
  const aliasIndex = columns.buildAliasIndex(cfg.aliases);
  const det = columns.detectHeaderRow(rows, aliasIndex, 3);
  if (det.rowIndex >= 0) {
    return Object.assign(parseRowsWithMapping(rows, det.rowIndex, det.mapping, o), {
      rows,
      headerRowNo: det.rowIndex + 1,
      mapping: det.mapping,
      delimiter: parsed.delimiter,
      source: 'paste+header',
    });
  }
  // 无表头：按内容特征猜列
  const guessed = guessColumnsByContent(rows);
  return Object.assign(parseRowsWithMapping(rows, -1, guessed.mapping, o), {
    rows,
    headerRowNo: -1,
    mapping: guessed.mapping,
    guessed: true,
    delimiter: parsed.delimiter,
    source: 'paste+guess',
    warnings: (guessed.warnings || []).concat([]),
  });
}

/** 无表头时按列内容特征猜：日期列 / 文本列 / 数字列 / 方向列 */
function guessColumnsByContent(rows) {
  const warnings = [];
  const width = Math.max.apply(null, rows.map((r) => r.length));
  const cols = [];
  for (let c = 0; c < width; c++) {
    let dateHit = 0;
    let numHit = 0;
    let dirHit = 0;
    let textHit = 0;
    let total = 0;
    for (const r of rows) {
      const v = r[c];
      if (v === undefined || v === '') continue;
      total++;
      if (dates.parseDate(v)) dateHit++;
      else if (/^(借|贷|借方|贷方)$/.test(String(v).trim())) dirHit++;
      else if (money.parseToFen(v).ok) numHit++;
      else textHit++;
    }
    cols.push({ c, dateHit, numHit, dirHit, textHit, total });
  }
  const mapping = {};
  const dateCol = cols.filter((x) => x.dateHit > 0).sort((a, b) => b.dateHit - a.dateHit)[0];
  if (dateCol) mapping.date = dateCol.c;
  const dirCol = cols.filter((x) => x.dirHit > 0).sort((a, b) => b.dirHit - a.dirHit)[0];
  if (dirCol) mapping.direction = dirCol.c;
  const numCols = cols.filter((x) => x.numHit > 0 && x.c !== (dateCol && dateCol.c)).sort((a, b) => a.c - b.c);
  if (numCols.length === 1) {
    mapping.amount = numCols[0].c;
    warnings.push('只有一列数字，已按「金额」处理（正负号决定方向）');
  } else if (numCols.length >= 2) {
    mapping.debit = numCols[0].c;
    mapping.credit = numCols[1].c;
    warnings.push('识别到两列数字，已按「借方金额 / 贷方金额」处理，请核对');
  }
  const textCol = cols.filter((x) => x.textHit > 0 && x.c !== (dateCol && dateCol.c)).sort((a, b) => b.textHit - a.textHit)[0];
  if (textCol) mapping.summary = textCol.c;
  return { mapping, warnings };
}

/** 用给定 mapping 解析行 → 分录 */
function parseRowsWithMapping(rows, headerRow, mapping, opts) {
  const o = opts || {};
  const warnings = [];
  const entries = [];
  const start = headerRow >= 0 ? headerRow + 1 : 0;
  let balanceFen = null;
  let skipped = 0;

  const flip = !!o.signFlip;
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (columns.rowIsBlank(row)) continue;
    const texts = [];
    for (let ci = 0; ci < Math.min(row.length, 2); ci++) if (row[ci] !== '' && row[ci] !== undefined) texts.push(String(row[ci]));
    if (texts.some((t) => columns.isSubtotalText(t))) {
      skipped++;
      continue;
    }
    const dateIso = mapping.date !== undefined ? dates.parseDate(row[mapping.date]) : null;
    let debitFen = 0;
    let creditFen = 0;
    const hasDR = mapping.debit !== undefined || mapping.credit !== undefined;
    if (hasDR) {
      if (mapping.debit !== undefined) debitFen = money.parseToFen(row[mapping.debit]).fen || 0;
      if (mapping.credit !== undefined) creditFen = money.parseToFen(row[mapping.credit]).fen || 0;
      if (debitFen < 0 && creditFen === 0) {
        creditFen = Math.abs(debitFen);
        debitFen = 0;
      }
      if (creditFen < 0 && debitFen === 0) {
        debitFen = Math.abs(creditFen);
        creditFen = 0;
      }
    } else if (mapping.amount !== undefined) {
      const amt = money.parseToFen(row[mapping.amount]).fen || 0;
      let dir = '';
      if (mapping.direction !== undefined) {
        const raw = String(row[mapping.direction] || '');
        if (/借/.test(raw)) dir = 'debit';
        else if (/贷/.test(raw)) dir = 'credit';
      }
      if (dir === 'debit' || (!dir && amt >= 0)) debitFen = Math.abs(amt);
      else creditFen = Math.abs(amt);
    }
    if (mapping.balance !== undefined) {
      const b = money.parseToFen(row[mapping.balance]);
      if (b.ok && b.fen !== 0) balanceFen = b.fen;
    }
    if (flip) {
      const t = debitFen;
      debitFen = creditFen;
      creditFen = t;
    }
    if (!dateIso && !debitFen && !creditFen) continue;
    entries.push({
      date: dateIso,
      summary: mapping.summary !== undefined ? money.normalizeText(row[mapping.summary]) : '',
      debitFen,
      creditFen,
      sourceRow: i + 1,
    });
  }
  if (!mapping.date) warnings.push('未识别到日期列，回函明细将没有日期，时间性差异无法判断');
  if (skipped) warnings.push('已剔除 ' + skipped + ' 行小计/合计行');
  return { entries, balanceFen, warnings, headerRowNo: headerRow < 0 ? -1 : headerRow + 1, mapping, skipped };
}

/** 回函文件分析（第 1、2 层） */
function analyzeReplyFile(input) {
  const cfg = input.config || require('./config').getConfig();
  const loaded = importer.loadWorkbook(input.buffer, input.filename);
  const aliasIndex = columns.buildAliasIndex(cfg.aliases);
  const sheets = loaded.sheets.map((s) => {
    const det = columns.detectHeaderRow(s.rows, aliasIndex, 10);
    const headers = det.rowIndex >= 0 ? s.rows[det.rowIndex].map((c) => importer.cellToText(c)) : s.rows[0] ? s.rows[0].map((c) => importer.cellToText(c)) : [];
    const sig = signatureOf(headers);
    const saved = findMap(input.unitId, sig);
    const numbersOnly = headers.filter((h) => h !== '').length <= 1;
    return {
      name: s.name,
      headers,
      signature: sig,
      headerRowNo: det.rowIndex < 0 ? -1 : det.rowIndex + 1,
      autoMapping: det.mapping,
      autoHits: det.hits,
      savedMap: saved ? { id: saved.id, name: saved.name, headerRowNo: saved.headerRowNo, mapping: saved.mapping, usedCount: saved.usedCount } : null,
      effectiveHeaderRowNo: saved ? saved.headerRowNo : det.rowIndex < 0 ? -1 : det.rowIndex + 1,
      effectiveMapping: saved ? saved.mapping : det.mapping,
      mappingSource: saved ? '记忆方案：' + saved.name : det.rowIndex >= 0 ? '自动识别' : '未识别',
      rowCount: s.rows.length,
      singleValue: numbersOnly,
      preview: s.rows.slice(0, 12).map((r) => r.map((c) => importer.cellToText(c))),
    };
  });
  return {
    fileKind: loaded.kind,
    encoding: loaded.encoding,
    filename: input.filename,
    sheets,
    unitId: input.unitId || '',
    maps: listMaps({ unitId: input.unitId }).map((m) => ({ id: m.id, name: m.name, usedCount: m.usedCount, signature: m.signature })),
    stdKeys: STD_KEYS,
    stdKeyLabel: columns.KEY_LABEL,
  };
}

/** 回函文件 → 分录（第 3 层手工映射也走这里） */
function parseReplySheet(input) {
  const cfg = input.config || require('./config').getConfig();
  const loaded = importer.loadWorkbook(input.buffer, input.filename);
  const sheet = loaded.sheets.find((s) => s.name === input.sheetName) || loaded.sheets[0];
  let mapping = input.mapping;
  let headerRow = input.headerRowNo === undefined || input.headerRowNo === null ? -1 : Number(input.headerRowNo);
  if (!mapping) {
    const aliasIndex = columns.buildAliasIndex(cfg.aliases);
    const det = columns.detectHeaderRow(sheet.rows, aliasIndex, 10);
    mapping = det.mapping;
    headerRow = det.rowIndex + 1;
  }
  if (input.directionHint === 'payableAccount') {
    // 对方用他们自己的应付账套导出：借贷方向与我们相反
    input = Object.assign({}, input, { signFlip: true });
  }
  const r = parseRowsWithMapping(sheet.rows, headerRow - 1, mapping, {
    signFlip: input.signFlip,
    config: cfg,
  });
  return Object.assign(r, {
    sheetName: sheet.name,
    unitId: input.unitId,
    theirBalanceFen: r.balanceFen,
  });
}

/** 保存当前回函格式为该单位的记忆方案 */
function rememberFormat(input) {
  return saveMap({
    unitId: input.unitId,
    name: input.name || '回函格式',
    headers: input.headers,
    signature: input.signature || signatureOf(input.headers),
    headerRowNo: input.headerRowNo,
    mapping: input.mapping,
    source: input.source || 'manual',
  });
}

module.exports = {
  STD_KEYS,
  allMaps,
  listMaps,
  saveMap,
  removeMap,
  touchMap,
  findMap,
  exportMaps,
  importMaps,
  signatureOf,
  parsePasted,
  entriesFromPaste,
  guessColumnsByContent,
  parseRowsWithMapping,
  analyzeReplyFile,
  parseReplySheet,
  rememberFormat,
};
