#!/usr/bin/env node
// ===== lingxing_auto.js =====
// 基于录制轨迹(2026-08-14)确认的 REAL DOM 选择器，自动导出两大核心报表（产品表现/补货建议）。
// 利润报表已于 2026-08-19 按用户要求停用（enabled:false，默认不导出；--only=profit 可临时手动导出）。
// 设计原则：
//   1) 登录由用户手动完成（不把公司账号密码写进脚本，符合本地优先/隐私合规）。
//   2) 登录后菜单/标签/粒度/日期/导出全部自动；下载按文件内容归位到 源文件2.0。
//   3) 任何一步自动点击失败，自动暂停让你补刀，下载仍会被捕获归档（不漏存）。
const fs = require('fs');
const path = require('path');
// 同时把 stdout/stderr 内容镜像写入同目录日志文件，bat 不再做重定向，
// 这样黑色窗口能实时看到日志，关闭后也能查看 export_debug.log。
const LOG_FILE = path.join(__dirname, 'export_debug.log');
try { fs.writeFileSync(LOG_FILE, ''); } catch (_) {}
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
function teeWrite(targetWrite, stream, chunk, encoding, callback) {
  try { stream.write(chunk, typeof encoding === 'function' ? 'utf8' : encoding); } catch (_) {}
  return targetWrite(chunk, encoding, callback);
}
process.stdout.write = function (chunk, encoding, callback) { return teeWrite(originalStdoutWrite, logStream, chunk, encoding, callback); };
process.stderr.write = function (chunk, encoding, callback) { return teeWrite(originalStderrWrite, logStream, chunk, encoding, callback); };

const MODULE_DIR = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules';
if (!module.paths.includes(MODULE_DIR)) module.paths.unshift(MODULE_DIR);
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const XLSX = require('./xlsx.full.min.js');

// 优先使用 WorkBuddy 托管的 Python（已装 openpyxl），否则回退到系统 python
const MANAGED_PY = 'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe';
function resolvePython() {
  for (const p of [MANAGED_PY, 'python3', 'python']) {
    if (p === MANAGED_PY) { if (fs.existsSync(p)) return p; continue; }
    try { execFileSync(p, ['-c', 'import openpyxl'], { timeout: 3000, stdio: 'ignore' }); return p; } catch (_) {}
  }
  return null;
}
const PY_BIN = resolvePython();

