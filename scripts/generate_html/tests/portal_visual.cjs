// Compare images rendered from pinned forecast code and the candidate in the same Edge.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {execFileSync} = require('node:child_process');
const {once} = require('node:events');
const {startFixture} = require('./start_forecast_fixture.cjs');
const playwright = process.env.PLAYWRIGHT_MODULE || path.resolve(__dirname, '../../../.test_runtime/node_modules/playwright');
const {chromium} = require(playwright);
const {PNG} = require(require.resolve('pngjs', {paths: [path.dirname(require.resolve(playwright))]}));
const root = path.resolve(__dirname, '../../..');
const refs = require('./portal_visual_refs.json');

function checkReference(dir, revision, checkedPaths) {
  const git = args => execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8'}).trim();
  assert.equal(git(['rev-parse', 'HEAD']), revision, 'Unexpected visual reference in ' + dir);
  assert.equal(git(['status', '--porcelain', '--', ...checkedPaths]), '', 'Reference has local edits in ' + dir);
}

async function capture(browser, gateway, fixtureOrigin, output, label, live) {
  const context = await browser.newContext({viewport: {width: 1600, height: 900}, deviceScaleFactor: 1,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block'});
  try {
    if (live) {
      // The operator's gateway stays online. Only this browser context gets synthetic data.
      await context.route(gateway + '/forecast/**', async route => {
        const url = new URL(route.request().url());
        const response = await route.fetch({url: fixtureOrigin + url.pathname + url.search});
        await route.fulfill({response});
      });
    }
    const page = await context.newPage();
    await page.goto(gateway + '/#/app/forecast');
    const iframe = page.locator('iframe[data-app="forecast"]');
    await iframe.waitFor();
    const frame = page.frameLocator('iframe[data-app="forecast"]');
    const mark = '.topbar > .brand > .brand-mark';
    await frame.locator('.brand strong').waitFor();
    assert.equal(await frame.locator(mark).isVisible(), false, 'PlanHub title should omit the forecast icon');
    const standalone = await context.newPage();
    try {
      await standalone.goto(fixtureOrigin + '/forecast/');
      await standalone.locator(mark).waitFor({state:'visible'});
    } finally { await standalone.close(); }
    const model = frame.getByRole('combobox', {name:'预测车型', exact:true});
    await model.waitFor();
    assert.equal((await model.locator('option:checked').textContent()).trim(), '测试车型 A');
    await frame.locator('[data-forecast-nav="launch"]').click();
    await frame.locator('[data-forecast-stage-pane="launch"].active').waitFor();
    // Capture when all styles, fonts, and the post-layout responsive menu have settled.
    for (const [name, width, height, focus] of [['desktop',1600,900,false], ['mobile',390,844,false], ['focus',1600,900,true]]) {
      await page.setViewportSize({width,height});
      const doc = await (await iframe.elementHandle()).contentFrame();
      await doc.waitForFunction(() => document.querySelector('#forecastNavParameters').open === (innerWidth >= 1280));
      await frame.locator('[data-forecast-nav="launch"]').evaluate(el => el.blur());
      await model.evaluate(el => el.blur());
      if (focus) {
        await model.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        assert(await model.evaluate(el => el.matches(':focus-visible') && document.activeElement === el));
      }
      await doc.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const box = await iframe.boundingBox();
      const nav = await frame.locator('.module-bar').boundingBox();
      assert(box && nav && nav.y >= box.y && box.width > 240, 'Forecast header is outside the real portal frame');
      await page.screenshot({path:path.join(output, label + '-' + name + '.png'), animations:'disabled',
        caret:'hide', clip:{x:box.x, y:box.y, width:box.width, height:Math.ceil(nav.y + nav.height - box.y)}});
    }
  } finally { await context.close(); }
}

function compare(output, name) {
  const read = label => PNG.sync.read(fs.readFileSync(path.join(output,label + '-' + name + '.png')));
  const expected = read('expected'), actual = read('actual');
  const width = Math.max(expected.width,actual.width), height = Math.max(expected.height,actual.height);
  const diff = new PNG({width,height});
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y*width+x)*4, a = (y*actual.width+x)*4, e = (y*expected.width+x)*4;
      const outside = x>=actual.width || x>=expected.width || y>=actual.height || y>=expected.height;
      const changedPixel = outside || [0,1,2].some(c => Math.abs(actual.data[a+c]-expected.data[e+c])>12);
      if (changedPixel) changed++;
      const gray = outside ? 240 : 180 + Math.round(actual.data[a] * 0.25);
      diff.data.set(changedPixel ? [220,25,60,255] : [gray,gray,gray,255],index);
    }
  }
  if (changed) fs.writeFileSync(path.join(output,'diff-' + name + '.png'), PNG.sync.write(diff));
  return {name, changed, expected: [expected.width,expected.height], actual: [actual.width,actual.height]};
}

