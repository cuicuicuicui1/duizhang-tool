'use strict';
/*
 * statement.js — 批量生成对账函
 * 版本化只增不删（计划 §4.4）：同单位同期间同方向重复生成 → version+1，旧版本永久可查。
 * 编号规则默认 DZH-{yyyymmdd}-{4位序号}，序号按「当日全局自增」，
 * 避免同一截止日的两个批次各自从 0001 起导致重号。
 */

const fs = require('fs');
const path = require('path');

const store = require('./store');
const money = require('./money');
const ledger = require('./ledger');
const templates = require('./templates');
const exporter = require('./exporter');
const unitsMod = require('./units');
const configMod = require('./config');

function allStatements() {
  return store.readJson('statements.json', []);
}
function allSessions() {
  return store.readJson('sessions.json', []);
}

function listSessions() {
  const stmts = allStatements();
  return allSessions()
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((s) => {
      const mine = stmts.filter((x) => x.sessionId === s.id);
      return Object.assign({}, s, {
        statementCount: mine.length,
        unitCount: mine.length,
        confirmedCount: require('./matcher').confirmedCountOf(s.id),
      });
    });
}

function getSession(id) {
  return allSessions().find((s) => s.id === id) || null;
}

function createSession(input) {
  const list = allSessions();
  const s = {
    id: store.nextId('s'),
    period: input.period || (input.cutoffDate ? String(input.cutoffDate).slice(0, 7) : ''),
    cutoffDate: input.cutoffDate || '',
    direction: input.direction === 'payable' ? 'payable' : 'receivable',
    unitIds: input.unitIds || [],
    note: input.note || '',
    createdAt: store.isoNow(),
  };
  list.push(s);
  store.writeJson('sessions.json', list);
  return s;
}

/** 编号：{yyyymmdd} 取生成日，序号按当日全局自增 */
function buildSerialNo(rule, dateStr) {
  const day = (dateStr || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const seq = store.nextSeq('serial_' + day, 1);
  const seq4 = String(seq).padStart(4, '0');
  return String(rule || 'DZH-{yyyymmdd}-{seq4}').replace('{yyyymmdd}', day).replace('{seq4}', seq4).replace('{seq}', String(seq));
}

function nextVersion(unitId, period, direction) {
  const list = allStatements().filter((s) => s.unitId === unitId && s.period === period && s.direction === direction);
  return list.reduce((m, s) => Math.max(m, Number(s.version) || 0), 0) + 1;
}

function archiveDir(unitId, period, version) {
  return path.join(store.DATA, 'archive', unitId, period || 'unknown', 'v' + version);
}

/** 受限并发池（PDF 打印是子进程调用，天然适合并发；并发数可配） */
async function pool(items, concurrency, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const run = async (slot) => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i, slot);
    }
  };
  const n = Math.max(1, Math.min(concurrency || 1, items.length));
  await Promise.all(Array.from({ length: n }, (_v, s) => run(s)));
  return out;
}

/**
 * 生成一批对账函
 * @param {{unitIds:string[], cutoffDate:string, direction:string, period:string, sessionId:string}} input
 */