// 补货建议导出后，删除所有包含「共享库存」的行（用户固定需求）。
// 用 openpyxl 原地修改以最大程度保留原表格式；带重试以应对文件短暂锁定。
function cleanReplenishSharedRows(dest) {
  if (!PY_BIN) { console.log('  ⚠ 未找到可用的 Python/openpyxl，跳过「共享库存」行清理'); return 0; }
  const code = [
    'import sys, openpyxl',
    'p = sys.argv[1]; kw = "共享库存"; tot = 0',
    'wb = openpyxl.load_workbook(p)',
    'for ws in wb.worksheets:',
    '    rows = list(ws.iter_rows(values_only=True))',
    '    for idx in range(len(rows), 0, -1):',
    '        if any(isinstance(v, str) and kw in v for v in rows[idx-1]):',
    '            ws.delete_rows(idx); tot += 1',
    'wb.save(p)',
    'print("DELETED=" + str(tot))',
  ].join('\n');
  for (let i = 0; i < 5; i++) {
    try {
      const out = execFileSync(PY_BIN, ['-c', code, dest], { encoding: 'utf8', timeout: 60000 });
      const m = out.match(/DELETED=(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    } catch (e) {
      if (i < 4) { try { require('child_process'); } catch (_) {} }
      if (i < 4) { const _s = Date.now(); while (Date.now() - _s < 700) {} continue; }
      console.log('  ⚠ 删除「共享库存」行失败:', e.message);
      return 0;
    }
  }
  return 0;
}

const LOGIN_URL = 'https://erp.lingxing.com/login';
const OUT_DIR = 'D:/00-运营/000-工作台自动化/源文件2.0';

// 优先使用系统已安装的 Chrome / Edge，而非 Playwright 自带的 Chromium。
// Playwright 自带 Chromium 在加载领星后台 /erp/home 时反复崩溃（Out of Memory / STATUS_STACK_OVERFLOW / 错误 39），
// 系统版 Chrome/Edge 是正式发行版，渲染兼容性与内存管理通常更稳。
function findSystemBrowser() {
  const home = process.env.USERPROFILE || 'C:/Users/Administrator';
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
  const pf32 = process.env['PROGRAMFILES(X86)'];
  const pf64 = process.env.PROGRAMFILES;
  const candidates = [];
  // Google Chrome
  candidates.push(path.join(local, 'Google/Chrome/Application/chrome.exe'));
  if (pf64) candidates.push(path.join(pf64, 'Google/Chrome/Application/chrome.exe'));
  if (pf32) candidates.push(path.join(pf32, 'Google/Chrome/Application/chrome.exe'));
  // Microsoft Edge
  candidates.push(path.join(local, 'Microsoft/Edge/Application/msedge.exe'));
  if (pf64) candidates.push(path.join(pf64, 'Microsoft/Edge/Application/msedge.exe'));
  if (pf32) candidates.push(path.join(pf32, 'Microsoft/Edge/Application/msedge.exe'));
  for (const p of candidates) { if (p && fs.existsSync(p)) return p; }
  // 若文件路径未命中，再查注册表
  try {
    const { execSync } = require('child_process');
    for (const key of ['chrome.exe', 'msedge.exe']) {
      try {
        const out = execSync(`reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${key}" /ve`, { encoding: 'utf8', timeout: 3000 });
        const m = out.match(/REG_SZ\s+(.+)$/m);
        if (m) { const p2 = m[1].trim(); if (fs.existsSync(p2)) return p2; }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}
const SYSTEM_BROWSER = findSystemBrowser();
const BROWSER_DESC = SYSTEM_BROWSER
  ? (SYSTEM_BROWSER.includes('Edge') ? 'Microsoft Edge' : 'Google Chrome')
  : 'Playwright 内置 Chromium';
console.log('[浏览器] 将优先用系统 Chrome / Edge（Playwright channel 模式），失败才回退自带 Chromium');

// 持久化浏览器配置目录：登录态（含「5天内免登录」Cookie）会写入此处并被后续运行复用
// 系统浏览器与 Playwright Chromium 使用不同 profile 目录，避免跨浏览器版本锁/不兼容。
const UHOME = process.env.USERPROFILE || 'C:/Users/Administrator';
// 默认用系统 Chrome 专用 profile；若实际落到系统 Edge，会在 openBrowser 内改用对应 profile。
// 绝不使用用户日常的默认 profile，保证「脚本与日常办公互不打扰」。
let USERDATA_DIR = path.join(UHOME, '.lingxing_auto_chrome_profile');

function fmtDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- 日期范围设置 ----------
// 说明：Element UI 的 .el-range-input 是只读式日期框，Playwright 的 fill() 写入的值
// 不会进入组件数据模型，会被组件重置（现象：填完变成当月 1 号）。因此一律走「日历面板点选」，
// 见下方唯一的 setRangeDays（日历版）。

// 读取某个面板元素句柄的当前年月（领星真实类名 .el-date-range-picker__header，文字如 "2026 年 8 月"）
async function readMonthOf(handle) {
  return await handle.evaluate((p) => {
    const h = p.querySelector('.el-date-range-picker__header') || p.querySelector('[class*="header"]');
    const t = (h ? (h.innerText || h.textContent) : '').trim().replace(/\s+/g, ' ');
    const m = t.match(/(\d{4})\D{1,4}(\d{1,2})/);
    return m ? { y: +m[1], m: +m[2] } : null;
  }).catch(() => null);
}

// 获取左右两个日历面板元素（按 DOM 顺序：左=index0, 右=index1）
async function getPanels(page) {
  return await page.$$('.el-date-range-picker__content').catch(() => []);
}

// 读取两个日期输入框的值（Element UI 格式 YYYY-MM-DD）。
// 关键：使用 page.evaluate 直接读 .value，避免 Playwright inputValue() 聚焦输入框，
// 否则在日历展开且已选起点时聚焦输入框，会把控件重置回「选起点」模式，导致终点覆盖起点。
async function readRangeInputs(page) {
  return await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('.el-range-input'));
    if (inputs.length >= 2) {
      return { v0: (inputs[0].value || '').trim(), v1: (inputs[1].value || '').trim() };
    }
    return { v0: '', v1: '' };
  }).catch(() => ({ v0: '', v1: '' }));
}

// 原生点击：直接在 DOM 上触发 .click()，绕过 Playwright 坐标/可操作性检查，
// 对领星动态重渲染的日历格 / 箭头最可靠（Vue 的 @click 监听原生 click 冒泡）。
async function domClick(handle) {
  if (!handle || !handle.asElement) return false;
  return await handle.evaluate((el) => { try { el.click(); return true; } catch (e) { return false; } }).catch(() => false);
}

// 在指定 side 的面板内点选某一天：严格只搜索该面板，先确认其 header 月份匹配目标，
// 再在面板作用域内按数字匹配 available 日格（排除上/下月灰格），原生点击该 td 触发 Vue 选择。
// 领星日历是「左面板=起始、右面板=终点」的双独立面板，因此 side 必须固定，不得跨面板匹配。
async function clickDayInPanel(page, targetDate, side) {
  const y = targetDate.getFullYear(), m = targetDate.getMonth() + 1, d = targetDate.getDate();
  const panels = await getPanels(page);
  if (panels.length < 2) return false;
  const panel = panels[side === 'left' ? 0 : 1];
  const cur = await readMonthOf(panel);
  if (!cur || cur.y !== y || cur.m !== m) return false;
  const clicked = await panel.evaluate((el, day) => {
    const tds = Array.from(el.querySelectorAll('td.available:not(.prev-month):not(.next-month)'));
    for (const c of tds) {
      const cell = c.querySelector('.cell') || c;
      if (parseInt((cell.textContent || '').trim(), 10) === day) {
        try { c.click(); return true; } catch (e) { return false; }
      }
    }
    return false;
  }, d).catch(() => false);
  await page.waitForTimeout(300);
  return clicked;
}

// 在指定作用域内点击含文字的元素（用于面板内的「确定」按钮，避免误点页面其它同名按钮）
async function clickTextIn(page, scope, text, timeout = 4000) {
  const sel = `${scope} button:has-text("${text}"), ${scope} span:has-text("${text}"), ${scope} a:has-text("${text}"), ${scope} div:has-text("${text}")`;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = await page.$(sel);
    if (el && await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 2000 }).catch(() => {});
      return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

// 快捷方式快路径：领星日历含 .el-picker-panel__shortcut（今天/昨天/本周/最近N天/最近一季度等）。
// 命中「90天 / 三个月 / 一季度」之一即点选，省去爬日历；要求结果区间 <= 90 天（产品表现平台上限）。
async function tryShortcut(page) {
  const btns = await page.$$('.el-picker-panel__shortcut').catch(() => []);
  for (const b of btns) {
    const t = (await b.textContent().catch(() => '')).trim();
    if (/(90\s*天|三个月|一季度|近\s*90)/i.test(t)) {
      await b.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(500);
      const { v0, v1 } = await readRangeInputs(page);
      const d0 = new Date(v0), d1 = new Date(v1);
      if (!isNaN(d0) && !isNaN(d1)) {
        const span = Math.round((d1 - d0) / 86400000) + 1;
        if (span >= 1 && span <= 90) { console.log('  ✓ 命中快捷方式「' + t + '」: ' + v0 + ' ~ ' + v1); return true; }
        console.log('  ⚠ 快捷方式「' + t + '」区间 ' + span + ' 天（超出 90 上限），改走日历');
      }
      // 快捷路径不符合要求，重新打开日历走手动点选（一次性完成）
      const inputs = await page.$$('.el-range-input');
      if (inputs.length) await inputs[0].click({ timeout: 2000 }).catch(() => {});
      await page.waitForSelector('.el-date-range-picker', { state: 'visible', timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }
  return false;
}

// 导航左面板（起始日期专用面板）到目标年月：只点击左面板内的月份箭头，
// 目标月到达左面板后即停止。左/右箭头均可使用（面板独立，可前可后）。
async function navigateLeftPanelToMonth(page, ty, tm) {
  for (let i = 0; i < 40; i++) {
    const panels = await getPanels(page);
    if (panels.length < 2) return false;
    const cur = await readMonthOf(panels[0]);
    if (!cur) return false;
    if (cur.y === ty && cur.m === tm) return true;
    const delta = (ty - cur.y) * 12 + (tm - cur.m);
    const dirClass = delta < 0 ? 'arrow-left' : 'arrow-right';
    const arrow = await panels[0].$(`.${dirClass}.lx_arrow_down_rev:not(.is-disabled)`).catch(() => null);
    if (!arrow) { console.log('    ↳ 左面板翻月受阻（' + (delta < 0 ? '左' : '右') + '箭头已禁用），当前 ' + cur.y + '-' + cur.m); return false; }
    await domClick(arrow);
    await page.waitForTimeout(260);
  }
  return false;
}

// 导航右面板（结束日期专用面板）到目标年月：只点击右面板内的月份箭头，
// 目标月到达右面板后即停止。左/右箭头均可使用（面板独立，可前可后）。
async function navigateRightPanelToMonth(page, ty, tm) {
  for (let i = 0; i < 40; i++) {
    const panels = await getPanels(page);
    if (panels.length < 2) return false;
    const cur = await readMonthOf(panels[1]);
    if (!cur) return false;
    if (cur.y === ty && cur.m === tm) return true;
    const delta = (ty - cur.y) * 12 + (tm - cur.m);
    const dirClass = delta < 0 ? 'arrow-left' : 'arrow-right';
    const arrow = await panels[1].$(`.${dirClass}.lx_arrow_down_rev:not(.is-disabled)`).catch(() => null);
    if (!arrow) { console.log('    ↳ 右面板翻月受阻（' + (delta < 0 ? '左' : '右') + '箭头已禁用），当前 ' + cur.y + '-' + cur.m); return false; }
    await domClick(arrow);
    await page.waitForTimeout(260);
  }
  return false;
}

// 通过领星双独立面板日历点选起止日期
// 关键事实（用户 2026-08-15 明确）：左面板只负责起始日期，右面板只负责结束日期，
// 两个面板功能完全独立。因此：起点只在左面板翻/点，终点只在右面板翻/点。
// 通过领星双独立面板日历点选起止日期。
// 硬性约束（用户 2026-08-15 明确）：
//   1. 日历展开后，必须一次性在左面板点起点、右面板点终点，中途严禁关闭/重开面板。
//   2. 起点只从左面板选；终点只从右面板选。
//   3. 点完两个日期之前不读输入框（避免 inputValue 聚焦导致重置为「选起点」模式）。
async function setRangeViaCalendar(page, start, end) {
  const sStr = fmtDate(start), eStr = fmtDate(end);
  const sy = start.getFullYear(), sm = start.getMonth() + 1;
  const ey = end.getFullYear(), em = end.getMonth() + 1;

  // 最多 3 轮整段重试；每一轮内部「一次打开、连续点完起点与终点」，中途绝不关闭/重开面板
  // （关闭/重开会重置为「选起点」模式，是过去单日区间的根因）。只有整轮彻底失败才 Escape 重开。
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 打开日历（仅在本轮未展开时点击起始输入框）
    let picker = await page.$('.el-date-range-picker');
    if (!picker) {
      const inputs = await page.$$('.el-range-input');
      if (!inputs.length) { console.log('    ↳ 未找到日期输入框'); return false; }
      await inputs[0].click({ timeout: 2000 }).catch(() => {});
      await page.waitForSelector('.el-date-range-picker', { state: 'visible', timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
    }

    // 快路径：命中近 90 天类快捷方式（领星实际无，通常走下方日历）
    if (attempt === 1 && await tryShortcut(page)) {
      const { v0, v1 } = await readRangeInputs(page);
      if (v0 === sStr && v1 === eStr) return true;
    }

    // 1) 左面板点起点（仅一次；先翻到起始月，再点该月日格。严禁补点——面板内重复点击会被组件当作「第二击=终点」，吞掉起点）
    await navigateLeftPanelToMonth(page, sy, sm);
    await page.waitForTimeout(240);
    const sClicked = await clickDayInPanel(page, start, 'left');
    console.log('  ' + (sClicked ? '✓' : '⌛') + ' 点击起点 ' + sStr + '（左面板）');
    await page.waitForTimeout(380);

    // 2) 右面板点终点（仅一次；中途不读输入框、不聚焦，严防重置为「选起点」模式）
    await navigateRightPanelToMonth(page, ey, em);
    await page.waitForTimeout(240);
    const eClicked = await clickDayInPanel(page, end, 'right');
    console.log('  ' + (eClicked ? '✓' : '⌛') + ' 点击终点 ' + eStr + '（右面板）');
    await page.waitForTimeout(380);

    const { v0, v1 } = await readRangeInputs(page);
    const ok = (v0 === sStr) && (v1 === eStr);
    console.log('  ' + (ok ? '✓' : '⚠') + ' 日历点选完成（第' + attempt + '轮），日期输入框值: ' + (v0 || '?') + ' ~ ' + (v1 || '?'));

    if (ok) {
      // 若面板仍未关闭（部分 UI 需要点确定），尝试点确定；否则由选择自动关闭。
      const confirmed = await clickTextIn(page, '.el-date-range-picker', '确定', 1200)
        || await clickTextIn(page, '.el-date-range-picker', '确认', 1200);
      if (confirmed) console.log('  ✓ 点击面板「确定」提交');
      await page.waitForTimeout(400);
      return true;
    }
    // 整轮失败：关闭面板，下一轮整段重开（属整段重开，非中途重开）
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }
  return false;
}

// ---------- 内容感知下载归位（复用已验证逻辑）----------
const _processedDL = new Set();
let pageRefGlobal = null;
let currentExportTarget = null;   // 当前正在导出的报表名（如「利润报表」），用于按上下文归位下载文件
let dlTmpDir = '';                // CDP 下载直写的纯英文临时目录（模块级，供 exportOne 轮询使用）

// 日期范围覆盖（命令行参数）：--end=YYYY-MM-DD / --days=N / --range=START~END
// 默认行为：截至今天的前 N 天（N 取各报表自身配置，利润/表现=90，补货=90）。
let globalEndDate = null;         // 自定义「截止日」（如 2026-08-01），起点=截止日往前 days-1 天
let globalDaysOverride = null;    // 覆盖各报表默认天数
let globalRangeStart = null;      // 显式起始日（--range）
let globalRangeEnd = null;        // 显式结束日（--range）

function notify(page, text) {
  console.log('[提醒]', text);
  if (!page) return;
  // 用 .catch 吞掉异步拒绝：浏览器若已断开，page.evaluate 会 reject，不加 .catch 会变成
  // 未处理的异步拒绝，直接导致 Node 静默杀掉整个进程（这正是之前"连报错机会都没有"的元凶）。
  try {
    page.evaluate((t) => {
      if (!document.body) return;
      let box = document.getElementById('__lx_toast');
      if (!box) {
        box = document.createElement('div');
        box.id = '__lx_toast';
        box.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:90vw;background:#1c2530;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;line-height:1.45;box-shadow:0 4px 16px rgba(0,0,0,.4);font-family:sans-serif;';
        document.body.appendChild(box);
      }
      box.textContent = '🔔 ' + t;
      box.style.display = 'block';
      clearTimeout(box.__t);
      box.__t = setTimeout(() => { box.style.display = 'none'; }, 6000);
    }, text).catch(() => {});
  } catch (_) {}
}

function classifyXlsx(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const head = (rows[0] || []).map((c) => String(c));
    const hs = head.join(' ');
    const has = (k) => hs.includes(k);
    if (has('可售') && (has('日均') || has('销量'))) return 'REPLENISH';
    if (has('日期') && (has('订单量') || has('Sessions') || has('广告花费'))) return 'PERFORMANCE';
    if ((has('毛利润') || has('毛利率')) && has('ASIN')) return 'PROFIT';
    if (has('ASIN') && (has('SKU') || has('父体') || has('品名'))) return 'MINE';
    return 'UNKNOWN';
  } catch (e) {
    return 'ERROR:' + e.message;
  }
}

const TYPE_NAME = { PROFIT: '利润报表', PERFORMANCE: '产品表现', REPLENISH: '补货建议', MINE: '我的ASIN' };

async function routeDownload(filePath) {
  const type = classifyXlsx(filePath);
  const name = TYPE_NAME[type];
  if (!name) {
    // 诊断：打印首行表头，便于核对关键词
    let head = '';
    try {
      const buf = fs.readFileSync(filePath);
      const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      head = (rows[0] || []).map((c) => String(c)).join(' | ').slice(0, 200);
    } catch (_) {}
    console.log('  ↳ 未识别的下载文件（已跳过）:', path.basename(filePath), '→', type, '| 表头:', head);
    return false;
  }
  const dest = path.join(OUT_DIR, name + '.xlsx');
  if (path.resolve(filePath) === path.resolve(dest)) return true; // 自我保护：源==目标直接视为已就位
  return await withCopyLock(async () => {
    try {
      fs.copyFileSync(filePath, dest);
      console.log('  ↳ 已归位[' + name + '] →', dest, '（原始:', path.basename(filePath) + '）');
      if (pageRefGlobal) notify(pageRefGlobal, '✓ ' + name + ' 已保存到 源文件2.0');
      return true;
    } catch (e) {
      console.log('  ↳ 归位失败:', e.message);
      return false;
    }
  });
}

// 按上下文归位：我们点导出时已知当前是哪张表，直接用它命名，不再靠内容猜
async function routeDownloadContext(filePath, target) {
  try {
    // 1) 等待文件落盘完成：存在且大小在两次采样间稳定（规避 chromium 仍持有/写入中导致复制失败）
    let stable = false;
    for (let i = 0; i < 40; i++) { // 最多 ~20s
      try {
        const s1 = fs.statSync(filePath).size;
        await new Promise((r) => setTimeout(r, 500));
        const s2 = fs.statSync(filePath).size;
        if (s1 > 0 && s1 === s2) { stable = true; break; }
      } catch (_) { await new Promise((r) => setTimeout(r, 500)); }
    }
    if (!stable) console.log('  ↳ 警告：下载文件大小未稳定，仍尝试归位');

    const detected = classifyXlsx(filePath);
    const name = (target || '').trim() || TYPE_NAME[detected];
    if (!name) {
      console.log('  ↳ 无上下文目标且内容未识别（已跳过）:', path.basename(filePath), '→', detected);
      return false;
    }
    const dest = path.join(OUT_DIR, name + '.xlsx');
    if (path.resolve(filePath) === path.resolve(dest)) return true; // 自我保护：源==目标直接视为已就位
    // 2) 复制带重试：文件可能被 chromium 短暂锁定（EBUSY/EPERM/EACCES），最多重试 10 次；
    //    复制+清理放进串行锁，避免与主循环保存校验/定时扫描互相覆盖。
    return await withCopyLock(async () => {
      let copied = false;
      for (let i = 0; i < 10 && !copied; i++) {
        try { fs.copyFileSync(filePath, dest); copied = true; }
        catch (e) {
          if (i < 9) { await new Promise((r) => setTimeout(r, 600)); }
          else console.log('  ↳ 归位复制失败:', e.message);
        }
      }
      if (!copied) return false;
      console.log('  ↳ 已归位[' + name + '] →', dest, '（原始:', path.basename(filePath) + ', 内容识别:', detected + '）');
      if (pageRefGlobal) notify(pageRefGlobal, '✓ ' + name + ' 已保存到 源文件2.0');
      // 3) 清理已成功复制的临时源文件（任意命名，避免下载文件长期滞留临时目录）
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
      return true;
    });
  } catch (e) {
    console.log('  ↳ 归位失败:', e.message);
    return false;
  }
}

function scanDownloadLocations() {
  const roots = [];
  const dl = path.join(process.env.USERPROFILE || 'C:\\Users\\Administrator', 'Downloads');
  if (fs.existsSync(dl)) roots.push(dl);
  const localApp = process.env.LOCALAPPDATA || 'C:\\Users\\Administrator\\AppData\\Local';
  const tmp = path.join(localApp, 'Temp');
  if (fs.existsSync(tmp)) {
    let profs = [];
    try { profs = fs.readdirSync(tmp).filter((d) => d.startsWith('playwright_chromiumdev_profile-')); } catch (_) {}
    for (const d of profs) {
      for (const sub of ['Downloads', 'Default/Downloads', 'Network/Downloads']) {
        const p = path.join(tmp, d, sub);
        if (fs.existsSync(p)) roots.push(p);
      }
    }
  }
  const now = Date.now();
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (_) { continue; }
    for (const e of entries) {
      if (!/\.xlsx$/i.test(e)) continue;
      const fp = path.join(root, e);
      if (_processedDL.has(fp)) continue;
      let st;
      try { st = fs.statSync(fp); } catch (_) { continue; }
      if (now - st.mtimeMs > 300000) continue;
      _processedDL.add(fp);
      routeDownload(fp).then((ok) => {
        if (!ok && classifyXlsx(fp).startsWith('ERROR')) _processedDL.delete(fp);
        if (/^_dl_\d+\.xlsx$/i.test(e)) { try { fs.unlinkSync(fp); } catch (_) {} }
      });
    }
  }
}

// 判断是否为合法的 xlsx（文件头 PK\x03\x04）。下载若被浏览器崩溃打断可能留下截断文件，须过滤。
function isValidXlsx(p) {
  try { const b = fs.readFileSync(p); return b.length > 4 && b[0] === 0x50 && b[1] === 0x4B; } catch (_) { return false; }
}
// 读取文件字节数（不存在返回 0）
function _sizeOf(p) { try { return fs.statSync(p).size; } catch (_) { return 0; } }
// 等待 ms 后再次读取字节数（用于判断下载是否写完）
function _sizeOfAfter(p, ms) { return new Promise((res) => setTimeout(() => res(_sizeOf(p)), ms)); }
// 在多个目录中找出"晚于 sinceMs 的最新 .xlsx"（用于挑出本次新落下的下载文件）
function pickNewestXlsx(dirs, sinceMs) {
  let best = null, bestT = 0;
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) { continue; }
    for (const e of entries) {
      if (!/\.xlsx$/i.test(e)) continue;
      const fp = path.join(dir, e);
      let mt = 0; try { mt = fs.statSync(fp).mtimeMs; } catch (_) { continue; }
      if (sinceMs && mt < sinceMs) continue;
      if (mt > bestT) { bestT = mt; best = fp; }
    }
  }
  return best;
}

function pause(hint) {
  return new Promise((res) => {
    console.log(hint);
    if (process.stdin.isTTY) {
      process.stdin.resume();
      process.stdin.once('data', () => res());
    } else {
      setTimeout(res, 300000); // 手动兜底最长 5 分钟
    }
  });
}

// ---- 复制/归位串行锁 ----
// CDP 下载事件回调、主循环保存校验、定时扫描三处都可能对同一 dest 做 copy(+unlink)，
// 必须串行化，否则会互相覆盖，甚至把"刚复制好的目标文件"当作源删掉（曾出现「已保存 0 字节」丢文件）。
let _copyChain = Promise.resolve();
function withCopyLock(fn) {
  const run = _copyChain.then(() => fn(), () => fn());
  _copyChain = run.catch(() => {});
  return run;
}

// 点击页面中第一个含指定文字且可见的元素（兼容 button/a/span/li/div）
async function clickText(page, text, timeout = 8000) {
  const sels = [
    `button:has-text("${text}")`,
    `a:has-text("${text}")`,
    `span:has-text("${text}")`,
    `li:has-text("${text}")`,
    `div:has-text("${text}")`,
    `[role="button"]:has-text("${text}")`,
  ];
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of sels) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible().catch(() => false)) {
          // 优先直接 DOM 点击（绕过遮罩/动画导致的可点击性超时），失败再回退 Playwright 点击
          const domOk = await page.evaluate((e) => { try { e.scrollIntoView({ block: 'center', inline: 'nearest' }); e.click(); return true; } catch (_) { return false; } }, el).catch(() => false);
          if (!domOk) { await el.click({ timeout: 2000 }).catch(() => {}); }
          return true;
        }
      } catch (_) {}
    }
    await page.waitForTimeout(300);
  }
  return false;
}

