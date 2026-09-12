'use strict';
/*
 * archive.js — 归档与历史查询
 * 归档只增不删：按 单位 → 期间 → 版本 树形浏览，旧版本永远可查。
 * 「数据备份」按钮产出整包 zip（含 imports/archive 原件）；
 * 「从备份恢复」只支持 JSON 快照（backups/ 下自动备份），整包 zip 供人工取用。
 */

const fs = require('fs');
const path = require('path');

const store = require('./store');
const money = require('./money');
const statementMod = require('./statement');
const matcher = require('./matcher');
const unitsMod = require('./units');
const exporter = require('./exporter');

function tree() {
  const stmts = statementMod.allStatements();
  const byUnit = new Map();
  for (const s of stmts) {
    if (!byUnit.has(s.unitId)) byUnit.set(s.unitId, new Map());
    const periods = byUnit.get(s.unitId);
    if (!periods.has(s.period)) periods.set(s.period, []);
    periods.get(s.period).push(s);
  }
  const out = [];
  for (const [unitId, periods] of byUnit) {
    const unit = unitsMod.get(unitId) || { id: unitId, name: '（单位档案已不存在）', type: '' };
    const periodList = [];
    for (const [period, list] of periods) {
      list.sort((a, b) => b.version - a.version);
      const replies = matcher.allReplies();
      periodList.push({
        period,
        versions: list.map((s) => {
          const r = replies.filter((x) => x.statementId === s.id);
          const confirmed = r.filter((x) => x.status === 'confirmed');
          return {
            statementId: s.id,
            serialNo: s.serialNo,
            version: s.version,
            direction: s.direction,
            cutoffDate: s.cutoffDate,
            createdAt: s.createdAt,
            ourBalanceFen: s.ourBalanceFen,
            ourBalanceText: money.fenToStr(s.ourBalanceFen),
            hasPdf: !!s.pdfPath,
            hasXlsx: !!s.xlsxPath,
            pdfDegraded: !!s.pdfDegraded,
            detailCount: s.detailCount,
            replyCount: r.length,
            confirmedCount: confirmed.length,
            status: confirmed.length ? 'confirmed' : r.length ? 'draft' : 'pending',
          };
        }),
      });
    }
    periodList.sort((a, b) => String(b.period).localeCompare(String(a.period)));
    out.push({ unit, unitId, periods: periodList, statementCount: periodList.reduce((a, p) => a + p.versions.length, 0) });
  }
  out.sort((a, b) => String(a.unit.name).localeCompare(String(b.unit.name), 'zh'));
  return out;
}

function detail(stmtId) {
  const stmt = statementMod.getStatement(stmtId);
  if (!stmt) throw new Error('对账函不存在');
  const unit = unitsMod.get(stmt.unitId);
  const replies = matcher.listReplies({ statementId: stmtId });
  const dir = stmt.archivedDir || statementMod.archiveDir(stmt.unitId, stmt.period, stmt.version);
  let files = [];
  try {
    files = fs.readdirSync(dir).map((f) => {
      const p = path.join(dir, f);
      return { name: f, bytes: fs.statSync(p).size };
    });
  } catch (_) {
    files = [];
  }
  const reports = files
    .filter((f) => f.name.endsWith('_差异报告.html'))
    .map((f) => ({ name: f.name, html: fs.readFileSync(path.join(dir, f.name), 'utf8') }));
  return {
    statement: stmt,
    unit,
    replies,
    archiveDir: dir,
    files,
    reports,
    pdfAvailable: !!(stmt.pdfPath && fs.existsSync(stmt.pdfPath)),
  };
}

/** 整包备份 data/ → data/exports/backup_时间戳.zip */
async function fullBackup() {
  const out = path.join(store.DATA, 'exports', 'backup_' + store.ts() + '.zip');
  const r = await exporter.zipDataDir(out);
  store.log('[OK] 整包备份完成：' + path.basename(out) + '（' + Math.round(r.bytes / 1024) + ' KB）');
  return r;
}

function stats() {
  const led = store.readJson('ledgers.json', []);
  const stmts = statementMod.allStatements();
  const replies = store.readJson('replies.json', []);
  return {
    units: unitsMod.all().length,
    ledgerEntries: led.length,
    openings: store.readJson('openings.json', []).length,
    batches: new Set(led.map((e) => e.importBatch)).size,
    sessions: store.readJson('sessions.json', []).length,
    statements: stmts.length,
    replies: replies.length,
    confirmed: replies.filter((r) => r.status === 'confirmed').length,
    dataBytes: store.dirSize(store.DATA),
    archiveBytes: store.dirSize(path.join(store.DATA, 'archive')),
    backups: store.listBackups().slice(0, 20),
    backupCount: store.listBackups().length,
  };
}

module.exports = { tree, detail, fullBackup, stats };
