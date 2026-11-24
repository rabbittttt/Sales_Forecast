// Default: check the generated static report. --portal-fixture: run the isolated CI scenario.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE ||
  path.resolve(__dirname, '../../../.test_runtime/node_modules/playwright'));
const {startFixture} = require('./start_forecast_fixture.cjs');

async function openPortal(browser, origin, errors) {
  const context = await browser.newContext({
    viewport: {width: 1440, height: 900}, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('pageerror', e => {errors.push(e.message); console.error(e.stack);});
  await page.route(origin + '/portal/', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0}iframe{display:block;width:100%;height:100vh;border:0}</style><iframe title="销量预测" src="/forecast/?forecastStage=launch&forecastView=result"></iframe>',
  }));
  await page.goto(origin + '/portal/');
  const frame = page.frames().find(f => f.url().startsWith(origin + '/forecast/'));
  assert(frame, 'Expected the forecast page in the portal iframe.');
  await frame.locator('[data-forecast-nav="launch"][aria-current="page"]').waitFor();
  await frame.locator('[data-forecast-import="launch"] [data-forecast-import-status]').filter({hasText:'尚无共享导入'}).waitFor();
  return {context, page, frame};
}

async function checkLayout(page, frame, {singleCampaign}) {
  const model = frame.getByRole('combobox', {name: '预测车型', exact: true});
  const parameterMenu = frame.locator('#forecastNavParameters');
  for (const width of [1440, 1280, 1024, 768, 390, 320]) {
    await page.setViewportSize({width, height: 900});
    const wide = width >= 1280;
    await frame.waitForFunction(wide => document.querySelector('#forecastNavParameters').open === wide, wide);
    assert(await model.isVisible());
    assert.equal(await frame.locator('#updatedAt').isVisible(), width > 1000);
    assert.equal(await frame.locator('#grainSelect').isVisible(), false);
    const period = frame.locator('#periodSelect');
    if (singleCampaign) assert(await period.isDisabled());
    assert.equal(await period.isVisible(), !await period.isDisabled());
    const layout = await frame.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      return {
        viewport: innerWidth, scroll: document.documentElement.scrollWidth,
        subjectRight: rect('#subjectSelect').right, paramsLeft: rect('#forecastNavParameters').left,
        paramsRight: rect('#forecastNavParameters').right, resetRight: rect('[data-forecast-reset]').right,
        stagesTop: rect('#moduleNav').top, modelBottom: rect('#subjectSelect').bottom,
      };
    });
    assert(layout.scroll <= width + 1 && layout.viewport === width, JSON.stringify(layout));
    assert(layout.subjectRight <= layout.paramsLeft + 1 && layout.modelBottom <= layout.stagesTop + 1, JSON.stringify(layout));
    assert(Math.abs(layout.paramsRight - layout.resetRight) <= 1, JSON.stringify(layout));

    if (!wide) await parameterMenu.locator('summary').click();
    const tier = frame.locator('[data-forecast-target="tier"]');
    const keyboardStyle = async locator => {
      await locator.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      return locator.evaluate(el => {
        const s = getComputedStyle(el);
        if (document.activeElement !== el || !el.matches(':focus-visible')) throw Error('Keyboard focus did not return to field.');
        return [s.height, s.padding, s.borderRadius, s.fontSize, s.backgroundColor, s.outlineStyle, s.outlineColor, s.outlineOffset, s.boxShadow];
      });
    };
    const normalStyle = locator => locator.evaluate(el => {
      el.blur();
      const s = getComputedStyle(el);
      return [s.height, s.padding, s.border, s.borderRadius, s.backgroundColor, s.fontSize];
    });
    assert.deepEqual(await normalStyle(model), await normalStyle(tier));
    const tierStyle = await keyboardStyle(tier);
    if (!wide) await tier.press('Escape');
    const modelStyle = await keyboardStyle(model);
    assert.deepEqual(modelStyle, tierStyle);
    assert.equal(modelStyle[2], '6px');
    assert.equal(modelStyle[5], 'solid');
    assert.equal(modelStyle[7], '-2px');
    assert.equal(modelStyle[8], 'none');
    if (singleCampaign && process.env.FORECAST_SCREENSHOTS && [1440,390].includes(width)) {
      fs.mkdirSync(process.env.FORECAST_SCREENSHOTS, {recursive:true});
      const area = await frame.locator('.module-bar').boundingBox();
      await page.screenshot({path: path.join(process.env.FORECAST_SCREENSHOTS, 'header-'+width+'.png'),
        clip: {x: 0, y: 0, width, height: Math.ceil(area.y + area.height)}});
    }
  }
  await page.setViewportSize({width: 1440, height: 900});
  for (const stage of ['small','steady','launch']) {
    await frame.locator('[data-forecast-nav="'+stage+'"]').click();
    await frame.locator('[data-forecast-stage-pane="'+stage+'"].active').waitFor();
    for (const view of ['evidence','score','result']) {
      const tab = frame.locator('#forecastHeaderTools [data-forecast-tab="'+view+'"]');
      await tab.click();
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
    }
  }
}

