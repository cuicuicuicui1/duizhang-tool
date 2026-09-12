/* app.js — 前端逻辑（原生 JS，无构建步骤）
 * 约定（计划 §7）：所有请求走 api() 且 body 必须 JSON.stringify；Tab 用 showTab('xxx') 切换；
 * 金额展示统一走 fenToStr；确认弹窗用原生 confirm。
 */
'use strict';

var S = {
  config: null,
  options: null,
  units: [],
  periods: [],
  sessions: [],
  tree: [],
  statements: [],
  balances: [],
  stats: null,
  browser: null,
  replyMaps: []
};

// ---------------------------------------------------------------- 基础工具
function api(path, opts) {
  var o = opts || {};
  var init = { method: o.method || 'GET', headers: {} };
  if (o.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(o.body);
  }
  return fetch(path, init).then(function (r) {
    return r.text().then(function (txt) {
      var j;
      try {
        j = JSON.parse(txt);
      } catch (e) {
        throw new Error('服务返回的不是 JSON（HTTP ' + r.status + '）');
      }
      if (!j.ok) throw new Error(j.err || '请求失败');
      return j.data;
    });
  });
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function esc(s) { return escapeHtml(s); }

function fenToStr(fen) {
  var n = Number(fen);
  if (!isFinite(n) || Math.floor(n) !== n) return '0.00';
  var neg = n < 0;
  var abs = Math.abs(n);
  var yuan = Math.floor(abs / 100);
  var cent = abs % 100;
  var s = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + String(cent).padStart(2, '0');
  return neg ? '-' + s : s;
}
function yuanToFen(v) {
  var s = String(v === undefined || v === null ? '' : v).replace(/[\s,]/g, '');
  if (s === '' || s === '-') return 0;
  var neg = s.charAt(0) === '-';
  if (neg) s = s.slice(1);
  var parts = s.split('.');
  var intPart = parts[0] || '0';
  var frac = (parts[1] || '').padEnd(3, '0');
  var fen = Number(intPart) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) fen += 1;
  return neg ? -fen : fen;
}
function val(id) {
  var el = document.getElementById(id);
  return el ? el.value : '';
}
function checked(id) {
  var el = document.getElementById(id);
  return !!(el && el.checked);
}
function setHtml(id, html) {
  var el = document.getElementById(id);
  if (el) el.innerHTML = html;
}
function toast(msg, bad) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast on' + (bad ? ' bad' : '');
  clearTimeout(el._t);
  el._t = setTimeout(function () { el.className = 'toast'; }, 4200);
}
function fail(e) {
  toast(e && e.message ? e.message : String(e), true);
  if (typeof console !== 'undefined' && console.error) console.error(e);
}
function openModal(html) {
  var m = document.getElementById('modal');
  var b = document.getElementById('modalBox');
  if (!m || !b) return;
  b.innerHTML = html;
  m.className = 'modal on';
}
function closeModal() {
  var m = document.getElementById('modal');
  if (m) m.className = 'modal';
}
function tagKind(kind) {
  var map = { consistent: 'green', consistent_with_notes: 'yellow', diff: 'red', manual: 'yellow', draft: 'gray', confirmed: 'green', pending: 'gray' };
  return map[kind] || 'gray';
}
function tagText(kind) {
  var map = { consistent: '一致', consistent_with_notes: '一致（有提示）', diff: '有差异', manual: '需人工核对', draft: '待确认', confirmed: '已确认', pending: '待回函' };
  return map[kind] || kind || '';
}
function readFileBase64(input) {
  return new Promise(function (resolve, reject) {
    var f = input && input.files ? input.files[0] : null;
    if (!f) return reject(new Error('请先选择文件'));
    var fr = new FileReader();
    fr.onload = function () {
      var s = String(fr.result);
      var i = s.indexOf(',');
      resolve({ filename: f.name, contentBase64: i >= 0 ? s.slice(i + 1) : s, size: f.size });
    };
    fr.onerror = function () { reject(new Error('读取文件失败')); };
    fr.readAsDataURL(f);
  });
}

// ---------------------------------------------------------------- 首页
function renderHome() {
  api('/api/stats').then(function (st) {
    S.stats = st;
    api('/api/sessions').then(function (ss) {
      S.sessions = ss || [];
      var kpis =
        '<div class="kpis">' +
        kpi('往来单位', st.units, '家') +
        kpi('己方明细', st.ledgerEntries, '条') +
        kpi('导入批次', st.batches, '个') +
        kpi('已出对账函', st.statements, '份') +
        kpi('回函', st.replies, '份') +
        kpi('已确认', st.confirmed, '份') +
        kpi('数据体积', (st.dataBytes / 1024 / 1024).toFixed(2), 'MB') +
        kpi('自动备份', st.backupCount, '份') +
        '</div>';
      var rows = S.sessions.slice(0, 12).map(function (s) {
        return (
          '<tr><td class="mono">' + esc(s.id) + '</td><td>' + esc(s.period) + '</td>' +
          '<td>' + (s.direction === 'payable' ? '应付' : '应收') + '</td>' +
          '<td>' + esc(s.cutoffDate) + '</td><td class="num">' + s.statementCount + '</td>' +
          '<td class="num">' + s.confirmedCount + '</td>' +
          '<td><button class="sm" onclick="showTab(\'generate\');pickSession(\'' + esc(s.id) + '\')">查看</button> ' +
          '<button class="sm" onclick="downloadZip(\'' + esc(s.id) + '\')">下载 zip</button></td></tr>'
        );
      }).join('');
      setHtml('homeBody',
        (st.statements === 0
          ? '<div class="note info"><b>三步走完就能发函：</b><br />①「单位档案」建往来单位 → ②「数据导入」把财务软件导出的明细账导进来 → ③「批量生成」勾选单位出 PDF/Excel。回函回来后到「回函核对」做差异勾对。</div>'
          : '') +
        '<div class="card"><h3>总览</h3>' + kpis + '</div>' +
        '<div class="card"><h3>最近对账批次</h3>' +
        (rows ? '<table><thead><tr><th>批次</th><th>期间</th><th>方向</th><th>截止日</th><th class="num">函份数</th><th class="num">已确认</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="empty">还没有对账批次，先去「批量生成」建一个。</div>') +
        '</div>' +
        '<div class="card"><h3>最近自动备份</h3>' +
        ((st.backups || []).slice(0, 6).map(function (b) {
          return '<div class="muted">' + esc(b.name) + '　' + b.files + ' 个文件　' + Math.round(b.size / 1024) + ' KB</div>';
        }).join('') || '<div class="empty">暂无备份</div>') +
        '</div>');
    }).catch(fail);
  }).catch(fail);
}
function kpi(k, v, unit) {
  return '<div class="kpi"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + (unit ? '<span class="muted" style="font-size:12px">' + esc(unit) + '</span>' : '') + '</div></div>';
}