async function generate(input) {
  const cfg = input.config || configMod.getConfig();
  const direction = input.direction === 'payable' ? 'payable' : 'receivable';
  const cutoff = input.cutoffDate;
  const period = input.period || (cutoff ? cutoff.slice(0, 7) : '');
  if (!cutoff) return { ok: false, err: '必须指定对账截止日' };

  let session = input.sessionId ? getSession(input.sessionId) : null;
  if (!session) {
    session = createSession({ period, cutoffDate: cutoff, direction, unitIds: input.unitIds || [] });
  }
  const from = period ? period + '-01' : '';

  const probe = exporter.probeBrowser();
  const warnings0 = [];
  store.backup('批次生成前');

  // ---- 阶段 1（顺序）：算余额、定编号与版本，保证编号不重不跳 ----
  const prepared = [];
  const skipped = [];
  for (const unitId of input.unitIds || []) {
    const unit = unitsMod.get(unitId);
    if (!unit) {
      skipped.push({ unitId, ok: false, err: '单位不存在' });
      continue;
    }
    let balance;
    try {
      balance = ledger.computeUnitBalance(unitId, { cutoff, direction, from, config: cfg });
    } catch (e) {
      skipped.push({ unitId, unitName: unit.name, ok: false, err: e.message });
      continue;
    }
    if (balance.entryCount === 0) {
      skipped.push({ unitId, unitName: unit.name, ok: false, err: '该单位在截止日前没有任何明细或余额数据' });
      continue;
    }
    const version = nextVersion(unitId, period, direction);
    const serialNo = buildSerialNo(cfg.serialRule, new Date().toISOString().slice(0, 10));
    const stmt = {
      id: store.nextId('st'),
      sessionId: session.id,
      unitId,
      unitName: unit.name,
      period,
      direction,
      cutoffDate: cutoff,
      serialNo,
      version,
      ourBalanceFen: balance.absFen,
      ourSignedFen: balance.signedFen,
      balanceMode: cfg.balanceMode,
      usedMode: balance.parts.map((p) => p.usedMode).join(','),
      accounts: balance.accounts,
      issueDate: new Date().toISOString().slice(0, 10),
      createdAt: store.isoNow(),
      detailCount: balance.detailCount,
      hasDetail: balance.hasDetail,
      warnings: balance.warnings,
      dataSource: ledger.traceOf(balance),
    };
    prepared.push({ unit, balance, stmt });
  }

  // ---- 阶段 2：渲染 + Excel + PDF ----
  // 默认先开一个「复用同一个浏览器实例」的打印会话，顺序渲染：实测 0.24 秒/份，
  // 比每次单独启动浏览器（约 1.1 秒/份）快 4 倍多，也更不受机器负载影响。
  // 会话开不起来（没装 puppeteer-core / 浏览器启动失败）时才回退到命令行通道 + 并发池。
  const workers = Number(input.concurrency || cfg.pdfConcurrency || 3);
  const wantEngine = input.engine || cfg.pdfEngine || 'auto';
  let pdfSession = null;
  if (wantEngine !== 'cli') {
    pdfSession = await exporter.createPdfSession();
    if (!pdfSession.available) warnings0.push('PDF 打印会话不可用（' + pdfSession.reason + '）');
  }
  const useSession = !!(pdfSession && pdfSession.available);
  const renderOne = async (item, _index, slot) => {
    const { unit, balance, stmt } = item;
    try {
      const html = templates.renderStatement({ unit, balance, session, config: cfg, statement: stmt });
      const dir = archiveDir(stmt.unitId, period, stmt.version);
      fs.mkdirSync(dir, { recursive: true });
      const base = stmt.serialNo;

      const xr = await exporter.toXlsx({ unit, balance, session, config: cfg, statement: stmt }, path.join(dir, base + '_对账函.xlsx'));
      const pdf = useSession
        ? await pdfSession.print(html, path.join(dir, base + '_对账函.pdf'))
        : await exporter.htmlToPdf(html, path.join(dir, base + '_对账函.pdf'), { slot });
      let htmlPath = '';
      if (!pdf.ok) {
        htmlPath = exporter.writeHtml(html, path.join(dir, base + '_打印版.html')).path;
      }

      stmt.pdfPath = pdf.ok ? pdf.path : '';
      stmt.htmlPath = htmlPath;
      stmt.xlsxPath = xr.ok ? xr.path : '';
      stmt.pdfDegraded = !pdf.ok;
      stmt.pdfDegradeReason = pdf.ok ? '' : pdf.reason || '';
      stmt.pdfEngine = pdf.engine || '';
      stmt.archivedDir = dir;
      stmt.pdfFallbackHtml = pdf.htmlPath || '';

      return {
        unitId: stmt.unitId,
        unitName: unit.name,
        ok: true,
        statementId: stmt.id,
        serialNo: stmt.serialNo,
        version: stmt.version,
        balanceFen: stmt.ourBalanceFen,
        balanceText: money.fenToStr(stmt.ourBalanceFen),
        hasDetail: balance.hasDetail,
        pdfOk: pdf.ok,
        pdfEngine: pdf.engine || '',
        pdfDegraded: !pdf.ok,
        pdfReason: pdf.ok ? '' : pdf.reason,
        xlsxOk: xr.ok,
        warnings: balance.warnings,
      };
    } catch (e) {
      return { unitId: stmt.unitId, unitName: unit.name, ok: false, err: e.message };
    }
  };

  let rendered;
  try {
    rendered = useSession
      ? await pool(prepared, 1, (item, i) => renderOne(item, i, 0))
      : await pool(prepared, workers, (item, i, slot) => renderOne(item, i, slot));
    if (useSession && pdfSession.close) await pdfSession.close();
  } catch (e) {
    if (useSession && pdfSession.close) await pdfSession.close();
    throw e;
  }

  const statements = allStatements();
  for (const r of rendered) {
    if (r.ok) {
      const item = prepared.find((p) => p.stmt.id === r.statementId);
      if (item) statements.push(item.stmt);
    }
  }
  store.writeJson('statements.json', statements);

  const results = rendered.concat(skipped);
  const okCount = results.filter((r) => r.ok).length;
  store.log('[OK] 批次 ' + session.id + ' 生成对账函 ' + okCount + '/' + results.length + ' 份（并发 ' + workers + '）');
  return {
    ok: true,
    session,
    results,
    okCount,
    failCount: results.length - okCount,
    concurrency: workers,
    pdfEngine: useSession ? 'puppeteer-core-shared' : 'browser-cli',
    warnings: warnings0,
    browser: { ok: probe.ok, path: probe.path, source: probe.source },
  };
}

