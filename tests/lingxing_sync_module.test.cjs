const { chromium } = require('playwright');

const dashboardUrl = process.env.DASHBOARD_URL || 'http://127.0.0.1:4173/dashboard.html';
const screenshotDir = process.env.SCREENSHOT_DIR || '/private/tmp';
const bridgeOrigin = 'http://127.0.0.1:8765';
const pairKey = 'test-pairing-key-1234567890';
const cloudUploadedAt = '2026-08-20T02:47:23Z';
const apiSyncedAt = '2026-08-22T09:30:00Z';

const cases = [
  { name: 'desktop', viewport: { width: 1440, height: 1000 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
];

function dataRecord(name, date) {
  return {
    date, pasin: 'B0PARENT01', asin: 'B0API00001', name,
    sales: 120, orders: 4, units: 5, sessions: 30, naturalOrders: 2,
    gross: 32, refund: 0, impr: 1000, clicks: 22, natClicks: 12,
    adSpend: 20, adSales: 60, adUnits: 2, adOrders: 2, cpc: 2, cols: {},
  };
}

function dashboardData(name, date) {
  return {
    perf: { detail: [dataRecord(name, date)] },
    stock: [{ asin: 'B0API00001', sku: 'SKU-API', name, avail: 18, daily: { d7: 2 } }],
    ad: { detail: [{ date, pasin: 'B0PARENT01', asin: 'B0API00001', name, spend: 20, sales: 60, orders: 2 }] },
    profit: { detail: [{ date, pasin: 'B0PARENT01', asin: 'B0API00001', name, sales: 120, gross: 32, units: 5 }] },
    searchTerms: [],
    promo: null,
    track: null,
  };
}

const cloudData = dashboardData('云端基线商品', '2026-08-20');
const apiData = dashboardData('领星 API 商品', '2026-08-22');
const counts = { performance: 1, stock: 1, ads: 1, profit: 1 };

function rectObject(rect) {
  return rect && {
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    right: rect.right, bottom: rect.bottom,
  };
}

function overlaps(a, b) {
  return Boolean(a && b && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];

  for (const item of cases) {
    const context = await browser.newContext({ viewport: item.viewport, locale: 'zh-CN' });
    const page = await context.newPage();
    const pageErrors = [];
    const syncPayloads = [];

    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('console', message => {
      if (message.type() === 'error') pageErrors.push('console: ' + message.text());
    });
    await page.addInitScript(({ key }) => {
      sessionStorage.setItem('wb_amz_zk_unlocked', '1');
      sessionStorage.setItem('wb_amz_zk_lingxingBridgeKey', key);
    }, { key: pairKey });

    await page.route('**/cloud-status.json*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ uploadedAt: cloudUploadedAt, refreshedAt: cloudUploadedAt, count: 2, files: [] }),
    }));
    await page.route('**/amz-data.json*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cloudData),
    }));
    await page.route(bridgeOrigin + '/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const corsHeaders = {
        'Access-Control-Allow-Origin': new URL(dashboardUrl).origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-AMZ-Bridge-Key',
        'Access-Control-Allow-Private-Network': 'true',
        'Cache-Control': 'no-store',
      };
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: corsHeaders, body: '' });
        return;
      }
      if (request.headers()['x-amz-bridge-key'] !== pairKey) {
        await route.fulfill({
          status: 401,
          headers: corsHeaders,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, code: 'PAIRING_REQUIRED', message: '配对码无效' }),
        });
        return;
      }
      if (url.pathname === '/api/status') {
        await route.fulfill({
          status: 200,
          headers: corsHeaders,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true, connectorVersion: '1', credentialsConfigured: true,
            busy: false, dataReady: true, syncedAt: apiSyncedAt,
            sourceType: 'lingxing-openapi', counts,
          }),
        });
        return;
      }
      if (url.pathname === '/api/test') {
        await route.fulfill({
          status: 200,
          headers: corsHeaders,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true, message: '领星鉴权与店铺读取成功',
            sellerCount: 5, selectedSellerCount: 3,
          }),
        });
        return;
      }
      if (url.pathname === '/api/sync') {
        syncPayloads.push(request.postDataJSON());
        await route.fulfill({
          status: 200,
          headers: corsHeaders,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true, message: '领星数据已同步到本机看板',
            days: 7, datasets: ['performance', 'stock'], published: false,
            syncedAt: apiSyncedAt, sourceType: 'lingxing-openapi', counts,
          }),
        });
        return;
      }
      if (url.pathname === '/api/data') {
        await route.fulfill({
          status: 200,
          headers: corsHeaders,
          contentType: 'application/json',
          body: JSON.stringify(apiData),
        });
        return;
      }
      await route.fulfill({
        status: 404,
        headers: corsHeaders,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, message: 'not found' }),
      });
    });

    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const syncNav = item.name === 'mobile'
      ? page.locator('#bottomNav .bn-item[data-tab="sync"]')
      : page.locator('.sb-item[data-tab="sync"]');
    await syncNav.click();
    await page.locator('#panel-sync.active #lingxingApiModule').waitFor({ state: 'visible' });

    await page.locator('#lxTestBtn').click();
    await page.waitForFunction(() => {
      const badge = document.getElementById('lxApiBadgeText');
      return badge && badge.textContent === '接口正常';
    });

    await page.locator('#lxDays').fill('7');
    await page.locator('#lxSyncBtn').click();
    await page.waitForFunction(() => {
      const badge = document.getElementById('lxApiBadgeText');
      return badge && badge.textContent === '数据已载入';
    });

    const beforeCloudCheck = await page.evaluate(() => {
      const lastSync = JSON.parse(localStorage.getItem('wb_amz_zk_lastSync'));
      const perf = JSON.parse(localStorage.getItem('wb_amz_zk_perf'));
      return {
        lastSync,
        name: perf.detail[0].name,
        uploadedAt: JSON.parse(localStorage.getItem('wb_amz_zk_cloudUploadedAt')),
        pairInLocalStorage: localStorage.getItem('wb_amz_zk_lingxingBridgeKey'),
        pairInSessionStorage: sessionStorage.getItem('wb_amz_zk_lingxingBridgeKey'),
      };
    });

    await page.evaluate(() => syncFromCloud(true));
    const afterCloudCheck = await page.evaluate(() => {
      const lastSync = JSON.parse(localStorage.getItem('wb_amz_zk_lastSync'));
      const perf = JSON.parse(localStorage.getItem('wb_amz_zk_perf'));
      return { main: lastSync.main, name: perf.detail[0].name };
    });

    const metrics = await page.evaluate(() => {
      const toObject = rect => rect && ({
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        right: rect.right, bottom: rect.bottom,
      });
      const module = document.getElementById('lingxingApiModule');
      const actions = Array.from(document.querySelectorAll('#lingxingApiModule .lx-actions .lx-btn'));
      const keyInput = document.getElementById('lxBridgeKey');
      return {
        module: toObject(module.getBoundingClientRect()),
        actions: actions.map(button => toObject(button.getBoundingClientRect())),
        moduleFits: module.scrollWidth <= module.clientWidth,
        pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        buttonsFit: actions.every(button => button.scrollWidth <= button.clientWidth),
        keyType: keyInput.type,
        topLabel: document.getElementById('cloudBadgeLabel').textContent,
        statusTitle: document.getElementById('lxApiStatusTitle').textContent,
        appSecretInputs: Array.from(module.querySelectorAll('input')).filter(input => /secret|appid/i.test(input.id + input.name)).length,
      };
    });

    const actionOverlap = metrics.actions.some((a, index) =>
      metrics.actions.slice(index + 1).some(b => overlaps(a, b))
    );
    const failures = [];
    if (syncPayloads.length !== 1) failures.push('未精确触发一次 API 同步');
    if (syncPayloads[0] && (syncPayloads[0].days !== 7 || syncPayloads[0].publish !== false)) failures.push('同步参数不符合界面选择');
    if (beforeCloudCheck.lastSync.main !== '领星 API') failures.push('本机 API 数据源状态未保存');
    if (beforeCloudCheck.name !== '领星 API 商品') failures.push('API 数据未载入看板缓存');
    if (beforeCloudCheck.uploadedAt !== apiSyncedAt) failures.push('顶部数据更新时间未更新');
    if (beforeCloudCheck.pairInLocalStorage !== null) failures.push('配对码错误写入 localStorage');
    if (beforeCloudCheck.pairInSessionStorage !== pairKey) failures.push('当前会话配对码丢失');
    if (afterCloudCheck.main !== '领星 API' || afterCloudCheck.name !== '领星 API 商品') failures.push('旧云端快照回滚了较新的本机 API 数据');
    if (!metrics.moduleFits || !metrics.pageFits || !metrics.buttonsFit) failures.push('领星模块存在内容溢出');
    if (actionOverlap) failures.push('领星模块按钮重叠');
    if (metrics.keyType !== 'password') failures.push('配对码输入未默认隐藏');
    if (metrics.topLabel !== '领星 API 数据') failures.push('顶部数据源标签未切换');
    if (metrics.appSecretInputs) failures.push('公开网页出现领星凭证输入框');
    if (pageErrors.length) failures.push('页面存在脚本错误');

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(80);
    const viewportMetrics = await page.evaluate(() => {
      const toObject = rect => ({
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        right: rect.right, bottom: rect.bottom,
      });
      return {
        module: toObject(document.getElementById('lingxingApiModule').getBoundingClientRect()),
        topbar: toObject(document.querySelector('.topbar').getBoundingClientRect()),
        stickyBandDisplay: getComputedStyle(document.querySelector('.sticky-band')).display,
      };
    });
    if (overlaps(viewportMetrics.module, viewportMetrics.topbar)) failures.push('首屏顶部栏遮挡领星模块');
    if (item.name === 'mobile' && viewportMetrics.stickyBandDisplay !== 'none') failures.push('移动同步页仍展示无关置顶带');

    const screenshot = screenshotDir + '/amz-zk-lingxing-' + item.name + '.png';
    await page.screenshot({ path: screenshot, fullPage: false });
    results.push({
      name: item.name,
      syncPayloads,
      beforeCloudCheck,
      afterCloudCheck,
      metrics,
      viewportMetrics,
      pageErrors,
      failures,
      screenshot,
    });
    await context.close();
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => result.failures.length)) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
