'use strict';
/*
 * money.js — 金额红线模块（纯函数，零副作用）
 * 红线：金额全程用「分」（整数），中间禁止任何浮点运算。
 * 所有金额的解析入口在这里，展示出口也在这里。
 *
 * MANUAL_REVIEW: 「万元 / 千元」单位不做自动换算（静默 10000 倍错误代价过高），
 *                命中即返回 ok:false，交由导入向导高亮提示人工处理。
 */

const DIGIT_FULL = /[\uFF10-\uFF19]/g;
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const NBSP = /[\u00A0\u3000\u2007\u202F\u2009\u2002]/g;

// 视为「空/无值」→ 计 0 且不报错
const EMPTY_TOKENS = new Set(['', '-', '--', '---', '—', '－', '/', '\\', '无', '空', '不适用']);
// 视为「数据坏了」→ 计 0 但必须报错，交导入向导高亮给人工处理（静默当 0 会算错余额）
const ERROR_TOKENS = new Set([
  'nan', 'inf', 'infinity', '-inf', '+inf', 'null', 'undefined', 'nil',
  '#n/a', 'n/a', 'na', '#value!', '#div/0!', '#ref!', '#name?', '#null!', '#num!', '#error!',
]);

/** 全角/不可见字符归一，返回去空白后的字符串 */
function normalizeText(input) {
  if (input === null || input === undefined) return '';
  let s = typeof input === 'string' ? input : String(input);
  s = s.replace(DIGIT_FULL, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s
    .replace(/\uFF0C/g, ',')
    .replace(/\uFF0E/g, '.')
    .replace(/\uFF08/g, '(')
    .replace(/\uFF09/g, ')')
    .replace(/\uFF0D/g, '-')
    .replace(/\uFF0B/g, '+')
    .replace(/\uFF1A/g, ':')
    .replace(/\u2212/g, '-')
    .replace(/\u2013|\u2014/g, '-');
  s = s.replace(NBSP, ' ').replace(ZERO_WIDTH, '');
  s = s.replace(/[\r\n\t]/g, ' ');
  return s.trim();
}

/** 数值型输入转十进制字符串（处理科学计数法），避免浮点进入金额链路 */
function numberToDecimalString(n) {
  if (!Number.isFinite(n)) return null;
  if (Number.isInteger(n)) return String(n);
  // 科学计数法：用 toFixed 展开足够位数后再裁掉尾零
  const exp = String(n);
  if (exp.includes('e') || exp.includes('E')) {
    const m = n.toFixed(20);
    return m.replace(/0+$/, '').replace(/\.$/, '');
  }
  return exp;
}

/**
 * 字符串 → 分。
 * @returns {{fen:number, ok:boolean, empty?:boolean, err?:string, warn?:string}}
 * 支持：千分位 1,234.56 / 括号负数 (1,234.56) / 前导负号 / 全角 / 货币符号 /
 *       文本型数字 / -- 与空单元格（视为 0）/ 元 与 人民币 后缀
 */
function parseToFen(input) {
  if (input === null || input === undefined) return { fen: 0, ok: true, empty: true };
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { fen: 0, ok: false, err: '非法数字：' + String(input) };
    const dec = numberToDecimalString(input);
    if (dec === null) return { fen: 0, ok: false, err: '非法数字' };
    return decimalStringToFen(dec, 'number');
  }

  let s = normalizeText(input);
  if (s === '') return { fen: 0, ok: true, empty: true };

  const lower = s.toLowerCase();
  if (EMPTY_TOKENS.has(lower)) return { fen: 0, ok: true, empty: true };
  if (ERROR_TOKENS.has(lower)) return { fen: 0, ok: false, err: '单元格是错误值/非法值，已按 0 处理但需要人工核对：' + s };

  // 单位陷阱：万元/千元 不自动换算
  if (/万元|千元|百万元|亿元/.test(s)) {
    return { fen: 0, ok: false, err: '疑似以「万/千元」为单位，本工具不自动换算，请先换算为元后重导：' + s };
  }

  // 去掉货币符号/单位后缀/中文噪音
  s = s.replace(/[¥￥$€£]/g, '');
  s = s.replace(/人民币|rmb|cny/gi, '');
  s = s.replace(/元整?$/,'').replace(/元$/,'');
  // 「借」「贷」等方向字混入单元格时的兜底
  s = s.replace(/^(借方|贷方|借|贷)\s*/,'');
  s = s.replace(/\s+/g, '');
  if (s === '') return { fen: 0, ok: true, empty: true };

  // 括号负数
  let neg = false;
  const para = s.match(/^\((.*)\)$/);
  if (para) {
    neg = true;
    s = para[1];
  }
  // 尾随负号（部分财务软件 "1234.56-"）
  if (/-$/.test(s)) {
    neg = !neg;
    s = s.replace(/-+$/, '');
  }
  // 前导正负号
  while (/^[+-]/.test(s)) {
    if (s[0] === '-') neg = !neg;
    s = s.slice(1);
  }
  // 千分位
  s = s.replace(/,/g, '');
  if (s === '') return { fen: 0, ok: true, empty: true };
  // 允许科学计数法（部分系统导出的 CSV 会写成 9.9999999999999E+13）
  if (!/^\d+(\.\d*)?$|^\.\d+$|^\d+(\.\d+)?[eE][+-]?\d+$/.test(s)) {
    return { fen: 0, ok: false, err: '无法识别为金额：' + normalizeText(input) };
  }

  const res = decimalStringToFen(s, 'text');
  if (!res.ok) return res;
  res.fen = neg ? -res.fen : res.fen;
  return res;
}

