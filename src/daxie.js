'use strict';
/*
 * daxie.js — 人民币大写转换（纯函数）
 * 金额输入单位为「分」（整数）。
 * 负数视为非法（对账函上的余额一律先按方向口径折算为非负数）。
 */

const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const UNIT4 = ['', '拾', '佰', '仟'];
const SEC_UNIT = ['', '万', '亿', '万亿'];

/** 4 位以内整数节的读法 */
function sectionToUpper(sec) {
  let out = '';
  const len = sec.length;
  let zeroFlag = false;
  for (let i = 0; i < len; i++) {
    const d = Number(sec[i]);
    const u = UNIT4[len - 1 - i];
    if (d === 0) {
      zeroFlag = true;
    } else {
      if (zeroFlag && out) out += DIGITS[0];
      zeroFlag = false;
      out += DIGITS[d] + u;
    }
  }
  return out;
}

/** 整数部分（元）→ 大写，不含「元」字 */
function intToUpper(intStr) {
  let s = String(intStr).replace(/^0+/, '');
  if (s === '') return '';
  const secs = [];
  while (s.length > 0) {
    secs.unshift(s.slice(-4));
    s = s.slice(0, -4);
  }
  const n = secs.length;
  let out = '';
  for (let i = 0; i < n; i++) {
    const sec = secs[i];
    const secUnit = SEC_UNIT[n - 1 - i];
    const up = sectionToUpper(sec);
    if (up === '') {
      if (out && !out.endsWith(DIGITS[0])) out += DIGITS[0];
      continue;
    }
    if (out && Number(sec) < 1000 && !out.endsWith(DIGITS[0])) out += DIGITS[0];
    out += up + secUnit;
  }
  out = out.replace(/零+$/, '');
  return out;
}

/**
 * 分 → 人民币大写。
 * @param {number} fen 整数分，必须 >= 0
 * @param {{keepZeroYuan?:boolean}} [opts] keepZeroYuan=true 时，元位为零写「零元…」（银行票据习惯）
 * @throws {TypeError} 非整数分或负数
 */
function toDaxie(fen, opts) {
  const o = opts || {};
  const n = Number(fen);
  if (!Number.isInteger(n)) throw new TypeError('toDaxie: 金额必须是整数分，收到：' + fen);
  if (n < 0) throw new TypeError('toDaxie: 金额为负数，无法转换大写，请先按方向口径折算：' + fen);

  if (n === 0) return '零元整';

  const yuan = Math.floor(n / 100);
  const jiao = Math.floor((n % 100) / 10);
  const fenD = n % 10;

  const intUp = intToUpper(String(yuan));
  const needZeroYuan = o.keepZeroYuan === true;

  if (jiao === 0 && fenD === 0) {
    return (intUp || '零') + '元整';
  }
  // 元位为零且不保留「零元」：直接写角分（0.01 → 壹分；0.15 → 壹角伍分）
  if (!intUp && !needZeroYuan) {
    if (jiao === 0) return DIGITS[fenD] + '分';
    if (fenD === 0) return DIGITS[jiao] + '角整';
    return DIGITS[jiao] + '角' + DIGITS[fenD] + '分';
  }
  const head = intUp || '零';
  if (jiao === 0) return head + '元零' + DIGITS[fenD] + '分';
  if (fenD === 0) return head + '元' + DIGITS[jiao] + '角整';
  return head + '元' + DIGITS[jiao] + '角' + DIGITS[fenD] + '分';
}

/** 安全版：不抛异常，返回 {ok, text, err} */
function toDaxieSafe(fen, opts) {
  try {
    return { ok: true, text: toDaxie(fen, opts) };
  } catch (e) {
    return { ok: false, text: '', err: e.message };
  }
}

module.exports = { toDaxie, toDaxieSafe, intToUpper, sectionToUpper, DIGITS };
