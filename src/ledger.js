'use strict';
/*
 * ledger.js — 己方明细账 / 余额计算
 *
 * 余额口径全部可配（计划里「让用户自己选」的部分），实现在 BALANCE_STRATEGIES 注册表里：
 *   opening_from_file  用导入识别到的期初余额
 *   cumulative         直接累计借贷
 *   manual_opening     期初由会计手工录入
 *   balance_sheet      以科目余额表的期末余额列为准
 *   incremental        分次导入累加（期初表 + 期间明细）
 *   auto               先找期初，找不到回退累计并打标记
 *
 * 金额全程整数分；只用加法，不做任何乘除。
 */

const store = require('./store');
const money = require('./money');
const importer = require('./importer');

const SIDE_LABEL = { debit: '借方', credit: '贷方' };

/** 科目自然余额方向 */
function naturalSideOf(account, direction, cfg) {
  const s = importer.accountSide(account, cfg);
  if (s) return s;
  return direction === 'payable' ? 'credit' : 'debit';
}

/**
 * 明细表读取带 mtime 缓存：批量生成 50 家时，每算一家都重新 JSON.parse 上万条明细
 * 会白白花掉十几秒（实测）。文件一被改写 mtime 就变，缓存自动失效，不会读到脏数据。
 */
let _ledgerCache = { mtime: -1, size: -1, data: null };
function allLedgers() {
  const p = store.dataPath('ledgers.json');
  try {
    const st = require('fs').statSync(p);
    const key = st.mtimeMs + ':' + st.size;
    if (_ledgerCache.data && _ledgerCache.mtime === st.mtimeMs && _ledgerCache.size === st.size) return _ledgerCache.data;
    const data = store.readJson('ledgers.json', []);
    _ledgerCache = { mtime: st.mtimeMs, size: st.size, data };
    void key;
    return data;
  } catch (_) {
    return store.readJson('ledgers.json', []);
  }
}

function invalidateCache() {
  _ledgerCache = { mtime: -1, size: -1, data: null };
}
store.onWrite((name) => {
  if (name === 'ledgers.json') invalidateCache();
});

function openingsOf(unitId, account) {
  const list = store.readJson('openings.json', []);
  return list.filter((o) => o.unitId === unitId && (!account || o.account === account));
}

/** 取期初余额（同单位同科目取最新一条） */
function pickOpening(unitId, account, source) {
  const list = openingsOf(unitId, account).filter((o) => (source ? o.source === source : true));
  if (!list.length) return null;
  list.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return list[0];
}

function sumOpening(list) {
  return money.sumFen(list.map((o) => o.openingFen));
}

/** 某单位明细（按科目过滤可选，按截止日过滤） */
function entriesOf(unitId, opts) {
  const o = opts || {};
  let list = allLedgers().filter((e) => e.unitId === unitId);
  if (o.account) list = list.filter((e) => e.account === o.account);
  if (o.cutoff) list = list.filter((e) => !e.date || e.date <= o.cutoff);
  if (o.from) list = list.filter((e) => !e.date || e.date >= o.from);
  list.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || (a.sourceRow || 0) - (b.sourceRow || 0));
  return list;
}

const BALANCE_STRATEGIES = {
  opening_from_file(ctx) {
    const op = pickOpening(ctx.unitId, ctx.account, 'file');
    return {
      openingFen: op ? op.openingFen : null,
      source: op ? '导入文件期初（' + (op.note || '') + '）' : '未找到期初余额',
      missing: !op,
    };
  },
  manual_opening(ctx) {
    const op = pickOpening(ctx.unitId, ctx.account, 'manual');
    return {
      openingFen: op ? op.openingFen : null,
      source: op ? '手工录入期初' : '未录入期初余额',
      missing: !op,
    };
  },
  incremental(ctx) {
    const list = openingsOf(ctx.unitId, ctx.account);
    if (!list.length) return { openingFen: 0, source: '分次导入累加（暂无可累加的期初）', missing: true };
    return { openingFen: sumOpening(list), source: '分次导入累加（' + list.length + ' 笔期初）', missing: false };
  },
  cumulative() {
    return { openingFen: 0, source: '期初视为 0，明细借贷累计', missing: false };
  },
  balance_sheet(ctx) {
    const withBal = ctx.entries.filter((e) => typeof e.balanceFen === 'number');
    if (!withBal.length) return { openingFen: null, source: '科目余额表里没有余额列', missing: true, useBalanceColumn: true };
    const last = withBal[withBal.length - 1];
    return {
      openingFen: null,
      closeFromColumn: last.balanceFen,
      source: '科目余额表期末余额列',
      missing: false,
      useBalanceColumn: true,
    };
  },
};