// A 1px navigation divider or a lost focus border must fail the visual gate.
function verifyComparator() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forecast-image-test-'));
  try {
    const image = new PNG({width:32,height:16});
    image.data.fill(255);
    const write = (side, img) => fs.writeFileSync(path.join(dir, side + '-test.png'), PNG.sync.write(img));
    write('expected', image);
    write('actual', image);
    assert.equal(compare(dir, 'test').changed, 0);
    for (let x=0; x<image.width; x++) image.data.fill(64, x*4, x*4+3);
    write('actual', image);
    assert.equal(compare(dir, 'test').changed, 32);
    const diff = PNG.sync.read(fs.readFileSync(path.join(dir, 'diff-test.png')));
    assert.deepEqual([...diff.data.subarray(0,4)], [220,25,60,255]);
    write('actual', new PNG({width:33,height:16}));
    assert(compare(dir, 'test').changed > 0);
  } finally { fs.rmSync(dir,{recursive:true, force:true}); }
}

async function main() {
  verifyComparator();
  const baseline = process.env.FORECAST_VISUAL_BASELINE || path.join(root,'.test_runtime','visual-baseline');
  const portal = process.env.PLANHUB_TEST_ROOT || path.join(root,'..','计划工作台');
  const output = path.resolve(process.env.FORECAST_SCREENSHOTS || path.join(root,'.test_outputs','portal-visual'));
  checkReference(baseline, refs.forecast, ['scripts/generate_html']);
  checkReference(portal, refs.portal, ['scripts','portal','integration']);
  fs.mkdirSync(output, {recursive:true});
  const live = process.env.PLANHUB_TEST_LIVE_URL;
  if (live) assert.equal(live, 'http://127.0.0.1:4173', 'Use the local portal address for live checks.');
  const {createServer} = await import(pathToFileURL(path.join(portal,'scripts/dev-server.mjs')).href);
  const {applications} = JSON.parse(fs.readFileSync(path.join(portal, 'integration/apps.json'), 'utf8'));
  const app = {...applications.forecast};
  const server = live ? null : createServer({root:portal, localPreview:true, applications:{forecast:app}});
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    if (server) {
      server.listen(Number(process.env.PLANHUB_TEST_PORT || 4173), '127.0.0.1');
      await once(server, 'listening');
    }
    const gateway = live || 'http://127.0.0.1:' + server.address().port;
    for (const [label, code] of [['expected',baseline],['actual',root]]) {
      const service = await startFixture(path.join(code,'scripts','generate_html'));
      try {
        app.target = service.origin;
        await capture(browser, gateway, service.origin, output, label, live);
      } finally { await service.close(); }
    }
    const results = ['desktop','mobile','focus'].map(name => compare(output,name));
    assert(results.every(r => r.changed === 0), 'Header visual regression: ' + JSON.stringify(results));
    console.log('PASS real PlanHub ' + gateway + ' desktop/mobile/keyboard headers match ' + refs.forecast.slice(0,8));
  } finally {
    await browser.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}

main().catch(error => { console.error(error); process.exitCode=1; });