// 设置日期范围：领星日期框为只读式，fill 不可靠 → 一律走日历面板点选（见 setRangeViaCalendar）。
// 日期范围可由命令行参数覆盖（--end / --days / --range），否则默认「截至今天的前 N 天」。
async function setRangeDays(page, reportDays) {
  // 进入本函数前已通过 waitForDateInputs 门禁，但设置粒度可能触发重渲染；
  // 这里再兜底等一次日期框出现，避免在弱网/重渲染间隙点不到 .el-range-input。
  await waitForDateInputs(page, 30000);

  // 生效的天数：命令行 --days 优先，否则用报表自身配置的天数
  const days = (globalDaysOverride != null) ? globalDaysOverride : reportDays;

  // 生效的起止日：--range 显式优先；否则用 --end（截至该日往前 days 天）；否则截至今天
  let start, end;
  if (globalRangeStart && globalRangeEnd) {
    start = new Date(globalRangeStart); end = new Date(globalRangeEnd);
  } else if (globalEndDate) {
    end = new Date(globalEndDate);
    start = new Date(end); start.setDate(end.getDate() - (days - 1));
  } else {
    end = new Date();
    start = new Date(end); start.setDate(end.getDate() - (days - 1));
  }
  const sStr = fmtDate(start), eStr = fmtDate(end);
  let scopeDesc;
  if (globalRangeStart && globalRangeEnd) scopeDesc = '指定区间';
  else if (globalEndDate) scopeDesc = '截至 ' + eStr + ' 的前 ' + days + ' 天';
  else scopeDesc = '近 ' + days + ' 天（截至今天）';
  console.log('  设置日期范围（' + scopeDesc + '）:', sStr, '~', eStr);

  // 硬性要求：一次打开日历，连续点完起点和终点，中途绝不关闭/重开面板。
  // setRangeViaCalendar 内部已实现此约束；外层不再做 Escape 重试。
  const okCal = await setRangeViaCalendar(page, start, end);
  const { v0, v1 } = await readRangeInputs(page);
  console.log('  ' + (okCal ? '✓' : '⚠') + ' 最终日期输入框值: ' + (v0 || '?') + ' ~ ' + (v1 || '?'));
  if (okCal && v0 && v1) return true;
  console.log('  ⚠ 未能自动设置日期范围，请在页面手动设好后再继续');
  return false;
}

// 三大报表配置（选择器来自 2026-08-14 录制轨迹，已确认真实有效）
const REPORTS = [
  {
    key: 'profit', name: '利润报表', days: 90,
    enabled: false, // 2026-08-19 用户决定：未来不再导出利润报表（默认跳过；--only=profit 可临时手动导出）
    url: 'https://erp.lingxing.com/erp/ProfitReport', // 直接进报表页，绕过会崩溃的 /erp/home 首页
    navIcon: 'i.iconfont.lx_nav_financial',     // 财务
    menuText: '利润报表',
    tabId: 'tab-asin',                           // 切到 ASIN 明细标签（看板页无导出）
    tabText: 'ASIN',                             // 标签可见文字（id 不可见时按文字兜底）
    // 利润报表有两个粒度下拉，必须区分：
    //   1) 左侧「时间粒度」（日期框旁边）：先设为「按天」，再操作日历；选项为「按月/按周/按天」。
    //   2) 右侧「展示粒度」（导出按钮区域）：日期选完后再设为「按天展示」；选项为「汇总展示/按天展示」。
    timeGranularityText: '按天',                 // 左侧时间粒度下拉选「按天」
    timeGranularityMode: 'select',               // 需要先点下拉再选选项
    granularityText: '按天展示',                 // 右侧展示粒度下拉选「按天展示」
    granularityMode: 'select',                   // 需要先点下拉再选选项
    storeText: '价格与促销-ZK',                  // 店铺/Listing 标签筛选（在导出面板内选择）
    verifyText: ['毛利润', '毛利率', 'ASIN'],
    // 导出点击序列（来自 2026-08-14 录制轨迹，真实有效）
    exportSeq: [
      { tag: 'I', cls: 'lx_table_download' },         // 点表格导出图标
      { tag: 'SPAN', text: '请选择' },                // 展开店铺下拉
      { tag: 'SPAN', text: '价格与促销-ZK' },         // 选店铺
      { tag: 'BUTTON', text: '导出', cls: 'el-button--primary' }, // 点蓝色确认按钮
      { tag: 'SPAN', text: '立即下载' },              // 下载
    ],
  },
  {
    key: 'performance', name: '产品表现', days: 90, // 平台上限 90 天
    url: 'https://erp.lingxing.com/erp/productExpressionNew', // 直接进报表页，绕过会崩溃的 /erp/home 首页
    navIcon: 'i.iconfont.lx_nav_statistical',    // 统计
    menuText: '产品表现',
    timeGranularityText: '按天',                 // 左侧时间粒度下拉（选项：按月/按周/按天）
    timeGranularityMode: 'select',
    // 注意：产品表现没有利润报表右侧的「汇总展示/按天展示」第二个下拉
    // 因已按 URL 直达，不再做页面正文特征校验，避免无意义等待。
    skipContentWait: true,
    // 导出点击序列（来自录制：保存模板「自动化-ZK」）
    // 注意顺序：打开导出面板后，先点顶部的「日」单选，再选模板下拉「自动化-ZK」，最后点蓝色导出。
    exportSeq: [
      { tag: 'I', cls: 'lx_table_download' },         // 点表格导出图标
      { tag: 'SPAN', text: '日', radio: true },       // 先选导出面板顶部的「日」单选
      // 模板下拉：实测为 el-select（.el-select--small，选项 li.el-select-dropdown__item）。
      // 此前用两步文字点击（模板名称→自动化-ZK）从未真正打开下拉（「模板名称」命中的是 input 前缀标签），
      // 导致模板从未切换、导出始终是默认 40 列。改为 selectOptions 精确路径：展开 → 选中 → 关闭。
      { tag: 'SPAN', text: '自动化-ZK', selectOptions: ['自动化-ZK', '利润差异分析-ZK', '周报-ASIN-ZK', '运营数据追踪-ZK', '模板名称', '请选择'] },
      { tag: 'BUTTON', text: '导出', cls: 'el-button--primary' }, // 最后点蓝色确认按钮
      { tag: 'SPAN', text: '立即下载' },              // 下载
    ],
  },
  {
    key: 'replenish', name: '补货建议', days: 90,
    url: 'https://erp.lingxing.com/erp/msupply/replenishmentAdvice', // 直接进报表页，绕过会崩溃的 /erp/home 首页
    navIcon: 'i.iconfont.lx_nav_fba',            // FBA
    menuText: '补货建议',
    // 补货建议页面无日期范围、无顶部粒度/视图单选，进入 URL 后直接点导出图标即可。
    needsDateRange: false,
    verifyText: ['可售', '日均'],
    // 导出点击序列：点下载图标 → 在导出面板左上角模板下拉选择「备货与发货-ZK」→ 点蓝色导出 → 立即下载。
    // selectOptions 用于在 placeholder/当前值不直接显示目标时，也能正确定位并展开该下拉。
    exportSeq: [
      { tag: 'I', cls: 'lx_table_download' },         // 点表格导出图标
      { tag: 'SPAN', text: '备货与发货-ZK', selectOptions: ['备货与发货-ZK', '选择模板', '模板名称', '请选择', '请选择模板'] }, // 选已保存模板；placeholder 常见为「选择模板」
      { tag: 'BUTTON', text: '导出', cls: 'el-button--primary' }, // 确认导出
      { tag: 'SPAN', text: '立即下载' },              // 下载
    ],
  },
];

function verifyPage(page, texts) {
  // 采用「任一命中即通过」(OR) 语义：领星后台表头中英文不一致（如「会话数」vs「Sessions」）
  // 很常见，若用 every(AND) 会因单个词语言差异整体失败、触发 pause 阻断一次性导出。
  // 仅当所有关键字都不存在（页面多半没进对）才返回 false，由上层决定是否拦截。
  // 大小写不敏感：避免「Sessions」因大小写差异漏匹配。
  return page.evaluate((ts) => {
    const t = (document.body ? document.body.innerText : '').toLowerCase();
    return ts.some((k) => t.includes(k.toLowerCase()));
  }, texts);
}

// 等待领星后台应用框架（左侧导航）就绪：登录后 SPA 是客户端跳转 + 异步拉取资源，
// 若不等框架渲染就急于点导航图标/菜单，会遇到「图标/菜单/明细标签/日期框全找不到」的连锁失败
// （日志还会伴随 net::ERR_CONNECTION_RESET / TIMED_OUT —— 多半是资源还没拉完或网络抖动）。
// 这里轮询等待左侧导航容器出现；超时返回 false，由上层给出明确的网络/刷新提示。
async function waitForAppShell(page, timeout = 30000) {
  const selectors = 'i.iconfont, [class*="lx_nav"], [class*="nav-"], .el-menu, .sidebar, .aside, [class*="menu"], .layout-aside, .container-aside';
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await page.evaluate((sel) => {
      return !!document.querySelector(sel);
    }, selectors).catch(() => false);
    if (ok) { console.log('  ✓ 后台应用框架（左侧导航）已就绪'); return true; }
    await page.waitForTimeout(800);
  }
  console.log('  ⚠ 后台应用框架超时未加载（多半是网络/资源未完成，留意上方 ERR_CONNECTION 错误）');
  return false;
}

// 等待报表内容真正渲染完成：仅靠「左侧导航就绪」(waitForAppShell) 并不足以说明报表数据已加载，
// SPA 在弱网下左侧导航可能先出来、而右侧报表区域仍在拉取/渲染。若不等内容就急着「切标签 → 找日期」，
// 会连环失败（尤其利润报表切到 ASIN 后日期面板迟迟不出现）。
// 采用 OR 语义：任一特征词出现即通过（领星中英文表头不一致很常见）。
// 这层等待对应「页面加载完并且已经进入该报表」的硬约束，是后续找 ASIN 板块/日期面板的前置条件。
async function waitForReportContent(page, r, timeout = 20000) {
  const verifyText = Array.isArray(r.verifyText) ? r.verifyText : [];
  if (!verifyText.length) { console.log('  → 未配置报表特征词，跳过内容等待'); return true; }
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < timeout) {
    const ok = await verifyPage(page, verifyText).catch(() => false);
    if (ok) { console.log('  ✓ 报表内容已加载（命中特征: ' + verifyText.join('/') + '）'); return true; }
    // 每 5 秒打印一次等待提示，避免黑窗长时间无输出让用户以为卡死
    if (Date.now() - lastLog >= 5000) {
      console.log('  · 等待报表内容特征加载（' + verifyText.join('/') + '）...');
      lastLog = Date.now();
    }
    await page.waitForTimeout(1000);
  }
  console.log('  ⚠ 报表内容在 ' + (timeout / 1000) + 's 内未加载完成（期望含: ' + verifyText.join('/') + '）。已按 URL 直达，继续后续步骤。');
  return false;
}

