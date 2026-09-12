'use strict';
/*
 * t1_money.js — 层 2「规则内核单测」：money.js / daxie.js
 * 不碰存储层、不碰网络。金额脏格式 + 人民币大写全覆盖。
 */

const H = require('./_harness');
const money = require('../../src/money');
const daxie = require('../../src/daxie');

const P = (s) => money.parseToFen(s);

// ---------------------------------------------------------------- 基础解析
H.section('金额解析 — 基础与脏格式');
H.check('整数', P('1234').fen, 123400);
H.check('两位小数', P('1234.56').fen, 123456);
H.check('千分位', P('1,234.56').fen, 123456);
H.check('千分位（无小数）', P('1,234,567').fen, 123456700);
H.check('全角数字千分位', P('１，２３４．５６').fen, 123456);
H.check('前导负号', P('-1234.56').fen, -123456);
H.check('括号负数', P('(1,234.56)').fen, -123456);
H.check('全角括号负数', P('（1,234.56）').fen, -123456);
H.check('尾随负号', P('1234.56-').fen, -123456);
H.check('加号前缀', P('+1234.56').fen, 123456);
H.check('货币符号', P('¥1,234.56').fen, 123456);
H.check('人民币字样', P('人民币1234.56元').fen, 123456);
H.check('元字后缀', P('1234.56元').fen, 123456);
H.check('不可见字符 NBSP', P('1\u00A0234.56').fen, 123456);
H.check('零宽字符', P('1234\u200B.56').fen, 123456);
H.check('前后空格', P('   1234.56   ').fen, 123456);
H.check('单元格换行', P('1,234\n.56').fen, 123456);
H.check('方向字混入', P('借方 1234.56').fen, 123456);
H.check('小于 1 元的小数', P('.56').fen, 56);
H.check('一位小数补齐', P('1234.5').fen, 123450);

H.section('金额解析 — 空值与占位符视为 0');
H.check('空字符串', P('').fen, 0);
H.check('空字符串 ok', P('').ok, true);
H.check('null', P(null).fen, 0);
H.check('undefined', P(undefined).fen, 0);
H.check('--', P('--').fen, 0);
H.check('单个短横', P('-').fen, 0);
H.check('破折号', P('—').fen, 0);
H.check('零值', P('0.00').fen, 0);
H.check('斜杠', P('/').fen, 0);
H.check('Excel 错误值', P('#DIV/0!').fen, 0);
H.check('空标记 empty', P('--').empty, true);

H.section('金额解析 — 数值型输入（Excel 直接把数字给到我们）');
H.check('整数 number', P(1234).fen, 123400);
H.check('小数 number', P(1234.56).fen, 123456);
H.check('负小数 number', P(-1234.56).fen, -123456);
H.check('NaN number', P(NaN).ok, false);
H.check('Infinity number', P(Infinity).ok, false);

H.section('金额解析 — 精度与四舍五入');
H.check('三位小数进位', P('0.005').fen, 1);
H.check('三位小数舍去', P('0.004').fen, 0);
H.check('三位小数带警告', !!P('0.005').warn, true);
H.check('大额整数', P('9,999,999,999.99').fen, 999999999999);
H.check('大额精度不丢', money.fenToStr(P('9,999,999,999.99').fen), '9,999,999,999.99');

H.section('金额解析 — 必须报错的情形');
H.check('万元不自动换算', P('1.5万元').ok, false);
H.check('万元报错信息含提示', /万元/.test(P('1.5万元').err || ''), true);
H.check('纯文字', P('合计').ok, false);
H.check('多小数点', P('1.2.3').ok, false);
H.check('货币代码错位', P('ABC123').ok, false);