/** 纯十进制字符串 → 分，字符串层面做四舍五入，绝不经过浮点 */
function decimalStringToFen(dec, source) {
  let s = String(dec).trim();
  if (s.startsWith('+')) s = s.slice(1);
  let neg = false;
  if (s.startsWith('-')) {
    neg = true;
    s = s.slice(1);
  }
  if (s.includes('e') || s.includes('E')) {
    const n = Number(s);
    if (!Number.isFinite(n)) return { fen: 0, ok: false, err: '非法数字：' + dec };
    const expanded = numberToDecimalString(n * (neg ? -1 : 1));
    if (expanded === null) return { fen: 0, ok: false, err: '非法数字：' + dec };
    return decimalStringToFen(expanded, source);
  }
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') {
    return { fen: 0, ok: false, err: '非法数字：' + dec };
  }
  const parts = s.split('.');
  const intPart = parts[0] || '0';
  let frac = (parts[1] || '').padEnd(3, '0');
  const intFen = Number(intPart) * 100;
  if (!Number.isSafeInteger(intFen)) {
    return { fen: 0, ok: false, err: '金额超出安全范围：' + dec };
  }
  const two = Number(frac.slice(0, 2));
  const third = Number(frac[2]);
  let fen = intFen + two;
  let warn;
  if (third >= 5) {
    fen += 1;
    warn = '原值超过 2 位小数，已四舍五入到分：' + dec;
  } else if (parts[1] && parts[1].length > 2) {
    warn = '原值超过 2 位小数，已截断到分：' + dec;
  }
  if (neg) fen = -fen;
  if (source === 'number') return { fen, ok: true, warn };
  return { fen, ok: true, warn };
}

/** 分 → "1,234.56"（默认带千分位） */
function fenToStr(fen, opts) {
  const o = opts || {};
  const n = Number(fen);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return '0.00';
  }
  const neg = n < 0;
  const abs = Math.abs(n);
  const yuan = Math.floor(abs / 100);
  const cent = abs % 100;
  let intStr = String(yuan);
  if (o.thousand !== false) intStr = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = intStr + '.' + String(cent).padStart(2, '0');
  if (!neg) return body;
  return o.paren ? '(' + body + ')' : '-' + body;
}

/** 分 → "1234.56"（不带千分位，导入/接口用） */
function fenToPlain(fen) {
  const s = fenToStr(fen, { thousand: false });
  return s.replace(/[()]/g, '');
}

/** 分 → "1234.56" 带符号，用于 Excel 数值列 */
function fenToNumber(fen) {
  return Number(fenToPlain(fen));
}

/** 求和（整数加法，逐项校验） */
function sumFen(list) {
  let t = 0;
  for (const v of list || []) {
    const n = Number(v) || 0;
    if (!Number.isInteger(n)) throw new TypeError('sumFen: 非整数分：' + v);
    t += n;
  }
  return t;
}

function subFen(a, b) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new TypeError('subFen: 非整数分');
  return x - y;
}

function absFen(a) {
  return Math.abs(Number(a) || 0);
}

function negFen(a) {
  return -Number(a || 0);
}

/** 分 → 元（字符串），用于需要小数的展示（保留 2 位） */
function fenToYuanText(fen) {
  return fenToStr(fen, { thousand: false });
}

module.exports = {
  parseToFen,
  fenToStr,
  fenToPlain,
  fenToNumber,
  fenToYuanText,
  sumFen,
  subFen,
  absFen,
  negFen,
  normalizeText,
  numberToDecimalString,
};