// 等待日期面板就绪：进入 ASIN 板块（或其它明细视图）后，Element UI 日期范围框才会渲染出来。
// 弱网下即便报表框架在，日期框也可能迟到；此处轮询直到出现 .el-range-input（或已展开的 .el-date-range-picker）
// 才允许进入「设置粒度 / 设置日期范围」，避免「页面没加载完就找日期」导致根本定位不到 ASIN 页的日期。
// 这层等待对应「已进入 ASIN 板块、才开始找日期面板」的硬约束。
async function waitForDateInputs(page, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await page.evaluate(() => {
      const inputs = document.querySelectorAll('.el-range-input');
      if (inputs.length >= 2) return true;
      const picker = document.querySelector('.el-date-range-picker');
      if (picker && picker.offsetParent !== null) return true;
      return false;
    }).catch(() => false);
    if (ok) { console.log('  ✓ 日期面板已就绪（.el-range-input 出现）'); return true; }
    await page.waitForTimeout(1000);
  }
  console.log('  ⚠ 日期面板在 ' + (timeout / 1000) + 's 内未出现，尝试继续（可能需要手动设置日期）');
  return false;
}

// 录制驱动的点击匹配器：id → 精确/包含文字(DOM 点击，避开重叠 SPAN) → select 下拉选项 → class 兜底
async function clickStep(page, s) {
  const txt = (s.text || '').trim();
  if (s.id && /^[A-Za-z0-9_-]+$/.test(s.id)) {
    try {
      const el = page.locator('#' + s.id);
      if (await el.count()) { try { await el.first().click({ timeout: 5000 }); return true; } catch (_) {} }
    } catch (_) {}
  }
  if (txt) {
    const tag = (s.tag && /^(a|button|input|select|span|div|li|label|i|td|th|p)$/i.test(s.tag)) ? s.tag.toLowerCase() : '*';
    const clsName = (s.cls || '').trim();
    const hasSelectOptions = !!(s.selectOptions && s.selectOptions.length);

    // 通用文字/单选匹配：仅当没有配置 selectOptions 时使用。
    // 若同时有 text + selectOptions，说明目标是下拉框里的选项，必须由下方 select 逻辑控制：
    // 避免下拉展开后选项文字被通用匹配抢先点击，导致下拉未关闭、脚本卡住。
    if (!hasSelectOptions) {
      try {
        const clicked = await page.evaluate(({ tag, txt, radio, cls }) => {
          const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
          const hasClass = (el, n) => el && (' ' + (el.className || '') + ' ').indexOf(' ' + n + ' ') >= 0;
          // 0) 若同时指定 text + cls，优先在弹窗/导出面板内精确匹配两者（避免页面背景同名按钮干扰）
          if (cls) {
            const panels = Array.from(document.querySelectorAll('.el-dialog, .el-drawer, .el-popover, .export-panel, [class*="export"], [class*="dialog"]'));
            const scope = panels.length ? panels : [document.body];
            for (const root of scope) {
              const els = Array.from(root.querySelectorAll(tag === '*' ? '*' : tag));
              for (const e of els) {
                if (norm(e.textContent) === txt && hasClass(e, cls) && e.offsetParent !== null) { try { e.click(); return true; } catch (_) {} }
              }
              for (const e of els) {
                if (norm(e.textContent).includes(txt) && hasClass(e, cls) && e.offsetParent !== null) { try { e.click(); return true; } catch (_) {} }
              }
            }
          }
          // 1) 单选按钮优先在导出/弹窗面板内精确匹配
          if (radio) {
            const panels = Array.from(document.querySelectorAll('.el-dialog, .el-drawer, .el-popover, .export-panel, [class*="export"], [class*="dialog"]'));
            const candidates = panels.length ? panels.flatMap((p) => Array.from(p.querySelectorAll('.el-radio__label, label.el-radio, [role="radio"], .el-radio-button__inner'))) : Array.from(document.querySelectorAll('.el-radio__label, label.el-radio, [role="radio"], .el-radio-button__inner'));
            for (const e of candidates) { if (norm(e.textContent) === txt && e.offsetParent !== null) { try { e.click(); return true; } catch (_) {} } }
            for (const e of candidates) { if (norm(e.textContent).includes(txt) && e.offsetParent !== null) { try { e.click(); return true; } catch (_) {} } }
          }
          // 2) 普通文字精确/包含匹配
          const els = Array.from(document.querySelectorAll(tag === '*' ? '*' : tag));
          for (const e of els) { if (norm(e.textContent) === txt && e.offsetParent !== null) { try { e.click(); return true; } catch (_) {} } }
          for (const e of els) { if (norm(e.textContent).includes(txt) && e.offsetParent !== null) { try { e.click(); return true; } catch (_) {} } }
          return false;
        }, { tag, txt, radio: !!s.radio, cls: clsName });
        if (clicked) return true;
      } catch (_) {}
    }
    // 3) select 下拉选项精确控制：展开 → 选中目标 → 关闭下拉，确保选项真正生效。
    if (s.selectOptions && s.selectOptions.length) {
      // 3.0) 目标已经被选中：直接关闭可能展开的下拉，视为本步完成，跳到下一步（点导出）。
      try {
        const alreadySelected = await page.evaluate(({ txt }) => {
          const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
          for (const sel of document.querySelectorAll('.el-select')) {
            const inner = sel.querySelector('.el-input__inner');
            const val = n(inner ? (inner.value || inner.textContent || '') : '');
            if (val.indexOf(txt) >= 0) {
              // 关闭已展开的下拉：先 Escape，再点 body 空白处兜底
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
              document.body.click();
              return true;
            }
          }
          return false;
        }, { txt });
        if (alreadySelected) {
          try { await page.keyboard.press('Escape'); } catch (_) {}
          try { await page.waitForTimeout(250); } catch (_) {}
          return true;
        }
      } catch (e) { console.log('  [DIAG-ERR] 3.0 alreadySelected 异常: ' + String((e && e.message) || e)); }

      // 3.1) 定位目标下拉并展开（只处理未选中目标的情况）
      let opened = false;
      let diagInfo = '';
      try {
        const ev = await page.evaluate(({ txt, selectOptions }) => {
          const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
          const allOpts = [txt, ...selectOptions];
          const scopes = Array.from(document.querySelectorAll('.el-dialog, .el-drawer, .el-popover, .export-panel, [class*="export"], [class*="dialog"]'));
          const selectsInScopes = scopes.length ? scopes.flatMap((p) => Array.from(p.querySelectorAll('.el-select'))) : Array.from(document.querySelectorAll('.el-select'));
          const selects = [];
          for (const s of selectsInScopes) { if (!selects.includes(s)) selects.push(s); }
          let info = 'scopes=' + scopes.length + ' selects=' + selects.length;
          for (const sel of selects) {
            const iv = sel.querySelector('.el-input__inner');
            const pv = sel.querySelector('.el-input__placeholder');
            const v = (iv ? (iv.value || iv.textContent || '') : '');
            const p = (pv ? pv.textContent : (iv ? iv.getAttribute('placeholder') : ''));
            const itemsTxt = Array.from(sel.querySelectorAll('.el-select-dropdown__item')).map(it=>it.textContent.trim()).join('|');
            info += '; val="' + v + '" ph="' + p + '" items="' + itemsTxt + '"';
          }
          for (const sel of selects) {
            const inner = sel.querySelector('.el-input__inner');
            const placeholderEl = sel.querySelector('.el-input__placeholder');
            const val = norm(inner ? (inner.value || inner.textContent || '') : '');
            const ph = norm(placeholderEl ? placeholderEl.textContent : (inner ? inner.getAttribute('placeholder') : ''));
            if (val.indexOf(txt) >= 0) continue;
            const items = Array.from(sel.querySelectorAll('.el-select-dropdown__item'));
            const belongs = selectOptions.some((o) => val.indexOf(o) >= 0 || ph.indexOf(o) >= 0) ||
              items.some((it) => allOpts.some((o) => norm(it.textContent).indexOf(o) >= 0));
            info += ' belongs=' + belongs + ' for txt=' + txt;
            if (belongs) {
              const ipt = sel.querySelector('.el-input') || sel.querySelector('.el-input__inner') || sel.querySelector('.el-input__suffix') || sel;
              try { ipt.click(); return { opened: true, info }; } catch (_) {}
            }
          }
          if (selects.length === 1) {
            const sel = selects[0];
            const ipt = sel.querySelector('.el-input') || sel.querySelector('.el-input__inner') || sel.querySelector('.el-input__suffix') || sel;
            try { ipt.click(); return { opened: true, info }; } catch (_) {}
          }
          return { opened: false, info };
        }, { txt, selectOptions: s.selectOptions });
        opened = ev.opened;
        diagInfo = ev.info;
      } catch (_) {}

      if (opened) {
        try { await page.waitForTimeout(500); } catch (_) { return false; }

        // 3.2) 在展开的 portal 里点目标选项（最多等 3s）
        let picked = false;
        for (let t = 0; t < 10; t++) {
          try {
            picked = await page.evaluate(({ txt }) => {
              const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
              for (const dd of document.querySelectorAll('.el-select-dropdown')) {
                if (dd.offsetParent === null) continue;
                for (const it of dd.querySelectorAll('.el-select-dropdown__item')) {
                  if (norm(it.textContent).indexOf(txt) >= 0) { try { it.click(); return true; } catch (_) {} }
                }
              }
              return false;
            }, { txt });
            if (picked) break;
          } catch (_) {}
          try { await page.waitForTimeout(300); } catch (_) { return false; }
        }

        if (picked) {
          // 3.3) 选中后强制关闭下拉，确保选项生效、不影响后续点击导出按钮
          try {
            await page.waitForTimeout(300);
            await page.evaluate(() => {
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
              document.body.click();
            });
            await page.keyboard.press('Escape');
            await page.waitForTimeout(250);
          } catch (_) {}
          return true;
        }
      }
    }
    // 3.4) 兜底：领星「模板/店铺」可能是平铺标签或按钮组（非 el-select 下拉），3.1 永远无法展开。
    // 此时在导出/弹窗面板作用域内按文字直接点击目标标签，确保真正选中模板/店铺。
    if (txt) {
      try {
        const clicked = await page.evaluate(({ tag, txt }) => {
          const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
          const t = '*'; // 不限标签：领星模板/店铺选项可能是 div/li/span 等任意元素
          const panels = Array.from(document.querySelectorAll('.el-dialog, .el-drawer, .el-popover, .export-panel, [class*="export"], [class*="dialog"]'));
          const scopes = panels.length ? panels : [document.body];
          for (const root of scopes) {
            const els = Array.from(root.querySelectorAll(t === '*' ? '*' : t));
            for (const e of els) {
              if (e.offsetParent === null) continue;
              const c = norm(e.textContent);
              if (c === txt || c.indexOf(txt) >= 0) { try { e.click(); return true; } catch (_) {} }
            }
          }
          return false;
        }, { tag: s.tag || '*', txt });
        if (clicked) { try { await page.waitForTimeout(300); } catch (_) {} return true; }
      } catch (_) {}
    }
  }
  if (s.cls) {
    const cls = s.cls.split(/\s+/).filter((c) => c && !/^(ant|el)-/.test(c) && c.length > 4);
    const tagName = (s.tag || '').toLowerCase();
    for (const c of cls) {
      try {
        const el = page.locator('.' + c);
        if (await el.count()) { try { await el.first().click({ timeout: 4000 }); return true; } catch (_) {} }
      } catch (_) {}
      // DOM fallback：图标类元素（如导出按钮的 <i class="lx_table_download">）可能被按钮包裹，
      // 或被 Playwright 可点击性判定拦截；直接在页面内点击真实元素或它的父 button/a。
      try {
        const clicked = await page.evaluate(({ tag, cls: name }) => {
          const hasClass = (el, n) => el && (' ' + (el.className || '') + ' ').indexOf(' ' + n + ' ') >= 0;
          const selector = tag === '*' || !tag ? '*' : tag;
          // 1) 优先点击带目标 class 且可见的元素本身
          let candidates = Array.from(document.querySelectorAll(selector)).filter((e) => hasClass(e, name) && e.offsetParent !== null);
          // 2) 若没有直接命中的可见元素，找子元素含该 class 的 button/a/div/span（图标常被包裹）
          if (!candidates.length) {
            const parents = Array.from(document.querySelectorAll('button, a, div, span, [role="button"]'));
            for (const p of parents) {
              if (p.querySelector('.' + name) && p.offsetParent !== null) { candidates.push(p); break; }
            }
          }
          for (const e of candidates) { try { e.click(); return true; } catch (_) {} }
          return false;
        }, { tag: tagName || '*', cls: c });
        if (clicked) return true;
      } catch (_) {}
    }
  }
  return false;
}

