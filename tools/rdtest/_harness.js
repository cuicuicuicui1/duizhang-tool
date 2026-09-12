'use strict';
/*
 * _harness.js — 测试骨架：统一 PASS/FAIL + 预期/实际 对照输出，末尾汇总
 * 所有 rdtest 脚本共用。ASCII 标记避免 Windows GBK 控制台 UnicodeEncodeError。
 */

const results = { pass: 0, fail: 0, cases: [], startedAt: Date.now() };

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  try {
    const s = JSON.stringify(v);
    return s && s.length > 220 ? s.slice(0, 220) + '...' : String(s);
  } catch (_) {
    return String(v);
  }
}

function check(name, actual, expected) {
  const ok = deepEq(actual, expected);
  record(name, ok, expected, actual);
  return ok;
}

function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9;
  }
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEq(a[k], b[k]));
  }
  return false;
}

function ok(name, cond, detail) {
  record(name, !!cond, 'truthy', cond ? 'truthy' : fmt(detail));
  return !!cond;
}

function throws(name, fn, matchRe) {
  try {
    fn();
    record(name, false, 'throws ' + (matchRe || ''), '没有抛异常');
    return false;
  } catch (e) {
    const good = !matchRe || matchRe.test(e.message);
    record(name, good, 'throws ' + (matchRe || ''), e.message);
    return good;
  }
}

function record(name, pass, expected, actual) {
  results.cases.push({ name, pass, expected, actual });
  if (pass) {
    results.pass++;
  } else {
    results.fail++;
    console.log('  [FAIL] ' + name);
    console.log('         预期: ' + fmt(expected));
    console.log('         实际: ' + fmt(actual));
  }
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

function summary(suite) {
  const ms = Date.now() - results.startedAt;
  console.log('\n----------------------------------------');
  console.log(
    (results.fail === 0 ? '[OK]  ' : '[!!]  ') +
      (suite || 'suite') +
      '  通过 ' +
      results.pass +
      ' / 共 ' +
      (results.pass + results.fail) +
      '，失败 ' +
      results.fail +
      '，用时 ' +
      ms +
      'ms'
  );
  console.log('----------------------------------------');
  return results.fail === 0;
}

function finish(suite) {
  const good = summary(suite);
  if (!good && process.env.RDTEST_EXIT === '1') process.exit(1);
  // run_all 编排时强制退出：批量生成里浏览器进程树的处理偶尔会给事件循环留下
  // 不退场的句柄（结果已全部打印完，不影响判定），但会让 run_all 的 spawnSync 干等。
  if (process.env.RDTEST_FORCE_EXIT === '1') {
    const code = good ? 0 : 1;
    process.exitCode = code;
    // 实测：起了 HTTP 测试服务的套件（t6/t7）在个别运行里 process.exit 后进程仍不退场
    //（疑似本机 node 退出路径与残留句柄冲突）。定时器 3 秒后再试一次退出；
    // 就算这次 exit 又挂住，编排器的看门狗也会从外面杀掉——结果在此之前已全部打印完。
    console.log('[harness] FORCE_EXIT：3 秒后退出（code=' + code + '）');
    const t = setTimeout(() => {
      console.log('[harness] 定时退出触发');
      process.exit(code);
    }, 3000);
    if (t.unref) t.unref();
    return good;
  }
  return good;
}

module.exports = { check, ok, throws, section, summary, finish, results, fmt, deepEq };
