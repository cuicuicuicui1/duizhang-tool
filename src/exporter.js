'use strict';
/*
 * exporter.js — Excel / PDF / zip 导出
 * 红线（计划 §4.5）：PDF 一律走系统已装的 Edge/Chrome（puppeteer-core 传 executablePath），
 * 代码里绝不下载 Chromium；探测不到就降级成「打印优化 HTML」，不报错、不崩服务。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const store = require('./store');
const money = require('./money');
const { esc, dateText } = require('./templates');

// ---------------------------------------------------------------- 浏览器探测
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

let _probe = null;

/** 探测系统浏览器 → {ok, path, source, tried[]} */
function probeBrowser(force) {
  if (_probe && !force) return _probe;
  const cfg = require('./config').getConfig();
  const tried = [];
  const list = cfg.browserPath ? [cfg.browserPath].concat(CANDIDATES) : CANDIDATES.slice();
  for (const p of list) {
    if (!p) continue;
    tried.push(p);
    try {
      if (fs.existsSync(p)) {
        _probe = { ok: true, path: p, source: p === cfg.browserPath ? '设置里指定' : '自动探测', tried };
        return _probe;
      }
    } catch (_) {
      /* ignore */
    }
  }
  _probe = { ok: false, path: '', source: '未找到', tried };
  return _probe;
}

/** HTML 包装成完整文档（file:// 方式给浏览器打印时用，必须带 charset） */
function wrapHtml(html, title) {
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>' +
    esc(title || '对账函') +
    '</title></head><body class="dz-body">' +
    html +
    '</body></html>'
  );
}

/**
 * 备选 PDF 通道：直接调用浏览器自带的 --print-to-pdf。
 * 与 puppeteer-core 打印同一份 HTML、同一个浏览器内核，效果等价，
 * 但不依赖 node 侧任何第三方包 —— 计划要求的「禁止下载 Chromium」同样满足。
 *
 * 两个关键工程点（实测出来的，改动前先看这里）：
 *  1) 必须用异步 execFile。用 execFileSync 会阻塞事件循环，批量生成时的并发池形同虚设。
 *  2) 每次调用要带独立的 --user-data-dir。共用默认 profile 时多个浏览器实例会互相抢锁，
 *     并发等于串行（实测 8 个 PDF 无论并发 1/2/4 都是 13 秒）。
 */
function profileDirFor(slot) {
  const p = path.join(store.DATA, 'tmp', 'browser-profile', 'p' + (slot || 0));
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function htmlToPdfCli(html, outPath, browserPath, slot) {
  const probe = browserPath ? { ok: true, path: browserPath } : probeBrowser();
  if (!probe.ok) {
    return Promise.resolve({ ok: false, reason: '未在本机找到 Edge/Chrome，已改为导出打印版 HTML' });
  }
  const { execFile } = require('child_process');
  const tmpDir = path.join(store.DATA, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  // 临时 HTML 按「槽位」固定文件名覆盖写：红线要求程序内不做删除动作，
  // 若按时间戳生成，批量生成 50 家就会在 data/tmp 里留下上百个不会被清理的文件。
  const slotNo = Number(slot) || 0;
  const htmlPath = path.join(tmpDir, 'render_slot' + slotNo + '.html');
  fs.writeFileSync(htmlPath, wrapHtml(html, path.basename(outPath)), 'utf8');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--no-pdf-header-footer',
    '--user-data-dir=' + profileDirFor(slot),
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=1500',
    '--print-to-pdf=' + path.resolve(outPath),
    'file:///' + path.resolve(htmlPath).replace(/\\/g, '/'),
  ];
  return new Promise((resolve) => {
    execFile(probe.path, args, { timeout: 45000, windowsHide: true, killSignal: 'SIGKILL' }, (err) => {
      if (err) {
        const timedOut = err.killed === true || err.signal === 'SIGKILL' || /ETIMEDOUT|timeout/i.test(String(err.message));
        if (timedOut) {
          // 超时通常是浏览器被别的东西卡住（残留实例抢锁等），重试只会更慢
          resolve({ ok: false, reason: '浏览器打印超时（45 秒未产出 PDF）', htmlPath });
          return;
        }
        // 个别机型上某个开关不被识别会直接退出，去掉该开关再试一次
        const again = args.filter((a) => !a.startsWith('--no-pdf-header-footer'));
        execFile(probe.path, again, { timeout: 45000, windowsHide: true, killSignal: 'SIGKILL' }, (err2) => {
          if (err2) {
            resolve({ ok: false, reason: '浏览器打印失败：' + (err2.message || String(err2)), htmlPath });
            return;
          }
          resolve(finish());
        });
        return;
      }
      resolve(finish());
    });
    function finish() {
      try {
        const st = fs.statSync(outPath);
        if (st.size < 1000) return { ok: false, reason: '浏览器打印产出为空文件', htmlPath };
        return { ok: true, path: outPath, bytes: st.size, browser: probe.path, engine: 'browser-cli', htmlPath };
      } catch (e) {
        return { ok: false, reason: '浏览器没有产出 PDF：' + e.message, htmlPath };
      }
    }
  });
}

/** 第二条通道：puppeteer-core（可在设置里切换；批量场景下不如命令行通道稳） */
async function htmlToPdfPuppeteer(html, outPath, probe) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (e) {
    return { ok: false, reason: 'puppeteer-core 不可加载：' + e.message };
  }
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: probe.path,
      headless: true,
      timeout: 30000,
      protocolTimeout: 60000,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await page.emulateMediaType('print');
    const buf = await page.pdf({ printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return { ok: true, path: outPath, bytes: buf.length, browser: probe.path, engine: 'puppeteer-core' };
  } catch (e) {
    return { ok: false, reason: 'puppeteer-core 打印失败：' + e.message };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {
        /* ignore */
      }
    }
  }
}