// 依次回放导出序列；每个步骤都允许短暂重试，避免面板/选项弹出慢导致一次点不中。
// 最后一步（立即下载）轮询等待文件生成后再点。
async function runExportSequence(page, seq) {
  let ok = false;
  for (let k = 0; k < seq.length; k++) {
    const step = seq[k];
    const isLast = k === seq.length - 1;
    ok = false;
    const isExportConfirm = !isLast && step.tag === 'BUTTON' && /el-button--primary/.test(step.cls || '');
    // 最后一步（立即下载）最多等 180s：补货建议等大盘报表服务端生成较慢，原 40s 会超时（2026-08-19 修复）；
    // 导出确认按钮（蓝色「导出」）放宽到 ~28s，并在每次尝试前先关闭可能残留的下拉/遮罩，
    // 防止点击被吞导致导出未触发（表现为：点了「导出」却永远等不到「立即下载」）。
    const attempts = isLast ? 180 : (isExportConfirm ? 40 : 6);
    const interval = isLast ? 1000 : 700;
    for (let t = 0; t < attempts; t++) {
      if (isExportConfirm) {
        try {
          await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.body.click();
          });
          await page.waitForTimeout(150);
        } catch (_) {}
      }
      try {
        ok = await clickStep(page, step);
      } catch (e) {
        console.log('  ⚠ 点击步骤异常:', String((e && e.message) || e).split('\n')[0]);
        ok = false;
      }
      if (ok) break;
      try {
        await page.waitForTimeout(interval);
      } catch (e) {
        console.log('  ⚠ 等待步骤间隔时浏览器已断开:', String((e && e.message) || e).split('\n')[0]);
        return false;
      }
    }
    const desc = step.text || (step.cls || step.tag);
    if (ok) {
      console.log('  ✓ 点击「' + desc + '」');
      // 步骤间留出沉淀时间：让模板/粒度选择真正生效（面板重渲染、服务端加载模板列集）后再点下一步，
      // 否则紧跟的「导出」会沿用旧配置（曾出现：点击了「自动化-ZK」但导出仍是默认 40 列）。
      try { await page.waitForTimeout(isExportConfirm ? 400 : 800); } catch (_) {}
    }
    else if (isLast) console.log('  ⚠ 等待「' + desc + '」超时（文件可能仍在生成，稍后会在保存校验重试）');
    else console.log('  ⚠ 未点到「' + desc + '」（继续执行后续步骤）');
  }
  return ok;
}

// 利润报表有两个粒度下拉，必须区分处理：
//   左侧「时间粒度」下拉（日期框旁边）：先设为「按天」，再操作日历；选项通常为「按月 / 按周 / 按天」。
//   右侧「展示粒度」下拉（导出按钮区域）：日期选完后再设为「按天展示」；选项通常为「汇总展示 / 按天展示」。

// 设置左侧「时间粒度」下拉（先执行）：选项含「按月/按周/按天」，目标是「按天」。
async function setTimeGranularity(page, r) {
  const target = r.timeGranularityText; // 例如「按天」
  if (r.timeGranularityMode !== 'select') {
    const ok = await clickText(page, target);
    if (ok) console.log('  \u2713 设置左侧时间粒度为「' + target + '」');
    else console.log('  \u26a0 未自动设置左侧时间粒度「' + target + '」（若已是目标可忽略）');
    await page.waitForTimeout(800);
    return ok;
  }

  // 时间粒度下拉识别词：按月 / 按周 / 按天；必须与右侧「汇总展示/按天展示」严格区分，
  // 因此匹配时额外要求当前值不含「展示」二字（右侧才有「展示」）。
  const known = ['\u6309\u6708', '\u6309\u5468', '\u6309\u5929'];

  // 取页面上所有下拉框的当前值（诊断用）
  const getAllSelectValues = () => page.evaluate(() => {
    const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('.el-select')).map((sel) => {
      const inner = sel.querySelector('.el-input__inner');
      return n(inner ? (inner.value || inner.textContent) : '');
    }).filter(Boolean);
  });

  // 等待「时间粒度下拉」真正渲染出来（弱网下它可能晚于日期框）
  const waitForGranularitySelect = async (timeout = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = await page.evaluate((known) => {
        const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
        for (const sel of document.querySelectorAll('.el-select')) {
          const inner = sel.querySelector('.el-input__inner');
          const v = n(inner ? (inner.value || inner.textContent) : '');
          // 左侧时间粒度：含 按月/按周/按天，且不含「展示」
          if (known.some((k) => v.indexOf(k) >= 0) && v.indexOf('\u5c55\u793a') < 0) return true;
        }
        return false;
      }, known);
      if (found) return true;
      await page.waitForTimeout(800);
    }
    return false;
  };

  // 判断时间粒度下拉当前是否已是目标值：只看含「按月/按周/按天」且不含「展示」的那个 select。
  const isSet = async () => page.evaluate(({ known }) => {
    const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
    for (const sel of document.querySelectorAll('.el-select')) {
      const inner = sel.querySelector('.el-input__inner');
      const v = n(inner ? (inner.value || inner.textContent) : '');
      if (known.some((k) => v.indexOf(k) >= 0) && v.indexOf('\u5c55\u793a') < 0) {
        return v.indexOf('\u6309\u5929') >= 0; // 目标是「按天」
      }
    }
    return false;
  }, { known });

  console.log('  \u2192 等待左侧时间粒度下拉渲染...');
  const hasSelect = await waitForGranularitySelect(30000);
  const dbg = await getAllSelectValues();
  if (dbg.length) console.log('  \u00b7 页面下拉框当前值:', JSON.stringify(dbg));
  if (!hasSelect) {
    console.log('  \u26a0 未找到左侧时间粒度下拉（超时 30s），跳过');
    return false;
  }

  if (await isSet()) { console.log('  \u2713 左侧时间粒度已为「' + target + '」'); return true; }

  for (let attempt = 1; attempt <= 4; attempt++) {
    // 1) 确保下拉已展开：优先复用已展开的 portal；否则点目标 select 的触发区。
    let portalReady = await page.evaluate((known) => {
      const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
      for (const dd of document.querySelectorAll('.el-select-dropdown')) {
        if (dd.offsetParent === null) continue;
        const items = Array.from(dd.querySelectorAll('.el-select-dropdown__item'));
        // 左侧 portal 选项应含 按月/按周/按天 且不含「展示」
        if (items.some((it) => { const t = n(it.textContent); return known.some((k) => t.indexOf(k) >= 0) && t.indexOf('\u5c55\u793a') < 0; })) return true;
      }
      return false;
    }, known);

    if (!portalReady) {
      const clickedCaret = await page.evaluate((known) => {
        const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
        for (const sel of document.querySelectorAll('.el-select')) {
          const inner = sel.querySelector('.el-input__inner');
          const v = n(inner ? (inner.value || inner.textContent) : '');
          // 左侧时间粒度：含 按月/按周/按天，且不含「展示」
          if (known.some((k) => v.indexOf(k) >= 0) && v.indexOf('\u5c55\u793a') < 0) {
            // Element UI 下拉展开监听器在 .el-input 包装器 / .el-input__inner 上，
            // 点 caret/suffix 图标通常不会触发，必须点输入区本身。
            const trigger = sel.querySelector('.el-input') || inner || sel.querySelector('.el-input__suffix') || sel.querySelector('.el-select__caret') || sel;
            try { trigger.click(); return true; } catch (e) {}
          }
        }
        return false;
      }, known);
      if (!clickedCaret) { console.log('  \u26a0 未找到左侧时间粒度下拉触发区（第 ' + attempt + ' 次）'); await page.waitForTimeout(1000); continue; }
      console.log('  \u00b7 已点击左侧时间粒度下拉触发区');

      // 等待 portal 真正出现
      for (let p = 0; p < 20; p++) {
        portalReady = await page.evaluate((known) => {
          const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
          for (const dd of document.querySelectorAll('.el-select-dropdown')) {
            if (dd.offsetParent === null) continue;
            const items = Array.from(dd.querySelectorAll('.el-select-dropdown__item'));
            // 左侧 portal 选项必须不含「展示」
            if (items.some((it) => { const t = n(it.textContent); return known.some((k) => t.indexOf(k) >= 0) && t.indexOf('\u5c55\u793a') < 0; })) return true;
          }
          return false;
        }, known);
        if (portalReady) break;
        await page.waitForTimeout(300);
      }
      if (!portalReady) { console.log('  \u26a0 左侧下拉 portal 未出现（第 ' + attempt + ' 次）'); await page.waitForTimeout(500); continue; }
    }
    await page.waitForTimeout(400);

    // 2) 在展开的 portal 里 DOM 点击「按天」选项（避开「按月」「按周」）
    const clicked = await page.evaluate((target) => {
      const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
      for (const dd of document.querySelectorAll('.el-select-dropdown')) {
        if (dd.offsetParent === null) continue;
        for (const it of dd.querySelectorAll('.el-select-dropdown__item')) {
          const txt = n(it.textContent);
          if (txt.indexOf('\u6309\u5929') >= 0 && txt.indexOf('\u5468') < 0 && txt.indexOf('\u6708') < 0) {
            try { it.click(); return true; } catch (e) {}
          }
        }
      }
      return false;
    }, target);
    if (!clicked) { console.log('  \u26a0 未点到左侧「' + target + '」选项（第 ' + attempt + ' 次）'); await page.waitForTimeout(500); continue; }
    await page.waitForTimeout(1000);

    if (await isSet()) { console.log('  \u2713 设置左侧时间粒度为「' + target + '」'); return true; }
    console.log('  \u26a0 左侧点选后校验未通过，重试...');
  }
  console.log('  \u26a0 未自动设置左侧时间粒度「' + target + '」（若已是目标可忽略）');
  return false;
}

// 设置右侧「展示粒度」下拉（日期选完后执行）：选项含「汇总展示 / 按天展示」，目标是「按天展示」。
async function setDisplayGranularity(page, r) {
  const target = r.granularityText; // 例如「按天展示」
  if (r.granularityMode !== 'select') {
    const ok = await clickText(page, target);
    if (ok) console.log('  \u2713 设置右侧展示粒度为「' + target + '」');
    else console.log('  \u26a0 未自动设置右侧展示粒度「' + target + '」（若已是目标可忽略）');
    await page.waitForTimeout(800);
    return ok;
  }

  // 右侧展示粒度下拉识别词：汇总展示 / 按天展示；必须与左侧「按月/按周/按天」严格区分，
  // 因此匹配时额外要求当前值必须含「展示」二字（左侧没有「展示」）。
  const known = ['\u6c47\u603b\u5c55\u793a', '\u6309\u5929\u5c55\u793a'];

  // 取页面上所有下拉框的当前值（诊断用）
  const getAllSelectValues = () => page.evaluate(() => {
    const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('.el-select')).map((sel) => {
      const inner = sel.querySelector('.el-input__inner');
      return n(inner ? (inner.value || inner.textContent) : '');
    }).filter(Boolean);
  });

  // 等待「展示粒度下拉」真正渲染出来（弱网下它可能晚于日期框）
  const waitForGranularitySelect = async (timeout = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = await page.evaluate((known) => {
        const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
        for (const sel of document.querySelectorAll('.el-select')) {
          const inner = sel.querySelector('.el-input__inner');
          const v = n(inner ? (inner.value || inner.textContent) : '');
          // 右侧展示粒度：含 汇总展示/按天展示，且必须含「展示」
          if (known.some((k) => v.indexOf(k) >= 0) && v.indexOf('\u5c55\u793a') >= 0) return true;
        }
        return false;
      }, known);
      if (found) return true;
      await page.waitForTimeout(800);
    }
    return false;
  };

  // 判断展示粒度下拉当前是否已是目标值：只看含「汇总展示/按天展示」且含「展示」的那个 select。
  const isSet = async () => page.evaluate(({ known }) => {
    const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
    for (const sel of document.querySelectorAll('.el-select')) {
      const inner = sel.querySelector('.el-input__inner');
      const v = n(inner ? (inner.value || inner.textContent) : '');
      if (known.some((k) => v.indexOf(k) >= 0) && v.indexOf('\u5c55\u793a') >= 0) {
        return v.indexOf('\u6309\u5929') >= 0; // 目标是「按天展示」
      }
    }
    return false;
  }, { known });

  console.log('  \u2192 等待右侧展示粒度下拉渲染...');
  const hasSelect = await waitForGranularitySelect(30000);
  const dbg = await getAllSelectValues();
  if (dbg.length) console.log('  \u00b7 页面下拉框当前值:', JSON.stringify(dbg));
  if (!hasSelect) {
    console.log('  \u26a0 未找到右侧展示粒度下拉（超时 30s），跳过');
    return false;
  }

  if (await isSet()) { console.log('  \u2713 右侧展示粒度已为「' + target + '」'); return true; }

  for (let attempt = 1; attempt <= 4; attempt++) {
    // 1) 确保下拉已展开：优先复用已展开的 portal；否则点目标 select 的触发区。
    let portalReady = await page.evaluate((known) => {
      const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
      for (const dd of document.querySelectorAll('.el-select-dropdown')) {
        if (dd.offsetParent === null) continue;
        const items = Array.from(dd.querySelectorAll('.el-select-dropdown__item'));
        // 右侧 portal 选项应含 汇总展示/按天展示 且必须含「展示」
        if (items.some((it) => { const t = n(it.textContent); return known.some((k) => t.indexOf(k) >= 0) && t.indexOf('\u5c55\u793a') >= 0; })) return true;
      }
      return false;
    }, known);

    if (!portalReady) {
      const clickedCaret = await page.evaluate((known) => {
        const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
        for (const sel of document.querySelectorAll('.el-select')) {
          const inner = sel.querySelector('.el-input__inner');
          const v = n(inner ? (inner.value || inner.textContent) : '');
          // 右侧展示粒度：含 汇总展示/按天展示，且必须含「展示」
          if (known.some((k) => v.indexOf(k) >= 0) && v.indexOf('\u5c55\u793a') >= 0) {
            // Element UI 下拉展开监听器在 .el-input 包装器 / .el-input__inner 上，
            // 点 caret/suffix 图标通常不会触发，必须点输入区本身。
            const trigger = sel.querySelector('.el-input') || inner || sel.querySelector('.el-input__suffix') || sel.querySelector('.el-select__caret') || sel;
            try { trigger.click(); return true; } catch (e) {}
          }
        }
        return false;
      }, known);
      if (!clickedCaret) { console.log('  \u26a0 未找到右侧展示粒度下拉触发区（第 ' + attempt + ' 次）'); await page.waitForTimeout(1000); continue; }
      console.log('  \u00b7 已点击右侧展示粒度下拉触发区');

      // 等待 portal 真正出现
      for (let p = 0; p < 20; p++) {
        portalReady = await page.evaluate((known) => {
          const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
          for (const dd of document.querySelectorAll('.el-select-dropdown')) {
            if (dd.offsetParent === null) continue;
            const items = Array.from(dd.querySelectorAll('.el-select-dropdown__item'));
            // 右侧 portal 选项必须含「展示」
            if (items.some((it) => { const t = n(it.textContent); return known.some((k) => t.indexOf(k) >= 0) && t.indexOf('\u5c55\u793a') >= 0; })) return true;
          }
          return false;
        }, known);
        if (portalReady) break;
        await page.waitForTimeout(300);
      }
      if (!portalReady) { console.log('  \u26a0 右侧下拉 portal 未出现（第 ' + attempt + ' 次）'); await page.waitForTimeout(500); continue; }
    }
    await page.waitForTimeout(400);

    // 2) 在展开的 portal 里 DOM 点击「按天展示」选项（避开「汇总展示」）
    const clicked = await page.evaluate((target) => {
      const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
      for (const dd of document.querySelectorAll('.el-select-dropdown')) {
        if (dd.offsetParent === null) continue;
        for (const it of dd.querySelectorAll('.el-select-dropdown__item')) {
          const txt = n(it.textContent);
          if (txt.indexOf('\u6309\u5929\u5c55\u793a') >= 0) {
            try { it.click(); return true; } catch (e) {}
          }
        }
      }
      return false;
    }, target);
    if (!clicked) { console.log('  \u26a0 未点到右侧「' + target + '」选项（第 ' + attempt + ' 次）'); await page.waitForTimeout(500); continue; }
    await page.waitForTimeout(1000);

    if (await isSet()) { console.log('  \u2713 设置右侧展示粒度为「' + target + '」'); return true; }
    console.log('  \u26a0 右侧点选后校验未通过，重试...');
  }
  console.log('  \u26a0 未自动设置右侧展示粒度「' + target + '」（若已是目标可忽略）');
  return false;
}

