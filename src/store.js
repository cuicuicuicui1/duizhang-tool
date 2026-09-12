'use strict';
/*
 * store.js — JSON 文件存储层
 * 红线：写库前先备份；归档只增不删；程序内不出现任何删除文件的调用。
 *
 * 设计修正（相对计划 §4.3）：备份目录放在项目根的 backups/ 而不是 data/ 内，
 * 否则 `cp -r data data/_backup_x` 会把历次备份再套娃复制一遍（体积指数增长）。
 * 自动备份只复制 *.json（数据本体，通常 < 2MB），原件/归档/PDF 由「整包备份」按钮负责。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 测试隔离：DZ_DATA / DZ_BACKUP 可把数据目录指到临时目录，测试脚本用后即弃
const DATA = process.env.DZ_DATA ? path.resolve(process.env.DZ_DATA) : path.join(ROOT, 'data');
const BACKUP_ROOT = process.env.DZ_BACKUP ? path.resolve(process.env.DZ_BACKUP) : path.join(ROOT, 'backups');
const SUB_DIRS = ['archive', 'imports', 'exports', 'assets', 'logs', 'tmp'];

const JSON_FILES = [
  'units.json',
  'ledgers.json',
  'sessions.json',
  'statements.json',
  'replies.json',
  'replyMaps.json',
  'openings.json',
  'config.json',
  'counters.json',
];

function ensureDirs() {
  for (const d of [DATA, BACKUP_ROOT, ...SUB_DIRS.map((s) => path.join(DATA, s))]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function dataPath(name) {
  return path.join(DATA, name);
}

function readJson(name, fallback) {
  ensureDirs();
  const p = dataPath(name);
  try {
    if (!fs.existsSync(p)) return fallback === undefined ? [] : fallback;
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return fallback === undefined ? [] : fallback;
    return JSON.parse(raw);
  } catch (e) {
    // 文件损坏时不静默覆盖：改名留证，返回 fallback
    const broken = p + '.broken_' + ts();
    try {
      fs.renameSync(p, broken);
    } catch (_) {
      /* ignore */
    }
    log('[!!] JSON 解析失败，已改名为 ' + path.basename(broken) + '：' + e.message);
    return fallback === undefined ? [] : fallback;
  }
}

/** 写库通知钩子：内存缓存（如 ledger 的明细缓存）靠它失效，避免同毫秒写入的边界问题 */
const WRITE_HOOKS = [];
function onWrite(fn) {
  WRITE_HOOKS.push(fn);
}

function writeJson(name, value) {
  ensureDirs();
  const p = dataPath(name);
  const tmp = p + '.tmp';
  const text = JSON.stringify(value, null, 2);
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    fs.writeFileSync(p, text, 'utf8');
  }
  for (const h of WRITE_HOOKS) {
    try {
      h(name);
    } catch (_) {
      /* ignore */
    }
  }
  return p;
}

/** 时间戳 YYYYMMDD_HHMMSS */
function ts(d) {
  const t = d ? new Date(d) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + '_' + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds())
  );
}

function isoNow() {
  const t = new Date();
  const off = -t.getTimezoneOffset();
  const sgn = off >= 0 ? '+' : '-';
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  return (
    t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + 'T' +
    p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds()) +
    sgn + p(Math.floor(Math.abs(off) / 60)) + ':' + p(Math.abs(off) % 60)
  );
}

/** 仅备份 *.json，返回备份目录名 */
function backup(tag) {
  ensureDirs();
  const name = ts() + (tag ? '_' + String(tag).replace(/[^\w\u4e00-\u9fa5-]/g, '') : '');
  const dir = path.join(BACKUP_ROOT, name, 'data');
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(DATA)) {
    const src = path.join(DATA, f);
    const st = fs.statSync(src);
    if (st.isFile() && f.endsWith('.json')) {
      fs.copyFileSync(src, path.join(dir, f));
      n++;
    }
  }
  log('[OK] 已自动备份数据文件 ' + n + ' 个 -> backups/' + name);
  return { name, dir, files: n, at: isoNow() };
}

function listBackups() {
  ensureDirs();
  return fs
    .readdirSync(BACKUP_ROOT)
    .filter((d) => {
      try {
        return fs.statSync(path.join(BACKUP_ROOT, d)).isDirectory();
      } catch (_) {
        return false;
      }
    })
    .sort()
    .reverse()
    .map((d) => {
      const inner = path.join(BACKUP_ROOT, d, 'data');
      let files = 0;
      let size = 0;
      if (fs.existsSync(inner)) {
        for (const f of fs.readdirSync(inner)) {
          const st = fs.statSync(path.join(inner, f));
          files++;
          size += st.size;
        }
      }
      return { name: d, files, size };
    });
}

/** 恢复：先给当前数据再备份一次，再覆盖 */
function restore(name) {
  ensureDirs();
  const dir = path.join(BACKUP_ROOT, name, 'data');
  if (!fs.existsSync(dir)) throw new Error('备份不存在：' + name);
  const safety = backup('restore前自动备份');
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(dir, f), dataPath(f));
  }
  log('[OK] 已从 backups/' + name + ' 恢复；恢复前数据备份在 backups/' + safety.name);
  return safety;
}

/** 目录体积统计 */
function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  walk(dir);
  return total;
}

/** 顺序号：按 counters.json 里的 key 自增 */
function nextSeq(key, startAt) {
  const counters = readJson('counters.json', {});
  const cur = Number(counters[key] || (startAt === undefined ? 0 : startAt - 1));
  const next = cur + 1;
  counters[key] = next;
  writeJson('counters.json', counters);
  return next;
}

function peekSeq(key) {
  const counters = readJson('counters.json', {});
  return Number(counters[key] || 0);
}

let ID_SEQ = 0;
function nextId(prefix) {
  ID_SEQ = (ID_SEQ + 1) % 100000;
  return prefix + '_' + Date.now().toString(36) + String(ID_SEQ).padStart(3, '0');
}

function log(line) {
  ensureDirs();
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  const t = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  try {
    fs.appendFileSync(path.join(DATA, 'logs', day + '.log'), '[' + t + '] ' + line + '\n', 'utf8');
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  ROOT,
  DATA,
  BACKUP_ROOT,
  JSON_FILES,
  ensureDirs,
  dataPath,
  readJson,
  writeJson,
  onWrite,
  backup,
  listBackups,
  restore,
  dirSize,
  nextSeq,
  peekSeq,
  nextId,
  log,
  ts,
  isoNow,
};