async function checkDiagnostic({frame}) {
  // Capture the copy request inside this test page; leave the OS clipboard alone.
  await frame.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {value: {
      writeText: async value => { window.copiedForecastDiagnostic = value; },
    }});
  });
  const menu = frame.locator('.forecast-header-menu');
  await menu.locator(':scope > summary').click();
  const info = menu.locator('[data-live-diagnostic]');
  await info.waitFor();
  const diagnostic = await info.textContent();
  for (const field of ['后台状态','刷新原因','当前显示','template-v1','fixture-v1']) {
    assert(diagnostic.includes(field), diagnostic);
  }
  const copy = menu.locator('[data-copy-live-diagnostic]');
  await copy.click();
  await frame.waitForFunction(() => document.querySelector('[data-copy-live-diagnostic]').textContent === '已复制');
  assert.equal(await frame.evaluate(() => window.copiedForecastDiagnostic), diagnostic);
  await menu.locator(':scope > summary').click();
}

async function checkSharedImport(writer, reader) {
  let requests = 0;
  reader.page.on('request', req => {if (new URL(req.url()).pathname === '/forecast/api/status') requests++;});
  await reader.page.locator('iframe').evaluate(el => {el.style.display='none';});
  const panel = writer.frame.locator('[data-forecast-import="launch"]');
  const manager = panel.locator('.forecast-import-manager');
  if (!await manager.evaluate(n => n.open)) await manager.locator('summary').click();
  const upload = writer.page.waitForRequest(req => req.method() === 'POST' && req.url().includes('/api/imports?'));
  await panel.locator('[data-forecast-import-file]').setInputFiles({
    name:'fixture.csv', mimeType:'text/csv', buffer:Buffer.from('车型（代际）,日期,预测大定\n测试车型 A,2026-11-14,123.5\n'),
  });
  const post = await upload;
  await panel.locator('[data-forecast-import-status]').filter({hasText:'已共享'}).waitFor();
  const stored = await (await writer.page.request.get(post.url())).json();
  assert.equal(stored.record.rows[0].quantity, 123.5);
  // Permit the hide observer to settle, then exercise two complete poll intervals.
  await new Promise(resolve => setTimeout(resolve, 300));
  const hiddenStart = requests;
  await new Promise(resolve => setTimeout(resolve, 31000));
  assert.equal(requests, hiddenStart, 'A hidden portal module polled the forecast status.');
  await reader.page.locator('iframe').evaluate(el => {el.style.display='';});
  const result = reader.frame.locator('[data-forecast-import="launch"] [data-forecast-import-result]');
  await result.filter({hasText:'124'}).waitFor({timeout:20000});
  assert(requests > hiddenStart, 'Restoring the iframe must resume polling.');
  await reader.page.reload();
  await reader.page.frameLocator('iframe').locator('[data-forecast-import="launch"] [data-forecast-import-result]').filter({hasText:'124'}).waitFor();
}

(async () => {
  const browser = await chromium.launch({headless:true, channel:process.env.FORECAST_TEST_BROWSER || 'msedge'});
  try {
    if (!process.argv.includes('--portal-fixture')) {
      const page = await browser.newPage({viewport:{width:1440,height:900}});
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      const file = process.env.FORECAST_HTML || path.resolve(__dirname, '../../../output_file/static/鸿蒙智行销量预测.html');
      await page.goto(pathToFileURL(file).href);
      await page.locator('.forecast-workspace').waitFor();
      await checkLayout(page, page.mainFrame(), {singleCampaign:false});
      const decision = page.locator('[data-forecast-decision-chart="parameter"]');
      assert(!(await decision.textContent()).includes('退订率'));
      assert(await page.locator('[data-forecast-progress-actual-small]').count());
      assert.deepEqual(errors, []);
      console.log('PASS generated static page, responsive controls and three forecast stages');
      return;
    }
    const server = await startFixture();
    try {
      const errors = [];
      const writer = await openPortal(browser, server.origin, errors);
      await checkLayout(writer.page, writer.frame, {singleCampaign:true});
      await checkDiagnostic(writer);
      const reader = await openPortal(browser, server.origin, errors);
      await checkSharedImport(writer, reader);
      assert.deepEqual(errors, []);
      console.log('PASS embedded responsive navigation, keyboard focus, independent shared import and hidden iframe polling');
    } finally { await server.close(); }
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode=1;});