// 设置单选按钮型粒度（产品表现「日/周/月」、补货建议「父ASIN」等）：
// Element UI 单选渲染为 <label class="el-radio"><span class="el-radio__label">日</span></label>，
// 必须精确匹配标签文字（避免误点页面其它含该字的文本，如日期数字），点后再校验选中态。
async function setRadioGranularity(page, r) {
  const target = (r.granularityText || '').trim();
  if (!target) return false;
  console.log('  \u2192 设置单选粒度「' + target + '」...');

  const clickRadio = () => page.evaluate((t) => {
    const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
    const hit = (el, txt) => el && n(el.textContent) === txt && el.offsetParent !== null;
    // 1) Element UI 单选
    for (const lab of document.querySelectorAll('.el-radio, label.el-radio')) {
      const lbl = lab.querySelector('.el-radio__label') || lab;
      if (n(lbl.textContent) === t) { try { lab.click(); return true; } catch (e) {} }
    }
    // 2) 原生 radio + 关联 label
    for (const rb of document.querySelectorAll('input[type="radio"]')) {
      const id = rb.id; const lab = id ? document.querySelector('label[for="' + id + '"]') : rb.closest('label');
      if (lab && n(lab.textContent) === t) { try { rb.click(); return true; } catch (e) {} }
    }
    // 3) role=radio
    for (const el of document.querySelectorAll('[role="radio"]')) {
      if (n(el.textContent) === t) { try { el.click(); return true; } catch (e) {} }
    }
    // 4) 兜底：任何精确等于目标文字且可见的可点击元素
    for (const el of document.querySelectorAll('button,span,div,li,a,[role="button"]')) {
      if (hit(el, t)) { try { el.click(); return true; } catch (e) {} }
    }
    return false;
  }, target);

  const isChecked = () => page.evaluate((t) => {
    const n = (x) => (x || '').replace(/\s+/g, ' ').trim();
    for (const lab of document.querySelectorAll('.el-radio, label.el-radio')) {
      const lbl = lab.querySelector('.el-radio__label') || lab;
      if (n(lbl.textContent) === t) return lab.classList.contains('is-checked');
    }
    for (const rb of document.querySelectorAll('input[type="radio"]')) {
      const id = rb.id; const lab = id ? document.querySelector('label[for="' + id + '"]') : rb.closest('label');
      if (lab && n(lab.textContent) === t) return !!rb.checked;
    }
    for (const el of document.querySelectorAll('[role="radio"]')) {
      if (n(el.textContent) === t) return el.getAttribute('aria-checked') === 'true';
    }
    return false;
  }, target);

  for (let attempt = 1; attempt <= 4; attempt++) {
    const ok = await clickRadio();
    if (ok) {
      await page.waitForTimeout(600);
      if (await isChecked()) { console.log('  \u2713 设置单选粒度为「' + target + '」'); return true; }
    }
    console.log('  \u26a0 单选「' + target + '」暂未命中/未选中（第 ' + attempt + ' 次），重试...');
    await page.waitForTimeout(800);
  }
  console.log('  \u26a0 未自动设置单选粒度「' + target + '」（若已是目标可忽略）');
  return false;
}