// ---------------------------------------------------------------- 单位档案
function renderUnits() {
  api('/api/units').then(function (list) {
    S.units = list || [];
    var rows = S.units.map(function (u) {
      var o = u.overview || {};
      return (
        '<tr><td>' + esc(u.name) + '</td>' +
        '<td>' + esc(({ customer: '客户（应收）', supplier: '供应商（应付）', both: '兼有' })[u.type] || u.type) + '</td>' +
        '<td>' + esc((u.alias || []).join('、')) + '</td>' +
        '<td class="num">' + (o.ledgerCount || 0) + '</td>' +
        '<td class="num">' + (o.statementCount || 0) + '</td>' +
        '<td>' + esc((o.accounts || []).join('、')) + '</td>' +
        '<td><button class="sm" onclick="editUnit(\'' + esc(u.id) + '\')">编辑</button> ' +
        '<button class="sm danger" onclick="delUnit(\'' + esc(u.id) + '\')">删除</button></td></tr>'
      );
    }).join('');
    setHtml('unitsBody',
      '<div class="card"><h3>新增往来单位<span class="hint">导入时也能自动建档，这里适合先批量建好</span></h3>' +
      '<div class="row">' +
      '<div class="field"><label>单位全称</label><input type="text" id="uName" style="width:260px" placeholder="对账函抬头用的全称" /></div>' +
      '<div class="field"><label>往来类型</label><select id="uType"><option value="customer">客户（应收）</option><option value="supplier">供应商（应付）</option><option value="both">兼有</option></select></div>' +
      '<div class="field"><label>简称/别名（逗号分隔）</label><input type="text" id="uAlias" style="width:200px" /></div>' +
      '<div class="field"><label>期初余额（元，可留空）</label><input type="number" id="uOpening" style="width:140px" step="0.01" /></div>' +
      '<div class="field"><label>期初所属科目</label><input type="text" id="uAccount" style="width:130px" placeholder="应收账款" /></div>' +
      '<button class="primary" onclick="addUnit()">新增</button>' +
      '</div></div>' +
      '<div class="card"><h3>单位列表<span class="hint">共 ' + S.units.length + ' 家</span></h3>' +
      (rows ? '<div class="table-wrap"><table><thead><tr><th>单位全称</th><th>类型</th><th>别名</th><th class="num">明细条数</th><th class="num">对账函</th><th>科目</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="empty">还没有往来单位</div>') +
      '</div>');
  }).catch(fail);
}
function addUnit() {
  var name = val('uName');
  if (!name) return toast('请填写单位全称', true);
  if (val('uOpening') && val('uAccount') && !confirm('期初余额会用于「期初由我手工录入」口径，确认按科目「' + val('uAccount') + '」录入吗？')) return;
  api('/api/units', {
    method: 'POST',
    body: {
      name: name,
      type: val('uType'),
      alias: val('uAlias'),
      openingFen: val('uOpening') ? yuanToFen(val('uOpening')) : 0,
      account: val('uAccount')
    }
  }).then(function () { toast('已新增'); renderUnits(); }).catch(fail);
}
function editUnit(id) {
  var u = S.units.filter(function (x) { return x.id === id; })[0];
  if (!u) return;
  openModal(
    '<h3>编辑单位</h3><div class="grid c2">' +
    '<div class="field"><label>单位全称</label><input type="text" id="euName" value="' + esc(u.name) + '" /></div>' +
    '<div class="field"><label>类型</label><select id="euType">' +
    ['customer', 'supplier', 'both'].map(function (t) {
      return '<option value="' + t + '"' + (u.type === t ? ' selected' : '') + '>' + ({ customer: '客户（应收）', supplier: '供应商（应付）', both: '兼有' })[t] + '</option>';
    }).join('') + '</select></div>' +
    '<div class="field"><label>别名（逗号分隔）</label><input type="text" id="euAlias" value="' + esc((u.alias || []).join(',')) + '" /></div>' +
    '<div class="field"><label>联系人</label><input type="text" id="euContact" value="' + esc(u.contact || '') + '" /></div>' +
    '<div class="field"><label>电话</label><input type="text" id="euPhone" value="' + esc(u.phone || '') + '" /></div>' +
    '<div class="field"><label>地址</label><input type="text" id="euAddress" value="' + esc(u.address || '') + '" /></div>' +
    '</div><div class="row mt"><button class="primary" onclick="saveUnit(\'' + esc(id) + '\')">保存</button><button onclick="closeModal()">取消</button></div>'
  );
}
function saveUnit(id) {
  api('/api/units/' + id, {
    method: 'PUT',
    body: { name: val('euName'), type: val('euType'), alias: val('euAlias'), contact: val('euContact'), phone: val('euPhone'), address: val('euAddress') }
  }).then(function () { closeModal(); toast('已保存'); renderUnits(); }).catch(fail);
}
function delUnit(id) {
  var u = S.units.filter(function (x) { return x.id === id; })[0];
  if (!u || !confirm('确认删除单位「' + u.name + '」？有账务数据的单位不能删除。')) return;
  api('/api/units/' + id, { method: 'DELETE' }).then(function () { toast('已删除'); renderUnits(); }).catch(fail);
}

// ---------------------------------------------------------------- 数据导入
var IMP = { file: null, analysis: null, plans: [] };