/**
 * 收集某进程的全部后代 pid（浏览器是多层子进程，主进程一死子进程会被孤儿化，
 * 那时 taskkill /T 就追不到了 —— 所以必须在浏览器还活着的时候先记下整棵树）。
 */
function collectDescendantPids(rootPid, depth) {
  const d = depth || 0;
  if (d > 4) return Promise.resolve([]);
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process -Filter "ParentProcessId=' + rootPid + '" | Select-Object -ExpandProperty ProcessId'],
      { timeout: 10000, windowsHide: true },
      (err, stdout) => {
        const kids = String(stdout || '').split(/\s+/).map(Number).filter(Boolean);
        if (!kids.length) return resolve([]);
        Promise.all(kids.map((k) => collectDescendantPids(k, d + 1))).then((nested) => {
          resolve(kids.concat(nested.reduce((a, b) => a.concat(b), [])));
        });
      }
    );
  });
}

/** 杀掉一组 pid（忽略已退出的） */
function killPids(pids) {
  const { execFile } = require('child_process');
  for (const pid of pids) {
    execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }, () => {});
  }
}

/**
 * 批量打印会话：复用一个浏览器实例，顺序渲染多份 PDF。
 *
 * 为什么这么做（实测）：命令行通道每次调用都要重启一次浏览器，约 1.1 秒/份；
 * 复用同一个实例后是 0.24 秒/份（12 份 13.1s → 2.9s），而且不受机器负载影响那么大。
 * 注意区分：这里用的是**单实例顺序渲染**；之前踩过的坑是"10 个实例并发启动会卡死"。
 *
 * @returns {{available:boolean, reason?:string, engine?:string, print?:Function, close?:Function}}
 */
