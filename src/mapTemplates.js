'use strict';
/*
 * mapTemplates.js — 列映射模板库（开源共享的基础设施）
 *
 * 解决的问题：财务软件众多、导出格式各异，自动识别覆盖不了所有文件形态。
 * 模板 = 「表头特征 + 列映射」的可分享记录：
 *   - 谁家的会计为「XX软件」调好一次映射，存成模板，导出成 JSON 文件分享给社区；
 *   - 其他人导入同款软件的文件时，工具按表头特征自动匹配模板，一键套用，不用重新对列。
 *
 * 设计原则：
 *   - 模板只做「建议」，不静默改数据：套用动作由用户在向导里点一下，套用后仍走完整的
 *     预览/余额校验/人工核对流程，与计划的「判不准就交给人」红线一致；
 *   - 匹配键是表头签名（表头单元格文本归一化后拼接），不含文件名、单位名等易变信息；
 *   - 同签名+同映射视为同一模板，导入去重。
 */

const store = require('./store');

const FILE = 'map_templates.json';

/** 表头行 → 匹配签名：去空格/全角转半角/小写，再用 | 拼接 */
function headerSignature(headers) {
  return (headers || [])
    .map((h) =>
      String(h || '')
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, '')
        .toLowerCase()
    )
    .join('|');
}

function all() {
  return store.readJson(FILE, []);
}

function save(list) {
  store.writeJson(FILE, list);
}

/** 新建/更新模板（同签名+同映射 → 覆盖为最新，避免库膨胀） */
function upsert(input) {
  const b = input || {};
  if (!b.name) return { ok: false, err: '模板必须起个名字' };
  if (!b.mapping || typeof b.mapping !== 'object') return { ok: false, err: '缺少列映射 mapping' };
  const headers = Array.isArray(b.headers) ? b.headers.map(String) : [];
  if (!headers.length) return { ok: false, err: '缺少表头内容 headers' };

  const list = all();
  const sig = headerSignature(headers);
  const mapKey = JSON.stringify(b.mapping);
  let rec = list.find((t) => t.headerSignature === sig && JSON.stringify(t.mapping) === mapKey);
  if (rec) {
    rec.name = String(b.name);
    rec.software = String(b.software || rec.software || '');
    rec.note = String(b.note || rec.note || '');
    rec.updatedAt = store.isoNow();
  } else {
    rec = {
      id: store.nextId('mt'),
      name: String(b.name),
      software: String(b.software || ''),
      note: String(b.note || ''),
      headers,
      headerSignature: sig,
      mapping: b.mapping,
      account: String(b.account || ''),
      createdAt: store.isoNow(),
      updatedAt: store.isoNow(),
      usedCount: 0,
    };
    list.push(rec);
  }
  save(list);
  return { ok: true, template: rec };
}

/** 按表头内容找建议模板（可能多个，按使用次数排序） */
function suggest(headers) {
  const sig = headerSignature(headers);
  if (!sig.replace(/\|/g, '')) return [];
  return all()
    .filter((t) => t.headerSignature === sig)
    .sort((a, b) => (b.usedCount || 0) - (a.usedCount || 0));
}

/** 套用（记使用次数） */
function markUsed(id) {
  const list = all();
  const rec = list.find((t) => t.id === id);
  if (rec) {
    rec.usedCount = (rec.usedCount || 0) + 1;
    rec.lastUsedAt = store.isoNow();
    save(list);
  }
  return rec || null;
}

function remove(id) {
  const list = all();
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return { ok: false, err: '模板不存在' };
  const [gone] = list.splice(i, 1);
  save(list);
  return { ok: true, removed: gone };
}

/**
 * 从外部 JSON 导入模板（单条或数组）。字段不全的跳过并说明原因。
 * 返回 { imported, skipped: [{name, reason}] }
 */
function importFrom(input) {
  const arr = Array.isArray(input) ? input : [input];
  let imported = 0;
  const skipped = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') {
      skipped.push({ name: '(非对象)', reason: '不是有效 JSON 对象' });
      continue;
    }
    if (!item.name || !item.mapping || !Array.isArray(item.headers)) {
      skipped.push({ name: String(item.name || '(未命名)'), reason: '缺少 name/headers/mapping 之一' });
      continue;
    }
    const r = upsert(item);
    if (r.ok) imported++;
    else skipped.push({ name: String(item.name), reason: r.err });
  }
  return { imported, skipped };
}

module.exports = { headerSignature, all, upsert, suggest, markUsed, remove, importFrom };
