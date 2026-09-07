const { chromium } = require('playwright');

const dashboardUrl = process.env.DASHBOARD_URL || 'http://127.0.0.1:4173/dashboard.html';
const screenshotDir = process.env.SCREENSHOT_DIR || '/private/tmp';

const cases = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
];

const sampleData = {
  perf: {
    detail: [{
      date: '2026-08-19', pasin: 'PARENT', asin: 'B0TEST', name: '测试商品',
      sales: 100, orders: 1, units: 1, sessions: 10, naturalOrders: 1,
      gross: 20, refund: 0, impr: 100, clicks: 10, natClicks: 5,
      adSpend: 10, adSales: 20, adUnits: 1, adOrders: 1, cpc: 1, cols: {},
    }],
  },
  stock: [],
  ad: { detail: [] },
  profit: { detail: [] },
  searchTerms: [],
  promo: null,
  track: null,
};

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
    const uploadedAt = '2026-08-19T16:31:22Z';

    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('console', message => {
      if (message.type() === 'error') pageErrors.push('console: ' + message.text());
    });
    await page.addInitScript(() => {
      sessionStorage.setItem('wb_amz_zk_unlocked', '1');
    });
    await page.route('**/cloud-status.json*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ uploadedAt, refreshedAt: uploadedAt, count: 2, files: [] }),
    }));
    await page.route('**/amz-data.json*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleData),
    }));

    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => {
      const element = document.getElementById('cloudBadgeText');
      return element && element.textContent.includes('更新于');
    }, null, { timeout: 15000 });

    const metrics = await page.evaluate(() => {
      const toObject = rect => rect && ({
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        right: rect.right, bottom: rect.bottom,
      });
      const module = document.getElementById('cloudUpdateModule');
      const text = document.getElementById('cloudBadgeText');
      const brand = document.querySelector('.brand');
      const refresh = document.getElementById('btnRefresh');
      return {
        text: text.textContent,
        className: module.className,
        module: toObject(module.getBoundingClientRect()),
        brand: toObject(brand.getBoundingClientRect()),
        refresh: toObject(refresh.getBoundingClientRect()),
        topbarHeight: document.querySelector('.topbar').getBoundingClientRect().height,
        moduleFits: module.scrollWidth <= module.clientWidth,
        textFits: text.scrollWidth <= text.clientWidth,
      };
    });
    metrics.overlapBrand = overlaps(metrics.module, metrics.brand);
    metrics.overlapRefresh = overlaps(metrics.module, metrics.refresh);

    const failures = [];
    if (!metrics.text.startsWith('更新于 ')) failures.push('未展示更新时间');
    if (!metrics.className.includes('is-ready')) failures.push('同步成功状态缺失');
    if (!metrics.moduleFits || !metrics.textFits) failures.push('模块内容溢出');
    if (metrics.overlapBrand || metrics.overlapRefresh) failures.push('顶部元素重叠');
    if (pageErrors.length) failures.push('页面存在脚本错误');

    const screenshot = screenshotDir + '/amz-zk-' + item.name + '.png';
    await page.screenshot({ path: screenshot, fullPage: false });
    results.push({ name: item.name, metrics, pageErrors, failures, screenshot });
    await context.close();
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => result.failures.length)) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