async function createPdfSession() {
  const probe = probeBrowser();
  if (!probe.ok) return { available: false, reason: '未在本机找到 Edge/Chrome，将改为导出打印版 HTML' };
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (e) {
    return { available: false, reason: 'puppeteer-core 不可加载（' + e.message + '），将回退到命令行通道' };
  }
  let browser;
  try {
    // launch 本身也可能挂（系统里残留的无头浏览器进程堆积时）。20 秒起不来就放弃并强杀。
    browser = await Promise.race([
      puppeteer.launch({
        executablePath: probe.path,
        headless: true,
        timeout: 30000,
        protocolTimeout: 120000,
        args: [
          '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none',
          '--disable-crashpad', '--disable-background-networking', '--disable-component-update',
          '--disable-default-apps', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
          '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        ],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('浏览器启动超过 20 秒')), 20000)),
    ]);
  } catch (e) {
    return { available: false, reason: '浏览器启动失败：' + e.message + '，将回退到命令行通道' };
  }
  let closed = false;
  return {
    available: true,
    engine: 'puppeteer-core-shared',
    browser: probe.path,
    async print(html, outPath) {
      if (closed) return { ok: false, reason: '打印会话已关闭' };
      let page = null;
      try {
        page = await Promise.race([
          browser.newPage(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('newPage 超过 30 秒')), 30000)),
        ]);
        await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
        await page.emulateMediaType('print');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        await page.pdf({
          path: outPath,
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: false,
        });
        const st = fs.statSync(outPath);
        if (st.size < 1000) return { ok: false, reason: 'PDF 产出为空文件' };
        return { ok: true, path: outPath, bytes: st.size, engine: 'puppeteer-core-shared', browser: probe.path };
      } catch (e) {
        return { ok: false, reason: 'PDF 渲染失败：' + e.message };
      } finally {
        // 页面用完必须关，否则渲染器进程会一直挂着
        if (page) {
          try {
            await Promise.race([page.close(), new Promise((res) => setTimeout(res, 5000))]);
          } catch (_) {
            /* ignore */
          }
        }
      }
    },
    async close() {
      closed = true;
      // 关键顺序：必须在浏览器还活着时先记下整棵进程树 ——
      // 优雅关闭后主进程一死，子进程被孤儿化，taskkill /T 就追不到了（实测每批漏 3 个）。
      let tree = [];
      try {
        const proc = browser.process && browser.process();
        if (proc && proc.pid) tree = await collectDescendantPids(proc.pid);
      } catch (_) {
        /* ignore */
      }
      // 优雅关闭：最多等 8 秒
      try {
        await Promise.race([browser.close(), new Promise((res) => setTimeout(res, 8000))]);
      } catch (_) {
        /* ignore */
      }
      try {
        const proc = browser.process && browser.process();
        if (proc && proc.pid) {
          try {
            proc.kill('SIGKILL');
          } catch (_) {
            /* ignore */
          }
        }
      } catch (_) {
        /* ignore */
      }
      killPids(tree);
    },
  };
}

/**
 * HTML → PDF（单份打印时的入口；批量生成请走 createPdfSession，见 statement.js）。
 * 通道顺序由 config.pdfEngine 决定（默认 'auto' = 共享单实例优先，失败自动落到命令行通道），
 * 再落到打印版 HTML（降级，不崩、不静默给空文件）。产物三条通道等价。
 */
async function htmlToPdf(html, outPath, opts) {
  const o = opts || {};
  let cfg = {};
  try {
    cfg = require('./config').getConfig();
  } catch (_) {
    cfg = {};
  }
  const engine = o.engine || cfg.pdfEngine || 'cli';
  const probe = probeBrowser();
  if (!probe.ok) {
    return { ok: false, reason: '未在本机找到 Edge/Chrome，已改为导出打印版 HTML', tried: probe.tried };
  }
  const order = engine === 'puppeteer' ? ['puppeteer', 'cli'] : ['cli', 'puppeteer'];
  const failures = [];
  for (const eng of order) {
    const r = eng === 'cli' ? await htmlToPdfCli(html, outPath, null, o.slot) : await htmlToPdfPuppeteer(html, outPath, probe);
    if (r.ok) {
      if (failures.length) r.fellBackFrom = failures[0].engine + '：' + failures[0].reason;
      return r;
    }
    failures.push({ engine: eng, reason: r.reason });
  }
  return {
    ok: false,
    reason: failures.map((f) => f.engine + '：' + f.reason).join('；'),
    tried: failures,
  };
}

function writeHtml(html, outPath) {
  const full = wrapHtml(html, path.basename(outPath));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, full, 'utf8');
  return { ok: true, path: outPath, bytes: Buffer.byteLength(full) };
}

// ---------------------------------------------------------------- Excel 导出
const THIN = { style: 'thin', color: { argb: 'FF333333' } };
const BORDER_ALL = { top: THIN, left: THIN, bottom: THIN, right: THIN };

/**
 * 导出对账函 Excel（含「明细附页」工作表）
 * @param {{unit,balance,session,config,statement}} input
 */
