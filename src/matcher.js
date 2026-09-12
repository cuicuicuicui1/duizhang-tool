'use strict';
/*
 * matcher.js — 回函差异勾对算法（本工具技术含量最高的模块）+ 回函记录 CRUD
 *
 * 口径澄清（相对计划 §5.2 的必要补充，已在设计决策记录中说明）：
 *   计划把 L1 定为「金额相等一对一」，L2 定为「金额相等 + 日期差 ≤ 15 天」——
 *   两者按字面含义重叠，L1 会把 L2 的候选全部吃光。这里按业务意图拆开：
 *     L1 精确匹配   = 金额（按我方方向折算后的带符号分）相等 且 日期相同或相差 ≤ 3 天
 *     L2 时间性匹配 = 金额相等 且 3 < 日期差 ≤ 窗口（默认 15 天）
 *     L3 组合匹配   = 多笔合并成对方一笔（汇总付款/合并开票），双向各跑一次
 *     L4 剩余分类   = 己方有对方无 / 对方有己方无 / 方向相反疑似 / 疑似重复
 *
 * 金额一律用「按自然方向折算后的带符号分」参与匹配：应收 = 借 − 贷，应付 = 贷 − 借。
 * 这样两个方向的账套都能用同一套一维算法，不需要正负号特判。
 */

const store = require('./store');
const money = require('./money');
const dates = require('./dates');
const ledger = require('./ledger');
const configMod = require('./config');
const statementMod = require('./statement');

const LEVEL_LABEL = {
  1: '完全一致',
  2: '时间性差异（在途）',
  3: '组合匹配',
  4: '剩余未匹配',
};

// ---------------------------------------------------------------- 回函记录 CRUD
function allReplies() {
  return store.readJson('replies.json', []);
}