/**
 * 计算某单位在截止日的余额。
 * @param {{unitId:string, account?:string, direction?:string, cutoff?:string, from?:string, config?:Object}} input
 */
function computeBalance(input) {
  const cfg = input.config || require('./config').getConfig();
  const unitId = input.unitId;
  const account = input.account || '';
  const cutoff = input.cutoff || '';
  const entries = entriesOf(unitId, { account, cutoff });
  const warnings = [];
  const naturalSide = naturalSideOf(account, input.direction, cfg);

  let mode = cfg.balanceMode || 'auto';
  let used = mode;
  if (mode === 'auto') {
    const a = BALANCE_STRATEGIES.opening_from_file({ unitId, account, entries });
    if (!a.missing) {
      used = 'opening_from_file';
    } else {
      used = 'cumulative';
    }
  }

  const ctx = { unitId, account, entries, cutoff, config: cfg };
  if (!BALANCE_STRATEGIES[used]) {
    warnings.push('MANUAL_REVIEW: 余额口径「' + mode + '」不是已知口径（可能是设置被改坏了），已回退到「明细借贷累计」。');
    used = 'cumulative';
  }
  let strat = BALANCE_STRATEGIES[used](ctx);

  // auto 模式：opening_from_file 缺失时回退 cumulative，并在对账函上明示口径
  if (mode === 'auto' && used === 'opening_from_file' && strat.missing) {
    used = 'cumulative';
    strat = BALANCE_STRATEGIES.cumulative(ctx);
  }
  if (mode === 'auto' && used === 'cumulative') {
    warnings.push('余额口径说明：未取到导入的期初余额，已按「明细借贷累计」计算（相当于假设期初为 0）。如与账面不符，请在设置里改口径或补录期初。');
  }
  if (strat.missing) {
    warnings.push('MANUAL_REVIEW: 余额口径「' + mode + '」所需的期初余额未取到，请补录或改用其他口径（当前按 ' + used + ' 计算）');
  }

  let debitSumFen = 0;
  let creditSumFen = 0;
  let periodDebitFen = 0;
  let periodCreditFen = 0;
  let detailCount = 0;
  for (const e of entries) {
    debitSumFen += e.debitFen || 0;
    creditSumFen += e.creditFen || 0;
    if (e.date) detailCount++;
    // 本期发生额：有日期的按 from 过滤；无日期的（科目余额表整表）全额计入本期
    if (!e.date || !input.from || e.date >= input.from) {
      periodDebitFen += e.debitFen || 0;
      periodCreditFen += e.creditFen || 0;
    }
  }
  const movement = naturalSide === 'credit' ? creditSumFen - debitSumFen : debitSumFen - creditSumFen;
  const periodMovement = naturalSide === 'credit' ? periodCreditFen - periodDebitFen : periodDebitFen - periodCreditFen;

  let signedFen;
  if (strat.useBalanceColumn) {
    signedFen = strat.closeFromColumn;
    if (typeof signedFen !== 'number') signedFen = 0;
  } else {
    signedFen = (strat.openingFen || 0) + movement;
  }

  return {
    unitId,
    account,
    cutoff,
    mode,
    usedMode: used,
    naturalSide,
    naturalSideLabel: SIDE_LABEL[naturalSide],
    openingFen: strat.openingFen,
    openingSource: strat.source,
    debitSumFen,
    creditSumFen,
    periodDebitFen,
    periodCreditFen,
    movementFen: movement,
    periodMovementFen: periodMovement,
    signedFen,
    absFen: money.absFen(signedFen),
    directionAbnormal: signedFen < 0,
    entryCount: entries.length,
    detailCount,
    hasDetail: detailCount > 0,
    balanceOnly: detailCount === 0,
    entries,
    warnings,
  };
}