async function toXlsx(input, outPath) {
  const ExcelJS = require('exceljs');
  const { unit, balance, session, config, statement } = input;
  const cfg = config || {};
  const company = cfg.company || {};
  const cutoff = (session && session.cutoffDate) || '';
  const payable = (session && session.direction) === 'payable';
  const daxie = require('./daxie');

  const wb = new ExcelJS.Workbook();
  wb.creator = company.name || '往来对账工具';
  wb.created = new Date();

  const ws = wb.addWorksheet('对账函', {
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.98, right: 0.98, top: 0.98, bottom: 0.98, header: 0.3, footer: 0.3 },
    },
    views: [{ showGridLines: false }],
  });
  ws.columns = [
    { width: 34 },
    { width: 20 },
    { width: 8 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
  ];

  const put = (rowIdx, colIdx, value, opts) => {
    const c = ws.getCell(rowIdx, colIdx);
    c.value = value;
    if (opts) Object.assign(c, opts);
    return c;
  };
  const box = (r1, c1, r2, c2) => {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) ws.getCell(r, c).border = BORDER_ALL;
  };
  const merge = (r1, c1, r2, c2) => ws.mergeCells(r1, c1, r2, c2);

  let R = 1;
  merge(R, 1, R, 6);
  put(R, 1, company.name || '（我方公司名称未设置）', { font: { name: '宋体', size: 16, bold: true }, alignment: { horizontal: 'center' } });
  R++;
  merge(R, 1, R, 6);
  put(R, 1, (company.address || '') + (company.phone ? '　电话：' + company.phone : ''), { font: { name: '宋体', size: 9 }, alignment: { horizontal: 'center' } });
  R += 2;
  merge(R, 1, R, 6);
  put(R, 1, payable ? '应付账款对账函' : '应收账款对账函', { font: { name: '宋体', size: 18, bold: true }, alignment: { horizontal: 'center' } });
  ws.getRow(R).height = 30;
  R += 1;
  put(R, 1, '编号：' + (statement ? statement.serialNo : ''), { font: { name: '宋体', size: 10 } });
  merge(R, 4, R, 6);
  put(R, 4, '日期：' + dateText((statement && statement.issueDate) || new Date().toISOString().slice(0, 10)), {
    font: { name: '宋体', size: 10 },
    alignment: { horizontal: 'right' },
  });
  R += 1;
  put(R, 1, '致：' + unit.name, { font: { name: '宋体', size: 11, bold: true } });
  R += 1;

  merge(R, 1, R, 6);
  put(R, 1, '为核实双方往来账目，现将我方账簿记录的本单位往来款项余额函告如下，请贵公司核对无误后在回函联签章寄回；如有不符，请在回函联中列明差异事项及金额。', {
    font: { name: '宋体', size: 10 },
    alignment: { wrapText: true, vertical: 'middle' },
  });
  ws.getRow(R).height = 34;
  R += 1;

  merge(R, 1, R, 3);
  put(R, 1, '项目', { font: { name: '宋体', size: 10, bold: true }, alignment: { horizontal: 'center' } });
  merge(R, 4, R, 6);
  put(R, 4, '金额（元）', { font: { name: '宋体', size: 10, bold: true }, alignment: { horizontal: 'center' } });
  box(R, 1, R, 6);
  R++;

  const parts = balance.parts && balance.parts.length ? balance.parts : [balance];
  for (const p of parts) {
    merge(R, 1, R, 3);
    put(R, 1, (p.account || '往来款项') + '余额', { font: { name: '宋体', size: 10 }, alignment: { horizontal: 'left' } });
    merge(R, 4, R, 6);
    put(R, 4, money.fenToNumber(p.absFen), { font: { name: 'Consolas', size: 10 }, numFmt: '#,##0.00', alignment: { horizontal: 'right' } });
    box(R, 1, R, 6);
    R++;
    merge(R, 1, R, 3);
    put(R, 1, '（大写）' + daxie.toDaxieSafe(p.absFen, { keepZeroYuan: !!cfg.daxieKeepZeroYuan }).text, { font: { name: '宋体', size: 10 }, alignment: { horizontal: 'left' } });
    merge(R, 4, R, 6);
    put(R, 4, p.directionAbnormal ? '（余额方向异常，请核对）' : '', { font: { name: '宋体', size: 9, color: { argb: 'FFAA0000' } } });
    box(R, 1, R, 6);
    R++;
  }

  merge(R, 1, R, 6);
  put(R, 1, '本期发生额（' + ((session && session.period) || (cutoff ? cutoff.slice(0, 7) : '')) + '）', { font: { name: '宋体', size: 10, bold: true }, alignment: { horizontal: 'left' } });
  box(R, 1, R, 6);
  R++;
  const statRow = (label, fen) => {
    merge(R, 1, R, 3);
    put(R, 1, label, { font: { name: '宋体', size: 10 } });
    merge(R, 4, R, 6);
    put(R, 4, money.fenToNumber(fen), { font: { name: 'Consolas', size: 10 }, numFmt: '#,##0.00', alignment: { horizontal: 'right' } });
    box(R, 1, R, 6);
    R++;
  };
  statRow('本期借方发生额合计', balance.periodDebitFen);
  statRow('本期贷方发生额合计', balance.periodCreditFen);

  R++;
  merge(R, 1, R, 6);
  put(R, 1, '回函联（请贵公司填写后签章寄回）', { font: { name: '宋体', size: 10, bold: true } });
  box(R, 1, R, 6);
  R++;
  merge(R, 1, R, 6);
  put(R, 1, '□ 截至 ' + dateText(cutoff) + ' 止，上述信息证明无误。    □ 上述信息不符，差异事项及金额说明如下：', {
    font: { name: '宋体', size: 10 },
    alignment: { wrapText: true, vertical: 'middle' },
  });
  ws.getRow(R).height = 30;
  box(R, 1, R, 6);
  R++;
  for (let i = 0; i < 3; i++) {
    merge(R, 1, R, 6);
    ws.getRow(R).height = 22;
    box(R, 1, R, 6);
    R++;
  }
  merge(R, 1, R, 6);
  put(R, 1, '对方单位（签章）：__________________　　经办人：__________　　日期：____________', { font: { name: '宋体', size: 10 } });
  R += 2;
  merge(R, 1, R, 6);
  put(R, 1, '我方单位（盖章）：' + (company.name || '') + '　　经办人：' + (company.contact || '') + '　　日期：' + dateText((statement && statement.issueDate) || new Date().toISOString().slice(0, 10)), {
    font: { name: '宋体', size: 10 },
  });
  R++;
  merge(R, 1, R, 6);
  put(R, 1, '本函仅用于双方核对往来款项余额，不构成任何债权债务的确认、变更或放弃。', { font: { name: '宋体', size: 9, color: { argb: 'FF666666' } } });
  R++;
  merge(R, 1, R, 6);
  put(R, 1, require('./templates').buildTraceLine(input, balance.parts || [balance]), {
    font: { name: '宋体', size: 8, color: { argb: 'FF888888' } },
    alignment: { wrapText: true, vertical: 'middle' },
  });

  // ---- 明细附页 ----
  if (balance.hasDetail) {
    const ds = wb.addWorksheet('明细附页', {
      pageSetup: {
        paperSize: 9,
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        horizontalCentered: true,
        margins: { left: 0.98, right: 0.98, top: 0.98, bottom: 0.98, header: 0.3, footer: 0.3 },
      },
      views: [{ showGridLines: false }],
    });
    ds.columns = [
      { width: 6 },
      { width: 12 },
      { width: 30 },
      { width: 15 },
      { width: 15 },
      { width: 16 },
      { width: 10 },
    ];
    const putD = (r, c, v, f) => {
      const cell = ds.getCell(r, c);
      cell.value = v;
      if (f) Object.assign(cell, f);
      cell.border = BORDER_ALL;
      return cell;
    };
    let dr = 1;
    ds.mergeCells(dr, 1, dr, 7);
    putD(dr, 1, '往来款项明细附页', { font: { name: '宋体', size: 14, bold: true }, alignment: { horizontal: 'center' } });
    dr++;
    ds.mergeCells(dr, 1, dr, 7);
    putD(dr, 1, '单位：' + unit.name + '　｜　截止日：' + cutoff + '　｜　编号：' + (statement ? statement.serialNo : '') + '　｜　期初余额：' + (balance.openingFen === null ? '—' : money.fenToStr(balance.openingFen)), {
      font: { name: '宋体', size: 9 },
      alignment: { horizontal: 'left' },
    });
    dr++;
    const heads = ['序号', '日期', '摘要', '借方金额', '贷方金额', '余额', '凭证号'];
    for (let i = 0; i < heads.length; i++) {
      putD(dr, i + 1, heads[i], { font: { name: '宋体', size: 10, bold: true }, alignment: { horizontal: 'center' } });
    }
    dr++;
    const detail = require('./ledger').detailRows(balance);
    let n = 0;
    for (const part of detail.parts) {
      if (detail.parts.length > 1) {
        ds.mergeCells(dr, 1, dr, 7);
        putD(dr, 1, (part.account || '（未标注科目）') + '　期初：' + (part.openingFen === null ? '—' : money.fenToStr(part.openingFen)), {
          font: { name: '宋体', size: 9, bold: true },
          alignment: { horizontal: 'left' },
        });
        dr++;
      }
      for (const e of part.rows) {
        n++;
        putD(dr, 1, n, { font: { name: '宋体', size: 9 }, alignment: { horizontal: 'center' } });
        putD(dr, 2, e.date || '', { font: { name: '宋体', size: 9 }, alignment: { horizontal: 'center' } });
        putD(dr, 3, e.summary || '', { font: { name: '宋体', size: 9 } });
        putD(dr, 4, e.debitFen ? money.fenToNumber(e.debitFen) : '', { font: { name: 'Consolas', size: 9 }, numFmt: '#,##0.00' });
        putD(dr, 5, e.creditFen ? money.fenToNumber(e.creditFen) : '', { font: { name: 'Consolas', size: 9 }, numFmt: '#,##0.00' });
        putD(dr, 6, money.fenToNumber(e.runningFen), { font: { name: 'Consolas', size: 9 }, numFmt: '#,##0.00' });
        putD(dr, 7, e.voucherNo || '', { font: { name: '宋体', size: 9 }, alignment: { horizontal: 'center' } });
        dr++;
      }
    }
    ds.mergeCells(dr, 1, dr, 3);
    putD(dr, 1, '本期合计', { font: { name: '宋体', size: 10, bold: true }, alignment: { horizontal: 'center' } });
    putD(dr, 4, money.fenToNumber(balance.debitSumFen), { font: { name: 'Consolas', size: 10, bold: true }, numFmt: '#,##0.00' });
    putD(dr, 5, money.fenToNumber(balance.creditSumFen), { font: { name: 'Consolas', size: 10, bold: true }, numFmt: '#,##0.00' });
    putD(dr, 6, money.fenToNumber(balance.signedFen), { font: { name: 'Consolas', size: 10, bold: true }, numFmt: '#,##0.00' });
    putD(dr, 7, '', {});
    ds.pageSetup.printArea = 'A1:G' + dr;
  }

  ws.pageSetup.printArea = 'A1:F' + R;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await wb.xlsx.writeFile(outPath);
  return { ok: true, path: outPath, bytes: fs.statSync(outPath).size };
}