// ---------------------------------------------------------------- 展示
H.section('金额展示 — fenToStr');
H.check('千分位', money.fenToStr(123456), '1,234.56');
H.check('小于千', money.fenToStr(5600), '56.00');
H.check('负数', money.fenToStr(-123456), '-1,234.56');
H.check('括号负数', money.fenToStr(-123456, { paren: true }), '(1,234.56)');
H.check('零', money.fenToStr(0), '0.00');
H.check('大额千分位', money.fenToStr(123456789000), '1,234,567,890.00');
H.check('无千分位', money.fenToStr(123456, { thousand: false }), '1234.56');
H.check('非整数兜底', money.fenToStr(1.5), '0.00');
H.check('NaN 兜底', money.fenToStr(NaN), '0.00');
H.check('fenToPlain', money.fenToPlain(-123456), '-1234.56');
H.check('fenToNumber', money.fenToNumber(123456), 1234.56);

H.section('金额运算 — 整数加法');
H.check('sumFen', money.sumFen([100, 200, -50]), 250);
H.check('sumFen 空数组', money.sumFen([]), 0);
H.check('sumFen null 元素', money.sumFen([100, null, 50]), 150);
H.throws('sumFen 拒绝浮点', () => money.sumFen([1.5]), /非整数/);
H.check('subFen', money.subFen(1000, 250), 750);
H.check('absFen', money.absFen(-700), 700);
H.check('negFen', money.negFen(700), -700);

// ---------------------------------------------------------------- 大写
H.section('人民币大写 — 计划指定用例');
H.check('0', daxie.toDaxie(0), '零元整');
H.check('100 元', daxie.toDaxie(10000), '壹佰元整');
H.check('1001 元', daxie.toDaxie(100100), '壹仟零壹元整');
H.check('10000 元', daxie.toDaxie(1000000), '壹万元整');
H.check('10010 元', daxie.toDaxie(1001000), '壹万零壹拾元整');
H.check('1 亿元', daxie.toDaxie(10000000000), '壹亿元整');
H.check('0.01 元', daxie.toDaxie(1), '壹分');
H.check('15000 元', daxie.toDaxie(1500000), '壹万伍仟元整');

H.section('人民币大写 — 角分与连续零');
H.check('0.15 元', daxie.toDaxie(15), '壹角伍分');
H.check('1.05 元', daxie.toDaxie(105), '壹元零伍分');
H.check('1.50 元', daxie.toDaxie(150), '壹元伍角整');
H.check('1.55 元', daxie.toDaxie(155), '壹元伍角伍分');
H.check('10.00 元', daxie.toDaxie(1000), '壹拾元整');
H.check('1000000 元', daxie.toDaxie(100000000), '壹佰万元整');
H.check('1010 元', daxie.toDaxie(101000), '壹仟零壹拾元整');
H.check('100010 元', daxie.toDaxie(10001000), '壹拾万零壹拾元整');
H.check('1 亿元零 1 分', daxie.toDaxie(10000000001), '壹亿元零壹分');
H.check('2.32 元', daxie.toDaxie(232), '贰元叁角贰分');
H.check('零元保留写法（0.01）', daxie.toDaxie(1, { keepZeroYuan: true }), '零元零壹分');
H.check('零元保留写法（0.15）', daxie.toDaxie(15, { keepZeroYuan: true }), '零元壹角伍分');
H.throws('负数必须报错', () => daxie.toDaxie(-100), /负数/);
H.throws('非整数分必须报错', () => daxie.toDaxie(1.5), /整数分/);
H.check('安全版返回 ok:false', daxie.toDaxieSafe(-1).ok, false);
H.check('安全版成功', daxie.toDaxieSafe(100).text, '壹元整');

// ---------------------------------------------------------------- 往返一致性
H.section('往返一致性 — 解析↔展示 1000 次随机');
let roundTripFail = 0;
let seed = 20260912;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
for (let i = 0; i < 1000; i++) {
  const fen = Math.floor(rnd() * 200000000) - 100000000;
  const s = money.fenToStr(fen);
  const back = money.parseToFen(s);
  if (!back.ok || back.fen !== fen) roundTripFail++;
}
H.check('1000 次往返全部一致', roundTripFail, 0);

H.finish('t1_money');
module.exports = H.results;
