'use strict';
/*
 * units.js — 往来单位档案
 * 单位匹配采用「归一化名称 + 别名」双路：归一化后完全相等 → 名字包含 → 别名命中。
 * 匹配不到一律返回 null，由导入向导让会计选择「新建档案 / 绑定已有单位」，不自动猜。
 */

const store = require('./store');
const money = require('./money');

function normalizeName(s) {
  if (s === null || s === undefined) return '';
  let t = String(s);
  t = t.replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  t = t.replace(/[\uFF08\uFF09]/g, (m) => (m === '\uFF08' ? '(' : ')'));
  t = t.replace(/[\u00A0\u3000\s\r\n\t]/g, '');
  t = t.replace(/[.。]+$/g, '');
  return t.toLowerCase();
}

function all() {
  return store.readJson('units.json', []).filter((u) => !u.archived);
}

function allWithArchived() {
  return store.readJson('units.json', []);
}

function get(id) {
  return store.readJson('units.json', []).find((u) => u.id === id) || null;
}

function saveAll(list) {
  return store.writeJson('units.json', list);
}

const TYPE_LABEL = { customer: '客户（应收）', supplier: '供应商（应付）', both: '兼有（客户+供应商）' };

function create({ name, type, contact, phone, address, alias, taxNo, note }) {
  const list = store.readJson('units.json', []);
  const nm = String(name || '').trim();
  if (!nm) throw new Error('单位名称不能为空');
  const dup = findByName(nm);
  if (dup.unit) throw new Error('单位已存在：' + dup.unit.name);
  const u = {
    id: store.nextId('u'),
    name: nm,
    type: type || 'customer',
    contact: contact || '',
    phone: phone || '',
    address: address || '',
    taxNo: taxNo || '',
    note: note || '',
    alias: Array.isArray(alias) ? alias.filter(Boolean) : String(alias || '').split(/[,，、]/).filter(Boolean),
    archived: false,
    createdAt: store.isoNow(),
  };
  list.push(u);
  saveAll(list);
  return u;
}

function update(id, patch) {
  const list = store.readJson('units.json', []);
  const i = list.findIndex((u) => u.id === id);
  if (i < 0) throw new Error('单位不存在：' + id);
  const allow = ['name', 'type', 'contact', 'phone', 'address', 'taxNo', 'note', 'alias', 'archived'];
  for (const k of allow) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
      if (k === 'alias' && !Array.isArray(patch.alias)) {
        list[i].alias = String(patch.alias || '').split(/[,，、]/).filter(Boolean);
      } else {
        list[i][k] = patch[k];
      }
    }
  }
  list[i].updatedAt = store.isoNow();
  saveAll(list);
  return list[i];
}

/** 硬删除前必须确认没有账务数据挂在上面 */
function remove(id) {
  const ledgers = store.readJson('ledgers.json', []).filter((e) => e.unitId === id);
  const stmts = store.readJson('statements.json', []).filter((s) => s.unitId === id);
  const replies = store.readJson('replies.json', []).filter((r) => r.unitId === id);
  if (ledgers.length || stmts.length || replies.length) {
    throw new Error(
      '该单位已有数据（明细 ' + ledgers.length + ' 条 / 对账函 ' + stmts.length + ' 份 / 回函 ' + replies.length + ' 条），' +
        '不能删除。如需停止使用请改为「停用」。'
    );
  }
  const list = store.readJson('units.json', []);
  const next = list.filter((u) => u.id !== id);
  if (next.length === list.length) throw new Error('单位不存在：' + id);
  saveAll(next);
  return { ok: true };
}

/**
 * 按名称找单位。
 * @returns {{unit:Object|null, method:string}}
 */
function findByName(name) {
  const nm = normalizeName(name);
  if (!nm) return { unit: null, method: 'empty' };
  const list = all();
  for (const u of list) if (normalizeName(u.name) === nm) return { unit: u, method: 'name' };
  for (const u of list) for (const a of u.alias || []) if (normalizeName(a) === nm) return { unit: u, method: 'alias' };
  let best = null;
  for (const u of list) {
    const cands = [u.name, ...(u.alias || [])];
    for (const c of cands) {
      const nc = normalizeName(c);
      if (nc.length >= 4 && (nm.includes(nc) || nc.includes(nm))) {
        if (!best || nc.length > best.len) best = { unit: u, len: nc.length, method: 'partial' };
      }
    }
  }
  if (best) return { unit: best.unit, method: best.method };
  return { unit: null, method: 'none' };
}

/** 导入时用：找不到就按名字建档案（type 由借贷方向推断） */
function ensureByName(name, type) {
  const hit = findByName(name);
  if (hit.unit) {
    if (hit.method === 'partial' && normalizeName(hit.unit.name) !== normalizeName(name)) {
      // 名称只是包含关系，不算同一家：补成别名并新建，交人复核
      const u = create({ name, type, alias: [] });
      return { unit: u, created: true, ambiguousWith: hit.unit.id };
    }
    return { unit: hit.unit, created: false, method: hit.method };
  }
  const u = create({ name, type });
  return { unit: u, created: true, method: 'new' };
}

function addAlias(id, alias) {
  const u = get(id);
  if (!u) throw new Error('单位不存在');
  const list = store.readJson('units.json', []);
  const i = list.findIndex((x) => x.id === id);
  const a = String(alias || '').trim();
  if (!a) throw new Error('别名不能为空');
  list[i].alias = Array.from(new Set([...(list[i].alias || []), a]));
  saveAll(list);
  return list[i];
}

/** 单位概览：余额、明细条数、对账函份数（供档案页展示） */
function overview(id) {
  const ledgers = store.readJson('ledgers.json', []).filter((e) => e.unitId === id);
  const stmts = store.readJson('statements.json', []).filter((s) => s.unitId === id);
  const replies = store.readJson('replies.json', []).filter((r) => r.unitId === id);
  return {
    ledgerCount: ledgers.length,
    statementCount: stmts.length,
    replyCount: replies.length,
    accounts: Array.from(new Set(ledgers.map((e) => e.account))).filter(Boolean),
  };
}

function label(u) {
  if (!u) return '';
  const t = TYPE_LABEL[u.type] || u.type;
  return u.name + '（' + t + '）';
}

module.exports = {
  TYPE_LABEL,
  all,
  allWithArchived,
  get,
  create,
  update,
  remove,
  findByName,
  ensureByName,
  addAlias,
  overview,
  normalizeName,
  label,
};
