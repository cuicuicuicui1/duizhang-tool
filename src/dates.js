'use strict';
/*
 * dates.js — 日期归一（纯函数）
 * 财务软件导出的日期格式五花八门，统一归一为 ISO 'YYYY-MM-DD'。
 */

const FULL_DIGIT = /[\uFF10-\uFF19]/g;

function norm(s) {
  return String(s)
    .replace(FULL_DIGIT, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u00A0\u3000]/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + pad2(m) + '-' + pad2(d);
}

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

/** Excel 序列数 → ISO */
function fromSerial(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n < 1 || n > 2958465) return null;
  const days = Math.floor(n);
  const ms = EXCEL_EPOCH_UTC + days * 86400000;
  const dt = new Date(ms);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/**
 * 任意输入 → 'YYYY-MM-DD' | null
 * 支持：Date 对象 / Excel 序列数 / 2026-08-31 / 2026/8/31 / 2026.8.31 /
 *       2026年8月31日 / 20260831 / 26-8-31 / 2026-08（取 1 日）
 */
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const asStr = String(Math.trunc(v));
    if (/^(19|20)\d{6}$/.test(asStr)) {
      const r = parseDate(asStr);
      if (r) return r;
    }
    return fromSerial(v);
  }

  const s = norm(v);
  if (!s) return null;
  if (/^(19|20)\d{6}$/.test(s)) {
    const y = Number(s.slice(0, 4));
    const m = Number(s.slice(4, 6));
    const d = Number(s.slice(6, 8));
    return ymd(y, m, d);
  }
  let m = s.match(/^(\d{4})[年.\-/](\d{1,2})[月.\-/](\d{1,2})日?$/);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{4})[年.\-/](\d{1,2})月?$/);
  if (m) return ymd(Number(m[1]), Number(m[2]), 1);
  m = s.match(/^(\d{2})[年.\-/](\d{1,2})[月.\-/](\d{1,2})日?$/);
  if (m) return ymd(2000 + Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{4})$/);
  if (m) return ymd(Number(m[1]), 1, 1);
  return null;
}

function isValidIso(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !!ymd(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10));
}

/** 日期比较：'2026-08-31' <= '2026-08-31' */
function lte(a, b) {
  if (!a || !b) return false;
  return a <= b;
}

function monthOf(iso) {
  return iso && iso.length >= 7 ? iso.slice(0, 7) : '';
}

function lastDayOfMonth(ym) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return ym + '-' + pad2(new Date(Date.UTC(y, m, 0)).getUTCDate());
}

function toUTC(iso) {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

function addDays(iso, n) {
  const dt = new Date(toUTC(iso) + n * 86400000);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

module.exports = { parseDate, isValidIso, monthOf, lastDayOfMonth, daysBetween, addDays, fromSerial, ymd };
