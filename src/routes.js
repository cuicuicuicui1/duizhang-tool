'use strict';
/*
 * routes.js — 全部 API 路由
 * 统一返回 { ok, data, err }；文件上传走 JSON + base64（避免引入 multer，也方便 jsdom 测试）。
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const store = require('./store');
const configMod = require('./config');
const unitsMod = require('./units');
const importer = require('./importer');
const ledger = require('./ledger');
const templates = require('./templates');
const mapTemplates = require('./mapTemplates');
const statementMod = require('./statement');
const exporter = require('./exporter');
const matcher = require('./matcher');
const replyAdapter = require('./replyAdapter');
const archiveMod = require('./archive');

const router = express.Router();

function ok(res, data) {
  res.json({ ok: true, data: data === undefined ? null : data, err: '' });
}
function bad(res, err, code) {
  res.status(code || 400).json({ ok: false, data: null, err: String(err && err.message ? err.message : err) });
}
/** 统一包装 async handler 的异常 */
function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      store.log('[!!] API 异常 ' + req.method + ' ' + req.originalUrl + '：' + e.message);
      bad(res, e, 500);
    }
  };
}
function bufFrom(req) {
  const b = req.body || {};
  if (!b.contentBase64) throw new Error('缺少文件内容');
  const clean = String(b.contentBase64).replace(/^data:[^;]+;base64,/, '');
  return { buffer: Buffer.from(clean, 'base64'), filename: b.filename || 'upload.xlsx' };
}

// ---------------------------------------------------------------- 基础
router.get('/health', (req, res) => ok(res, { status: 'up', at: store.isoNow(), node: process.version }));

router.get('/stats', wrap((req, res) => ok(res, archiveMod.stats())));

router.get('/config', wrap((req, res) => ok(res, { config: configMod.getConfig(), options: configMod.OPTIONS })));
router.put('/config', wrap((req, res) => ok(res, configMod.saveConfig(req.body || {}))));
router.post('/config/reset', wrap((req, res) => ok(res, configMod.resetConfig())));

router.get('/browser', wrap((req, res) => ok(res, exporter.probeBrowser(true))));

// ---------------------------------------------------------------- 单位档案
router.get('/units', wrap((req, res) => ok(res, unitsMod.all().map((u) => Object.assign({}, u, { overview: unitsMod.overview(u.id) })))));
router.post('/units', wrap((req, res) => {
  const b = req.body || {};
  const u = unitsMod.create({
    name: b.name,
    type: b.type,
    contact: b.contact,
    phone: b.phone,
    address: b.address,
    taxNo: b.taxNo,
    note: b.note,
    alias: b.alias,
  });
  // 手工录入的期初余额（balanceMode = manual_opening 时用）
  if (Number.isInteger(b.openingFen) && b.openingFen !== 0) {
    const list = store.readJson('openings.json', []);
    list.push({
      id: store.nextId('op'),
      unitId: u.id,
      account: b.account || '',
      date: b.openingDate || null,
      openingFen: b.openingFen,
      source: 'manual',
      importBatch: '',
      note: '单位档案手工录入',
    });
    store.writeJson('openings.json', list);
  }
  ok(res, u);
}));
router.get('/units/:id', wrap((req, res) => {
  const u = unitsMod.get(req.params.id);
  if (!u) return bad(res, '单位不存在', 404);
  ok(res, Object.assign({}, u, { overview: unitsMod.overview(u.id), accounts: ledger.accountsOf(u.id) }));
}));
router.put('/units/:id', wrap((req, res) => ok(res, unitsMod.update(req.params.id, req.body || {}))));
router.delete('/units/:id', wrap((req, res) => ok(res, unitsMod.remove(req.params.id))));
router.post('/units/:id/alias', wrap((req, res) => ok(res, unitsMod.addAlias(req.params.id, (req.body || {}).alias))));

