// Verify the generated standalone page and production presentation adapters.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const project = path.resolve(__dirname, '../../..');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || path.join(project, '.test_runtime/node_modules/playwright'));
const output = path.join(project, 'output_file/.test_outputs/forecast_layout_20261116');
const html = process.env.FORECAST_HTML || path.join(project, 'output_file/static/鸿蒙智行销量预测.html');
const script = require('./template_source.cjs').readTemplate(path.join(__dirname, '../templates/dashboard.js'));
const productionFunction = name => {
  const start = script.indexOf(`  function ${name}(`);
  const end = script.indexOf('\n  function ', start + 1);
  assert(start >= 0 && end > start, `Production function not found: ${name}`);
  return script.slice(start, end);
};
const pageUrl = view => {
  const url = pathToFileURL(html);
  url.search = new URLSearchParams({module: 'sales_forecast', subject: '问界 M9 2026款', forecastStage: 'launch', forecastView: view});
  return url.href;
};
const ready = page => page.waitForFunction(() => document.querySelector('#page')?.getAttribute('aria-busy') === 'false' && document.querySelector('.forecast-workspace')?._forecastComparison);
const snapshot = page => page.locator('.forecast-workspace').evaluate(root => JSON.stringify(root._forecastComparison));
const screenshot = (page, name) => page.screenshot({path: path.join(output, name + '.png'), fullPage: true});

