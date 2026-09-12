'use strict';
/*
 * t6_ops.js — 层 5「运维操作」：走真实 HTTP 服务
 * 覆盖：备份/恢复往返、重复导入幂等、版本递增、删除保护、静态资源、错误返回结构
 */

const path = require('path');
const fs = require('fs');

const RUN = path.join(__dirname, '.run', 'ops_' + Date.now());
process.env.DZ_DATA = path.join(RUN, 'data');
process.env.DZ_BACKUP = path.join(RUN, 'backups');
process.env.DZ_NO_OPEN = '1';

const H = require('./_harness');
const { startServer, jget, jpost, jput, jdel } = require('./_server');
const samples = require('../make_samples');

const SAMPLE_DIR = path.join(__dirname, '..', '..', 'samples');
const E = {};
for (const u of samples.EXPECTED.units) E[u.key] = u;

function b64(name) {
  return fs.readFileSync(path.join(SAMPLE_DIR, name)).toString('base64');
}

(async () => {
  const srv = await startServer();
  const B = srv.url;
  console.log('测试服务: ' + B);

  H.section('健康检查与静态资源');
  {
    const h = await jget(B, '/api/health');
    H.check('health ok', h.ok, true);
    const r = await fetch(B + '/');
    const html = await r.text();
    H.check('首页 200', r.status, 200);
    H.check('首页含标题', /往来单位对账函工具/.test(html), true);
    for (const f of ['/style.css', '/app.js', '/tabs.js', '/templates/common.css']) {
      const rr = await fetch(B + f);
      H.check('静态资源可访问 ' + f, rr.status, 200);
    }
    const nf = await jget(B, '/api/not-exist');
    H.check('未知接口返回标准错误结构', nf.ok, false);
    H.check('未知接口 err 可读', /接口不存在/.test(nf.err), true);
  }

  H.section('建档与配置');
  let units = {};
  {
    for (const u of samples.EXPECTED.units) {
      const r = await jpost(B, '/api/units', { name: u.name, type: u.type });
      H.check('建档成功 ' + u.name, r.ok, true);
      units[u.key] = r.data;
    }
    const cf = await jget(B, '/api/config');
    H.check('配置可取', !!cf.data.config, true);
    H.check('口径选项齐全', cf.data.options.balanceMode.choices.length >= 5, true);
    const put = await jput(B, '/api/config', { company: samples.EXPECTED.ourCompany });
    H.check('保存公司信息', put.data.company.name, samples.EXPECTED.ourCompany.name);
  }

  H.section('导入（HTTP 上传）与幂等');
  {
    const name = 's01_标准明细账_' + E.jia.name + '.xlsx';
    const pv = await jpost(B, '/api/import/preview', { filename: name, contentBase64: b64(name) });
    H.check('预览成功', pv.ok, true);
    H.check('识别到表头行', pv.data.sheets[0].headerRowNo, 4);
    const s = pv.data.sheets[0];
    const plan = { sheetName: s.name, include: true, headerRow: s.headerRowNo, mapping: s.mapping, unitId: units.jia.id, account: E.jia.account };

    const c1 = await jpost(B, '/api/import/commit', { filename: name, contentBase64: b64(name), plans: [plan] });
    H.check('首次入库 4 条', c1.data.added, 4);
    const c2 = await jpost(B, '/api/import/commit', { filename: name, contentBase64: b64(name), plans: [plan] });
    H.check('重复导入新增 0 条', c2.data.added, 0);
    H.check('重复导入全部判重', c2.data.dupSkipped, 4);
    const dry = await jpost(B, '/api/import/commit', { filename: name, contentBase64: b64(name), plans: [plan], dryRun: true });
    H.check('试算不入库', dry.data.wouldAdd, 0);
    const bad = await jpost(B, '/api/import/preview', { filename: 'x.xlsx' });
    H.check('缺文件内容 → 400 且结构标准', bad.ok, false);
  }

  H.section('余额与单位信息');
  {
    const b = await jget(B, '/api/ledger/balance?unitId=' + units.jia.id + '&cutoff=2026-08-31&direction=receivable');
    H.check('余额接口返回', b.data.signedFen, E.jia.closingFen);
    const list = await jget(B, '/api/ledger/balances?cutoff=2026-08-31&direction=receivable');
    H.check('余额列表 1 家', list.data.length, 1);
    const ov = await jget(B, '/api/units/' + units.jia.id);
    H.check('单位详情含科目', ov.data.accounts.length >= 1, true);
    const pp = await jget(B, '/api/ledger/periods');
    H.check('期间列表含 2026-08', pp.data.indexOf('2026-08') >= 0, true);
  }

  H.section('生成对账函 + 版本递增 + 文件下载');
  let st1;
  {
    const g1 = await jpost(B, '/api/statements/generate', { unitIds: [units.jia.id], cutoffDate: '2026-08-31', direction: 'receivable', period: '2026-08' });
    H.check('生成成功', g1.data.okCount, 1);
    st1 = g1.data.results[0];
    H.check('版本 1', st1.version, 1);

    const g2 = await jpost(B, '/api/statements/generate', { unitIds: [units.jia.id], cutoffDate: '2026-08-31', direction: 'receivable', period: '2026-08' });
    H.check('重复生成版本递增到 2', g2.data.results[0].version, 2);
    H.check('旧版本仍在（只增不删）', fs.existsSync(path.join(process.env.DZ_DATA, 'archive', units.jia.id, '2026-08', 'v1')), true);

    const pdf = await fetch(B + '/api/statements/' + st1.statementId + '/file?fmt=pdf');
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    H.check('PDF 下载 200', pdf.status, 200);
    H.check('PDF 魔数正确', pdfBuf.slice(0, 4).toString(), '%PDF');
    const xlsx = await fetch(B + '/api/statements/' + st1.statementId + '/file?fmt=xlsx');
    const xBuf = Buffer.from(await xlsx.arrayBuffer());
    H.check('Excel 下载 200', xlsx.status, 200);
    H.check('xlsx 是 zip 包（PK 魔数）', xBuf.slice(0, 2).toString(), 'PK');
    const html = await jget(B, '/api/statements/' + st1.statementId + '/html');
    H.check('同名 HTML 预览可取', /对 账 函|对账函/.test(html.data.html), true);

    const zip = await fetch(B + '/api/statements/batchZip?sessionId=' + g2.data.session.id);
    const zBuf = Buffer.from(await zip.arrayBuffer());
    H.check('zip 下载 200', zip.status, 200);
    H.check('zip 是 zip 包', zBuf.slice(0, 2).toString(), 'PK');
    H.check('zip 有体积', zBuf.length > 5000, true);
  }

  H.section('回函 + 勾对 + 确认（HTTP）');
  {
    const r = await jpost(B, '/api/diff/run', {
      statementId: st1.statementId,
      theirBalanceFen: E.jia.closingFen,
      theirEntries: samples.EXPECTED.replies.jia.detail,
      channel: 'manual',
    });
    H.check('勾对成功且余额一致', r.data.diffResult.balanceDiffFen, 0);
    const rep = await jget(B, '/api/diff/report?replyId=' + r.data.reply.id);
    H.check('差异报告 HTML 可取', /往来对账差异报告/.test(rep.data.html), true);
    const cf = await jpost(B, '/api/diff/confirm', { replyId: r.data.reply.id, confirmedBy: '测试会计', note: '确认' });
    H.check('确认后状态', cf.data.status, 'confirmed');
    const noReply = await jget(B, '/api/diff/report?replyId=r_none');
    H.check('不存在的回函 → 标准错误', noReply.ok, false);
  }

  H.section('备份 → 改数据 → 恢复（往返一致）');
  {
    const before = await jget(B, '/api/units');
    const beforeNames = before.data.map((u) => u.name).sort();

    const bk = await jpost(B, '/api/backup/json', {});
    H.check('JSON 快照备份成功', bk.data.files >= 4, true);

    const added = await jpost(B, '/api/units', { name: '临时插入单位有限公司', type: 'customer' });
    H.check('插入新单位成功', added.ok, true);
    const mid = await jget(B, '/api/units');
    H.check('数据已改变', mid.data.length, beforeNames.length + 1);

    const rs = await jpost(B, '/api/restore', { name: bk.data.name });
    H.check('恢复成功', rs.ok, true);
    H.check('恢复前自动再备份一次', /restore前自动备份/.test(rs.data.name), true);

    const after = await jget(B, '/api/units');
    H.check('数据回到备份时点', after.data.map((u) => u.name).sort(), beforeNames);
    const afterLed = await jget(B, '/api/ledger/balance?unitId=' + units.jia.id + '&cutoff=2026-08-31&direction=receivable');
    H.check('明细也一起回滚', afterLed.data.signedFen, E.jia.closingFen);

    const list = await jget(B, '/api/backups');
    H.check('备份列表可取', list.data.length >= 2, true);
    const rbad = await jpost(B, '/api/restore', { name: 'no-such-backup' });
    H.check('恢复不存在的备份 → 报错', rbad.ok, false);
  }

  H.section('整包 zip 备份');
  {
    const z = await jpost(B, '/api/backup', {});
    H.check('整包备份成功', z.data.ok, true);
    H.check('zip 落盘且有名', fs.existsSync(z.data.path), true);
    H.check('zip 体积合理', z.data.bytes > 1000, true);
  }

  H.section('删除保护与统计');
  {
    const del = await jdel(B, '/api/units/' + units.jia.id);
    H.check('有数据的单位不能删除', del.ok, false);
    H.check('给出可读原因', /不能删除/.test(del.err), true);
    const del2 = await jdel(B, '/api/units/u_not_exist');
    H.check('删不存在的单位 → 报错', del2.ok, false);

    const st = await jget(B, '/api/stats');
    H.check('统计：单位数', st.data.units, 3);
    H.check('统计：对账函数 = 2', st.data.statements, 2);
    H.check('统计：已确认 1', st.data.confirmed, 1);
    const tr = await jget(B, '/api/archive/tree');
    H.check('归档树可取', tr.data.length >= 1, true);
    const dt = await jget(B, '/api/archive/' + st1.statementId + '/detail');
    H.check('归档详情含差异报告', (dt.data.reports || []).length >= 1, true);
    H.check('归档详情文件清单非空', dt.data.files.length >= 3, true);
  }

  H.section('模板接口');
  {
    const list = await jget(B, '/api/templates/list');
    H.check('模板清单 3 个以上', list.data.length >= 3, true);
    const raw = await jget(B, '/api/templates/raw?file=receivable.html');
    H.check('模板原文可取', /回 函 联/.test(raw.data.content) && /\{\{directionTitle\}\}/.test(raw.data.content), true);
    const prev = await jpost(B, '/api/templates/preview', { direction: 'receivable', unitId: units.jia.id, cutoffDate: '2026-08-31' });
    H.check('模板预览可渲染', /柒万元整/.test(prev.data.html), true);
    const path = await jget(B, '/api/templates/raw?file=../../package.json');
    H.check('模板文件名做了路径校验', path.ok, false);
  }

  await srv.close();
  console.log('\n测试数据目录: ' + process.env.DZ_DATA);
  H.finish('t6_ops');
})();