/** 手工录入/修改期初余额 */
router.get('/openings', wrap((req, res) => {
  let list = store.readJson('openings.json', []);
  if (req.query.unitId) list = list.filter((o) => o.unitId === req.query.unitId);
  ok(res, list);
}));
router.post('/openings', wrap((req, res) => {
  const b = req.body || {};
  if (!b.unitId) return bad(res, '缺少 unitId');
  if (!Number.isInteger(b.openingFen)) return bad(res, '期初余额必须是整数分');
  const list = store.readJson('openings.json', []);
  const rec = {
    id: b.id || store.nextId('op'),
    unitId: b.unitId,
    account: b.account || '',
    date: b.date || null,
    openingFen: b.openingFen,
    source: b.source || 'manual',
    importBatch: '',
    note: b.note || '手工录入',
  };
  const i = list.findIndex((o) => o.id === rec.id);
  if (i >= 0) list[i] = rec;
  else list.push(rec);
  store.writeJson('openings.json', list);
  ok(res, rec);
}));

// ---------------------------------------------------------------- 导入
router.post('/import/preview', wrap((req, res) => {
  const { buffer, filename } = bufFrom(req);
  ok(res, importer.analyze({ buffer, filename, config: configMod.getConfig() }));
}));
router.post('/import/commit', wrap((req, res) => {
  const { buffer, filename } = bufFrom(req);
  const b = req.body || {};
  if (!Array.isArray(b.plans) || !b.plans.length) return bad(res, '缺少导入计划 plans');
  ok(
    res,
    importer.commit({
      buffer,
      filename,
      plans: b.plans,
      force: !!b.force,
      dryRun: !!b.dryRun,
      config: configMod.getConfig(),
      units: unitsMod.all(),
    })
  );
}));

// ------------------------------------------------ 列映射模板（开源共享）
router.get('/map-templates', wrap((req, res) => ok(res, mapTemplates.all())));
router.post('/map-templates', wrap((req, res) => {
  const r = mapTemplates.upsert(req.body || {});
  if (!r.ok) return bad(res, r.err);
  store.log('[OK] 保存列映射模板「' + r.template.name + '」');
  ok(res, r.template);
}));
router.post('/map-templates/import', wrap((req, res) => ok(res, mapTemplates.importFrom(req.body))));
router.post('/map-templates/:id/use', wrap((req, res) => {
  const rec = mapTemplates.markUsed(req.params.id);
  if (!rec) return bad(res, '模板不存在');
  ok(res, rec);
}));
router.delete('/map-templates/:id', wrap((req, res) => {
  const r = mapTemplates.remove(req.params.id);
  if (!r.ok) return bad(res, r.err);
  ok(res, { deleted: req.params.id });
}));
router.get('/map-templates/export', wrap((req, res) => {
  // 导出全部或指定模板为 JSON 文件（社区分享的载体）
  const ids = req.query.ids ? String(req.query.ids).split(',') : null;
  let list = mapTemplates.all();
  if (ids) list = list.filter((t) => ids.includes(t.id));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="dz-map-templates.json"');
  res.send(JSON.stringify(list, null, 2));
}));

// ---------------------------------------------------------------- 余额与账
router.get('/ledger/periods', wrap((req, res) => ok(res, ledger.periods())));
router.get('/ledger/balance', wrap((req, res) => {
  const q = req.query;
  if (!q.unitId) return bad(res, '缺少 unitId');
  ok(
    res,
    ledger.computeUnitBalance(q.unitId, {
      cutoff: q.cutoff || '',
      direction: q.direction || 'receivable',
      from: q.from || '',
      config: configMod.getConfig(),
    })
  );
}));
router.get('/ledger/balances', wrap((req, res) => {
  const q = req.query;
  ok(res, ledger.listBalances(q.cutoff || '', q.direction || 'receivable'));
}));
router.get('/ledger/entries', wrap((req, res) => {
  const q = req.query;
  if (!q.unitId) return bad(res, '缺少 unitId');
  ok(res, ledger.entriesOf(q.unitId, { account: q.account || '', cutoff: q.cutoff || '' }));
}));