(async () => {
  fs.mkdirSync(output, {recursive: true});
  const browser = await chromium.launch({headless: true, channel: 'msedge'});
  const errors = [], report = {checks: [], screenshots: [], errors};
  const contextOptions = {viewport: {width: 1365, height: 900}, reducedMotion: 'reduce', timezoneId: 'Asia/Shanghai'};
  const attachErrors = page => page.on('pageerror', error => errors.push(error.message));
  try {
    // A legacy params URL remains usable, with all controls in the evidence tab.
    const draftContext = await browser.newContext(contextOptions), draftPage = await draftContext.newPage();
    attachErrors(draftPage);
    await draftPage.goto(pageUrl('params'));
    await ready(draftPage);
    assert.equal(await draftPage.locator('[data-forecast-tab="params"],.forecast-parameters-pane').count(), 0);
    assert.equal(await draftPage.locator('[data-forecast-tab="evidence"]').getAttribute('aria-selected'), 'true');
    assert.equal(new URL(draftPage.url()).searchParams.get('forecastView'), 'evidence');
    const evidence = draftPage.locator('#forecast-pane-evidence');
    assert(await evidence.evaluate(pane => pane.firstElementChild?.matches('[data-forecast-region="controls"]')));
    assert.equal(await evidence.locator('[data-forecast-region="controls"] .forecast-parameter-rail').count(), 1);
    const sourceConfig = await draftPage.locator('.forecast-workspace').getAttribute('data-forecast-config');
    const input = field => draftPage.locator(`[data-forecast-input="${field}"]`);
    await draftPage.locator('[data-forecast-target="launchDate"]').fill('2080-01-01');
    await draftPage.locator('[data-forecast-target="launchDate"]').dispatchEvent('change');
    await input('small').fill('10000');
    await input('conversion').fill('40');
    await input('direct').fill('50');
    await draftPage.waitForFunction(() => document.querySelector('.forecast-workspace')._forecastComparison.scenarios.parameter.gross === 8000);
    await input('conversion').fill('25');
    await draftPage.waitForFunction(() => document.querySelector('.forecast-workspace')._forecastComparison.scenarios.parameter.gross === 5000);
    assert.equal(await draftPage.locator('.forecast-workspace').getAttribute('data-forecast-config'), sourceConfig);
    await draftPage.reload();
    await ready(draftPage);
    await draftPage.waitForFunction(() => document.querySelector('[data-forecast-input="conversion"]').value === '25' && document.querySelector('.forecast-workspace')._forecastComparison.scenarios.parameter.gross === 5000);
    assert.equal(await draftPage.locator('[data-forecast-target="launchDate"]').inputValue(), '2080-01-01');
    report.checks.push('legacy params URL redirects to evidence; parameters recalculate and manual draft survives reload');
    const navigation = draftPage.locator('#forecastNavParameters');
    const targetInputs = navigation.locator('[data-forecast-target]');
    const expectedFields = ['tier', 'energy', 'node', 'smallStartDate', 'smallPeriod', 'smallDays', 'launchDate', 'period', 'days'].sort();
    const fieldNames = () => targetInputs.evaluateAll(inputs => inputs.map(input => input.dataset.forecastTarget).sort());
    assert.deepEqual(await fieldNames(), expectedFields);
    assert.equal(await draftPage.locator('[data-forecast-target]').count(), expectedFields.length);
    const wideLayout = await navigation.evaluate(menu => {
      const stage = document.querySelector('#subjectSelect').getBoundingClientRect();
      const controls = [...menu.querySelectorAll('[data-forecast-target]')].map(input => input.getBoundingClientRect());
      return menu.open && controls.every(box =>
        box.width > 0 && box.left >= stage.right && box.right <= innerWidth &&
        box.top < stage.bottom && box.bottom > stage.top);
    });
    assert(wideLayout, 'All nine fields share the model selection row on a wide screen');

    const days = navigation.locator('[data-forecast-target="days"]');
    const changedDays = (await days.inputValue()) === '5' ? '6' : '5';
    await days.fill(changedDays);
    await days.dispatchEvent('change');
    await draftPage.waitForFunction(value => document.querySelector('[data-forecast-time-summary]').textContent.includes('共' + value + '天'), changedDays);
    await draftPage.reload();
    await ready(draftPage);
    assert.equal(await days.inputValue(), changedDays);
    const subject = draftPage.locator('#subjectSelect');
    const firstModel = await subject.inputValue();
    const nextModel = await subject.evaluate(select => [...select.options].find(option => option.value !== select.value)?.value);
    assert(nextModel, 'Model switching requires a second forecast model');
    for (const id of [nextModel, firstModel]) {
      await subject.selectOption(id);
      await draftPage.waitForFunction(id => document.querySelector('.forecast-workspace')?._forecastSubjectId.split('|')[0] === id &&
        document.querySelector('#page').getAttribute('aria-busy') === 'false', id);
      const launchDate = navigation.locator('[data-forecast-target="launchDate"]');
      if (id === firstModel) {
        assert.equal(await days.inputValue(), changedDays);
        assert.equal(await launchDate.inputValue(), '2080-01-01');
      } else {
        const target = JSON.parse(await draftPage.locator('.forecast-workspace').getAttribute('data-forecast-config')).target;
        assert.equal(await launchDate.inputValue(), target.launch_date || '');
      }
    }
    for (const stage of ['small', 'steady', 'launch']) {
      const stageButton = draftPage.locator('[data-forecast-nav="' + stage + '"]');
      await stageButton.click();
      await draftPage.waitForFunction(id => document.querySelector('[data-forecast-nav="' + id + '"]')?.getAttribute('aria-current') === 'page', stage);
      assert.deepEqual(await fieldNames(), expectedFields);
      assert.equal(await draftPage.locator('[data-forecast-target]').count(), expectedFields.length);
    }
    for (const width of [1024, 390]) {
      await draftPage.setViewportSize({width, height: 850});
      const summary = navigation.locator('summary');
      await summary.waitFor({state: 'visible'});
      assert.equal(await navigation.evaluate(menu => menu.open), false);
      await summary.click();
      assert(await days.isVisible());
      assert(await targetInputs.evaluateAll(inputs => inputs.every(input => {
        const box = input.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= innerWidth + 1;
      })), width + 'px: fields are usable within the viewport');
      await days.press('Escape');
      assert.equal(await navigation.evaluate(menu => menu.open), false);
    }
    report.checks.push('navigation owns nine unique fields; model drafts, stage changes, compact menu and time calculations work');
    await draftContext.close();

    // A fresh browser context uses the real, untouched launch data for both methods.
    const context = await browser.newContext(contextOptions), page = await context.newPage();
    attachErrors(page);
    await page.goto(pageUrl('result'));
    await ready(page);
    const original = await snapshot(page);
    for (const method of ['progress', 'parameter']) {
      const chart = page.locator(`[data-forecast-decision-chart="${method}"]`);
      const actual = await chart.evaluate(node => ({
        headers: [...node.querySelectorAll('thead th')].map(cell => cell.textContent),
        values: [...node.querySelectorAll('tbody tr')].map(row => row.cells[2]?.textContent),
        quantities: [...node.querySelectorAll('[data-forecast-quantity-label]')].map(label => label.textContent),
        tooltip: node.querySelector('svg title')?.textContent || '',
      }));
      const expected = await page.locator('.forecast-workspace').evaluate((root, method) => root._forecastComparison.scenarios[method].rows.map(row => typeof row.daily_gross === 'number' && Number.isFinite(row.daily_gross) ? new Intl.NumberFormat('zh-CN').format(row.daily_gross) : '—'), method);
      assert(expected.length > 1, `${method}: the real launch fixture must contain multiple dates`);
      assert.deepEqual(actual.values, expected, `${method}: conclusion table must display daily quantities`);
      assert(actual.headers[2].includes('单日大定'));
      assert(!actual.headers.some(label => /累计(?:销量|大定)(?:（单）)?$/.test(label)));
      assert.equal(actual.headers.filter(label => /(?:单日|当日)大定/.test(label)).length, 1, 'Only one daily quantity column is needed');
      assert.deepEqual(actual.quantities, expected.filter(value => value !== '—'));
    }
    assert.equal(await snapshot(page), original, 'Chart presentation must not change the forecast source');
    await page.locator('[data-forecast-decision-chart="progress"]').scrollIntoViewIfNeeded();
    await screenshot(page, 'desktop-launch-daily'); report.screenshots.push('desktop-launch-daily.png');
    report.checks.push('both launch method charts and value tables use existing daily quantities without changing predictions');

    // Exercise missing values and true zero directly through the production adapters.
    const adapters = await page.evaluate(({quantity, decision}) => {
      const fmt = value => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('zh-CN').format(value) : '—';
      const esc = value => String(value ?? '').replace(/[&<>\"]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[char]));
      const api = new Function('fmt', 'esc', `'use strict';\n${quantity}\n${decision}\nreturn {renderForecastDecisionChartV2};`)(fmt, esc);
      const rows = Object.freeze([
        Object.freeze({day: 'D1', date: '2026-11-01', actual: true, daily_gross: 0, cumulative_gross: 100}),
        Object.freeze({day: 'D2', date: '2026-11-02', missing: true, daily_gross: null, cumulative_gross: null}),
        Object.freeze({day: 'D3', date: '2026-11-03', actual: false, daily_gross: 37, cumulative_gross: 137}),
      ]);
      const before = JSON.stringify(rows), container = document.createElement('div');
      container.innerHTML = '<div data-forecast-decision-chart="progress"></div>';
      api.renderForecastDecisionChartV2(container, rows, 'progress');
      const values = [...container.querySelectorAll('tbody tr')].map(row => row.cells[2].textContent);
      const labels = [...container.querySelectorAll('[data-forecast-quantity-label]')].map(label => label.textContent);
      return {values, labels, unchanged: JSON.stringify(rows) === before};
    }, {quantity: productionFunction('renderForecastQuantityChart'), decision: productionFunction('renderForecastDecisionChartV2')});
    assert.deepEqual(adapters.values, ['0', '—', '37']);
    assert.deepEqual(adapters.labels, ['0', '37']);
    assert(adapters.unchanged);
    report.checks.push('true zero and missing daily data remain distinct; source rows are immutable');

    // All stage score detail rows are initially expanded, and remain normal disclosures.
    for (const stage of ['small', 'launch', 'steady']) {
      await page.locator(`[data-forecast-nav="${stage}"]`).click();
      await page.locator('[data-forecast-tab="score"]').click();
      const scope = page.locator(`[data-forecast-stage-pane="${stage}"]`);
      const details = scope.locator('.forecast-score-detail-table .forecast-score-row-details');
      const taskSelect = scope.locator('[data-forecast-score-task]');
      const tasks = await taskSelect.count() ? await taskSelect.locator('option').evaluateAll(nodes => nodes.filter(node => !node.disabled).map(node => node.value)) : [null];
      let checked = 0;
      for (const task of tasks) {
        if (task !== null) await taskSelect.selectOption(task);
        const counts = await details.evaluateAll(nodes => ({total: nodes.length, open: nodes.filter(node => node.open).length}));
        assert.equal(counts.open, counts.total, `${stage}/${task}: all available scoring details should start expanded`);
        if (!counts.total) continue; // A task with no eligible evidence correctly has no detail rows.
        await details.first().locator('summary').click();
        assert.equal(await details.first().evaluate(node => node.open), false, 'Manual collapse must still work');
        await scope.evaluate((scope, source) => {
          const compact = new Function(source+'\nreturn compactForecastScorePage;')();
          compact(scope);
        }, productionFunction('compactForecastScorePage'));
        assert.equal(await details.count(), counts.total, 'Compaction must preserve the existing candidates');
        assert.equal(await details.first().evaluate(node => node.open), false, 'Compaction must preserve the manual collapse');
        await details.first().locator('summary').click();
        assert.equal(await details.first().evaluate(node => node.open), true);
        checked += counts.total;
      }
      assert(checked > 0, `${stage}: at least one score task must have detail rows`);
      report.checks.push(`${stage}: ${checked} available score details default expanded and can be toggled manually`);
    }
    assert.equal(await snapshot(page), original, 'Viewing scoring details must not alter launch predictions');
    await screenshot(page, 'desktop-expanded-scores'); report.screenshots.push('desktop-expanded-scores.png');

    // Controls stay at the beginning of evidence on narrow screens as on desktop.
    await page.locator('[data-forecast-nav="launch"]').click();
    await page.locator('[data-forecast-tab="evidence"]').click();
    for (const viewport of [{width: 1365, height: 900}, {width: 375, height: 812}, {width: 812, height: 375}]) {
      await page.setViewportSize(viewport);
      await page.locator('#forecast-pane-evidence [data-forecast-region="controls"]').scrollIntoViewIfNeeded();
      assert(await page.locator('#forecast-pane-evidence').evaluate(pane => pane.firstElementChild?.matches('[data-forecast-region="controls"]')));
      const size = await page.evaluate(() => ({scroll: document.documentElement.scrollWidth, viewport: innerWidth}));
      assert(size.scroll <= size.viewport + 2, `${viewport.width}px: document must not overflow horizontally`);
      const name = `evidence-${viewport.width}x${viewport.height}`;
      await screenshot(page, name); report.screenshots.push(name + '.png');
    }
    assert.deepEqual(errors, []);
    await context.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({checks: report.checks, screenshots: report.screenshots, errors}, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