// ---------------------------------------------------------------- zip 打包
/** files: [{path, name}] → zip 落盘 */
function zipFiles(files, outPath) {
  return new Promise((resolve, reject) => {
    let archiver;
    try {
      archiver = require('archiver');
    } catch (e) {
      return reject(new Error('archiver 未安装：' + e.message));
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve({ ok: true, path: outPath, bytes: archive.pointer() }));
    archive.on('error', reject);
    archive.pipe(output);
    for (const f of files) {
      if (fs.existsSync(f.path)) archive.file(f.path, { name: f.name });
    }
    archive.finalize();
  });
}

/** 整包备份 data/ → data/exports/backup_xxx.zip（排除 exports 自身） */
function zipDataDir(outPath) {
  return new Promise((resolve, reject) => {
    const archiver = require('archiver');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve({ ok: true, path: outPath, bytes: archive.pointer() }));
    archive.on('error', reject);
    archive.pipe(output);
    for (const f of fs.readdirSync(store.DATA)) {
      const p = path.join(store.DATA, f);
      const st = fs.statSync(p);
      if (st.isFile()) archive.file(p, { name: 'data/' + f });
      else if (f !== 'exports' && f !== 'tmp') archive.directory(p, 'data/' + f);
    }
    archive.finalize();
  });
}

/** 从 zip 恢复不可靠，这里只做「解压到临时目录后由调用方处理」的占位说明 */
function zipEngineOk() {
  try {
    require('archiver');
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  CANDIDATES,
  probeBrowser,
  createPdfSession,
  htmlToPdf,
  htmlToPdfCli,
  wrapHtml,
  writeHtml,
  toXlsx,
  zipFiles,
  zipDataDir,
  zipEngineOk,
};