// ---------------------------------------------------------------- 模板
router.get('/templates/list', wrap((req, res) => ok(res, templates.listTemplates())));
router.get('/templates/raw', wrap((req, res) => {
  const file = req.query.file;
  if (!file) return bad(res, '缺少 file');
  if (/[\\/]/.test(file)) return bad(res, '非法文件名');
  ok(res, { file, content: fs.readFileSync(path.join(store.ROOT, 'templates', file), 'utf8') });
}));
router.put('/templates/raw', wrap((req, res) => {
  const b = req.body || {};
  if (!b.file || /[\\/]/.test(b.file)) return bad(res, '非法文件名');
  store.backup('改模板前');
  fs.writeFileSync(path.join(store.ROOT, 'templates', b.file), String(b.content || ''), 'utf8');
  ok(res, { file: b.file, bytes: Buffer.byteLength(String(b.content || '')) });
}));
router.post('/templates/preview', wrap((req, res) => {
  const b = req.body || {};
  const cfg = configMod.getConfig();
  const direction = b.direction === 'payable' ? 'payable' : 'receivable';
  const cutoff = b.cutoffDate || new Date().toISOString().slice(0, 10);
  const units = unitsMod.all();
  const unit = b.unitId ? unitsMod.get(b.unitId) : units[0];
  if (!unit) return bad(res, '还没有任何往来单位档案，请先建档或导入数据');
  const balance = ledger.computeUnitBalance(unit.id, {
    cutoff,
    direction,
    from: cutoff.slice(0, 7) + '-01',
    config: cfg,
  });
  const session = { id: 'preview', period: cutoff.slice(0, 7), cutoffDate: cutoff, direction };
  const statement = { serialNo: 'DZH-PREVIEW-0001', version: 1, issueDate: cutoff };
  const html = templates.renderStatement({ unit, balance, session, config: cfg, statement });
  ok(res, { html, unit: unit.name, balance, balanceText: require('./money').fenToStr(balance.absFen) });
}));

// ---------------------------------------------------------------- 批次与生成
router.get('/sessions', wrap((req, res) => ok(res, statementMod.listSessions())));
router.post('/sessions', wrap((req, res) => ok(res, statementMod.createSession(req.body || {}))));
router.get('/sessions/:id', wrap((req, res) => {
  const s = statementMod.getSession(req.params.id);
  if (!s) return bad(res, '批次不存在', 404);
  ok(res, { session: s, statements: statementMod.listBySession(s.id) });
}));
router.post('/statements/generate', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.cutoffDate) return bad(res, '必须指定对账截止日');
  if (!Array.isArray(b.unitIds) || !b.unitIds.length) return bad(res, '请至少勾选一家单位');
  const r = await statementMod.generate({
    sessionId: b.sessionId,
    unitIds: b.unitIds,
    cutoffDate: b.cutoffDate,
    direction: b.direction,
    period: b.period,
    config: configMod.getConfig(),
  });
  ok(res, r);
}));
router.get('/statements/:id/file', wrap((req, res) => {
  const fmt = req.query.fmt || 'pdf';
  const p = statementMod.fileOf(req.params.id, fmt);
  const stmt = statementMod.getStatement(req.params.id);
  const ext = path.extname(p) || '.' + fmt;
  const safeName = (stmt ? stmt.serialNo : 'statement') + '_对账函' + ext;
  res.setHeader('Content-Type', ext === '.pdf' ? 'application/pdf' : ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(safeName) + '"');
  fs.createReadStream(p).pipe(res);
}));
router.get('/statements/batchZip', wrap(async (req, res) => {
  const r = await statementMod.batchZip(req.query.sessionId);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(r.path) + '"');
  fs.createReadStream(r.path).pipe(res);
}));
/** 生成前查看该批次会放出什么（HTML 预览，不落盘） */
router.get('/statements/:id/html', wrap((req, res) => {
  const stmt = statementMod.getStatement(req.params.id);
  if (!stmt) return bad(res, '对账函不存在', 404);
  const cfg = configMod.getConfig();
  const unit = unitsMod.get(stmt.unitId);
  const session = { period: stmt.period, cutoffDate: stmt.cutoffDate, direction: stmt.direction };
  const balance = ledger.computeUnitBalance(stmt.unitId, { cutoff: stmt.cutoffDate, direction: stmt.direction, from: stmt.period + '-01', config: cfg });
  ok(res, { html: templates.renderStatement({ unit, balance, session, config: cfg, statement: stmt }) });
}));

