'use strict';
/*
 * fix-deps.js — 依赖完整性自检与修复
 *
 * 为什么需要它：在内网镜像 / 受限环境下，npm 解包偶尔会漏掉个别文件
 * （实测 proxy-agent、http-proxy-agent 的 dist/index.js 会缺，导致 require 直接报错）。
 * 本脚本扫描 node_modules，找出 package.json 声明的入口文件实际不存在的包，
 * 从 registry 重新下载 tarball 并手工解包补齐（纯 zlib + 手写 tar 解析，不引入新依赖）。
 *
 *   node tools/fix-deps.js          # 只检查并修复
 *   node tools/fix-deps.js --check  # 只检查
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const REGISTRY = process.env.DZ_REGISTRY || 'https://registry.npmmirror.com';

function listPackages(dir, depth, out) {
  if (depth > 6 || !fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      const sub = path.join(dir, name);
      if (!fs.statSync(sub).isDirectory()) continue;
      for (const inner of fs.readdirSync(sub)) out.push(path.join(sub, inner));
      continue;
    }
    const p = path.join(dir, name);
    if (!fs.statSync(p).isDirectory()) continue;
    if (name === 'node_modules') {
      listPackages(p, depth + 1, out);
      continue;
    }
    if (fs.existsSync(path.join(p, 'package.json'))) out.push(p);
    const nested = path.join(p, 'node_modules');
    if (fs.existsSync(nested)) listPackages(nested, depth + 1, out);
  }
  return out;
}

/** 按 Node 的解析规则判断候选路径是否存在（补 .js/.json/index.js，兼容目录） */
function resolves(pkgDir, candidate) {
  const base = path.join(pkgDir, String(candidate).replace(/^\.\//, ''));
  const tries = [base, base + '.js', base + '.json', base + '.mjs', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.json')];
  for (const t of tries) {
    try {
      if (fs.existsSync(t) && fs.statSync(t).isFile()) return true;
    } catch (_) {
      /* ignore */
    }
  }
  return false;
}

/** 收集 exports 里的入口候选（兼容子路径映射与条件导出两种写法） */
function collectExport(v, add) {
  if (typeof v === 'string') {
    add(v);
    return;
  }
  if (v && typeof v === 'object') {
    if (v['.'] !== undefined) {
      collectExport(v['.'], add);
      return;
    }
    for (const k of ['require', 'import', 'default', 'node', 'browser', 'module']) {
      if (v[k] !== undefined) collectExport(v[k], add);
    }
  }
}

/**
 * 判定是否缺文件。
 * 只把「入口声明的目录存在、但声明的那个文件不存在」判为缺失 —— 这正是解包漏文件的特征
 * （实测 proxy-agent/dist 里有 .map 却没有 index.js）。这样不会把
 * 「main 没有扩展名」「只导出子路径」「纯类型包」等正常情况误判成损坏。
 */
function entryMissing(pkgDir, pkg) {
  const candidates = [];
  const add = (v) => {
    if (typeof v === 'string') candidates.push(v);
  };
  if (typeof pkg.main === 'string') add(pkg.main);
  if (typeof pkg.module === 'string') add(pkg.module);
  if (typeof pkg.browser === 'string') add(pkg.browser);
  if (pkg.exports !== undefined) collectExport(pkg.exports, add);
  for (const c of candidates) {
    const base = path.join(pkgDir, String(c).replace(/^\.\//, ''));
    if (resolves(pkgDir, c)) continue; // 这一个能解析，说明包是好的
    let parent = path.dirname(base);
    try {
      if (fs.existsSync(parent) && fs.statSync(parent).isDirectory()) return true;
    } catch (_) {
      /* ignore */
    }
  }
  return false;
}

/** 极简 tar 解包（只处理普通文件与目录） */
function untar(buf, destRoot) {
  let off = 0;
  let count = 0;
  while (off + 512 <= buf.length) {
    const header = buf.slice(off, off + 512);
    let name = header.toString('utf8', 0, 100).replace(/\0[\s\S]*$/, '');
    if (!name) {
      // 空块：可能是结尾 padding，往后找
      const rest = buf.slice(off, off + 1024).toString('latin1');
      if (/^\0+$/.test(rest)) break;
      off += 512;
      continue;
    }
    const sizeStr = header.toString('utf8', 124, 136).replace(/\0[\s\S]*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = header.toString('utf8', 156, 157);
    const data = buf.slice(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;

    let rel = name.replace(/^\.\//, '');
    if (rel.startsWith('package/')) rel = rel.slice('package/'.length);
    rel = rel.replace(/^\.\//, '');
    if (!rel || rel.endsWith('/')) continue;
    const target = path.join(destRoot, rel);
    if (!target.startsWith(destRoot)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (type === '5') continue;
    fs.writeFileSync(target, data);
    count++;
  }
  return count;
}

async function fetchTarball(name, version) {
  const short = name.split('/').pop();
  const url = REGISTRY + '/' + name + '/-/' + short + '-' + version + '.tgz';
  const r = await fetch(url);
  if (!r.ok) throw new Error('下载失败 ' + url + ' → HTTP ' + r.status);
  const gz = Buffer.from(await r.arrayBuffer());
  return zlib.gunzipSync(gz);
}

async function main() {
  const checkOnly = process.argv.indexOf('--check') >= 0;
  const dirs = listPackages(path.join(ROOT, 'node_modules'), 0, []);
  console.log('[..] 扫描到 ' + dirs.length + ' 个包');
  const broken = [];
  for (const d of dirs) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
    } catch (_) {
      continue;
    }
    if (!pkg.name || !pkg.version) continue;
    try {
      if (entryMissing(d, pkg)) broken.push({ dir: d, name: pkg.name, version: pkg.version });
    } catch (_) {
      /* ignore */
    }
  }
  if (!broken.length) {
    console.log('[OK] 依赖完整，无需修复');
    return;
  }
  console.log('[!!] 发现 ' + broken.length + ' 个包入口文件缺失：');
  for (const b of broken) console.log('     ' + b.name + '@' + b.version + '  (' + b.dir + ')');
  if (checkOnly) return;
  let fixed = 0;
  for (const b of broken) {
    try {
      const tar = await fetchTarball(b.name, b.version);
      const n = untar(tar, b.dir);
      console.log('[OK] 已补齐 ' + b.name + '@' + b.version + '（' + n + ' 个文件）');
      fixed++;
    } catch (e) {
      console.log('[!!] 修复 ' + b.name + ' 失败：' + e.message);
    }
  }
  console.log('[OK] 修复完成 ' + fixed + '/' + broken.length);
}

if (require.main === module) {
  main().catch((e) => {
    console.log('[!!] ' + e.message);
    process.exit(1);
  });
}
module.exports = { listPackages, entryMissing, untar };