/** 按单位汇总（同一单位多科目合并） */
function computeUnitBalance(unitId, opts) {
  const o = opts || {};
  const cfg = o.config || require('./config').getConfig();
  const ledgers = entriesOf(unitId, { cutoff: o.cutoff });
  const accounts = Array.from(new Set(ledgers.map((e) => e.account).filter(Boolean)));
  if (!accounts.length) accounts.push('');
  const parts = accounts.map((account) =>
    computeBalance({
      unitId,
      account,
      direction: o.direction,
      cutoff: o.cutoff,
      from: o.from,
      config: cfg,
    })
  );
  const total = money.sumFen(parts.map((p) => p.signedFen));
  return {
    unitId,
    cutoff: o.cutoff,
    parts,
    accounts,
    signedFen: total,
    absFen: money.absFen(total),
    directionAbnormal: total < 0,
    hasDetail: parts.some((p) => p.hasDetail),
    balanceOnly: parts.every((p) => p.balanceOnly),
    entryCount: parts.reduce((a, p) => a + p.entryCount, 0),
    debitSumFen: money.sumFen(parts.map((p) => p.debitSumFen)),
    creditSumFen: money.sumFen(parts.map((p) => p.creditSumFen)),
    periodDebitFen: money.sumFen(parts.map((p) => p.periodDebitFen)),
    periodCreditFen: money.sumFen(parts.map((p) => p.periodCreditFen)),
    warnings: parts.reduce((a, p) => a.concat(p.warnings), []),
  };
}

/**
 * 留痕用：这批明细是从哪些导入批次/原始文件来的
 * 对账函上会印一行「数据来源」，归档 JSON 里也会带上，便于审计回溯。
 */
function traceOf(balance) {
  const parts = balance.parts && balance.parts.length ? balance.parts : [balance];
  const entries = parts.reduce((a, p) => a.concat(p.entries || []), []);
  return {
    batches: Array.from(new Set(entries.map((e) => e.importBatch).filter(Boolean))),
    files: Array.from(new Set(entries.map((e) => e.sourceFile).filter(Boolean))),
    accounts: Array.from(new Set(entries.map((e) => e.account).filter(Boolean))),
    count: entries.length,
    firstDate: entries.map((e) => e.date).filter(Boolean).sort()[0] || '',
    lastDate: entries.map((e) => e.date).filter(Boolean).sort().slice(-1)[0] || '',
  };
}

/** 所有存在明细的截止日/期间，供页面下拉 */
function listBalances(cutoff, direction, opts) {
  const cfg = (opts && opts.config) || require('./config').getConfig();
  const units = require('./units').all();
  const out = [];
  for (const u of units) {
    const b = computeUnitBalance(u.id, { cutoff, direction, config: cfg });
    if (b.entryCount === 0) continue;
    out.push(Object.assign({ unit: u }, b));
  }
  out.sort((a, b) => Math.abs(b.absFen) - Math.abs(a.absFen));
  return out;
}

/**
 * 单位级余额对象 → 明细附页所需的扁平行（按科目分组，各自滚动余额）
 * 模板渲染与 Excel 导出共用，保证两条出口的明细完全一致。
 */
function detailRows(balance) {
  const parts = balance.parts && balance.parts.length ? balance.parts : [balance];
  const out = { parts: [], totalRows: 0 };
  let index = 0;
  for (const p of parts) {
    const side = p.naturalSide || 'debit';
    let running = p.openingFen || 0;
    const rows = [];
    for (const e of p.entries || []) {
      running += side === 'credit' ? (e.creditFen || 0) - (e.debitFen || 0) : (e.debitFen || 0) - (e.creditFen || 0);
      index++;
      rows.push({
        index,
        date: e.date || '',
        summary: e.summary || '',
        debitFen: e.debitFen || 0,
        creditFen: e.creditFen || 0,
        runningFen: running,
        voucherNo: e.voucherNo || '',
        sourceRow: e.sourceRow,
      });
    }
    out.totalRows += rows.length;
    out.parts.push({
      account: p.account || '',
      naturalSide: side,
      openingFen: p.openingFen === undefined ? null : p.openingFen,
      openingSource: p.openingSource || '',
      debitSumFen: p.debitSumFen || 0,
      creditSumFen: p.creditSumFen || 0,
      closingFen: p.signedFen || 0,
      rows,
    });
  }
  return out;
}

/** 所有存在明细的截止日/期间，供页面下拉 */
function periods() {
  const set = new Set();
  for (const e of allLedgers()) {
    if (e.date) set.add(e.date.slice(0, 7));
  }
  return Array.from(set).sort().reverse();
}

function accountsOf(unitId) {
  return Array.from(new Set(entriesOf(unitId, {}).map((e) => e.account).filter(Boolean)));
}

module.exports = {
  BALANCE_STRATEGIES,
  naturalSideOf,
  allLedgers,
  invalidateCache,
  entriesOf,
  openingsOf,
  pickOpening,
  computeBalance,
  computeUnitBalance,
  detailRows,
  traceOf,
  listBalances,
  periods,
  accountsOf,
};
