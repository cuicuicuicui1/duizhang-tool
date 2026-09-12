'use strict';
/*
 * columns.js — 智能列识别（表头行探测 + 别名字典映射）
 * 别名字典来自 config.aliases，可在「设置」页增删；设置页改完立即生效。
 *
 * MANUAL_REVIEW: 表头命中数不足 2 时不做任何猜测，返回 rowIndex=-1，
 *                由导入向导让会计手工点选表头行与列映射 —— 猜错比不猜更贵。
 */

const FULL_DIGIT = /[\uFF10-\uFF19]/g;

const KEY_ORDER = [
  'openingBalance',
  'balance',
  'unitName',
  'date',
  'summary',
  'debit',
  'credit',
  'direction',
  'amount',
  'subject',
  'voucherNo',
  'seq',
];

const KEY_LABEL = {
  unitName: '单位名称',
  date: '日期',
  summary: '摘要',
  debit: '借方金额',
  credit: '贷方金额',
  amount: '金额',
  direction: '方向',
  balance: '余额',
  openingBalance: '期初余额',
  subject: '科目',
  voucherNo: '凭证号',
  seq: '序号',
};

function normalizeHeader(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(FULL_DIGIT, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[（(][^）)]*[）)]/g, '') // 去掉「（元）」「(本位币)」这类单位注释
    .replace(/[\u00A0\u3000\s]/g, '')
    .replace(/[\r\n\t]/g, '')
    .replace(/[:：*]/g, '')
    .toLowerCase()
    .trim();
}

/** 建立「归一化别名 → 标准列」索引 */
function buildAliasIndex(aliases) {
  const idx = new Map();
  for (const key of KEY_ORDER) {
    const list = (aliases && aliases[key]) || [];
    for (const a of list) {
      const n = normalizeHeader(a);
      if (!n) continue;
      // 先出现的（KEY_ORDER 靠前者 / 别名列表靠前者）优先
      if (!idx.has(n)) idx.set(n, key);
      else if (n.length > 0 && idx.get(n) !== key && KEY_ORDER.indexOf(key) < KEY_ORDER.indexOf(idx.get(n))) {
        idx.set(n, key);
      }
    }
  }
  return idx;
}

/** 单个表头 → 标准列 key | null */
function matchColumn(header, aliasIndex) {
  const n = normalizeHeader(header);
  if (!n) return null;
  if (aliasIndex.has(n)) return aliasIndex.get(n);
  // 包含匹配：取命中别名最长者（避免「金额」抢走「借方金额」）
  let best = null;
  let bestLen = 0;
  for (const [alias, key] of aliasIndex) {
    if (alias.length < 2) continue;
    if (n.includes(alias) || alias.includes(n)) {
      const score = alias.length * 100 + (KEY_ORDER.length - KEY_ORDER.indexOf(key));
      if (score > bestLen) {
        bestLen = score;
        best = key;
      }
    }
  }
  return best;
}

function rowIsBlank(row) {
  return !row || row.every((c) => c === '' || c === null || c === undefined);
}

function nonEmptyCount(row) {
  let n = 0;
  for (const c of row || []) if (c !== '' && c !== null && c !== undefined) n++;
  return n;
}

/**
 * 探测表头行。
 * @returns {{rowIndex:number, mapping:Object, hits:number, candidates:Array}}
 */
function detectHeaderRow(rows, aliasIndex, maxScan) {
  const limit = Math.min(maxScan === undefined ? 10 : maxScan, rows.length);
  const candidates = [];
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (rowIsBlank(row)) continue;
    if (nonEmptyCount(row) < 2) continue;
    const mapping = {};
    const used = new Set();
    for (let c = 0; c < row.length; c++) {
      const key = matchColumn(row[c], aliasIndex);
      if (!key) continue;
      if (used.has(key)) continue;
      used.add(key);
      mapping[key] = c;
    }
    const hits = Object.keys(mapping).length;
    candidates.push({ rowIndex: i, hits, mapping });
  }
  candidates.sort((a, b) => b.hits - a.hits || a.rowIndex - b.rowIndex);
  const best = candidates[0];
  if (!best || best.hits < 2) {
    return { rowIndex: -1, mapping: {}, hits: best ? best.hits : 0, candidates };
  }
  return { rowIndex: best.rowIndex, mapping: best.mapping, hits: best.hits, candidates };
}

/** 表头行 → 各标准列的表头原文（用于 UI 展示） */
function headerLabels(row, mapping) {
  const out = {};
  for (const k of Object.keys(mapping)) {
    out[k] = row[mapping[k]] === undefined || row[mapping[k]] === null ? '' : String(row[mapping[k]]);
  }
  return out;
}

/** 文件签名：表头行原文拼接，用于映射记忆 */
function headerSignature(row, mapping) {
  const keys = Object.keys(mapping).sort((a, b) => mapping[a] - mapping[b]);
  return keys.map((k) => normalizeHeader(row[mapping[k]] || '')).filter(Boolean).join('|');
}

const SUBTOTAL_RE = /^(小计|合计|总计|本期合计|本年累计|累计|本季合计|月度合计|合计：?)$/;

function isSubtotalText(t) {
  if (t === null || t === undefined) return false;
  const s = String(t).replace(/[\s\u00A0\u3000]/g, '').replace(/[:：]$/, '');
  if (!s) return false;
  return SUBTOTAL_RE.test(s);
}

const OPENING_RE = /(期初余额|年初余额|期初数|上期结转|上年结转|年初数|期初)/;

function isOpeningText(t) {
  if (t === null || t === undefined) return false;
  const s = String(t).replace(/[\s\u00A0\u3000]/g, '');
  if (!s) return false;
  return OPENING_RE.test(s);
}

module.exports = {
  KEY_ORDER,
  KEY_LABEL,
  normalizeHeader,
  buildAliasIndex,
  matchColumn,
  detectHeaderRow,
  headerLabels,
  headerSignature,
  isSubtotalText,
  isOpeningText,
  rowIsBlank,
  nonEmptyCount,
};
