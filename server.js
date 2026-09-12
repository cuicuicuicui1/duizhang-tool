'use strict';
/*
 * server.js — 入口：Express 启动、静态托管、路由挂载
 *   node server.js        （启动后浏览器访问 http://localhost:3210）
 *   DZ_PORT=3300 node server.js
 *   DZ_NO_OPEN=1 node server.js   启动后不自动开浏览器（测试用）
 *
 * 日志一律用 ASCII 标记（[OK]/[!!]），避免 Windows GBK 控制台打印 Unicode 符号直接崩掉。
 */

const express = require('express');
const path = require('path');
const { execFile } = require('child_process');

const store = require('./src/store');
const configMod = require('./src/config');
const exporter = require('./src/exporter');

const app = express();
const ROOT = __dirname;

app.disable('x-powered-by');
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: false, limit: '200mb' }));

// 静态资源
app.use('/', express.static(path.join(ROOT, 'public'), { index: 'index.html', etag: false }));
app.use('/templates', express.static(path.join(ROOT, 'templates'), { etag: false }));
app.use('/src', express.static(path.join(ROOT, 'src'), { etag: false }));

// API
app.use('/api', require('./src/routes'));

// 兜底
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ ok: false, data: null, err: '接口不存在：' + req.path });
  } else {
    res.sendFile(path.join(ROOT, 'public', 'index.html'));
  }
});

app.use((err, req, res, _next) => {
  store.log('[!!] 未捕获错误 ' + req.method + ' ' + req.originalUrl + '：' + err.message);
  res.status(500).json({ ok: false, data: null, err: err.message });
});

function openBrowser(url) {
  if (process.env.DZ_NO_OPEN === '1') return;
  try {
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else if (process.platform === 'darwin') execFile('open', [url], () => {});
    else execFile('xdg-open', [url], () => {});
  } catch (_) {
    /* 打不开就算了，用户自己点链接 */
  }
}

function main() {
  store.ensureDirs();
  const cfg = configMod.getConfig();
  const port = Number(process.env.DZ_PORT || cfg.port || 3210);

  const server = app.listen(port, () => {
    const url = 'http://localhost:' + port;
    console.log('');
    console.log('  ================================================');
    console.log('   往来单位对账函工具  已启动');
    console.log('   请在浏览器打开： ' + url);
    console.log('   数据目录： ' + store.DATA);
    const b = exporter.probeBrowser();
    console.log('   PDF 引擎： ' + (b.ok ? '已找到 ' + b.path : '未找到 Edge/Chrome（将降级为打印版 HTML）'));
    console.log('   关闭本窗口即停止服务');
    console.log('  ================================================');
    console.log('');
    openBrowser(url);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log('[!!] 端口 ' + port + ' 已被占用。请关掉已运行的本工具窗口，或换端口启动：');
      console.log('     set DZ_PORT=3300 && node server.js');
    } else {
      console.log('[!!] 启动失败：' + e.message);
    }
    process.exit(1);
  });
}

if (require.main === module) main();

module.exports = { app, main };