async function exportOne(page, r) {
  console.log('\n[' + r.name + '] 开始处理...');
  currentExportTarget = r.name;   // 声明当前导出目标，供下载事件按上下文归位
  // 0) 直接导航到报表页（绕过会崩溃的 /erp/home 首页；根因是 Playwright 自带 Chromium 渲染该超重型仪表盘时自身 renderer 崩溃，
  //    与脚本点选逻辑无关。直接进报表 URL 只渲染该报表组件，从根本上消除崩溃）。
  if (r.url) {
    // 直接导航到报表页（绕过会崩溃的 /erp/home 首页）；若加载不出则自动重载重试最多 3 次
    let shellOk = false;
    for (let attempt = 1; attempt <= 3 && !shellOk; attempt++) {
      console.log('  → 直接导航到报表页（绕过首页）:', r.url, '(第 ' + attempt + ' 次)');
      try {
        await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (e) {
        console.log('  ⚠ 导航到报表页失败:', String(e.message).split('\n')[0]);
      }
      shellOk = await waitForAppShell(page, 30000);
      if (!shellOk) {
        console.log('  ↳ 报表页未就绪，重新加载再试...');
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) {}
      }
    }
    if (!shellOk) console.log('  ⚠ 报表页多次加载仍未就绪（可能为网络 / VPN 抖动）；继续后续步骤，失败将提示手动操作。');
    await page.waitForTimeout(1500);
  } else {
    // 兜底：无 url 配置时走旧的「导航图标 → 菜单」点击流
    await waitForAppShell(page, 15000);
    // 1) 左侧导航图标
    try {
      const clicked = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        el.click();
        return true;
      }, r.navIcon);
      if (clicked) console.log('  ✓ 点击导航图标 ' + r.navIcon);
      else console.log('  ⚠ 未找到导航图标，尝试按文字点击');
    } catch (e) { console.log('  ⚠ 导航图标点击异常:', e.message); }
    await page.waitForTimeout(1200);
    // 2) 菜单项
    const menuOk = await clickText(page, r.menuText, 8000);
    if (menuOk) console.log('  ✓ 点击菜单「' + r.menuText + '」');
    else console.log('  ⚠ 未自动找到「' + r.menuText + '」');
    await page.waitForTimeout(2000);
  }

  // 2.5) 硬约束①：必须等报表内容真正加载完、确认已进入该报表页，才允许去找 ASIN 板块。
  //      弱网下框架先出、内容后到，若不拦一层就会「页面没加载完就找日期」而全落空。
  //      默认最多等 20s；因已按报表 URL 直达，页面身份可信，超时不阻塞，仅警告后继续。
  //      若配置 skipContentWait:true（用户确认 URL 准确），则直接跳过此等待。
  if (r.skipContentWait) {
    console.log('  → 已跳过报表内容特征等待（URL 直达可信）');
  } else {
    console.log('  → 等待报表内容加载完成（进入「' + r.name + '」）...');
    await waitForReportContent(page, r);
  }

  // 3) 明细标签（利润报表需切 ASIN）—— 等待可见 + 重试 + 按文字兜底（scoped 到 tab 头部）
  if (r.tabId) {
    let switched = false;
    try { await page.waitForSelector('#' + r.tabId, { state: 'visible', timeout: 8000 }); } catch (_) {}
    for (let t = 0; t < 3 && !switched; t++) {
      try {
        const tab = await page.$('#' + r.tabId);
        if (tab && await tab.isVisible().catch(() => false)) {
          // 直接 DOM 点击，绕过遮挡判定
          await page.evaluate((id) => {
            const el = document.querySelector('#' + id);
            if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
          }, r.tabId).catch(() => {});
          switched = true;
          console.log('  ✓ 切换明细标签 #' + r.tabId + '（第' + (t + 1) + '次）');
        }
      } catch (_) {}
      if (!switched) {
        const txt = r.tabText || 'ASIN';
        const ok = await page.evaluate((t2) => {
          const heads = Array.from(document.querySelectorAll('.el-tabs__item, [role="tab"], .el-tabs__nav > div'));
          for (const h of heads) {
            if (h.offsetParent !== null && (h.textContent || '').trim() === t2) { h.click(); return true; }
          }
          for (const h of heads) {
            if (h.offsetParent !== null && (h.textContent || '').trim().includes(t2)) { h.click(); return true; }
          }
          return false;
        }, txt).catch(() => false);
        if (ok) { switched = true; console.log('  ✓ 按文字切换明细标签「' + txt + '」（第' + (t + 1) + '次）'); }
      }
      if (!switched) await page.waitForTimeout(900);
    }
    if (!switched) console.log('  ⚠ 未找到明细标签（#' + r.tabId + ' / 「' + (r.tabText || 'ASIN') + '」），若页面已是明细页可忽略');
    await page.waitForTimeout(1200);
  }

  // 3.5) 硬约束②：必须等切换到 ASIN 板块、且日期面板真正渲染出来，才允许找日期。
  //      弱网下切到 ASIN 后表格与工具栏仍在加载，若立刻找 .el-range-input 会找不到。
  //      这层等待对应「只有进入 ASIN 板块才开始寻找日期面板」。
  if (r.tabId || r.granularityText || r.timeGranularityText) {
    console.log('  → 已定位 ASIN / 明细板块，等待日期面板渲染就绪...');
    await waitForDateInputs(page, 45000);
  }

  // 4) 左侧「时间粒度」下拉（日期框旁边）：必须先设为「按天」，再操作日历。
  //    只有先切到按天，日期面板才是日视图，否则后续日历可能点不到具体日期。
  if (r.timeGranularityText) {
    console.log('  → 设置左侧时间粒度...');
    await setTimeGranularity(page, r);
  }

  // 4.5) 单选按钮型粒度（产品表现「日」、补货建议「父ASIN」）：应在选日期之前设置，
  //      等价于利润报表的左侧「时间粒度」，必须先切到目标视图再操作日历，避免点错视图。
  if (r.granularityMode === 'radio') {
    await setRadioGranularity(page, r);
  }

  // 5) 设置日期范围（补货建议等报表无日期控件，直接跳过）
  if (r.needsDateRange === false) {
    console.log('  → 该报表无需设置日期范围，跳过');
  } else {
    console.log('  → 设置日期范围...');
    await setRangeDays(page, r.days);
  }

  // 6) 右侧「展示粒度」下拉（导出按钮区域）：日期选完后，再选「按天展示」。
  //    注意：与左侧「时间粒度」是完全不同的两个下拉，不要混淆。
  //    仅利润报表的 select 型展示粒度走此步（产品表现/补货的单选粒度已在日期前处理）。
  if (r.granularityMode === 'select' && r.granularityText) {
    await setDisplayGranularity(page, r);
  }

  // 6.5) 防回退：切换右侧展示粒度可能让报表重渲染并把日期框重置；此处无聚焦地读取两输入框，
  //      若发现为空则重新设置日期范围（不依赖聚焦，避免触发日历控件重置）。仅 select 型适用。
  if (r.granularityMode === 'select' && r.granularityText) {
    const rangeStill = await page.evaluate(() => {
      const ins = document.querySelectorAll('.el-range-input');
      if (ins.length < 2) return false;
      const a = (ins[0].value || '').trim(), b = (ins[1].value || '').trim();
      return a.length > 0 && b.length > 0;
    }).catch(() => false);
    if (!rangeStill) {
      console.log('  ⚠ 切换粒度后日期框被重置，重新设置日期范围...');
      await setRangeDays(page, r.days);
    } else {
      console.log('  ✓ 切换粒度后日期范围仍有效');
    }
  }

  // 6) 店铺/视图筛选已在导出面板内由 exportSeq 处理，此处不再预点

  // 7) 页面特征校验（避免导出错页内容）—— 轮询等待表格渲染，避免页面加载慢导致误判
  const verifyText = Array.isArray(r.verifyText) ? r.verifyText : [];
  let ok = false;
  if (!verifyText.length) {
    console.log('  → 未配置页面特征校验词，跳过校验');
    ok = true;
  } else {
    for (let i = 0; i < 20; i++) {
      ok = await verifyPage(page, verifyText).catch(() => false);
      if (ok) break;
      await page.waitForTimeout(700);
    }
    if (!ok) {
      // 已按报表 URL 直达，页面身份可信；特征词未命中多半是领星表头文案与我预设不一致
      // （如「Sessions」写成「会话数」、或表头尚未完全渲染），不再阻塞暂停，直接警告后继续。
      console.log('  ⚠ 页面特征未命中（期望含: ' + verifyText.join('/') + '），但已按 URL 直达，页面身份可信，自动继续...');
    } else {
      console.log('  ✓ 页面特征校验通过');
    }
  }

  // 8) 按录制轨迹回放出导出处（下载图标→选店铺/模板→导出→立即下载）
  //    下载已由启动时 CDP 接管、直接写到磁盘（_lxTmpDir），与浏览器存活解耦；浏览器即使闪退，文件已在硬盘。
  const dlStart = Date.now();
  console.log('  → 已触发导出序列，CDP 正在把文件直写磁盘，等待落盘（浏览器闪退也不影响）...');
  const dlOk = await runExportSequence(page, r.exportSeq);

  // 9) 轮询磁盘：找出"本次导出后新落下的" xlsx（mtime 晚于触发时刻、大小稳定、且为合法 xlsx）→ 改名归位到目标文件名
  const dest = path.join(OUT_DIR, r.name + '.xlsx');
  let saved = false, src = null;
  for (let i = 0; i < 90; i++) {
    // 只扫 CDP 临时目录，绝不扫 OUT_DIR：否则会把上一轮刚复制好的目标文件
    // 当作"新下载"再次复制并 unlink，等于把自己删掉（曾出现「已保存 0 字节」丢文件）。
    src = pickNewestXlsx([dlTmpDir], dlStart);
    if (src && path.resolve(src) === path.resolve(dest)) { src = null; continue; } // 自我复制保护
    if (src) {
      const s1 = _sizeOf(src), s2 = await _sizeOfAfter(src, 400);
      if (s1 > 0 && s1 === s2 && isValidXlsx(src)) break; // 大小稳定且为合法 xlsx，认为写完
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (src && isValidXlsx(src) && path.resolve(src) !== path.resolve(dest)) {
    await withCopyLock(async () => {
      try { fs.copyFileSync(src, dest); try { fs.unlinkSync(src); } catch (_) {} } catch (e) { console.log('  ↳ 复制到目标失败:', e.message); }
      let sz = 0; try { sz = fs.statSync(dest).size; } catch (_) {}
      saved = sz > 0;
      console.log('  ✓ [' + r.name + '] 已保存 → ' + dest + ' (' + sz + ' 字节)');
    });
  }
  // 10) 兜底归位：若上述仍未保存（极可能是浏览器崩溃打断下载），扫描临时目录里本次新落下的
  //     合法 xlsx，若仅有一份则直接当作本报表归位，避免"文件已在硬盘却没改名"的丢失。
  if (!saved) {
    let candidates = [];
    try {
      candidates = (fs.existsSync(dlTmpDir) ? fs.readdirSync(dlTmpDir) : [])
        .filter((f) => /\.xlsx$/i.test(f) && (Date.now() - fs.statSync(path.join(dlTmpDir, f)).mtimeMs) < 600000)
        .map((f) => path.join(dlTmpDir, f))
        .filter(isValidXlsx);
    } catch (_) {}
    if (candidates.length === 1) {
      try { fs.copyFileSync(candidates[0], dest); saved = true; console.log('  ⚠ 兜底归位（浏览器可能中断，已据最新合法文件恢复）: ' + candidates[0] + ' → ' + dest); }
      catch (e) { console.log('  ↳ 兜底复制失败:', e.message); }
    }
  }
  if (!saved) {
    console.log('  ⚠ 未在等待窗口内确认保存（CDP 落盘可能失败，或导出未真正触发下载）。');
    console.log('    若页面仍在，可手动再点一次「立即下载」，文件会自动归位；或按回车继续');
    await pause('  手动导出后按回车继续（或 300s 后自动继续）...');
  }
  // 补货建议：无论走哪种归位路径，最终保存成功后统一删除「共享库存」行（用户固定需求）
  if (saved && r.name === '补货建议') {
    try {
      const n = cleanReplenishSharedRows(dest);
      console.log('  ↳ 已删除「共享库存」行: ' + n + ' 行');
    } catch (e) {
      console.log('  ⚠ 删除「共享库存」行失败:', e.message);
    }
  }
}

(async () => {
  // 全局兜底：任何未处理的异步拒绝 / 未捕获异常都只记录、绝不退出进程，
  // 否则浏览器一旦断开（notify 的 page.evaluate 等）会触发未处理拒绝而静默杀掉整脚本。
  process.on('unhandledRejection', (e) => {
    console.log('  ⚠ [未处理的异步拒绝，已忽略]:', String((e && e.message) || e).split('\n')[0]);
  });
  process.on('uncaughtException', (e) => {
    console.log('  ⚠ [未捕获异常，已忽略]:', String((e && e.message) || e).split('\n')[0]);
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 启动时清理上次可能残留的 _dl_ 临时文件（若仍被旧进程锁定则跳过，不阻塞）
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (/^_dl_\d+\.xlsx$/i.test(f)) { try { fs.unlinkSync(path.join(OUT_DIR, f)); } catch (_) {} }
    }
  } catch (_) {}
  // 清理 CDP 临时目录中超过 12 小时的残留下载（失败/中断运行留下的旧文件，避免与本次下载混淆）
  try {
    const lxTmp = path.join(process.env.LOCALAPPDATA || 'C:/Users/Administrator/AppData/Local', 'Temp', 'lx_auto');
    if (fs.existsSync(lxTmp)) {
      const cutoff = Date.now() - 12 * 3600 * 1000;
      for (const f of fs.readdirSync(lxTmp)) {
        if (!/\.xlsx$/i.test(f) && !/\.crdownload$/i.test(f)) continue;
        try { if (fs.statSync(path.join(lxTmp, f)).mtimeMs < cutoff) fs.unlinkSync(path.join(lxTmp, f)); } catch (_) {}
      }
    }
  } catch (_) {}
  const onlyKey = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
  const onlyKeys = onlyKey ? onlyKey.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (onlyKeys.length) console.log('[--only] 仅导出匹配「' + onlyKeys.join(' / ') + '」的报表');
  // 默认只导出未禁用（enabled !== false）的报表；--only 显式指定时可覆盖（如临时导出已停用的利润报表）
  const match = (r) => {
    if (onlyKeys.length) return onlyKeys.some((k) => r.key === k || r.name === k);
    return r.enabled !== false;
  };
  if (!onlyKeys.length) {
    const enabledNames = REPORTS.filter((r) => r.enabled !== false).map((r) => r.name);
    const disabledNames = REPORTS.filter((r) => r.enabled === false).map((r) => r.name);
    console.log('[默认导出] ' + enabledNames.join('、') + (disabledNames.length ? '（已停用: ' + disabledNames.join('、') + '）' : ''));
  }
  // 第一个需要导出的报表 URL：登录成功后立刻 navigate 过去，避免停留在会崩溃的 /erp/home 首页
  const firstTargetUrl = () => { for (const r of REPORTS) { if (match(r) && r.url) return r.url; } return null; };

  // 日期范围覆盖参数：--end=YYYY-MM-DD（截至该日的前 N 天）、--days=N（覆盖天数）、--range=START~END（显式区间）
  const argEnd = (process.argv.find((a) => a.startsWith('--end=')) || '').split('=')[1];
  const argDays = (process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1];
  const argRange = (process.argv.find((a) => a.startsWith('--range=')) || '').split('=')[1];
  const isValidDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));
  if (argDays && /^\d+$/.test(argDays)) { globalDaysOverride = parseInt(argDays, 10); console.log('[--days] 覆盖天数 = ' + globalDaysOverride); }
  if (argEnd) {
    if (isValidDateStr(argEnd)) { globalEndDate = argEnd; console.log('[--end] 自定义截止日 = ' + globalEndDate); }
    else console.log('  ⚠ [--end] 格式应为 YYYY-MM-DD，已忽略，回退默认（截至今天）');
  }
  if (argRange && argRange.includes('~')) {
    const [s, e] = argRange.split('~');
    if (isValidDateStr(s) && isValidDateStr(e)) {
      globalRangeStart = s; globalRangeEnd = e;
      console.log('[--range] 显式区间 = ' + s + ' ~ ' + e);
    } else console.log('  ⚠ [--range] 格式应为 START~END（YYYY-MM-DD），已忽略');
  }
  if (globalRangeStart && globalEndDate) { globalEndDate = null; console.log('  ⚠ [--range] 与 [--end] 同时指定，已优先采用 --range'); }

  // 统一的浏览器启动 + 下载接管辅助：设置持久化目录、页面监听、CDP 直写落盘（纯英文临时目录）
  async function openBrowser(h) {
    const _lxTmpDir = path.join(process.env.LOCALAPPDATA || 'C:/Users/Administrator/AppData/Local', 'Temp', 'lx_auto');
    dlTmpDir = _lxTmpDir;
    try { fs.mkdirSync(_lxTmpDir, { recursive: true }); } catch (_) {}

    const baseArgs = [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      '--js-flags=--max-old-space-size=4096,--stack-size=8192',
      '--disable-features=DownloadBubble,DownloadDragIcon',
    ];
    // 启动策略（按优先级逐一尝试，首个成功即用）：
    //   ① 系统 Chrome（channel 模式，Playwright 官方推荐，协议兼容最稳）
    //   ② 系统 Chrome（exe 路径兜底）
    //   ③ 系统 Edge（channel 模式）
    //   ④ 系统 Edge（exe 路径兜底）
    //   ⑤ Playwright 自带 Chromium（最后兜底，仍可能崩溃）
    // 系统浏览器与用户日常浏览器是不同进程/不同 profile，互不干扰；
    // 因自带 Chromium 渲染领星必崩而被优先绕过。
    const attempts = [];
    attempts.push({ label: 'Google Chrome (系统 channel)', profile: path.join(UHOME, '.lingxing_auto_chrome_profile'), opts: { headless: h, acceptDownloads: false, args: baseArgs, channel: 'chrome' } });
    if (fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe'))
      attempts.push({ label: 'Google Chrome (exe)', profile: path.join(UHOME, '.lingxing_auto_chrome_profile'), opts: { headless: h, acceptDownloads: false, args: baseArgs, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
    attempts.push({ label: 'Microsoft Edge (系统 channel)', profile: path.join(UHOME, '.lingxing_auto_edge_profile'), opts: { headless: h, acceptDownloads: false, args: baseArgs, channel: 'msedge' } });
    if (fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'))
      attempts.push({ label: 'Microsoft Edge (exe)', profile: path.join(UHOME, '.lingxing_auto_edge_profile'), opts: { headless: h, acceptDownloads: false, args: baseArgs, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } });
    attempts.push({ label: 'Playwright 内置 Chromium', profile: path.join(UHOME, '.lingxing_auto_profile'), opts: { headless: h, acceptDownloads: false, args: baseArgs } });

    let ctx = null, actualBrowser = '', actualProfile = USERDATA_DIR;
    for (const a of attempts) {
      try {
        ctx = await chromium.launchPersistentContext(a.profile, a.opts);
        actualBrowser = a.label;
        actualProfile = a.profile;
        break;
      } catch (e) {
        console.log('  ⚠ 启动 ' + a.label + ' 失败:', String(e.message).split('\n')[0]);
      }
    }
    if (!ctx) {
      console.log('  ✗ 所有浏览器候选均启动失败（系统 Chrome/Edge 与 Playwright Chromium 都不可用）。');
      console.log('    请确认系统已安装 Chrome 或 Edge，或重装 Playwright 浏览器；关闭本窗口后重新双击 bat。');
      process.exit(1);
    }
    USERDATA_DIR = actualProfile; // 让后续提示与持久化路径保持一致
    console.log('[浏览器] 实际使用:', actualBrowser, '| 配置目录:', actualProfile);

    const pg = ctx.pages()[0] || await ctx.newPage();
    pageRefGlobal = pg;
    pg.on('pageerror', (e) => console.log('  [页面脚本错误]', String(e.message).split('\n')[0]));
    pg.on('console', (m) => { if (m.type() === 'error') console.log('  [控制台错误]', String(m.text()).slice(0, 200)); });
    pg.on('crash', () => console.log('  [页面崩溃] Chromium 标签页异常终止（常见 Out of Memory），请检查系统内存或关闭其他高内存程序'));
    ctx.on('disconnected', () => console.log('[浏览器] 浏览器进程已断开（窗口被关闭 / 崩溃）'));
    try {
      const cdp = await ctx.newCDPSession(pg);
      global.cdpSession = cdp;
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: _lxTmpDir, eventsEnabled: true });
      // 监听 CDP 下载完成事件，第一时间把文件归位（即使后续浏览器断开也能保住文件）
      cdp.on('Browser.downloadProgress', (ev) => {
        if (ev && ev.state === 'completed') {
          try {
            const files = (fs.existsSync(_lxTmpDir) ? fs.readdirSync(_lxTmpDir) : [])
              .filter((f) => /\.xlsx$/i.test(f))
              .map((f) => path.join(_lxTmpDir, f))
              .filter((p) => isValidXlsx(p));
            if (files.length) {
              files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
              routeDownloadContext(files[0], currentExportTarget);
            }
          } catch (_) {}
        }
      });
    } catch (e) { console.log('  ⚠ CDP 下载接管初始化失败:', e.message); }
    return { context: ctx, page: pg };
  }

  // 默认有界面（GUI）：本机环境下无界面 headless 浏览器访问领星后台 API 会间歇性
  // ERR_CONNECTION_RESET / TIMED_OUT，导致登录后无法跳转到后台、菜单加载不出；
  // 而有界面浏览器网络正常。下载已通过 CDP 直写磁盘（acceptDownloads:false + setDownloadBehavior），
  // 有界面模式不会弹系统保存框崩溃，故默认用有界面最稳、也便于观察。
  // 仅当显式传 --headless 时才隐藏浏览器（用于已登录、纯导出、无需观察的场景）。
  const loginOnly = process.argv.includes('--login-only');
  const headless = process.argv.includes('--headless');
  console.log('[浏览器] 运行模式:', headless ? '无界面 --headless（导出时隐藏）' : '有界面（默认，可见可观察、网络最稳）');
  let { context, page } = await openBrowser(headless);
  function bindContextEvents(ctx) {
    ctx.on('close', () => console.log('[浏览器] 浏览器进程已断开（窗口被关闭）'));
  }
  bindContextEvents(context);
  const _dlTimer = setInterval(scanDownloadLocations, 2000);

  // ---------- 登录（手动，合规：不落密码；登录态由持久化配置复用）----------
  console.log('打开登录页:', LOGIN_URL);
  let navOk = false;
  for (let attempt = 1; attempt <= 3 && !navOk; attempt++) {
    try {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      navOk = true;
    } catch (e) {
      console.log('  ⚠ 第 ' + attempt + ' 次导航登录页失败:', String(e.message).split('\n')[0]);
      await page.waitForTimeout(1500);
    }
  }
  const curUrl = page.url();
  const curTitle = await page.title().catch(() => '');
  console.log('  导航后 URL:', curUrl, '| 页面标题:', curTitle);

  // 导航失败（停在 about:blank 等）多半是断网 / DNS / 代理 / VPN / 浏览器进程异常
  if (!/lingxing\.com/i.test(curUrl)) {
    console.log('  ✗ 页面未加载到领星域名（多半是断网 / DNS / 代理 / VPN 问题，或浏览器进程异常）。');
    console.log('    请先在你常用的浏览器里手动打开 https://erp.lingxing.com 确认能正常访问；');
    console.log('    排除网络 / VPN 后，关闭本窗口，重新双击 bat 运行。');
    notify(page, '页面未能加载领星，请检查网络后重跑脚本');
    await pause('  网络 / 导航异常，按回车退出...');
    try { await context.close(); } catch (_) {}
    process.exit(1);
  }

  // 判断是否需要登录：已登录时访问 login 页会由前端 SPA 异步跳回后台，
  // domcontentloaded 瞬间 url 仍是 login，若立刻判定会误把「有 cookie 的会话」当成未登录。
  // 故先等待最多 20 秒观察是否自动离开 login 域；离开则视为已登录（headless 不再误判）。
  let needsLogin = /login|passport|sso/i.test(curUrl);
  if (needsLogin) {
    const jumped = await page.waitForFunction(
      () => !/login|passport|sso/i.test(location.href),
      { timeout: 20000, polling: 1000 }
    ).then(() => true).catch(() => false);
    if (jumped) {
      console.log('  ✓ 访问登录页后已自动跳回后台，检测到有效会话，视为已登录');
      needsLogin = false;
    } else {
      console.log('  ⚠ 停留在登录页，确认需要登录');
    }
  }

  // 仅在领星域内判断是否需要登录，避免 about:blank 被误判为「已登录」
  if (needsLogin) {
    // 默认有界面时页面已在登录页，无需重导航；仅当显式 --headless 且未登录时，才弹出有界面浏览器登录
    let loginNavOk = !headless;
    if (headless) {
      console.log('★ 当前无界面模式未检测到登录态，即将弹出浏览器供你登录；登录成功后自动继续导出。');
      try { await context.close(); } catch (_) {}
      const gui = await openBrowser(false);
      context = gui.context; page = gui.page;
      pageRefGlobal = page;
      bindContextEvents(context);
      for (let attempt = 1; attempt <= 3 && !loginNavOk; attempt++) {
        try {
          await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
          const u = page.url();
          loginNavOk = /lingxing\.com/i.test(u) && !/^about:blank/i.test(u);
          if (!loginNavOk) console.log('  ⚠ 第 ' + attempt + ' 次导航后 URL 异常:', u);
        } catch (e) {
          console.log('  ⚠ 第 ' + attempt + ' 次导航登录页失败:', String(e.message).split('\n')[0]);
        }
        if (!loginNavOk) await page.waitForTimeout(1500);
      }
      if (!loginNavOk) {
        console.log('  ✗ 登录页始终未能加载（多半是断网 / DNS / 代理 / VPN / 浏览器进程异常）。');
        console.log('    请先在常用浏览器里手动打开 https://erp.lingxing.com 确认能正常访问；');
        console.log('    排除网络问题后，关闭本窗口，重新双击 bat 运行。');
        notify(page, '登录页加载失败，请检查网络或 VPN');
        await pause('  网络 / 导航异常，按回车退出...');
        try { await context.close(); } catch (_) {}
        process.exit(1);
      }
    }

    // 统一在【当前浏览器】等待用户登录（无论原本有界面，还是刚弹出的有界面）
    console.log('★ 请在浏览器中登录领星（含 MFA），并勾选「5天内免登录」。登录成功后脚本自动继续。');
    try {
      await page.waitForFunction(() => {
        const h = location.href;
        return !/^about:blank/i.test(h) && /lingxing\.com/i.test(h) && !/login|passport|sso/i.test(h);
      }, { timeout: 0, polling: 1000 });
    } catch (e) { console.log('  ⚠ 登录等待异常:', e.message); }
    console.log('✓ 登录成功，正在保存会话...');
    await page.waitForTimeout(3000);
    if (loginOnly) {
      try { await context.close(); } catch (_) {}
      console.log('[登录保存完成] 可以关闭此窗口，双击 lingxing_auto.bat 即可自动导出。');
      process.exit(0);
    }

    // 关键修复：登录后【不切回无界面、不重开浏览器】。
    // 本机无界面浏览器访问领星后台 API 会间歇性 ERR_CONNECTION_RESET / TIMED_OUT；
    // 刚完成登录的（有界面）浏览器网络是通的，直接沿用它继续导出最稳。
    // 下载已通过 CDP 直写磁盘（acceptDownloads:false + setDownloadBehavior），有界面不会弹系统保存框崩溃。
    console.log('✓ 沿用当前浏览器继续导出（网络已验证可用）...');
    // 关键修复：登录成功后立刻跳到第一个报表页，绝不待在会崩溃的 /erp/home 首页
    const fu = firstTargetUrl();
    if (fu) {
      console.log('  → 登录后直接跳转报表页（绕过首页）:', fu);
      try { await page.goto(fu, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { console.log('  ⚠ 跳转报表页失败:', String(e.message).split('\n')[0]); }
    }
    let shellOk = await waitForAppShell(page, 30000);
    if (!shellOk) {
      console.log('  ↳ 尝试重新加载页面以恢复资源...');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) {}
      shellOk = await waitForAppShell(page, 30000);
    }
    if (!shellOk) {
      console.log('  ✗ 后台框架始终未能加载（多半是网络 / 代理 / VPN 抖动）。');
      console.log('    请确认网络正常后，关闭本窗口，重新双击 lingxing_auto.bat 运行。');
      notify(page, '后台加载失败，请检查网络后重跑');
      await pause('  后台加载失败，按回车退出...');
      try { await context.close(); } catch (_) {}
      process.exit(1);
    }
    console.log('✓ 已自动登录，开始导出报表...');
  } else {
    console.log('✓ 已检测到有效登录会话，自动跳过登录步骤（无需重新输入）');
    // 已登录时同样先跳到第一个报表页，避免停留在会崩溃的 /erp/home 首页
    const fu2 = firstTargetUrl();
    if (fu2) {
      console.log('  → 已登录，直接跳转报表页（绕过首页）:', fu2);
      try { await page.goto(fu2, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { console.log('  ⚠ 跳转报表页失败:', String(e.message).split('\n')[0]); }
    }
    // SPA 后台框架可能尚未渲染完，等左侧导航就绪再导出，避免连锁失败
    const shellOk = await waitForAppShell(page, 30000);
    if (!shellOk) {
      console.log('  ↳ 尝试重新加载页面以恢复资源...');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) {}
      try { await page.waitForFunction(() => !/login|passport|sso/i.test(location.href), { timeout: 30000 }); } catch (e) {}
      await waitForAppShell(page, 30000);
    }
  }

  // 「仅登录」模式：登录态确认后立即保存到持久化配置并退出，绝不进入导出阶段。
  // 这样可避免任何后续的下载/导出异常导致 context 未正常 close、会话未落盘（过去反复要求重登的根因）。
  if (loginOnly) {
    console.log('✓ 登录态已确认，正在保存到本地配置（5天内免登录）...');
    await page.waitForTimeout(3000); // 留出时间让 Chromium 把 cookies 落盘到 USERDATA_DIR
    try { await context.close(); } catch (_) {}
    console.log('[登录保存完成] 可以关闭此窗口，双击 lingxing_auto.bat 即可自动导出。');
    process.exit(0);
  }

  // 偶发绑定手机中间页：出现就跳过
  for (let i = 0; i < 20; i++) {
    const url = page.url();
    if (!/bindMobile/i.test(url)) break;
    await clickText(page, '跳过，暂不绑定', 3000).catch(() => {});
    await clickText(page, '完成登录', 3000).catch(() => {});
    await page.waitForTimeout(1000);
  }
  console.log('✓ 登录成功，开始自动导出报表...');

  // ---------- 逐张导出 ----------
  for (const r of REPORTS) {
    if (!match(r)) continue;
    let exportErr = null;
    try { await exportOne(page, r); }
    catch (e) { exportErr = e; console.log('  ✗ [' + r.name + '] 处理异常:', e.message); }
    // 即使 exportOne 内部异常（如浏览器断开），也尝试从 CDP 临时目录恢复本次下载
    if (exportErr) {
      try {
        const dest = path.join(OUT_DIR, r.name + '.xlsx');
        let candidates = (fs.existsSync(dlTmpDir) ? fs.readdirSync(dlTmpDir) : [])
          .filter((f) => /\.xlsx$/i.test(f) && (Date.now() - fs.statSync(path.join(dlTmpDir, f)).mtimeMs) < 600000)
          .map((f) => path.join(dlTmpDir, f))
          .filter(isValidXlsx);
        if (candidates.length === 1) {
          fs.copyFileSync(candidates[0], dest);
          console.log('  ⚠ 异常兜底归位（浏览器可能中断，已据最新合法文件恢复）[' + r.name + ']: ' + candidates[0] + ' → ' + dest);
        } else if (candidates.length > 1) {
          // 多份文件时，按修改时间取最新
          candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
          fs.copyFileSync(candidates[0], dest);
          console.log('  ⚠ 异常兜底归位（取最新文件）[' + r.name + ']: ' + candidates[0] + ' → ' + dest);
        }
      } catch (_) {}
    }
  }

  clearInterval(_dlTimer);
  console.log('\n===== 全部报表处理完毕 =====');
  console.log('目标目录:', OUT_DIR);
  // 列出实际已落盘的文件（含绝对路径），方便用户直接定位；只列本次匹配（启用）的报表 + 我的ASIN
  const expectNames = [...REPORTS.filter((r) => match(r)).map((r) => r.name), '我的ASIN'];
  for (const n of expectNames) {
    const fp = path.join(OUT_DIR, n + '.xlsx');
    const ex = fs.existsSync(fp);
    console.log('  ' + (ex ? '✓' : '·') + ' ' + n + '.xlsx → ' + fp + (ex ? '  (' + fs.statSync(fp).size + ' 字节)' : '  (未生成)'));
  }
  // 清理 OUT_DIR 内残留的 _dl_ 临时文件（若仍被旧进程锁定则跳过）
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (/^_dl_\d+\.xlsx$/i.test(f)) { try { fs.unlinkSync(path.join(OUT_DIR, f)); console.log('  ↳ 已清理残留临时文件:', f); } catch (_) {} }
    }
  } catch (_) {}
  console.log('请在黑色窗口按任意键关闭（或直接关闭浏览器窗口）。');
  await pause('按回车结束...');
  try { await context.close(); } catch (_) {}
  process.exit(0);
})().catch((e) => {
  console.error('脚本异常:', e);
  console.log('若窗口消失，请查看同目录 export_debug.log；或把黑色窗口文字发我。');
  setTimeout(() => process.exit(1), 3000);
});