function getStatement(id) {
  return allStatements().find((s) => s.id === id) || null;
}

function listBySession(sessionId) {
  return allStatements().filter((s) => s.sessionId === sessionId);
}

/** 下载单个文件 */
function fileOf(stmtId, fmt) {
  const s = getStatement(stmtId);
  if (!s) throw new Error('对账函不存在');
  if (fmt === 'pdf') {
    if (s.pdfPath && fs.existsSync(s.pdfPath)) return s.pdfPath;
    if (s.htmlPath && fs.existsSync(s.htmlPath)) return s.htmlPath;
    throw new Error('PDF 不可用' + (s.pdfDegradeReason ? '：' + s.pdfDegradeReason : ''));
  }
  if (fmt === 'xlsx') {
    if (s.xlsxPath && fs.existsSync(s.xlsxPath)) return s.xlsxPath;
    throw new Error('Excel 不可用');
  }
  if (fmt === 'html') {
    if (s.htmlPath && fs.existsSync(s.htmlPath)) return s.htmlPath;
    throw new Error('HTML 不可用');
  }
  throw new Error('未知格式：' + fmt);
}

/** 批次 zip：每单位取该批次最新版本 */
async function batchZip(sessionId) {
  const list = listBySession(sessionId);
  const byUnit = new Map();
  for (const s of list) {
    const cur = byUnit.get(s.unitId);
    if (!cur || s.version > cur.version) byUnit.set(s.unitId, s);
  }
  const files = [];
  for (const s of byUnit.values()) {
    const safe = String(s.unitName).replace(/[\\/:*?"<>|]/g, '_');
    if (s.pdfPath && fs.existsSync(s.pdfPath)) files.push({ path: s.pdfPath, name: safe + '/' + s.serialNo + '_对账函.pdf' });
    if (s.htmlPath && fs.existsSync(s.htmlPath)) files.push({ path: s.htmlPath, name: safe + '/' + s.serialNo + '_打印版.html' });
    if (s.xlsxPath && fs.existsSync(s.xlsxPath)) files.push({ path: s.xlsxPath, name: safe + '/' + s.serialNo + '_对账函.xlsx' });
  }
  if (!files.length) throw new Error('该批次还没有可下载的文件');
  const out = path.join(store.DATA, 'exports', 'DZH_batch_' + sessionId + '.zip');
  const r = await exporter.zipFiles(files, out);
  return Object.assign(r, { count: files.length });
}

module.exports = {
  allStatements,
  allSessions,
  listSessions,
  getSession,
  createSession,
  buildSerialNo,
  nextVersion,
  archiveDir,
  generate,
  getStatement,
  listBySession,
  fileOf,
  batchZip,
};
