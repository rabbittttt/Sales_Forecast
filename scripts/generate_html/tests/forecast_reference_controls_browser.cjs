// Verify the real main.py output: reference resets, compact scoring and responsive layout.
const path=require('path'),fs=require('fs'),assert=require('assert'),{pathToFileURL}=require('url');
const project=path.resolve(__dirname,'../../..');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(project,'.test_runtime/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'}),errors=[];
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>errors.push(e.message));
 const output=path.join(project,'.test_outputs/forecast_ui_20261012');fs.mkdirSync(output,{recursive:true});
 const url=pathToFileURL(path.join(project,'output_file/static/鸿蒙智行销量预测.html'));
 url.search=new URLSearchParams({module:'sales_forecast',subject:'问界 M9 2026款',forecastStage:'small',forecastView:'evidence'});
 const pause=()=>page.waitForTimeout(350);
 try{
  await page.goto(url.href);await page.waitForSelector('.forecast-workspace');await pause();
  const selector='[data-forecast-ref],[data-forecast-ref-weight],[data-lifecycle-ref],[data-lifecycle-weight]';
  assert.equal(await page.locator(selector).count(),await page.locator('.forecast-reference-reset').count());
  assert(await page.locator(selector).evaluateAll(nodes=>nodes.every(n=>n.closest('.forecast-field-control')?.querySelector('.forecast-reference-reset')&&n.getAttribute('aria-label'))));
  let checked=0;
  for(const stage of ['small','launch','steady']){
   await page.locator(`[data-forecast-nav="${stage}"]`).click();await page.locator('[data-forecast-tab="evidence"]').click();await pause();
   const cards=page.locator('.forecast-ref-card:visible').filter({has:page.locator('[data-forecast-ref],[data-lifecycle-ref]')});
   for(let i=0;i<await cards.count();i++){
    const card=cards.nth(i),weights=card.locator('[data-forecast-ref-weight],[data-lifecycle-weight]'),selects=card.locator('[data-forecast-ref],[data-lifecycle-ref]');
    const hasWeights=await weights.count()===2;
    const selected=await selects.evaluateAll(nodes=>nodes.map(n=>n.value));
    if(hasWeights){
    await weights.nth(1).fill('41');await weights.first().fill('59');await pause();
    await weights.first().locator('..').locator('.forecast-reference-reset').click();await pause();
    assert.equal(await weights.first().inputValue(),'70');assert.equal(await weights.nth(1).inputValue(),'41');
    assert.deepEqual(await selects.evaluateAll(nodes=>nodes.map(n=>n.value)),selected);
    await weights.nth(1).locator('..').locator('.forecast-reference-reset').click();await pause();
    assert.equal(await weights.nth(1).inputValue(),'30');
    }
    const recommended=await selects.first().inputValue(),options=await selects.first().locator('option:not(:disabled)').evaluateAll(nodes=>nodes.map(n=>n.value));
    const alternative=options.find(value=>value&&value!==recommended&&value!==selected[1]);
    if(alternative){
     await selects.first().selectOption(alternative);await pause();
     const sibling=await selects.nth(1).inputValue();
     if(hasWeights)await weights.nth(1).fill('37');await pause();
     await selects.first().locator('..').locator('.forecast-reference-reset').click();await pause();
     assert.equal(await selects.first().inputValue(),recommended,`${stage} card ${i} restores its recommendation`);
     assert.equal(await selects.nth(1).inputValue(),sibling);if(hasWeights)assert.equal(await weights.nth(1).inputValue(),'37');
     await page.reload();await page.waitForSelector('.forecast-workspace');await pause();
     assert.equal(await selects.first().inputValue(),recommended);if(hasWeights){assert.equal(await weights.nth(1).inputValue(),'37');await weights.nth(1).locator('..').locator('.forecast-reference-reset').click();}await pause();
    }
    checked++;
   }
   console.log(`PASS ${stage}: reference selections and independent weight resets`);
  }
  assert(checked>=10,'All reference groups must be exercised');
  for(const width of [1440,1024,390]){
   await page.setViewportSize({width,height:1000});
   for(const stage of ['small','launch','steady']){
    await page.locator(`[data-forecast-nav="${stage}"]`).click();
    for(const view of ['result','evidence','score']){
     await page.locator(`[data-forecast-tab="${view}"]`).click();await pause();
     assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${stage}/${view}/${width}: page overflow`);
     if(view==='score'){
      const details=page.locator('.forecast-score-detail-table:visible .forecast-score-row-details');
      if(stage==='launch'&&await details.count()===0){
       const tasks=page.locator('[data-forecast-score-task]:visible');
       for(const value of await tasks.locator('option').evaluateAll(nodes=>nodes.filter(node=>!node.disabled).map(node=>node.value))){
        await tasks.selectOption(value);await pause();if(await details.count()>0)break;
       }
      }
      assert(await details.count()>0,'At least one scoring task must contain comparable candidates');
      assert(await details.evaluateAll(nodes=>nodes.every(node=>node.open)),`${stage}/${width}: score details default to expanded`);
      const reasons=page.locator('.forecast-score-summary-table:visible .forecast-score-row-details');
      if(stage==='launch')assert(await reasons.count()>0);
      assert(await reasons.evaluateAll(nodes=>nodes.every(node=>!node.open)),`${stage}/${width}: summary reasons stay collapsed`);
      await details.first().locator('summary').click();assert.equal(await details.first().getAttribute('open'),null);
      assert(await page.locator('.forecast-score-methodology:visible').count()>0);
      const summaryHeight=await details.first().evaluate(card=>card.getBoundingClientRect().height);
      assert(summaryHeight<(width<700?160:80),`compact ${stage} candidate summary ${summaryHeight}px`);
      await details.first().locator('summary').click();assert.notEqual(await details.first().getAttribute('open'),null);
     }
     if(view==='evidence'){
      assert(await page.locator('.forecast-chart-notes:visible').count()>0);
      assert(await page.locator('.forecast-reference-reset:visible').evaluateAll(nodes=>nodes.every(n=>n.getBoundingClientRect().width>=24)));
      assert(await page.locator('.forecast-ref-weights input:visible').evaluateAll(nodes=>nodes.every(n=>{const s=getComputedStyle(n);return n.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)>=24})),`${stage}/${width}: three-digit weight must fit`);
     }
     if(width!==1024)await page.screenshot({path:path.join(output,`${stage}-${view}-${width}.png`),fullPage:true});
    }
   }
  }
  assert.deepEqual(errors,[]);console.log(`PASS ${checked} reference groups, persistence, 27 responsive views; no JS errors`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
