/* tabs.js — Tab 定义与切换（jsdom 前端测试通过 showTab('xxx') 逐页切换） */
'use strict';

var TABS = [
  { key: 'home', label: '首页', title: '首页', render: 'renderHome' },
  { key: 'units', label: '单位档案', title: '往来单位档案', render: 'renderUnits' },
  { key: 'import', label: '数据导入', title: '数据导入（明细账 / 科目余额表）', render: 'renderImport' },
  { key: 'templates', label: '模板设置', title: '对账函模板与公司信息', render: 'renderTemplates' },
  { key: 'generate', label: '批量生成', title: '批量生成对账函', render: 'renderGenerate' },
  { key: 'reply', label: '回函核对', title: '回函核对与差异报告', render: 'renderReply' },
  { key: 'archive', label: '历史归档', title: '历史归档', render: 'renderArchive' },
  { key: 'settings', label: '设置', title: '口径与系统设置', render: 'renderSettings' }
];

var currentTab = 'home';

function buildNav() {
  var nav = document.getElementById('nav');
  if (!nav) return;
  nav.innerHTML = TABS.map(function (t) {
    return '<a href="#' + t.key + '" data-tab="' + t.key + '" onclick="showTab(\'' + t.key + '\');return false;">' + t.label + '</a>';
  }).join('');
}

function showTab(key) {
  var t = TABS.filter(function (x) { return x.key === key; })[0];
  if (!t) t = TABS[0];
  currentTab = t.key;
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
  var el = document.getElementById('tab-' + t.key);
  if (el) el.classList.add('active');
  var links = document.querySelectorAll('.nav a');
  for (var j = 0; j < links.length; j++) {
    if (links[j].getAttribute('data-tab') === t.key) links[j].classList.add('active');
    else links[j].classList.remove('active');
  }
  var titleEl = document.getElementById('tabTitle');
  if (titleEl) titleEl.textContent = t.title;
  if (typeof window[t.render] === 'function') {
    try {
      window[t.render]();
    } catch (e) {
      console.error('渲染 ' + t.key + ' 失败：' + e.message);
      var body = document.getElementById(t.key + 'Body') || document.getElementById('tab-' + t.key);
      if (body) body.innerHTML = '<div class="note bad">页面渲染失败：' + escapeHtml(e.message) + '</div>';
    }
  }
  if (typeof window.location !== 'undefined' && window.location && window.location.hash !== '#' + t.key) {
    try {
      window.location.hash = '#' + t.key;
    } catch (_) { /* jsdom 下可能只读 */ }
  }
}