function listReplies(filter) {
  const f = filter || {};
  let list = allReplies();
  if (f.statementId) list = list.filter((r) => r.statementId === f.statementId);
  if (f.unitId) list = list.filter((r) => r.unitId === f.unitId);
  if (f.sessionId) {
    const ids = new Set(statementMod.listBySession(f.sessionId).map((s) => s.id));
    list = list.filter((r) => ids.has(r.statementId));
  }
  if (f.status) list = list.filter((r) => r.status === f.status);
  return list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function getReply(id) {
  return allReplies().find((r) => r.id === id) || null;
}

function saveReply(input) {
  const list = allReplies();
  const idx = input.id ? list.findIndex((r) => r.id === input.id) : -1;
  const base =
    idx >= 0
      ? list[idx]
      : {
          id: store.nextId('r'),
          statementId: input.statementId,
          unitId: input.unitId || '',
          createdAt: store.isoNow(),
          status: 'draft',
          confirmedBy: '',
          confirmedAt: '',
        };
  const patch = {
    theirBalanceFen: Number.isInteger(input.theirBalanceFen) ? input.theirBalanceFen : base.theirBalanceFen || 0,
    theirEntries: input.theirEntries || base.theirEntries || [],
    channel: input.channel || base.channel || 'manual',
    signFlip: !!input.signFlip,
    replyDate: input.replyDate || base.replyDate || '',
    replyFile: input.replyFile || base.replyFile || '',
    replySheet: input.replySheet || base.replySheet || '',
    note: input.note === undefined ? base.note || '' : input.note,
    status: base.status,
    diffResult: base.diffResult || null,
    updatedAt: store.isoNow(),
  };
  const rec = Object.assign({}, base, patch);
  if (!rec.unitId) {
    const st = statementMod.getStatement(rec.statementId);
    if (st) rec.unitId = st.unitId;
  }
  if (idx >= 0) list[idx] = rec;
  else list.push(rec);
  store.writeJson('replies.json', list);
  return rec;
}

function confirmedCountOf(sessionId) {
  const ids = new Set(statementMod.listBySession(sessionId).map((s) => s.id));
  return allReplies().filter((r) => r.status === 'confirmed' && ids.has(r.statementId)).length;
}

// ---------------------------------------------------------------- 算法
/** 把一条明细折算成「按自然方向带符号的分」 */
function toSigned(entry, naturalSide, flip) {
  const d = entry.debitFen || 0;
  const c = entry.creditFen || 0;
  let s = naturalSide === 'credit' ? c - d : d - c;
  if (flip) s = -s;
  return s;
}

function describe(entry) {
  return {
    date: entry.date || '',
    summary: entry.summary || '',
    debitFen: entry.debitFen || 0,
    creditFen: entry.creditFen || 0,
    amountText: money.fenToStr(Math.abs((entry.debitFen || 0) - (entry.creditFen || 0)) || 0),
  };
}

/** 有限预算的子集和搜索：找 candidates 中和等于 target 的组合（≤ maxItems 项） */
function subsetSum(candidates, target, maxItems, budget) {
  const n = candidates.length;
  if (n < 2) return null;
  const order = candidates.map((c, i) => ({ i, v: c.amount })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const state = { steps: 0, limit: budget || 200000, found: null };
  const picked = [];
  const suffixMax = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffixMax[i] = suffixMax[i + 1] + Math.max(0, order[i].v);

  const dfs = (pos, remain, depth) => {
    if (state.found) return;
    if (state.steps++ > state.limit) return;
    if (remain === 0 && picked.length >= 2) {
      state.found = picked.map((p) => p.i);
      return;
    }
    if (pos >= n || depth >= maxItems) return;
    if (suffixMax[pos] < remain) return;
    for (let i = pos; i < n; i++) {
      const v = order[i].v;
      if (v <= 0) continue;
      if (v > remain) continue;
      picked.push(order[i]);
      dfs(i + 1, remain - v, depth + 1);
      picked.pop();
      if (state.found) return;
    }
  };
  dfs(0, target, 0);
  return state.found;
}

/**
 * 执行勾对
 * @param {{statementId:string, theirBalanceFen:number, theirEntries:Array, signFlip:boolean, config:Object}} input
 */
function diff(input) {
  const cfg = input.config || configMod.getConfig();
  const stmt = statementMod.getStatement(input.statementId);
  if (!stmt) throw new Error('对账函不存在：' + input.statementId);
  const windowDays = Number(cfg.matchWindowDays) || 15;
  const flip = !!input.signFlip;

  const balance = ledger.computeUnitBalance(stmt.unitId, {
    cutoff: stmt.cutoffDate,
    direction: stmt.direction,
    from: stmt.period ? stmt.period + '-01' : '',
    config: cfg,
  });
  const naturalSide = ledger.naturalSideOf(balance.accounts[0] || '', stmt.direction, cfg);
  const ourClosingFen = balance.signedFen;
  // 口径说明：对方回函上填的余额就是「对方欠我方多少」（应付场景即「我方欠对方多少」），
  // 与我的账面余额同向，因此**余额不做方向翻转**；方向翻转只作用于逐笔明细的借贷两列
  // （对方用自己账套导出的明细账，借贷方向与我方相反）。
  const theirBalanceFen = Number(input.theirBalanceFen) || 0;
  const balanceDiffFen = ourClosingFen - theirBalanceFen;

  const ourEntries = (balance.parts || []).reduce((a, p) => a.concat(p.entries), []);
  const ourList = ourEntries.map((e, i) => ({
    idx: i,
    date: e.date || '',
    summary: e.summary || '',
    debitFen: e.debitFen || 0,
    creditFen: e.creditFen || 0,
    amount: toSigned(e, naturalSide, false),
    matched: false,
  }));

  const theirRaw = input.theirEntries || [];
  const theirList = theirRaw.map((e, i) => ({
    idx: i,
    date: e.date || '',
    summary: e.summary || '',
    debitFen: e.debitFen || 0,
    creditFen: e.creditFen || 0,
    amount: toSigned(e, naturalSide, flip),
    matched: false,
  }));

  const out = {
    statementId: stmt.id,
    serialNo: stmt.serialNo,
    unitId: stmt.unitId,
    cutoffDate: stmt.cutoffDate,
    direction: stmt.direction,
    naturalSide,
    signFlip: flip,
    ourClosingFen,
    theirBalanceFen: Number(input.theirBalanceFen) || 0,
    theirBalanceAdjustedFen: theirBalanceFen,
    balanceDiffFen,
    levels: { l1: 0, l2: 0, l3: 0 },
    matched: [],
    timeDiffs: [],
    combos: [],
    ourOnly: [],
    theirOnly: [],
    suspects: [],
    warnings: [],
    status: '',
    summary: '',
  };

  if (ourList.length === 0) {
    out.warnings.push('MANUAL_REVIEW: 该单位没有逐笔明细，无法逐笔勾对，只做了余额比对。');
    out.status = balanceDiffFen === 0 ? 'consistent' : 'manual';
    out.balanceOnly = true;
    out.summary =
      balanceDiffFen === 0
        ? '双方余额一致（无逐笔明细可比对）。'
        : '双方余额相差 ' + money.fenToStr(balanceDiffFen) + '，且我方无逐笔明细，请人工核对。';
    return out;
  }

  if (theirList.length === 0) {
    const dated = ourList.filter((o) => o.date).length;
    if (dated === 0) {
      out.balanceOnly = true;
      out.warnings.push('MANUAL_REVIEW: 我方只有余额数据、没有逐笔明细（例如只导入了科目余额表），无法逐笔核对。');
    }
    if (balanceDiffFen === 0) {
      out.status = 'consistent';
      out.summary = dated === 0 ? '双方余额一致（我方无逐笔明细，无法进一步核对）。' : '双方余额一致（对方未提供明细）。';
    } else {
      out.status = 'manual';
      out.summary = '双方余额相差 ' + money.fenToStr(balanceDiffFen) + '，对方仅提供余额未提供明细，请索取明细或人工逐笔核对。';
      out.warnings.push('MANUAL_REVIEW: 对方回函只有余额没有明细。');
    }
    return out;
  }

  // ---- L1 精确匹配（金额相等 + 日期差 ≤ 3 天），同金额多笔取日期最近 ----
  const dayDiff = (a, b) => {
    if (!a || !b) return null;
    return Math.abs(dates.daysBetween(a, b));
  };
  const greedyPair = (acceptFn, sink, levelNo, build) => {
    for (const t of theirList) {
      if (t.matched) continue;
      let best = null;
      let bestGap = null;
      for (const o of ourList) {
        if (o.matched) continue;
        if (o.amount !== t.amount) continue;
        const d = dayDiff(o.date, t.date);
        if (!acceptFn(d)) continue;
        if (best === null) {
          best = o;
          bestGap = d;
          continue;
        }
        if (d !== null && (bestGap === null || d < bestGap)) {
          best = o;
          bestGap = d;
        }
      }
      if (best) {
        best.matched = true;
        t.matched = true;
        sink.push(build(best, t, bestGap));
        out.levels['l' + levelNo]++;
      }
    }
  };

  greedyPair((d) => d === null || d <= 3, out.matched, 1, (o, t, gap) => ({
    level: 1,
    levelLabel: LEVEL_LABEL[1],
    amountFen: t.amount,
    our: describe(o),
    their: describe(t),
    dateGapDays: gap,
  }));

  // ---- L2 时间性匹配（金额相等 + 3 < 日期差 ≤ 窗口） ----
  greedyPair((d) => d !== null && d > 3 && d <= windowDays, out.timeDiffs, 2, (o, t, gap) => ({
    level: 2,
    levelLabel: LEVEL_LABEL[2],
    amountFen: t.amount,
    dateGapDays: gap,
    our: describe(o),
    their: describe(t),
  }));

  // ---- 同金额但日期差超出窗口：单独提示，不算匹配掉 ----
  greedyPair(
    (d) => d !== null && d > windowDays,
    out.suspects,
    0,
    (o, t, gap) => ({
      kind: 'same_amount_far_date',
      label: '金额相同但日期相差 ' + gap + ' 天（超出 ' + windowDays + ' 天窗口，疑似同一笔）',
      amountFen: t.amount,
      our: describe(o),
      their: describe(t),
    })
  );


  // ---- L3 组合匹配（子集和，按绝对值同号匹配：汇总付款 / 合并开票） ----
  const ourRest = () => ourList.filter((o) => !o.matched);
  const theirRest = () => theirList.filter((t) => !t.matched);
  const MAX_COMBO_INPUT = 20;
  const MAX_COMBO_ITEMS = 8;
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

  // 方向 A：我方多笔 = 对方一笔
  {
    const rest = ourRest();
    if (rest.length > MAX_COMBO_INPUT) {
      out.warnings.push('MANUAL_REVIEW: 未匹配笔数过多（我方 ' + rest.length + ' 笔），已跳过组合匹配，请人工勾对。');
    } else if (rest.length >= 2) {
      for (const t of theirRest().slice()) {
        if (t.amount === 0) continue;
        const cands = rest.filter((o) => !o.matched && sgn(o.amount) === sgn(t.amount) && Math.abs(o.amount) < Math.abs(t.amount));
        if (cands.length < 2) continue;
        const hit = subsetSum(
          cands.map((c) => ({ amount: Math.abs(c.amount) })),
          Math.abs(t.amount),
          MAX_COMBO_ITEMS,
          200000
        );
        if (hit) {
          const picked = hit.map((i) => cands[i]);
          picked.forEach((p) => (p.matched = true));
          t.matched = true;
          out.combos.push({
            level: 3,
            levelLabel: LEVEL_LABEL[3],
            direction: 'ours_merged',
            describe: '我方 ' + picked.length + ' 笔合并 = 对方 1 笔（' + money.fenToStr(Math.abs(t.amount)) + '）',
            amountFen: t.amount,
            our: picked.map(describe),
            their: [describe(t)],
          });
          out.levels.l3++;
        }
      }
    }
  }
  // 方向 B：对方多笔 = 我方一笔
  {
    const rest = theirRest();
    if (rest.length <= MAX_COMBO_INPUT && rest.length >= 2) {
      for (const o of ourRest().slice()) {
        if (o.amount === 0) continue;
        const cands = rest.filter((t) => !t.matched && sgn(t.amount) === sgn(o.amount) && Math.abs(t.amount) < Math.abs(o.amount));
        if (cands.length < 2) continue;
        const hit = subsetSum(
          cands.map((c) => ({ amount: Math.abs(c.amount) })),
          Math.abs(o.amount),
          MAX_COMBO_ITEMS,
          200000
        );
        if (hit) {
          const picked = hit.map((i) => cands[i]);
          picked.forEach((p) => (p.matched = true));
          o.matched = true;
          out.combos.push({
            level: 3,
            levelLabel: LEVEL_LABEL[3],
            direction: 'theirs_merged',
            describe: '对方 ' + picked.length + ' 笔合并 = 我方 1 笔（' + money.fenToStr(Math.abs(o.amount)) + '）',
            amountFen: o.amount,
            our: [describe(o)],
            their: picked.map(describe),
          });
          out.levels.l3++;
        }
      }
    }
  }

  // ---- L4 剩余分类 ----
  const ourLeft = ourRest();
  const theirLeft = theirRest();

  // 方向相反疑似：金额绝对值相等但符号相反
  for (const o of ourLeft.slice()) {
    if (o.matched) continue;
    const t = theirLeft.find((x) => !x.matched && x.amount === -o.amount && o.amount !== 0);
    if (t) {
      o.matched = true;
      t.matched = true;
      out.suspects.push({
        kind: 'reversed',
        label: '方向相反疑似（金额同为 ' + money.fenToStr(Math.abs(o.amount)) + '，借贷方向对调）',
        amountFen: o.amount,
        our: describe(o),
        their: describe(t),
      });
    }
  }

  // 疑似重复：我方同金额同摘要出现 ≥ 2 次
  {
    const seen = new Map();
    for (const o of ourList) {
      const k = o.amount + '|' + String(o.summary).replace(/\s/g, '');
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    const reported = new Set();
    for (const o of ourList) {
      const k = o.amount + '|' + String(o.summary).replace(/\s/g, '');
      if (seen.get(k) >= 2 && !reported.has(k) && !o.matched) {
        reported.add(k);
        out.suspects.push({
          kind: 'duplicate',
          label: '疑似重复记账（同金额同摘要出现 ' + seen.get(k) + ' 次）',
          amountFen: o.amount,
          our: [describe(o)],
          their: [],
        });
      }
    }
  }

  for (const o of ourRest()) out.ourOnly.push(Object.assign({ level: 4, levelLabel: LEVEL_LABEL[4], amountFen: o.amount }, describe(o)));
  for (const t of theirRest()) out.theirOnly.push(Object.assign({ level: 4, levelLabel: LEVEL_LABEL[4], amountFen: t.amount }, describe(t)));

  // ---- 结论 ----
  const leftovers = out.ourOnly.length + out.theirOnly.length;
  // 未匹配项净影响（按我方方向带符号汇总），用来解释差异金额的构成
  out.unmatchedImpactFen = money.sumFen(
    out.ourOnly.map((x) => x.amountFen).concat(out.theirOnly.map((x) => -x.amountFen))
  );

  if (balanceDiffFen === 0 && leftovers === 0 && out.suspects.length === 0) {
    out.status = 'consistent';
    out.summary = '双方余额一致，逐笔勾对全部匹配。';
  } else if (balanceDiffFen === 0 && leftovers === 0) {
    out.status = 'consistent_with_notes';
    out.summary = '双方余额一致；存在 ' + out.suspects.length + ' 项可疑记录（方向/重复），建议复核。';
  } else if (balanceDiffFen === 0) {
    out.status = 'consistent_with_notes';
    out.summary = '双方余额一致，但存在 ' + leftovers + ' 笔未匹配明细（可能相互抵销），建议复核。';
  } else {
    out.status = 'diff';
    out.summary =
      '双方余额相差 ' + money.fenToStr(balanceDiffFen) +
      '；已匹配 ' + out.levels.l1 + ' 笔、时间性差异 ' + out.levels.l2 + ' 项、组合匹配 ' + out.levels.l3 +
      ' 组、我方独有 ' + out.ourOnly.length + ' 笔、对方独有 ' + out.theirOnly.length + ' 笔。';
  }

  if (leftovers > 0) {
    out.warnings.push('MANUAL_REVIEW: 有 ' + leftovers + ' 笔未能自动勾对，请人工逐项确认。');
  }
  if (out.ourOnly.length + out.theirOnly.length > 20) {
    out.warnings.push('MANUAL_REVIEW: 未匹配笔数较多，勾对结果仅供参考。');
  }

  // 方向翻转建议：把「明细借贷翻转」再跑一遍，问题项更少就建议翻转
  if (input.autoDetectFlip !== false) {
    const problemCount = (d) =>
      d.ourOnly.length + d.theirOnly.length + d.suspects.filter((s) => s.kind === 'reversed').length;
    const now = problemCount(out);
    if (now > 0) {
      const alt = diff({
        statementId: input.statementId,
        theirBalanceFen: input.theirBalanceFen,
        theirEntries: input.theirEntries,
        signFlip: !flip,
        config: cfg,
        autoDetectFlip: false,
      });
      const altCount = problemCount(alt);
      if (altCount < now) {
        out.flipSuggestion =
          '疑似对方明细的借贷方向与我方相反：勾选「对方明细方向翻转」后，待处理项将从 ' +
          now +
          ' 项降到 ' +
          altCount +
          ' 项，建议翻转后重跑。';
        out.flipAlternative = { signFlip: !flip, problems: altCount };
      }
    }
  }

  return out;
}

/** 跑勾对并落库（draft） */
function runAndSave(input) {
  const cfg = input.config || configMod.getConfig();
  const stmt = statementMod.getStatement(input.statementId);
  if (!stmt) throw new Error('对账函不存在：' + input.statementId);
  const theirEntries = input.theirEntries || (input.replyId ? (getReply(input.replyId) || {}).theirEntries : []) || [];
  const reply = saveReply({
    id: input.replyId,
    statementId: input.statementId,
    unitId: stmt.unitId,
    theirBalanceFen: input.theirBalanceFen,
    theirEntries,
    channel: input.channel,
    signFlip: input.signFlip,
    replyDate: input.replyDate,
    replyFile: input.replyFile,
    replySheet: input.replySheet,
    note: input.note,
  });
  const result = diff({
    statementId: input.statementId,
    theirBalanceFen: reply.theirBalanceFen,
    theirEntries: reply.theirEntries,
    signFlip: reply.signFlip,
    config: cfg,
    autoDetectFlip: input.autoDetectFlip,
  });
  result.status = 'draft';
  reply.diffResult = result;
  reply.status = 'draft';
  const list = allReplies();
  const i = list.findIndex((r) => r.id === reply.id);
  if (i >= 0) list[i] = reply;
  else list.push(reply);
  store.writeJson('replies.json', list);
  store.log('[OK] 勾对完成 ' + stmt.serialNo + '：' + result.summary);
  return { reply, diffResult: result };
}

/** 会计确认 → confirmed + 归档差异报告 */
function confirm(input) {
  const list = allReplies();
  const i = list.findIndex((r) => r.id === input.replyId);
  if (i < 0) throw new Error('回函记录不存在');
  const rec = list[i];
  if (!rec.diffResult || rec.status === 'draft') {
    if (!rec.diffResult) throw new Error('请先执行勾对');
  }
  rec.status = 'confirmed';
  rec.confirmedBy = input.confirmedBy || '会计';
  rec.confirmedAt = store.isoNow();
  rec.decisions = input.decisions || [];
  rec.confirmNote = input.note || '';
  list[i] = rec;
  store.writeJson('replies.json', list);

  // 归档差异报告
  const stmt = statementMod.getStatement(rec.statementId);
  if (stmt) {
    const fs = require('fs');
    const path = require('path');
    const dir = stmt.archivedDir || statementMod.archiveDir(stmt.unitId, stmt.period, stmt.version);
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
      statement: {
        serialNo: stmt.serialNo,
        unitName: stmt.unitName,
        period: stmt.period,
        direction: stmt.direction,
        cutoffDate: stmt.cutoffDate,
        version: stmt.version,
        ourBalanceFen: stmt.ourBalanceFen,
        dataSource: stmt.dataSource || null,
        generatedAt: stmt.createdAt,
      },
      reply: {
        id: rec.id,
        theirBalanceFen: rec.theirBalanceFen,
        channel: rec.channel,
        signFlip: rec.signFlip,
        replyDate: rec.replyDate,
        replyFile: rec.replyFile,
      },
      diffResult: rec.diffResult,
      confirmedBy: rec.confirmedBy,
      confirmedAt: rec.confirmedAt,
      decisions: rec.decisions,
      note: rec.confirmNote,
    };
    fs.writeFileSync(path.join(dir, stmt.serialNo + '_差异报告.json'), JSON.stringify(payload, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, stmt.serialNo + '_差异报告.html'), renderReportHtml(payload), 'utf8');
    store.log('[OK] 差异报告已归档：' + stmt.serialNo);
  }
  return rec;
}

/** 差异报告 HTML（归档 + 页面预览共用） */
function renderReportHtml(payload) {
  const esc = require('./templates').esc;
  const d = payload.diffResult || {};
  const row = (cells, cls) => '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' + cells.map((c) => '<td>' + c + '</td>').join('') + '</tr>';
  const block = (title, rows, cls) =>
    rows && rows.length
      ? '<h3>' + title + '（' + rows.length + '）</h3><table class="' + (cls || '') + '"><thead><tr><th>日期</th><th>摘要</th><th>借方</th><th>贷方</th><th>说明</th></tr></thead><tbody>' +
        rows.join('\n') +
        '</tbody></table>'
      : '<h3>' + title + '（0）</h3><p class="muted">无</p>';
  const lineOf = (x, note) =>
    row([
      esc(x.date || ''),
      esc(x.summary || ''),
      x.debitFen ? money.fenToStr(x.debitFen) : '',
      x.creditFen ? money.fenToStr(x.creditFen) : '',
      esc(note || ''),
    ]);

  const matchedRows = (d.matched || []).map((m) =>
    row([esc(m.our.date), esc(m.our.summary), m.our.debitFen ? money.fenToStr(m.our.debitFen) : '', m.our.creditFen ? money.fenToStr(m.our.creditFen) : '', '与对方 ' + esc(m.their.date) + ' 金额一致' + (m.dateGapDays ? '（相差 ' + m.dateGapDays + ' 天）' : '')], 'ok')
  );
  const timeRows = (d.timeDiffs || []).map((m) =>
    row([esc(m.our.date), esc(m.our.summary), m.our.debitFen ? money.fenToStr(m.our.debitFen) : '', m.our.creditFen ? money.fenToStr(m.our.creditFen) : '', '时间性差异：与对方 ' + esc(m.their.date) + ' 相差 ' + m.dateGapDays + ' 天'], 'warn')
  );
  const comboRows = [];
  for (const c of d.combos || []) {
    for (const o of c.our) comboRows.push(row([esc(o.date), esc(o.summary), o.debitFen ? money.fenToStr(o.debitFen) : '', o.creditFen ? money.fenToStr(o.creditFen) : '', c.describe], 'info'));
  }
  const ourOnlyRows = (d.ourOnly || []).map((x) => lineOf(x, '己方有、对方无'));
  const theirOnlyRows = (d.theirOnly || []).map((x) => lineOf(x, '对方有、己方无'));
  const suspectRows = (d.suspects || []).map((s) =>
    row([esc((s.our[0] || {}).date || (s.their[0] || {}).date || ''), esc((s.our[0] || {}).summary || (s.their[0] || {}).summary || ''), '', '', esc(s.label)], 'bad')
  );

  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>差异报告 ' +
    esc(payload.statement.serialNo) +
    '</title><style>' +
    'body{font-family:"Microsoft YaHei","微软雅黑",sans-serif;font-size:13px;color:#222;margin:24px;background:#fff}' +
    'h1{font-size:20px;margin:0 0 6px}h2{font-size:15px;margin:18px 0 6px}h3{font-size:14px;margin:14px 0 6px}' +
    'table{width:100%;border-collapse:collapse;margin-bottom:10px}' +
    'th,td{border:1px solid #ddd;padding:4px 8px;text-align:left}th{background:#f5f5f5}' +
    'td:nth-child(3),td:nth-child(4){text-align:right;font-family:Consolas,monospace}' +
    'tr.ok td{background:#f2fbf2}tr.warn td{background:#fffbe6}tr.info td{background:#f0f6ff}tr.bad td{background:#fdf0f0}' +
    '.kv{display:grid;grid-template-columns:180px 1fr;gap:4px 12px;margin-bottom:10px}' +
    '.muted{color:#888}.big{font-size:16px;font-weight:700}' +
    '</style></head><body>' +
    '<h1>往来对账差异报告</h1>' +
    '<div class="kv">' +
    '<div>对账函编号</div><div>' + esc(payload.statement.serialNo) + '（v' + payload.statement.version + '）</div>' +
    '<div>往来单位</div><div>' + esc(payload.statement.unitName) + '</div>' +
    '<div>方向 / 期间</div><div>' + (payload.statement.direction === 'payable' ? '应付' : '应收') + '　' + esc(payload.statement.period) + '　截止 ' + esc(payload.statement.cutoffDate) + '</div>' +
    '<div>我方账面余额</div><div>' + money.fenToStr(d.ourClosingFen) + '</div>' +
    '<div>对方回函余额</div><div>' + money.fenToStr(d.theirBalanceAdjustedFen) + (d.signFlip ? '（明细借贷方向已按对方口径翻转）' : '') + '</div>' +
    '<div>差异金额</div><div class="big" style="color:' + (d.balanceDiffFen === 0 ? '#1a7f37' : '#c0392b') + '">' + money.fenToStr(d.balanceDiffFen) + '</div>' +
    '<div>勾对结论</div><div>' + esc(d.summary || '') + '</div>' +
    '<div>确认人 / 时间</div><div>' + esc(payload.confirmedBy || '（未确认）') + '　' + esc(payload.confirmedAt || '') + '</div>' +
    '</div>' +
    (d.flipSuggestion ? '<p style="color:#c0392b">' + esc(d.flipSuggestion) + '</p>' : '') +
    (d.warnings && d.warnings.length ? '<div style="background:#fffdf3;border:1px solid #c9a227;padding:8px"><b>待人工确认</b><ul>' + d.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></div>' : '') +
    '<h2>一、逐笔勾对结果</h2>' +
    (matchedRows.length
      ? '<table><thead><tr><th>我方日期</th><th>摘要</th><th>借方</th><th>贷方</th><th>说明</th></tr></thead><tbody>' + matchedRows.join('\n') + '</tbody></table>'
      : '<p class="muted">无</p>') +
    '<h2>二、时间性差异（在途）</h2>' +
    (timeRows.length
      ? '<table><thead><tr><th>我方日期</th><th>摘要</th><th>借方</th><th>贷方</th><th>说明</th></tr></thead><tbody>' + timeRows.join('\n') + '</tbody></table>'
      : '<p class="muted">无</p>') +
    '<h2>三、组合匹配（多笔合并）</h2>' +
    (comboRows.length
      ? '<table><thead><tr><th>日期</th><th>摘要</th><th>借方</th><th>贷方</th><th>说明</th></tr></thead><tbody>' + comboRows.join('\n') + '</tbody></table>'
      : '<p class="muted">无</p>') +
    '<h2>四、我方有对方无</h2>' +
    (ourOnlyRows.length
      ? '<table><thead><tr><th>日期</th><th>摘要</th><th>借方</th><th>贷方</th><th>说明</th></tr></thead><tbody>' + ourOnlyRows.join('\n') + '</tbody></table>'
      : '<p class="muted">无</p>') +
    '<h2>五、对方有己方无</h2>' +
    (theirOnlyRows.length
      ? '<table><thead><tr><th>日期</th><th>摘要</th><th>借方</th><th>贷方</th><th>说明</th></tr></thead><tbody>' + theirOnlyRows.join('\n') + '</tbody></table>'
      : '<p class="muted">无</p>') +
    '<h2>六、可疑记录（方向相反 / 疑似重复）</h2>' +
    (suspectRows.length
      ? '<table><thead><tr><th>日期</th><th>摘要</th><th></th><th></th><th>说明</th></tr></thead><tbody>' + suspectRows.join('\n') + '</tbody></table>'
      : '<p class="muted">无</p>') +
    '<p class="muted">本报告由「往来单位对账函工具」生成，勾对结果为机器建议，最终确认以会计逐项确认为准。</p>' +
    '</body></html>'
  );
}

module.exports = {
  LEVEL_LABEL,
  allReplies,
  listReplies,
  getReply,
  saveReply,
  confirmedCountOf,
  diff,
  runAndSave,
  confirm,
  renderReportHtml,
  subsetSum,
  toSigned,
};
