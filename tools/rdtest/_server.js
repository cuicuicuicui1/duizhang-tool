'use strict';
/*
 * _server.js — 测试用：在随机端口起真实 Express 服务（不自动开浏览器）
 */
const path = require('path');

function startServer(port) {
  process.env.DZ_NO_OPEN = '1';
  const { app } = require(path.join(__dirname, '..', '..', 'server.js'));
  return new Promise((resolve, reject) => {
    const p = port || 3300 + Math.floor(Math.random() * 400);
    const server = app.listen(p, () => {
      resolve({
        port: p,
        url: 'http://127.0.0.1:' + p,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
    server.on('error', reject);
  });
}

async function jget(url, p) {
  const r = await fetch(url + p);
  return r.json();
}
async function jpost(url, p, body) {
  const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function jput(url, p, body) {
  const r = await fetch(url + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function jdel(url, p) {
  const r = await fetch(url + p, { method: 'DELETE' });
  return r.json();
}

module.exports = { startServer, jget, jpost, jput, jdel };