function renderImport() {
  setHtml('importBody',
    '<div class="steps" id="impSteps">' +
    '<div class="step active">1 选文件</div><div class="step">2 列映射与预览</div><div class="step">3 确认入库</div>' +
    '</div>' +
    '<div class="card"><h3>第 1 步：选择财务软件导出的文件<span class="hint">支持 .xls / .xlsx / .csv（GBK 编码也能识别）</span></h3>' +
    '<div class="row"><div class="field"><label>文件</label><input type="file" id="impFile" accept=".xls,.xlsx,.csv,.txt" /></div>' +
    '<button class="primary" onclick="impAnalyze()">解析并预览</button>' +
    '<span class="muted">明细账用于逐笔勾对；科目余额表只能出余额对账函。</span></div></div>' +
    '<div id="impResult"></div>');
}
function impAnalyze() {
  var input = document.getElementById('impFile');
  readFileBase64(input).then(function (f) {
    return api('/api/import/preview', { method: 'POST', body: { filename: f.filename, contentBase64: f.contentBase64 } }).then(function (a) {
      IMP.file = f;
      IMP.analysis = a;
      IMP.plans = (a.sheets || []).map(function (s) {
        var hit = (a.unitHits || [])[0];
        var hint = (a.unitHints || [])[0];
        return {
          sheetName: s.name,
          include: a.sheets.length === 1,
          headerRowNo: s.headerRowNo,
          mapping: Object.assign({}, s.mapping),
          unitId: hit && hit.matchedUnitId ? hit.matchedUnitId : '',
          account: '',
          direction: 'receivable'
        };
      });
      renderImpPlan();
    });
  }).catch(fail);
}
function renderImpPlan() {
  var a = IMP.analysis;
  var curPlan0 = IMP.plans[0] || {};
  var unitOpts = '<option value="">— 请选择 —</option>' + S.units.map(function (u) {
      var sel = (!curPlan0.autoNew && curPlan0.unitId === u.id) ? ' selected' : '';
      return '<option value="' + esc(u.id) + '"' + sel + '>' + esc(u.name) + '</option>';
    }).join('') + '<option value="__new__">＋按列里的名称自动新建</option>';
  var sheets = (a.sheets || []).map(function (s, i) {
    var p = IMP.plans[i];
    var keys = ['unitName', 'date', 'summary', 'debit', 'credit', 'amount', 'direction', 'balance', 'openingBalance', 'subject', 'voucherNo'];
    var labels = { unitName: '单位名称', date: '日期', summary: '摘要', debit: '借方金额', credit: '贷方金额', amount: '金额', direction: '方向', balance: '余额', openingBalance: '期初余额', subject: '科目', voucherNo: '凭证号' };
    var colOpts = '<option value="">（无）</option>';
    for (var c = 0; c < (s.headers || []).length; c++) colOpts += '<option value="' + c + '">第' + (c + 1) + '列：' + esc(s.headers[c] || '（空）') + '</option>';
    var mapRows = keys.map(function (k) {
      var cur = p.mapping[k];
      return '<tr><td>' + labels[k] + '</td><td><select onchange="impSetMap(' + i + ',\'' + k + '\',this.value)">' +
        colOpts.replace('value="' + cur + '"', 'value="' + cur + '" selected') + '</select></td></tr>';
    }).join('');
    var prev = (s.preview || []).map(function (r) {
      var cls = r.kind === 'subtotal' ? 'row-subtotal' : r.kind === 'opening' ? 'row-opening' : ((r.errors && r.errors.length) ? 'row-error' : ((r.warn && r.warn.length) ? 'row-subtotal' : ''));
      var cells = (r.cells || []).map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('');
      var note = r.kind === 'subtotal' ? '小计/合计行（不入库）' : r.kind === 'opening' ? '期初行（只取期初余额）' : (r.errors || []).concat(r.warn || []).join('；');
      return '<tr class="' + cls + '"><td class="muted">' + r.rowNo + '</td>' + cells +
        '<td class="num">' + (r.debitFen ? fenToStr(r.debitFen) : '') + '</td>' +
        '<td class="num">' + (r.creditFen ? fenToStr(r.creditFen) : '') + '</td>' +
        '<td class="muted">' + esc(note) + '</td></tr>';
    }).join('');
    var headCells = (s.headers || []).map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('');
    return (
      '<div class="card"><h3>工作表：' + esc(s.name) +
      '　<label class="muted"><input type="checkbox" ' + (p.include ? 'checked' : '') + ' onchange="impSetInclude(' + i + ',this.checked)" /> 导入此表</label>' +
      '<span class="hint">' + (s.sheetKind === 'balance' ? '识别为「科目余额表」（仅余额）' : '识别为「明细账」') + '，共 ' + s.rowCount + ' 行，数据行 ' + s.dataRows + '，小计行 ' + (s.subtotalRows || []).length + '</span></h3>' +
      '<div class="row">' +
      '<div class="field"><label>表头所在行（1 开头）</label><input type="number" id="impHr' + i + '" value="' + p.headerRowNo + '" style="width:110px" onchange="impSetHeader(' + i + ',this.value)" /></div>' +
      '<div class="field"><label>入库到哪家单位</label><select id="impUnit' + i + '" onchange="impSetUnit(' + i + ',this.value)">' + unitOpts + '</select></div>' +
      '<div class="field"><label>科目（可留空，文件里有科目列会自动按行取）</label><input type="text" id="impAcc' + i + '" value="' + esc(p.account || '') + '" onchange="impSetAcc(' + i + ',this.value)" /></div>' +
      '<div class="field"><label>方向</label><select id="impDir' + i + '" onchange="impSetDir(' + i + ',this.value)"><option value="receivable"' + (p.direction === 'receivable' ? ' selected' : '') + '>应收（我方债权）</option><option value="payable"' + (p.direction === 'payable' ? ' selected' : '') + '>应付（我方债务）</option></select></div>' +
      '</div>' +
      (function () {
        var sug = s.templateSuggestions || [];
        if (!sug.length) return '';
        var btns = sug.map(function (t) {
          return '<button class="sm" onclick="impApplyTemplate(' + i + ',\'' + esc(t.id) + '\')">套用「' + esc(t.name) + '」</button>';
        }).join(' ');
        return '<div class="note info"><b>匹配到列映射模板：</b>这份文件的表头与库里已保存的模板一致，可一键套用（套用后仍请核对下方预览）：' + btns + '</div>';
      })() +
      '<div class="row mt"><button class="sm" onclick="impSaveTemplate(' + i + ')">把当前映射存为模板</button><span class="hint">给模板起个带软件名的名字（如「用友T3 明细账」），导出 JSON 可分享给其他用户</span></div>' +
      (s.detected ? '' : '<div class="note warn">未自动识别到表头，请手工填「表头所在行」，并核对下面的列对应关系。</div>') +
      (function () {
        var b = s.balanceCheck || {};
        if (!b.available) return '<div class="note info">余额列交叉校验未启用：' + esc(b.reason || '文件里没有余额列') + '</div>';
        if (!b.compared) return '<div class="note info">余额列交叉校验：' + esc(b.reason || '可比对的行不足两行') + '</div>';
        if (!b.mismatchCount) {
          return '<div class="note ok">余额列交叉校验：' + b.compared + ' 行与文件自带的「余额」列逐行吻合（该文件余额为' + esc(b.conventionLabel || '') + '）。方向与金额都没读错。</div>';
        }
        var or = p.rowOverrides || {};
        var rows2 = (b.mismatches || []).map(function (m) {
          var st = or[String(m.rowNo)];
          return '<tr class="bad"><td class="muted">第 ' + m.rowNo + ' 行</td><td>' + esc(m.summary || '') + '</td>' +
            '<td class="num">' + fenToStr(m.delta) + '</td><td class="num">' + fenToStr(m.movement) + '</td>' +
            '<td class="num">' + fenToStr(m.diff) + '</td>' +
            '<td>' + (st === 'flip' ? '<span class="tag blue">已取反</span>' : st === 'skip' ? '<span class="tag yellow">已剔除</span>' : '') +
            '<button class="sm" onclick="impRowFix(' + i + ',' + m.rowNo + ',\'flip\')">借贷取反</button> ' +
            '<button class="sm" onclick="impRowFix(' + i + ',' + m.rowNo + ',\'skip\')">剔除此行</button></td></tr>';
        }).join('');
        return '<div class="note warn"><b>余额列交叉校验：' + b.compared + ' 行里有 ' + b.mismatchCount + ' 行与文件自带的「余额」列对不上。</b>' +
          '最常见的原因是红字没用负号/括号表示（颜色我们读不到），也可能是金额被截断或漏行。请逐行核对后点「借贷取反」或「剔除此行」：</div>' +
          '<div class="table-wrap"><table><thead><tr><th>行号</th><th>摘要</th><th class="num">余额变化</th><th class="num">解析出的借贷净额</th><th class="num">差额</th><th>处理</th></tr></thead><tbody>' + rows2 + '</tbody></table></div>';
      })() +
      '<div class="grid c2 mt"><div><div class="muted mb">列对应关系</div><table>' + mapRows + '</table></div>' +
      '<div><div class="muted mb">前 20 行预览（橙色=小计行会被剔除，蓝色=期初行；右侧两列是工具解析出的借贷金额，请重点核对冲销/红字行）</div><div class="table-wrap"><table><thead><tr><th>行</th>' + headCells + '<th>解析为借方</th><th>解析为贷方</th><th>说明</th></tr></thead><tbody>' + prev + '</tbody></table></div></div></div>' +
      '</div>'
    );
  }).join('');
  var hints = (a.unitHints || []).map(function (h) {
    return '标题行「' + esc(h.text) + '」→ 疑似单位「' + esc(h.guess) + '」' + (h.matchedUnitName ? '（已匹配档案：' + esc(h.matchedUnitName) + '）' : '（未匹配到档案，导入时若选了自动新建会建档）');
  });
  setHtml('impResult',
    '<div class="card"><h3>第 2 步：核对映射与预览<span class="hint">文件签名 ' + esc(a.fileHash) + '，编码 ' + esc(a.encoding || a.fileKind) + '</span></h3>' +
    (hints.length ? '<div class="note info"><b>单位线索</b><br />' + hints.join('<br />') + '</div>' : '') +
    ((a.warnings || []).length ? '<div class="note warn">' + a.warnings.map(esc).join('<br />') + '</div>' : '') +
    '</div>' + sheets +
    '<div class="card"><button class="primary" onclick="impCommit(false)">确认入库</button> ' +
    '<button onclick="impCommit(true)">先试算（不入库）</button></div>' +
    '<div class="card"><h3>列映射模板库<span class="hint">开源共享的适配层：一种财务软件的导出格式，适配一次全网复用</span></h3><div id="mapTplList"></div></div>' +
    '<div id="impDone"></div>');
  loadMapTemplates();
}
function impApplyTemplate(i, tid) {
  var p = IMP.plans[i];
  api('/api/map-templates/' + tid + '/use', { method: 'POST' }).then(function (t) {
    if (t && t.mapping) {
      var m = t.mapping, k;
      for (k in m) if (Object.prototype.hasOwnProperty.call(m, k)) p.mapping[k] = m[k];
      if (t.account && !p.account) { p.account = t.account; var el = document.getElementById('impAcc' + i); if (el) el.value = t.account; }
      toast('已套用模板「' + t.name + '」，请核对预览');
      renderImpPlan();
    }
  }).catch(fail);
}
function impSaveTemplate(i) {
  var p = IMP.plans[i];
  var s = IMP.analyze.sheets[i];
  var name = prompt('模板名字（建议带软件名，如「用友T3 明细账导出」）：');
  if (!name) return;
  var software = prompt('财务软件名称（可选，便于社区检索）：') || '';
  api('/api/map-templates', { method: 'POST', body: { name: name, software: software, headers: s.headers, mapping: p.mapping, account: p.account || '' } })
    .then(function (t) { toast('模板已保存：' + t.name + '（可在下方导出分享）'); loadMapTemplates(); })
    .catch(fail);
}
function loadMapTemplates() {
  api('/api/map-templates').then(function (list) {
    S.mapTemplates = list || [];
    var el = document.getElementById('mapTplList');
    if (!el) return;
    if (!S.mapTemplates.length) { el.innerHTML = '<div class="muted">还没有保存过映射模板。在导入向导里调好列映射后点「把当前映射存为模板」，就能导出 JSON 分享给其他用户。</div>'; return; }
    el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>名字</th><th>软件</th><th>表头特征</th><th>使用次数</th><th>操作</th></tr></thead><tbody>' +
      S.mapTemplates.map(function (t) {
        return '<tr><td>' + esc(t.name) + '</td><td>' + esc(t.software || '') + '</td><td class="muted">' + esc((t.headers || []).join(' | ').slice(0, 60)) + '</td><td>' + (t.usedCount || 0) + '</td>' +
          '<td><a href="/api/map-templates/export?ids=' + esc(t.id) + '">导出</a> <button class="sm" onclick="impDelTemplate(\'' + esc(t.id) + '\')">删除</button></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="row mt"><a href="/api/map-templates/export" class="btn">导出全部模板</a>' +
      '<input type="file" id="tplImportFile" accept=".json" style="display:none" onchange="impImportTemplateFile(this)" />' +
      '<button class="sm" onclick="document.getElementById(\'tplImportFile\').click()">从 JSON 导入模板</button></div>';
  }).catch(fail);
}
function impDelTemplate(id) {
  if (!confirm('删除这个映射模板？')) return;
  api('/api/map-templates/' + id, { method: 'DELETE' }).then(function () { toast('已删除'); loadMapTemplates(); }).catch(fail);
}
function impImportTemplateFile(input) {
  var f = input.files && input.files[0];
  if (!f) return;
  var rd = new FileReader();
  rd.onload = function () {
    var data;
    try { data = JSON.parse(rd.result); } catch (e) { alert('不是有效的 JSON 文件'); return; }
    api('/api/map-templates/import', { method: 'POST', body: data })
      .then(function (r) {
        toast('导入 ' + r.imported + ' 个模板' + (r.skipped.length ? '，跳过 ' + r.skipped.length + ' 个' : ''));
        loadMapTemplates();
      }).catch(fail);
  };
  rd.readAsText(f, 'utf-8');
}
function impRowFix(i, rowNo, action) {
  var p = IMP.plans[i];
  p.rowOverrides = p.rowOverrides || {};
  if (p.rowOverrides[String(rowNo)] === action) delete p.rowOverrides[String(rowNo)];
  else p.rowOverrides[String(rowNo)] = action;
  renderImpPlan();
}
function impSetMap(i, k, v) {
  if (v === '') delete IMP.plans[i].mapping[k];
  else IMP.plans[i].mapping[k] = Number(v);
}
function impSetInclude(i, v) { IMP.plans[i].include = !!v; }
function impSetHeader(i, v) { IMP.plans[i].headerRowNo = Number(v); }
function impSetUnit(i, v) { IMP.plans[i].unitId = v === '__new__' ? '' : v; IMP.plans[i].autoNew = v === '__new__'; }
function impSetAcc(i, v) { IMP.plans[i].account = v; }
function impSetDir(i, v) { IMP.plans[i].direction = v; }
function impCommit(dryRun) {
  var plans = IMP.plans.map(function (p) { return Object.assign({}, p, { unitId: p.unitId || undefined }); });
  api('/api/import/commit', {
    method: 'POST',
    body: { filename: IMP.file.filename, contentBase64: IMP.file.contentBase64, plans: plans, dryRun: !!dryRun }
  }).then(function (r) {
    setHtml('impDone',
      '<div class="card"><h3>' + (dryRun ? '试算结果（未入库）' : '入库结果') + '</h3>' +
      '<div class="note ' + (r.errors && r.errors.length ? 'warn' : 'ok') + '">' +
      '新增明细 <b>' + (r.added !== undefined ? r.added : r.wouldAdd) + '</b> 条，' +
      '期初余额 <b>' + (r.addedOpening !== undefined ? r.addedOpening : r.wouldAddOpening) + '</b> 条，' +
      '跳过重复 <b>' + r.dupSkipped + '</b> 条，剔除小计行 <b>' + r.subtotalSkipped + '</b> 行，' +
      '导入批次 <span class="mono">' + esc(r.batch) + '</span></div>' +
      ((r.unitsCreated || []).length ? '<div class="note info">自动新建单位：' + r.unitsCreated.map(function (u) { return esc(u.name); }).join('、') + '</div>' : '') +
      ((r.errors || []).length ? '<div class="note bad"><b>需要人工处理（' + r.errors.length + ' 条）</b><ul>' + r.errors.slice(0, 30).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>' : '') +
      ((r.warnings || []).length ? '<div class="note warn">' + r.warnings.map(esc).join('<br />') + '</div>' : '') +
      '</div>');
    toast(dryRun ? '试算完成（未写入）' : '导入完成');
    if (!dryRun) {
      loadUnits('units');
      IMP.analysis = null;
    }
  }).catch(fail);
}

// ---------------------------------------------------------------- 模板设置
function renderTemplates() {
  var c = (S.config && S.config.company) || {};
  setHtml('templatesBody',
    '<div class="card"><h3>我方公司信息<span class="hint">这些内容会印在对账函抬头上</span></h3>' +
    '<div class="grid c3">' +
    '<div class="field"><label>公司名称</label><input type="text" id="coName" value="' + esc(c.name || '') + '" /></div>' +
    '<div class="field"><label>地址</label><input type="text" id="coAddress" value="' + esc(c.address || '') + '" /></div>' +
    '<div class="field"><label>电话</label><input type="text" id="coPhone" value="' + esc(c.phone || '') + '" /></div>' +
    '<div class="field"><label>经办人</label><input type="text" id="coContact" value="' + esc(c.contact || '') + '" /></div>' +
    '<div class="field"><label>Logo 路径（本地图片，可留空）</label><input type="text" id="coLogo" value="' + esc(c.logoPath || '') + '" /></div>' +
    '<div class="field"><label>&nbsp;</label><button class="primary" onclick="saveCompany()">保存</button></div>' +
    '</div></div>' +
    '<div class="card"><h3>函件预览<span class="hint">用真实数据渲染，切方向看看措辞</span></h3>' +
    '<div class="row"><div class="field"><label>方向</label><select id="tplDir"><option value="receivable">应收对账函</option><option value="payable">应付对账函</option></select></div>' +
    '<div class="field"><label>单位</label><select id="tplUnit">' + S.units.map(function (u) { return '<option value="' + esc(u.id) + '">' + esc(u.name) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>截止日</label><input type="date" id="tplCutoff" value="' + esc((S.periods[0] ? S.periods[0] + '-28' : new Date().toISOString().slice(0, 10))) + '" /></div>' +
    '<button class="primary" onclick="previewTemplate()">生成预览</button>' +
    '<span class="muted">' + (S.units.length ? '' : '还没有单位，先去建档或导入数据。') + '</span></div>' +
    '<div id="tplPreview" class="mt"></div></div>' +
    '<div class="card"><h3>模板文件<span class="hint">懂 HTML 的话可以直接改版式，改前会自动备份</span></h3>' +
    '<div id="tplList"></div><div id="tplEditor"></div></div>');
  loadTemplateList();
}
function saveCompany() {
  api('/api/config', {
    method: 'PUT',
    body: { company: { name: val('coName'), address: val('coAddress'), phone: val('coPhone'), contact: val('coContact'), logoPath: val('coLogo') } }
  }).then(function (cfg) { S.config = cfg; toast('已保存'); renderTopbar(); }).catch(fail);
}
function previewTemplate() {
  api('/api/templates/preview', { method: 'POST', body: { direction: val('tplDir'), unitId: val('tplUnit'), cutoffDate: val('tplCutoff') } })
    .then(function (r) {
      setHtml('tplPreview', '<div class="muted mb">预览单位：' + esc(r.unit) + '，余额 ' + fenToStr(r.balance.absFen) + '</div><iframe class="preview-frame" srcdoc="' + esc(r.html) + '"></iframe>');
    }).catch(fail);
}
function loadTemplateList() {
  api('/api/templates/list').then(function (list) {
    setHtml('tplList', list.map(function (f) {
      return '<button class="sm" onclick="editTemplate(\'' + esc(f.file) + '\')">编辑 ' + esc(f.file) + '</button> ';
    }).join(''));
  }).catch(fail);
}
function editTemplate(file) {
  api('/api/templates/raw?file=' + encodeURIComponent(file)).then(function (r) {
    setHtml('tplEditor',
      '<div class="mt"><div class="muted mb">' + esc(file) + '</div>' +
      '<textarea id="tplRaw" style="min-height:340px">' + esc(r.content) + '</textarea>' +
      '<div class="row mt"><button class="primary" onclick="saveTemplate(\'' + esc(file) + '\')">保存模板</button>' +
      '<button onclick="setHtml(\'tplEditor\',\'\')">关闭</button></div></div>');
  }).catch(fail);
}
function saveTemplate(file) {
  api('/api/templates/raw', { method: 'PUT', body: { file: file, content: val('tplRaw') } })
    .then(function () { toast('模板已保存（旧版已自动备份）'); }).catch(fail);
}

// ---------------------------------------------------------------- 批量生成
function renderGenerate() {
  api('/api/sessions').then(function (ss) { S.sessions = ss || []; });
  setHtml('generateBody',
    '<div class="card"><h3>选择对账范围</h3>' +
    '<div class="row">' +
    '<div class="field"><label>对账截止日</label><input type="date" id="genCutoff" value="' + esc(S.periods[0] ? S.periods[0] + '-28' : new Date().toISOString().slice(0, 10)) + '" onchange="loadBalances()" /></div>' +
    '<div class="field"><label>方向</label><select id="genDir" onchange="loadBalances()"><option value="receivable">应收（我方债权）</option><option value="payable">应付（我方债务）</option></select></div>' +
    '<button onclick="loadBalances()">列出截止日有数据的单位</button>' +
    '<button class="primary" onclick="doGenerate()">一键生成对账函</button>' +
    '</div>' +
    '<div class="note info">余额口径在「设置」里切换；这里显示的余额就是函上的金额。带「仅余额」标记的单位只有余额、没有逐笔明细，无法做逐笔勾对。</div>' +
    '</div>' +
    '<div class="card"><h3>单位与余额<span class="hint">勾选要发函的单位</span></h3><div id="genList">点上面的按钮开始</div></div>' +
    '<div class="card"><h3>生成结果</h3><div id="genResult"><div class="empty">还没有生成记录</div></div></div>' +
    (S.sessions.length ? '<div class="card"><h3>历史批次</h3>' + S.sessions.slice(0, 10).map(function (s) {
      return '<div class="row" style="align-items:center"><span class="mono">' + esc(s.id) + '</span><span>' + esc(s.period) + '　' + (s.direction === 'payable' ? '应付' : '应收') + '　截止 ' + esc(s.cutoffDate) + '　共 ' + s.statementCount + ' 份</span><span class="spacer"></span><button class="sm" onclick="downloadZip(\'' + esc(s.id) + '\')">下载 zip</button></div>';
    }).join('') + '</div>' : ''));
  loadBalances();
}
function loadBalances() {
  api('/api/ledger/balances?cutoff=' + encodeURIComponent(val('genCutoff')) + '&direction=' + encodeURIComponent(val('genDir')))
    .then(function (list) {
      S.balances = list || [];
      if (!S.balances.length) {
        setHtml('genList', '<div class="empty">这个截止日下没有任何单位有数据。先到「数据导入」导一份明细账，或改一下截止日。</div>');
        return;
      }
      var rows = S.balances.map(function (b) {
        return (
          '<tr><td><input type="checkbox" class="genPick" value="' + esc(b.unit.id) + '" checked /></td>' +
          '<td>' + esc(b.unit.name) + '</td>' +
          '<td>' + esc(({ customer: '客户', supplier: '供应商', both: '兼有' })[b.unit.type] || '') + '</td>' +
          '<td class="num">' + fenToStr(b.absFen) + '</td>' +
          '<td>' + (b.hasDetail ? '<span class="tag green">有明细 ' + b.entryCount + ' 笔</span>' : '<span class="tag yellow">仅余额</span>') + '</td>' +
          '<td>' + esc((b.accounts || []).join('、')) + '</td>' +
          '<td class="muted">' + esc((b.warnings || []).length ? '有口径提示' : '') + '</td>' +
          '</tr>'
        );
      }).join('');
      setHtml('genList',
        '<div class="row mb"><button class="sm" onclick="genPickAll(true)">全选</button><button class="sm" onclick="genPickAll(false)">全不选</button>' +
        '<span class="muted">共 ' + S.balances.length + ' 家，合计余额 ' + fenToStr(S.balances.reduce(function (a, b) { return a + Math.abs(b.absFen); }, 0)) + '</span></div>' +
        '<div class="table-wrap"><table><thead><tr><th></th><th>单位</th><th>类型</th><th class="num">余额</th><th>明细</th><th>科目</th><th>提示</th></tr></thead><tbody>' + rows + '</tbody></table></div>');
    }).catch(fail);
}
function genPickAll(v) {
  var els = document.querySelectorAll('.genPick');
  for (var i = 0; i < els.length; i++) els[i].checked = v;
}
function doGenerate() {
  var picks = [];
  var els = document.querySelectorAll('.genPick');
  for (var i = 0; i < els.length; i++) if (els[i].checked) picks.push(els[i].value);
  if (!picks.length) return toast('请至少勾选一家单位', true);
  var cutoff = val('genCutoff');
  if (!confirm('按截止日 ' + cutoff + ' 为 ' + picks.length + ' 家单位生成对账函？\n生成前会自动备份数据。')) return;
  toast('正在生成，请稍候…');
  api('/api/statements/generate', { method: 'POST', body: { unitIds: picks, cutoffDate: cutoff, direction: val('genDir'), period: cutoff.slice(0, 7) } })
    .then(function (r) {
      var rows = (r.results || []).map(function (x) {
        return x.ok
          ? '<tr class="ok"><td>' + esc(x.unitName) + '</td><td class="mono">' + esc(x.serialNo) + '</td><td class="num">v' + x.version + '</td><td class="num">' + fenToStr(x.balanceFen) + '</td>' +
            '<td>' + (x.pdfOk ? '<span class="tag green">PDF</span>' : '<span class="tag yellow">降级为打印版 HTML</span>') + ' <span class="tag blue">Excel</span></td>' +
            '<td>' + esc(x.pdfDegraded ? x.pdfReason : '') + '</td></tr>'
          : '<tr class="bad"><td>' + esc(x.unitName || x.unitId) + '</td><td colspan="4">' + esc(x.err || '失败') + '</td></tr>';
      }).join('');
      setHtml('genResult',
        '<div class="note ' + (r.failCount ? 'warn' : 'ok') + '">成功 ' + r.okCount + ' 份，失败 ' + r.failCount + ' 份。PDF 引擎：' + esc(r.browser.path || '未找到') + '</div>' +
        '<table><thead><tr><th>单位</th><th>编号</th><th>版本</th><th class="num">余额</th><th>产物</th><th>备注</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div class="row mt"><button class="primary" onclick="downloadZip(\'' + esc(r.session.id) + '\')">打包下载 zip</button>' +
        '<button onclick="showTab(\'archive\')">去历史归档</button></div>');
      toast('生成完成');
    }).catch(fail);
}
function downloadZip(sid) {
  if (typeof window !== 'undefined' && window.location) window.location.href = '/api/statements/batchZip?sessionId=' + encodeURIComponent(sid);
}

// ---------------------------------------------------------------- 回函核对
var RE = { statementId: '', theirBalanceFen: 0, theirEntries: [], channel: 'manual', signFlip: false, replyId: '', diff: null };

function renderReply() {
  api('/api/archive/tree').then(function (tree) {
    S.tree = tree || [];
    S.statements = [];
    (tree || []).forEach(function (n) {
      (n.periods || []).forEach(function (p) {
        (p.versions || []).forEach(function (v) {
          S.statements.push(Object.assign({ unitName: n.unit.name, unitId: n.unitId, period: p.period }, v));
        });
      });
    });
    var opts = S.statements.map(function (s) {
      return '<option value="' + esc(s.statementId) + '">' + esc(s.unitName) + '　' + esc(s.serialNo) + '　v' + s.version + '　' + tagText(s.status) + '</option>';
    }).join('');
    setHtml('replyBody',
      '<div class="card"><h3>选择要核对的对账函<span class="hint">共 ' + S.statements.length + ' 份</span></h3>' +
      (opts
        ? '<div class="row"><div class="field"><label>对账函</label><select id="reStmt" style="min-width:520px" onchange="pickStatement(this.value)">' + opts + '</select></div>' +
          '<button onclick="loadReplies()">查看已录回函</button></div><div id="reStmtInfo" class="mt"></div>'
        : '<div class="empty">还没有对账函，先去「批量生成」出一批。</div>') +
      '</div>' +
      '<div id="reForm"></div>' +
      '<div class="card"><h3>已录入的回函</h3><div id="reList"><div class="empty">未加载</div></div></div>');
    if (opts) pickStatement(S.statements[0].statementId);
  }).catch(fail);
}
function pickStatement(id) {
  RE.statementId = id;
  var s = S.statements.filter(function (x) { return x.statementId === id; })[0];
  if (!s) return;
  setHtml('reStmtInfo',
    '<div class="grid c4">' +
    '<div class="kpi"><div class="k">往来单位</div><div class="v small">' + esc(s.unitName) + '</div></div>' +
    '<div class="kpi"><div class="k">我方账面余额</div><div class="v">' + fenToStr(s.ourBalanceFen) + '</div></div>' +
    '<div class="kpi"><div class="k">方向 / 期间</div><div class="v small">' + (s.direction === 'payable' ? '应付' : '应收') + ' / ' + esc(s.period) + '</div><div class="k">截止 ' + esc(s.cutoffDate) + '</div></div>' +
    '<div class="kpi"><div class="k">回函状态</div><div class="v small"><span class="tag ' + tagKind(s.status) + '">' + tagText(s.status) + '</span> 共 ' + s.replyCount + ' 份</div></div>' +
    '</div>');
  setHtml('reForm',
    '<div class="card"><h3>录入对方回函</h3>' +
    '<div class="note info">三种录入方式随便挑：最省事的是「只填余额」，能逐笔勾对的是「导入对方明细」或「粘贴明细」。<br />' +
    '口径提示：对账函上填的余额就是「对方欠我方多少」（应付场景是「我方欠对方多少」），直接照抄即可；若对方给的是他们自己账套导出的明细账（借贷方向与我们相反），请勾选下面的「对方明细方向翻转」。</div>' +
    '<div class="row">' +
    '<div class="field"><label>对方申报余额（元）</label><input type="number" id="reBal" step="0.01" style="width:170px" value="' + (RE.theirBalanceFen ? RE.theirBalanceFen / 100 : '') + '" onchange="RE.theirBalanceFen=yuanToFen(this.value)" /></div>' +
    '<div class="field"><label>回函日期</label><input type="date" id="reDate" /></div>' +
    '<div class="field"><label>对方明细方向翻转</label><label class="muted"><input type="checkbox" id="reFlip" onchange="RE.signFlip=this.checked" /> 借贷对调</label></div>' +
    '<span class="spacer"></span>' +
    '<button class="primary" onclick="runDiff()">开始勾对</button>' +
    '</div>' +
    '<div class="grid c2 mt">' +
    '<div class="card" style="margin:0"><h3>方式 B：导入对方明细文件</h3>' +
    '<div class="row"><input type="file" id="reFile" accept=".xls,.xlsx,.csv,.txt" /><button onclick="reAnalyzeFile()">解析</button></div>' +
    '<div id="reFilePreview" class="mt"></div></div>' +
    '<div class="card" style="margin:0"><h3>方式 C：粘贴明细</h3>' +
    '<textarea id="rePaste" placeholder="从对方的 Excel 里直接复制几行粘进来即可，分隔符（Tab/逗号/空格）自动识别；&#10;不放心就带上表头，比如：&#10;日期  摘要  借方金额  贷方金额"></textarea>' +
    '<div class="row mt"><button onclick="reParsePaste()">解析粘贴内容</button></div>' +
    '<div id="rePastePreview" class="mt"></div></div>' +
    '</div>' +
    '<div id="reMapBox"></div>' +
    '</div>' +
    '<div id="reDiffBox"></div>');
}
function reAnalyzeFile() {
  readFileBase64(document.getElementById('reFile')).then(function (f) {
    RE.file = f;
    return api('/api/reply/analyze', { method: 'POST', body: { filename: f.filename, contentBase64: f.contentBase64, unitId: (S.statements.filter(function (x) { return x.statementId === RE.statementId; })[0] || {}).unitId || '' } });
  }).then(function (a) {
    RE.analyze = a;
    var s = (a.sheets || [])[0];
    if (!s) return toast('文件里没有工作表', true);
    RE.pendingMapping = { sheetName: s.name, headerRowNo: s.effectiveHeaderRowNo, mapping: s.effectiveMapping, headers: s.headers, signature: s.signature, source: s.mappingSource };
    var keys = Object.keys(s.effectiveMapping || {});
    setHtml('reFilePreview',
      '<div class="note info">' + esc(s.mappingSource) + (s.savedMap ? '（该单位的回函格式已记住，下次自动套用）' : '') + '</div>' +
      '<table><tr><th>识别到的列</th><td>' + (keys.length ? keys.map(function (k) { return esc(k) + '→第' + (s.effectiveMapping[k] + 1) + '列'; }).join('，') : '（没认出来，请手工指定）') + '</td></tr>' +
      '<tr><th>表头行</th><td>第 ' + s.effectiveHeaderRowNo + ' 行：' + esc(s.headers.join(' | ')) + '</td></tr></table>' +
      '<div class="row mt"><button class="primary" onclick="reParseFile()">按这个映射解析</button>' +
      '<button onclick="reRemember()">记住为该单位的回函格式</button></div>');
  }).catch(fail);
}
function reParseFile() {
  var m = RE.pendingMapping;
  api('/api/reply/parse', {
    method: 'POST',
    body: { filename: RE.file.filename, contentBase64: RE.file.contentBase64, sheetName: m.sheetName, headerRowNo: m.headerRowNo, mapping: m.mapping, signFlip: RE.signFlip, unitId: (S.statements.filter(function (x) { return x.statementId === RE.statementId; })[0] || {}).unitId }
  }).then(function (r) {
    RE.theirEntries = r.entries || [];
    RE.channel = 'excel';
    reShowEntries('导入文件');
  }).catch(fail);
}
function reRemember() {
  var st = S.statements.filter(function (x) { return x.statementId === RE.statementId; })[0] || {};
  var m = RE.pendingMapping;
  api('/api/reply/maps', {
    method: 'POST',
    body: { unitId: st.unitId, name: (st.unitName || '回函') + ' 的格式', headers: m.headers, signature: m.signature, headerRowNo: m.headerRowNo, mapping: m.mapping }
  }).then(function () { toast('已记住，下次这家单位的回函自动套用'); }).catch(fail);
}
function reParsePaste() {
  var txt = val('rePaste');
  if (!txt) return toast('请先粘贴内容', true);
  api('/api/reply/parse', { method: 'POST', body: { text: txt, signFlip: RE.signFlip } }).then(function (r) {
    RE.theirEntries = r.entries || [];
    RE.channel = 'paste';
    if (r.balanceFen) RE.theirBalanceFen = r.balanceFen;
    reShowEntries('粘贴');
  }).catch(fail);
}
function reShowEntries(how) {
  var e = RE.theirEntries || [];
  var rows = e.slice(0, 100).map(function (x) {
    return '<tr><td>' + esc(x.date || '') + '</td><td>' + esc(x.summary || '') + '</td><td class="num">' + (x.debitFen ? fenToStr(x.debitFen) : '') + '</td><td class="num">' + (x.creditFen ? fenToStr(x.creditFen) : '') + '</td></tr>';
  }).join('');
  var box = how === '粘贴' ? 'rePastePreview' : 'reFilePreview';
  var el = document.getElementById(box);
  if (el) el.innerHTML = '<div class="note ok">' + how + '解析出 ' + e.length + ' 笔' + (e.length > 100 ? '（只显示前 100 笔）' : '') + '</div>' +
    (rows ? '<div class="table-wrap"><table><thead><tr><th>日期</th><th>摘要</th><th class="num">借方</th><th class="num">贷方</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '');
  toast('已解析 ' + e.length + ' 笔明细');
}
function runDiff() {
  RE.theirBalanceFen = yuanToFen(val('reBal'));
  RE.signFlip = checked('reFlip');
  api('/api/diff/run', {
    method: 'POST',
    body: {
      statementId: RE.statementId,
      replyId: RE.replyId || undefined,
      theirBalanceFen: RE.theirBalanceFen,
      theirEntries: RE.theirEntries,
      channel: RE.channel,
      signFlip: RE.signFlip,
      replyDate: val('reDate')
    }
  }).then(function (r) {
    RE.replyId = r.reply.id;
    RE.diff = r.diffResult;
    renderDiff(r.reply.id, r.diffResult);
    toast('勾对完成');
  }).catch(fail);
}
function renderDiff(replyId, d) {
  var sec = function (title, list, cls, cols) {
    if (!list || !list.length) return '';
    var rows = list.map(function (x) {
      var o = x.our || x, t = x.their;
      var a = Array.isArray(o) ? o[0] : o;
      var b = Array.isArray(t) ? t[0] : t;
      return '<tr class="' + (cls || '') + '"><td>' + esc(a.date || '') + '</td><td>' + esc(a.summary || '') + '</td>' +
        '<td class="num">' + (a.debitFen ? fenToStr(a.debitFen) : '') + '</td><td class="num">' + (a.creditFen ? fenToStr(a.creditFen) : '') + '</td>' +
        '<td>' + esc(x.label || x.describe || '') + '</td>' +
        '<td class="muted">' + esc(b ? (b.date || '') + ' ' + (b.summary || '') : '') + '</td></tr>';
    }).join('');
    return '<h3 style="margin-top:14px">' + title + '（' + list.length + '）</h3><div class="table-wrap"><table><thead><tr><th>我方日期</th><th>摘要</th><th class="num">借方</th><th class="num">贷方</th><th>说明</th><th>对方</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  };
  var levelHtml = function (title, list, cls) {
    if (!list || !list.length) return '';
    var rows = list.map(function (m) {
      return '<tr class="' + cls + '"><td>' + esc(m.our.date) + '</td><td>' + esc(m.our.summary) + '</td>' +
        '<td class="num">' + (m.our.debitFen ? fenToStr(m.our.debitFen) : '') + '</td><td class="num">' + (m.our.creditFen ? fenToStr(m.our.creditFen) : '') + '</td>' +
        '<td class="muted">' + esc(m.their.date) + ' ' + esc(m.their.summary) + '</td>' +
        '<td>' + (m.dateGapDays !== undefined && m.dateGapDays !== null ? '相差 ' + m.dateGapDays + ' 天' : '') + '</td></tr>';
    }).join('');
    return '<h3 style="margin-top:14px">' + title + '（' + list.length + '）</h3><div class="table-wrap"><table><thead><tr><th>我方日期</th><th>摘要</th><th class="num">借方</th><th class="num">贷方</th><th>对方</th><th>说明</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  };
  setHtml('reDiffBox',
    '<div class="card"><h3>差异报告<span class="hint">勾对结果一律是草稿，逐项确认后才归档</span></h3>' +
    '<div class="grid c4">' +
    '<div class="kpi"><div class="k">我方余额</div><div class="v">' + fenToStr(d.ourClosingFen) + '</div></div>' +
    '<div class="kpi"><div class="k">对方余额</div><div class="v">' + fenToStr(d.theirBalanceFen) + '</div></div>' +
    '<div class="kpi"><div class="k">差异</div><div class="v" style="color:' + (d.balanceDiffFen === 0 ? '#1a7f37' : '#b42318') + '">' + fenToStr(d.balanceDiffFen) + '</div></div>' +
    '<div class="kpi"><div class="k">勾对结论</div><div class="v small"><span class="tag ' + tagKind(d.status) + '">' + tagText(d.status) + '</span></div></div>' +
    '</div>' +
    '<div class="note ' + (d.balanceDiffFen === 0 ? 'ok' : 'warn') + '">' + esc(d.summary || '') +
    (d.flipSuggestion ? '<br /><b>' + esc(d.flipSuggestion) + '</b> <button class="sm" onclick="document.getElementById(\'reFlip\').checked=true;RE.signFlip=true;runDiff()">按建议翻转后重跑</button>' : '') + '</div>' +
    ((d.warnings || []).length ? '<div class="note warn"><b>待人工确认</b><ul>' + d.warnings.map(function (w) { return '<li>' + esc(w.replace(/^MANUAL_REVIEW:\s*/, '')) + '</li>'; }).join('') + '</ul></div>' : '') +
    levelHtml('一、完全一致（绿）', d.matched, 'ok') +
    levelHtml('二、时间性差异 / 在途（黄）', d.timeDiffs, 'warn') +
    sec('三、组合匹配（蓝）：多笔合并', d.combos, 'info') +
    sec('四、我方有、对方无（红）', d.ourOnly, 'bad') +
    sec('五、对方有、我方无（红）', d.theirOnly, 'bad') +
    sec('六、可疑记录（方向相反 / 疑似重复）', d.suspects, 'warn') +
    '<div class="row mt"><button class="primary" onclick="confirmDiff(\'' + esc(replyId) + '\')">确认无误并归档</button>' +
    '<button onclick="showReport(\'' + esc(replyId) + '\')">打开完整差异报告</button>' +
    '<span class="muted">确认后状态变为「已确认」，差异报告会写进归档目录。</span></div>' +
    '</div>');
}
function confirmDiff(replyId) {
  var by = prompt('确认人（默认：会计）', '会计');
  if (by === null) return;
  var note = prompt('确认备注（可留空）', '') || '';
  api('/api/diff/confirm', { method: 'POST', body: { replyId: replyId, confirmedBy: by, note: note } })
    .then(function () { toast('已确认并归档'); loadReplies(); renderReply(); }).catch(fail);
}
function showReport(replyId) {
  api('/api/diff/report?replyId=' + encodeURIComponent(replyId)).then(function (r) {
    openModal('<div class="row mb"><b>差异报告</b><span class="spacer"></span><button onclick="closeModal()">关闭</button></div><iframe class="preview-frame" srcdoc="' + esc(r.html) + '"></iframe>');
  }).catch(fail);
}
function loadReplies() {
  api('/api/replies').then(function (list) {
    if (!list || !list.length) {
      setHtml('reList', '<div class="empty">还没有录入任何回函</div>');
      return;
    }
    var rows = list.slice(0, 30).map(function (r) {
      var d = r.diffResult || {};
      return '<tr><td>' + esc(r.replyDate || '') + '</td><td class="num">' + fenToStr(r.theirBalanceFen) + '</td>' +
        '<td class="num">' + fenToStr(d.balanceDiffFen) + '</td>' +
        '<td><span class="tag ' + tagKind(d.status === 'draft' ? r.status : d.status) + '">' + tagText(d.status === 'draft' ? r.status : d.status) + '</span></td>' +
        '<td>' + esc(r.channel === 'manual' ? '手工' : r.channel === 'paste' ? '粘贴' : '导入') + '</td>' +
        '<td>' + esc(r.confirmedBy || '') + ' ' + esc((r.confirmedAt || '').slice(0, 19).replace('T', ' ')) + '</td>' +
        '<td><button class="sm" onclick="selectReply(\'' + esc(r.statementId) + '\',\'' + esc(r.id) + '\')">打开</button> ' +
        '<button class="sm" onclick="showReport(\'' + esc(r.id) + '\')">报告</button></td></tr>';
    }).join('');
    setHtml('reList', '<div class="table-wrap"><table><thead><tr><th>回函日期</th><th class="num">对方余额</th><th class="num">差异</th><th>状态</th><th>方式</th><th>确认人/时间</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>');
  }).catch(fail);
}
function selectReply(statementId, replyId) {
  var el = document.getElementById('reStmt');
  if (el) el.value = statementId;
  pickStatement(statementId);
  api('/api/replies/' + replyId).then(function (r) {
    RE.replyId = r.id;
    RE.theirBalanceFen = r.theirBalanceFen;
    RE.theirEntries = r.theirEntries || [];
    RE.signFlip = !!r.signFlip;
    RE.channel = r.channel;
    var b = document.getElementById('reBal');
    if (b) b.value = fenToStr(r.theirBalanceFen).replace(/,/g, '');
    var f = document.getElementById('reFlip');
    if (f) f.checked = !!r.signFlip;
    if (r.diffResult) {
      renderDiff(r.id, r.diffResult);
      toast('已载入该回函的勾对结果');
    }
  }).catch(fail);
}

// ---------------------------------------------------------------- 历史归档
function renderArchive() {
  api('/api/archive/tree').then(function (tree) {
    S.tree = tree || [];
    if (!S.tree.length) {
      setHtml('archiveBody', '<div class="card"><div class="empty">还没有归档记录。生成并确认对账函后，这里会按「单位 → 期间 → 版本」列出来。</div></div>');
      return;
    }
    var html = S.tree.map(function (n) {
      var periods = n.periods.map(function (p) {
        var vs = p.versions.map(function (v) {
          return '<tr><td class="mono">' + esc(v.serialNo) + '</td><td>v' + v.version + '</td><td>' + (v.direction === 'payable' ? '应付' : '应收') + '</td>' +
            '<td>' + esc(v.cutoffDate) + '</td><td class="num">' + fenToStr(v.ourBalanceFen) + '</td>' +
            '<td>' + (v.hasPdf ? '<span class="tag green">PDF</span>' : '<span class="tag yellow">打印版 HTML</span>') + ' <span class="tag blue">Excel</span></td>' +
            '<td><span class="tag ' + tagKind(v.status) + '">' + tagText(v.status) + '</span></td>' +
            '<td class="muted">' + esc(v.createdAt.slice(0, 19).replace('T', ' ')) + '</td>' +
            '<td><button class="sm" onclick="archiveDetail(\'' + esc(v.statementId) + '\')">详情</button> ' +
            '<button class="sm" onclick="downloadFile(\'' + esc(v.statementId) + '\',\'pdf\')">PDF</button> ' +
            '<button class="sm" onclick="downloadFile(\'' + esc(v.statementId) + '\',\'xlsx\')">Excel</button></td></tr>';
        }).join('');
        return '<div class="muted mt">期间 ' + esc(p.period) + '（' + p.versions.length + ' 个版本，只增不删）</div>' +
          '<div class="table-wrap"><table><thead><tr><th>编号</th><th>版本</th><th>方向</th><th>截止日</th><th class="num">余额</th><th>产物</th><th>状态</th><th>生成时间</th><th>操作</th></tr></thead><tbody>' + vs + '</tbody></table></div>';
      }).join('');
      return '<div class="card"><h3>' + esc(n.unit.name) + '<span class="hint">共 ' + n.statementCount + ' 份</span></h3>' + periods + '</div>';
    }).join('');
    setHtml('archiveBody',
      '<div class="card"><h3>数据备份<span class="hint">归档只增不删；这里做整包 zip 备份与恢复</span></h3>' +
      '<div class="row"><button class="primary" onclick="doBackup()">整包备份（zip）</button>' +
      '<button onclick="doJsonBackup()">仅备份数据文件（快，可一键恢复）</button>' +
      '<button onclick="loadBackups()">查看备份列表</button></div><div id="backupList" class="mt"></div></div>' + html);
  }).catch(fail);
}
function archiveDetail(stmtId) {
  api('/api/archive/' + stmtId + '/detail').then(function (d) {
    var st = d.statement;
    openModal(
      '<div class="row mb"><b>' + esc(st.serialNo) + '　' + esc(st.unitName) + '</b><span class="spacer"></span><button onclick="closeModal()">关闭</button></div>' +
      '<div class="grid c3">' +
      '<div class="kpi"><div class="k">我方余额</div><div class="v">' + fenToStr(st.ourBalanceFen) + '</div></div>' +
      '<div class="kpi"><div class="k">版本</div><div class="v">v' + st.version + '</div></div>' +
      '<div class="kpi"><div class="k">余额口径</div><div class="v small">' + esc(st.usedMode || st.balanceMode) + '</div></div>' +
      '</div>' +
      '<div class="mt"><b>归档文件</b><div class="muted">' + esc(d.archiveDir) + '</div>' +
      '<table><thead><tr><th>文件</th><th class="num">大小</th></tr></thead><tbody>' +
      (d.files || []).map(function (f) { return '<tr><td>' + esc(f.name) + '</td><td class="num">' + Math.round(f.bytes / 1024) + ' KB</td></tr>'; }).join('') +
      (d.files && d.files.length ? '' : '<tr><td colspan="2">暂无文件</td></tr>') + '</tbody></table></div>' +
      '<div class="mt"><b>回函记录（' + (d.replies || []).length + '）</b>' +
      ((d.replies || []).map(function (r) {
        return '<div class="note' + (r.status === 'confirmed' ? ' ok' : '') + '">对方余额 ' + fenToStr(r.theirBalanceFen) + '　差异 ' + fenToStr((r.diffResult || {}).balanceDiffFen) + '　状态 ' + tagText(r.status) + '　确认人 ' + esc(r.confirmedBy || '—') + '</div>';
      }).join('') || '<div class="muted">无</div>') + '</div>' +
      ((d.reports || []).length ? '<div class="mt"><b>差异报告</b></div><iframe class="preview-frame" srcdoc="' + esc(d.reports[0].html) + '"></iframe>' : '')
    );
  }).catch(fail);
}
function downloadFile(stmtId, fmt) {
  if (typeof window !== 'undefined' && window.location) window.location.href = '/api/statements/' + encodeURIComponent(stmtId) + '/file?fmt=' + fmt;
}
function doBackup() {
  toast('正在打包…');
  api('/api/backup', { method: 'POST', body: {} }).then(function (r) {
    toast('备份完成：' + Math.round(r.bytes / 1024) + ' KB');
    loadBackups();
  }).catch(fail);
}
function doJsonBackup() {
  api('/api/backup/json', { method: 'POST', body: {} }).then(function (r) { toast('已备份 ' + r.files + ' 个数据文件 → backups/' + r.name); loadBackups(); }).catch(fail);
}
function loadBackups() {
  api('/api/backups').then(function (list) {
    setHtml('backupList', '<div class="table-wrap"><table><thead><tr><th>备份</th><th class="num">文件数</th><th class="num">大小(KB)</th><th>操作</th></tr></thead><tbody>' +
      (list || []).map(function (b) {
        return '<tr><td class="mono">' + esc(b.name) + '</td><td class="num">' + b.files + '</td><td class="num">' + Math.round(b.size / 1024) + '</td>' +
          '<td><button class="sm danger" onclick="doRestore(\'' + esc(b.name) + '\')">恢复这份</button></td></tr>';
      }).join('') + '</tbody></table></div>');
  }).catch(fail);
}
function doRestore(name) {
  if (!confirm('恢复会用备份「' + name + '」覆盖当前数据（覆盖前会自动再备份一次当前数据）。确认继续？')) return;
  api('/api/restore', { method: 'POST', body: { name: name } }).then(function () { toast('已恢复'); refreshAll(); }).catch(fail);
}

// ---------------------------------------------------------------- 设置
function renderSettings() {
  var cfg = S.config || {};
  var opts = S.options || {};
  var group = function (key) {
    var o = opts[key];
    if (!o) return '';
    return '<div class="card"><h3>' + esc(o.title) + '<span class="hint">' + esc(o.desc) + '</span></h3><div class="radio-cards">' +
      o.choices.map(function (c) {
        var on = String(cfg[key]) === String(c.value);
        return '<div class="radio-card' + (on ? ' on' : '') + '" onclick="setOption(\'' + key + '\',' + JSON.stringify(c.value) + ')">' +
          '<div class="t"><span class="tag ' + (on ? 'blue' : 'gray') + '">' + (on ? '已选' : '选择') + '</span>' + esc(c.label) + '</div>' +
          '<div class="d">' + esc(c.desc) + '</div></div>';
      }).join('') + '</div></div>';
  };
  var aliasKeys = Object.keys((cfg.aliases) || {});
  var aliasHtml = aliasKeys.map(function (k) {
    return '<tr><td>' + esc(k) + '</td><td><input type="text" data-alias="' + esc(k) + '" value="' + esc(((cfg.aliases || {})[k] || []).join('、')) + '" style="width:100%" /></td></tr>';
  }).join('');
  setHtml('settingsBody',
    '<div class="note info">下面这些都是「口径开关」——同一个账套选不同口径，算出来的余额会不一样。拿不准就保持默认：自动口径 + 按科目自然方向，并在前几次生成后跟账面核对一下。</div>' +
    group('balanceMode') + group('signConvention') + group('netting') + group('replySignFlip') +
    '<div class="grid c2">' + group('detailAttach') + group('daxieKeepZeroYuan') + '</div>' +
    group('pdfEngine') +
    '<div class="card"><h3>匹配与并发</h3><div class="row">' +
    '<div class="field"><label>时间性差异窗口（天）</label><input type="number" id="setWindow" value="' + esc(cfg.matchWindowDays) + '" style="width:120px" /></div>' +
    '<div class="field"><label>编号规则</label><input type="text" id="setSerial" value="' + esc(cfg.serialRule) + '" style="width:230px" /></div>' +
    '<div class="field"><label>PDF 并发数（仅兼容模式用；复用单实例时不需要）</label><input type="number" id="setConc" value="' + esc(cfg.pdfConcurrency) + '" style="width:110px" /></div>' +
    '<div class="field"><label>浏览器路径（一般留空）</label><input type="text" id="setBrowser" value="' + esc(cfg.browserPath || '') + '" style="width:300px" /></div>' +
    '<button class="primary" onclick="saveSettings()">保存</button>' +
    '<button onclick="resetSettings()">恢复默认</button></div>' +
    '<div class="mt muted">PDF 引擎探测：' + esc((S.browser && S.browser.ok ? S.browser.path + '（' + S.browser.source + '）' : '未找到，将导出打印版 HTML')) + '</div></div>' +
    '<div class="card"><h3>科目自然方向字典<span class="hint">只有「单列金额且没有方向列」的明细账才用得上它。填科目名里出现的关键词，用「、」分隔；两边都不命中的科目，工具会按你在导入向导里选的方向兜底并标注出来</span></h3>' +
    '<div class="grid c2">' +
    '<div class="field"><label>余额在借方的科目关键词</label><input type="text" id="sideDebit" value="' + esc(((cfg.subjectSideDebit) || []).join('、')) + '" style="width:100%" /></div>' +
    '<div class="field"><label>余额在贷方的科目关键词</label><input type="text" id="sideCredit" value="' + esc(((cfg.subjectSideCredit) || []).join('、')) + '" style="width:100%" /></div>' +
    '</div>' +
    '<div class="note warn">关键词要避开借贷两边都会出现的词（比如只写「长期」，会让「长期借款」同时命中两边而判不准）。改完建议拿一份真实明细账导一遍，在预览页对照「解析为借方/解析为贷方」两列核对。</div>' +
    '<div class="row mt"><button class="primary" onclick="saveSides()">保存科目方向</button></div></div>' +
    '<div class="card"><h3>列识别别名字典<span class="hint">对方或财务软件用别的叫法时，加进对应的格子里，用「、」分隔</span></h3>' +
    '<table><thead><tr><th>标准列</th><th>别名（可编辑）</th></tr></thead><tbody>' + aliasHtml + '</tbody></table>' +
    '<div class="row mt"><button class="primary" onclick="saveAliases()">保存字典</button></div></div>' +
    '<div class="card"><h3>回函格式方案<span class="hint">把某个单位的回函格式存下来/导出给同事</span></h3>' +
    '<div class="row"><button onclick="loadReplyMaps()">查看方案</button><button onclick="exportReplyMaps()">导出方案</button></div>' +
    '<div id="mapList" class="mt"></div></div>' +
    '<div class="card"><h3>运行环境</h3><div id="envInfo" class="muted">' + esc(JSON.stringify(S.stats || {}, null, 2)) + '</div></div>');
}
function setOption(key, value) {
  var body = {};
  body[key] = value;
  api('/api/config', { method: 'PUT', body: body }).then(function (cfg) {
    S.config = cfg;
    toast('已切换口径：' + key + ' = ' + value);
    renderSettings();
  }).catch(fail);
}
function saveSettings() {
  api('/api/config', {
    method: 'PUT',
    body: {
      matchWindowDays: Number(val('setWindow')),
      serialRule: val('setSerial'),
      pdfConcurrency: Number(val('setConc')),
      browserPath: val('setBrowser')
    }
  }).then(function (cfg) { S.config = cfg; toast('已保存'); }).catch(fail);
}
function resetSettings() {
  if (!confirm('恢复所有口径与设置为默认值？')) return;
  api('/api/config/reset', { method: 'POST', body: {} }).then(function (cfg) { S.config = cfg; toast('已恢复默认'); renderSettings(); }).catch(fail);
}
function saveAliases() {
  var map = {};
  var els = document.querySelectorAll('[data-alias]');
  for (var i = 0; i < els.length; i++) {
    map[els[i].getAttribute('data-alias')] = els[i].value.split(/[、,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  api('/api/config', { method: 'PUT', body: { aliases: map } }).then(function (cfg) { S.config = cfg; toast('别名字典已保存'); }).catch(fail);
}
function saveSides() {
  var split = function (v) {
    return String(v || '').split(/[、,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
  };
  api('/api/config', { method: 'PUT', body: { subjectSideDebit: split(val('sideDebit')), subjectSideCredit: split(val('sideCredit')) } })
    .then(function (cfg) { S.config = cfg; toast('科目方向字典已保存'); })
    .catch(fail);
}
function loadReplyMaps() {
  api('/api/reply/maps').then(function (list) {
    setHtml('mapList', (list || []).length
      ? '<table><thead><tr><th>单位 ID</th><th>方案名</th><th class="num">用过</th><th></th></tr></thead><tbody>' +
        list.map(function (m) {
          return '<tr><td class="mono">' + esc(m.unitId) + '</td><td>' + esc(m.name) + '</td><td class="num">' + (m.usedCount || 0) + '</td>' +
            '<td><button class="sm danger" onclick="delReplyMap(\'' + esc(m.id) + '\')">删除</button></td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty">还没有保存过回函格式方案</div>');
  }).catch(fail);
}
function delReplyMap(id) {
  if (!confirm('删除这个回函格式方案？')) return;
  api('/api/reply/maps/' + id, { method: 'DELETE' }).then(function () { toast('已删除'); loadReplyMaps(); }).catch(fail);
}
function exportReplyMaps() {
  api('/api/reply/maps/export').then(function (data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = (window.URL && window.URL.createObjectURL) ? window.URL.createObjectURL(blob) : '#';
    a.download = 'reply-maps.json';
    if (a.click) a.click();
    toast('已导出 reply-maps.json');
  }).catch(fail);
}

// ---------------------------------------------------------------- 启动
function renderTopbar() {
  var c = (S.config && S.config.company) || {};
  setHtml('companyName', c.name || '（还没设公司名称）');
}
function loadUnits(then) {
  return api('/api/units').then(function (list) {
    S.units = list || [];
    if (then === 'units') renderUnits();
    return S.units;
  }).catch(fail);
}
function refreshAll() {
  return Promise.all([
    api('/api/config').then(function (r) { S.config = r.config; S.options = r.options; renderTopbar(); }),
    api('/api/ledger/periods').then(function (p) { S.periods = p || []; }),
    api('/api/units').then(function (u) { S.units = u || []; }),
    api('/api/browser').then(function (b) {
      S.browser = b;
      setHtml('sideBrowser', b && b.ok ? 'PDF：已就绪' : 'PDF：降级为打印版');
    })
  ]).then(function () {
    if (typeof showTab === 'function') showTab(currentTab || 'home');
  }).catch(function (e) {
    setHtml('tab-home', '<div class="note bad">无法连接本地服务：' + esc(e.message) + '</div>');
    document.getElementById('tab-home').className = 'tab active';
  });
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
function boot() {
  if (typeof buildNav === 'function') buildNav();
  var h = (typeof window !== 'undefined' && window.location && window.location.hash) ? window.location.hash.replace('#', '') : 'home';
  refreshAll().then(function () { if (typeof showTab === 'function') showTab(h || 'home'); });
}
