'use strict';
/*
 * t8_e2e.js — 层 1「主场景端到端」（走真实 HTTP 接口，全流程闭环）
 * 场景（计划 §9.1）：3 家单位 —— 甲完全一致、乙 2 笔未达账项、丙 5 笔明细对应 1 笔汇总
 * 流程：建档案 → 导入明细账 → 生成对账函 → 录回函 → 勾对 → 核对预期差异表 → 确认归档
 */

const path = require('path');
const fs = require('fs');

const RUN = path.join(__dirname, '.run', 'e2e_' + Date.now());
process.env.DZ_DATA = path.join(RUN, 'data');
process.env.DZ_BACKUP = path.join(RUN, 'backups');
process.env.DZ_NO_OPEN = '1';

const H = require('./_harness');
const { startServer, jget, jpost, jput } = require('./_server');
const samples = require('../make_samples');

const SAMPLE_DIR = path.join(__dirname, '..', '..', 'samples');
const EX = samples.EXPECTED;
const money = require('../../src/money');

(async () => {
  const srv = await startServer();
  const B = srv.url;
  console.log('测试服务: ' + B);

  H.section('第 0 步：数据目录是干净的（模拟会计第一次打开工具）');
  {
    const st = await jget(B, '/api/stats');
    H.check('单位数 0', st.data.units, 0);
    H.check('明细 0 条', st.data.ledgerEntries, 0);
    H.check('对账函 0 份', st.data.statements, 0);
    const units = await jget(B, '/api/units');
    H.check('档案为空', units.data.length, 0);
  }

  H.section('第 1 步：设公司信息 + 建 3 家往来单位');
  const U = {};
  {
    await jput(B, '/api/config', { company: EX.ourCompany });
    const cf = await jget(B, '/api/config');
    H.check('公司名已保存', cf.data.config.company.name, EX.ourCompany.name);
    for (const u of EX.units) {
      const r = await jpost(B, '/api/units', { name: u.name, type: u.type });
      U[u.key] = r.data;
    }
    const units = await jget(B, '/api/units');
    H.check('3 家单位已建档', units.data.length, 3);
    H.check('甲是客户', units.data.find((x) => x.name === EX.units[0].name).type, 'customer');
  }

  H.section('第 2 步：导入 3 份明细账（真实样本文件）');
  {
    for (const u of EX.units) {
      const name = 's01_标准明细账_' + u.name + '.xlsx';
      const content = fs.readFileSync(path.join(SAMPLE_DIR, name)).toString('base64');
      const pv = await jpost(B, '/api/import/preview', { filename: name, contentBase64: content });
      H.check('[' + u.key + '] 表头识别为第 4 行', pv.data.sheets[0].headerRowNo, 4);
      const s = pv.data.sheets[0];
      const c = await jpost(B, '/api/import/commit', {
        filename: name,
        contentBase64: content,
        plans: [{ sheetName: s.name, include: true, headerRow: s.headerRowNo, mapping: s.mapping, unitId: U[u.key].id, account: u.account }],
      });
      H.check('[' + u.key + '] 入库 ' + u.rows + ' 条', c.data.added, u.rows);
    }
    const st = await jget(B, '/api/stats');
    H.check('明细合计 13 条', st.data.ledgerEntries, 13);
    H.check('导入批次 3 个', st.data.batches, 3);
  }

  H.section('第 3 步：核对各家余额（这是函上要写的金额）');
  {
    for (const u of EX.units) {
      const b = await jget(B, '/api/ledger/balance?unitId=' + U[u.key].id + '&cutoff=' + EX.cutoff + '&direction=' + (u.account === '应付账款' ? 'payable' : 'receivable'));
      H.check('[' + u.key + '] 余额 ' + money.fenToStr(u.closingFen), b.data.signedFen, u.closingFen);
      H.check('[' + u.key + '] 有逐笔明细', b.data.hasDetail, true);
      H.check('[' + u.key + '] 本期借方合计', b.data.periodDebitFen, u.debitFen);
    }
  }

  H.section('第 4 步：批量生成对账函');
  let stmtOf = {};
  {
    const g = await jpost(B, '/api/statements/generate', {
      unitIds: [U.jia.id, U.yi.id, U.bing.id],
      cutoffDate: EX.cutoff,
      direction: 'receivable',
      period: EX.period,
    });
    H.check('3 家全部成功', g.data.okCount, 3);
    H.check('没有失败项', g.data.failCount, 0);
    for (const r of g.data.results) {
      stmtOf[r.unitName] = r;
      H.check(r.unitName + ' 编号格式正确', /^DZH-\d{8}-\d{4}$/.test(r.serialNo), true);
      H.check(r.unitName + ' PDF 已生成', r.pdfOk, true);
    }
    const ids = g.data.results.map((r) => r.serialNo);
    H.check('编号互不重复', new Set(ids).size, 3);

    // 函件正文核对
    const html = await jget(B, '/api/statements/' + stmtOf[EX.units[0].name].statementId + '/html');
    H.check('函上有我方公司名', html.data.html.indexOf(EX.ourCompany.name) >= 0, true);
    H.check('函上有对方抬头', html.data.html.indexOf(EX.units[0].name) >= 0, true);
    H.check('函上金额 70,000.00', html.data.html.indexOf('70,000.00') >= 0, true);
    H.check('函上大写 柒万元整', html.data.html.indexOf('柒万元整') >= 0, true);
    H.check('函上措辞「贵公司欠我方」', html.data.html.indexOf('贵公司欠我方') >= 0, true);
    H.check('函上含归还截止日', html.data.html.indexOf('2026年08月31日') >= 0, true);
  }

  H.section('第 5 步：录回函 + 勾对（逐家核对预期差异）');
  const diffOf = {};
  {
    // 甲：完全一致
    const d1 = await jpost(B, '/api/diff/run', {
      statementId: stmtOf[EX.units[0].name].statementId,
      theirBalanceFen: EX.replies.jia.theirBalanceFen,
      theirEntries: EX.replies.jia.detail,
      channel: 'manual',
    });
    diffOf.jia = d1.data.diffResult;
    H.check('甲：余额差 0', diffOf.jia.balanceDiffFen, 0);
    H.check('甲：4 笔全部匹配（L1）', diffOf.jia.levels.l1, 4);
    H.check('甲：无剩余', diffOf.jia.ourOnly.length + diffOf.jia.theirOnly.length, 0);
    H.check('甲：结论文案', diffOf.jia.summary, '双方余额一致，逐笔勾对全部匹配。');

    // 乙：2 笔未达账项
    const d2 = await jpost(B, '/api/diff/run', {
      statementId: stmtOf[EX.units[1].name].statementId,
      theirBalanceFen: EX.replies.yi.theirBalanceFen,
      theirEntries: EX.replies.yi.detail,
      channel: 'manual',
    });
    diffOf.yi = d2.data.diffResult;
    H.check('乙：我方 120,000.00', money.fenToStr(diffOf.yi.ourClosingFen), '120,000.00');
    H.check('乙：对方 80,000.00', money.fenToStr(diffOf.yi.theirBalanceFen), '80,000.00');
    H.check('乙：差异 40,000.00', money.fenToStr(diffOf.yi.balanceDiffFen), '40,000.00');
    H.check('乙：已匹配 2 笔', diffOf.yi.levels.l1, 2);
    H.check('乙：己方独有 2 笔', diffOf.yi.ourOnly.length, 2);
    H.check('乙：未匹配净影响等于差异', diffOf.yi.unmatchedImpactFen, diffOf.yi.balanceDiffFen);
    H.check('乙：提示人工确认', diffOf.yi.warnings.some((w) => /人工逐项确认/.test(w)), true);

    // 丙：5 笔 ↔ 1 笔汇总
    const d3 = await jpost(B, '/api/diff/run', {
      statementId: stmtOf[EX.units[2].name].statementId,
      theirBalanceFen: EX.replies.bing.theirBalanceFen,
      theirEntries: EX.replies.bing.detail,
      channel: 'manual',
    });
    diffOf.bing = d3.data.diffResult;
    H.check('丙：余额差 0', diffOf.bing.balanceDiffFen, 0);
    H.check('丙：组合匹配 1 组', diffOf.bing.levels.l3, 1);
    H.check('丙：组合含 5 笔我方明细', diffOf.bing.combos[0].our.length, 5);
    H.check('丙：无剩余', diffOf.bing.ourOnly.length + diffOf.bing.theirOnly.length, 0);
  }

  H.section('第 6 步：确认归档 + 差异报告落盘');
  {
    const list0 = await jget(B, '/api/replies');
    H.check('勾对后回函已自动入库（3 份）', list0.data.length, 3);
    const yiReply = list0.data.find((x) => x.statementId === stmtOf[EX.units[1].name].statementId);
    H.check('乙的回函已入库', !!yiReply, true);
    H.check('乙的回函状态是 draft', yiReply.status, 'draft');

    // 回函可二次编辑（带 id 即更新，不会多出一条）
    const upd = await jpost(B, '/api/replies', { id: yiReply.id, statementId: yiReply.statementId, theirBalanceFen: yiReply.theirBalanceFen, theirEntries: yiReply.theirEntries, note: '对方 9/6 电话补充说明' });
    H.check('按 id 更新回函（不新增记录）', upd.data.id, yiReply.id);
    H.check('备注已写入', upd.data.note, '对方 9/6 电话补充说明');
    const list1 = await jget(B, '/api/replies');
    H.check('回函条数仍为 3', list1.data.length, 3);

    const c = await jpost(B, '/api/diff/confirm', { replyId: yiReply.id, confirmedBy: '王会计', note: '已电话确认，差异为对方未入账' });
    H.check('确认后状态 confirmed', c.data.status, 'confirmed');
    H.check('记录了确认人', c.data.confirmedBy, '王会计');

    const st = statementModStatement(B, stmtOf[EX.units[1].name].statementId);
    void st;
    const detail = await jget(B, '/api/archive/' + stmtOf[EX.units[1].name].statementId + '/detail');
    H.check('归档目录含 PDF', detail.data.files.some((f) => /\.pdf$/.test(f.name)), true);
    H.check('归档目录含 Excel', detail.data.files.some((f) => /\.xlsx$/.test(f.name)), true);
    H.check('归档目录含差异报告 JSON', detail.data.files.some((f) => /差异报告\.json$/.test(f.name)), true);
    H.check('归档目录含差异报告 HTML', detail.data.files.some((f) => /差异报告\.html$/.test(f.name)), true);
    H.check('差异报告内容含未匹配明细', /己方有、对方无/.test((detail.data.reports[0] || {}).html || ''), true);
    H.check('归档详情带到确认人', detail.data.replies.some((x) => x.confirmedBy === '王会计'), true);
  }

  H.section('第 7 步：归档树与统计的最终状态');
  {
    const tree = await jget(B, '/api/archive/tree');
    H.check('归档树 3 家单位', tree.data.length, 3);
    const jia = tree.data.find((t) => t.unitId === U.jia.id);
    H.check('甲有 2026-08 期间', jia.periods[0].period, EX.period);
    H.check('甲有 v1', jia.periods[0].versions[0].version, 1);
    const st = await jget(B, '/api/stats');
    H.check('最终：3 家单位', st.data.units, 3);
    H.check('最终：3 份对账函', st.data.statements, 3);
    H.check('最终：3 份回函', st.data.replies, 3);
    H.check('最终：1 份已确认', st.data.confirmed, 1);
    H.check('最终：归档目录有体积', st.data.archiveBytes > 10000, true);
  }

  H.section('第 8 步：整批打包下载（会计直接拿去打印寄出）');
  {
    const sessions = await jget(B, '/api/sessions');
    H.check('有 1 个批次', sessions.data.length, 1);
    const zip = await fetch(B + '/api/statements/batchZip?sessionId=' + sessions.data[0].id);
    const buf = Buffer.from(await zip.arrayBuffer());
    H.check('zip 下载成功', zip.status, 200);
    H.check('zip 体积 > 100KB', buf.length > 100000, true);
    // zip 里是压缩数据，看不到 %PDF 明文；改为数本地文件头（PK\x03\x04）与文件名字节
    const pkCount = buf.toString('latin1').split('PK\u0003\u0004').length - 1;
    H.check('zip 内含 3 家 × (pdf+xlsx) 共 6 个文件头', pkCount >= 6, true);
    H.check('zip 内有「_对账函.pdf」文件名', buf.indexOf(Buffer.from('_对账函.pdf', 'utf8')) >= 0, true);
    H.check('zip 内有「_对账函.xlsx」文件名', buf.indexOf(Buffer.from('_对账函.xlsx', 'utf8')) >= 0, true);
  }

  await srv.close();
  console.log('\n测试数据目录: ' + process.env.DZ_DATA);
  H.finish('t8_e2e');
})();

function statementModStatement() {
  return null;
}