// ---------------------------------------------------------------- 回函
router.get('/replies', wrap((req, res) => ok(res, matcher.listReplies(req.query))));
router.get('/replies/:id', wrap((req, res) => {
  const r = matcher.getReply(req.params.id);
  if (!r) return bad(res, '回函记录不存在', 404);
  ok(res, r);
}));
router.post('/replies', wrap((req, res) => ok(res, matcher.saveReply(req.body || {}))));

router.get('/reply/maps', wrap((req, res) => ok(res, replyAdapter.listMaps({ unitId: req.query.unitId }))));
router.post('/reply/maps', wrap((req, res) => ok(res, replyAdapter.saveMap(req.body || {}))));
router.delete('/reply/maps/:id', wrap((req, res) => ok(res, replyAdapter.removeMap(req.params.id))));
router.get('/reply/maps/export', wrap((req, res) => ok(res, replyAdapter.exportMaps())));
router.post('/reply/maps/import', wrap((req, res) => ok(res, replyAdapter.importMaps(req.body || {}))));

router.post('/reply/analyze', wrap((req, res) => {
  const { buffer, filename } = bufFrom(req);
  ok(res, replyAdapter.analyzeReplyFile({ buffer, filename, unitId: (req.body || {}).unitId, config: configMod.getConfig() }));
}));
router.post('/reply/parse', wrap((req, res) => {
  const b = req.body || {};
  const cfg = configMod.getConfig();
  if (b.text) {
    ok(res, replyAdapter.entriesFromPaste(b.text, { signFlip: !!b.signFlip, config: cfg }));
    return;
  }
  const { buffer, filename } = bufFrom(req);
  ok(
    res,
    replyAdapter.parseReplySheet({
      buffer,
      filename,
      unitId: b.unitId,
      sheetName: b.sheetName,
      headerRowNo: b.headerRowNo,
      mapping: b.mapping,
      signFlip: !!b.signFlip,
      config: cfg,
    })
  );
}));

// ---------------------------------------------------------------- 勾对
router.post('/diff/run', wrap((req, res) => {
  const b = req.body || {};
  if (!b.statementId) return bad(res, '缺少 statementId');
  ok(res, matcher.runAndSave(Object.assign({}, b, { config: configMod.getConfig() })));
}));
router.post('/diff/confirm', wrap((req, res) => {
  const b = req.body || {};
  if (!b.replyId) return bad(res, '缺少 replyId');
  ok(res, matcher.confirm(b));
}));
router.get('/diff/report', wrap((req, res) => {
  const r = matcher.getReply(req.query.replyId);
  if (!r) return bad(res, '回函记录不存在', 404);
  if (!r.diffResult) return bad(res, '该回函还没有勾对结果');
  const stmt = statementMod.getStatement(r.statementId);
  const payload = {
    statement: stmt
      ? {
          serialNo: stmt.serialNo,
          unitName: stmt.unitName,
          period: stmt.period,
          direction: stmt.direction,
          cutoffDate: stmt.cutoffDate,
          version: stmt.version,
          ourBalanceFen: stmt.ourBalanceFen,
        }
      : {},
    reply: {
      id: r.id,
      theirBalanceFen: r.theirBalanceFen,
      channel: r.channel,
      signFlip: r.signFlip,
      replyDate: r.replyDate,
      replyFile: r.replyFile,
    },
    diffResult: r.diffResult,
    confirmedBy: r.confirmedBy,
    confirmedAt: r.confirmedAt,
    decisions: r.decisions || [],
    note: r.confirmNote || '',
  };
  ok(res, { report: payload, html: matcher.renderReportHtml(payload) });
}));

// ---------------------------------------------------------------- 归档 / 备份
router.get('/archive/tree', wrap((req, res) => ok(res, archiveMod.tree())));
router.get('/archive/:stmtId/detail', wrap((req, res) => ok(res, archiveMod.detail(req.params.stmtId))));
router.get('/backups', wrap((req, res) => ok(res, store.listBackups())));
router.post('/backup', wrap(async (req, res) => ok(res, await archiveMod.fullBackup())));
router.post('/backup/json', wrap((req, res) => ok(res, store.backup('手工备份'))));
router.post('/restore', wrap((req, res) => {
  const b = req.body || {};
  if (!b.name) return bad(res, '缺少备份名称');
  ok(res, store.restore(b.name));
}));

module.exports = router;
