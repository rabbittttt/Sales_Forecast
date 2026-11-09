// Run after main.py. Exercise the independent forecast over HTTP and file://.
// Requires PLAYWRIGHT_MODULE or the local .test_runtime Playwright installation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const http=require('node:http');
const {pathToFileURL}=require('node:url');
const project=path.resolve(__dirname,'../../..');
const output=process.env.FORECAST_OUTPUT_DIR||path.join(project,'output_file');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(project,'.test_runtime/node_modules/playwright'));
const forecastName='鸿蒙智行销量预测.html';
const target='问界 M9 2026款',report={checks:[],errors:[],layout:[]};
const check=(name,value)=>{assert(value,name);report.checks.push(name);console.log('PASS',name);};
const ready=page=>page.waitForFunction(()=>document.querySelector('.forecast-workspace')?._forecastComparison);
const settled=page=>page.waitForFunction(()=>document.querySelector('#page')?.getAttribute('aria-busy')==='false');
async function run(){
  const requests=[];
  const server=http.createServer((req,res)=>{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=path.resolve(output,'.'+pathname);
    if(!file.startsWith(path.resolve(output)+path.sep)){res.writeHead(403);res.end();return;}
    fs.readFile(file,(error,body)=>{if(error){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript;charset=utf-8':'text/html;charset=utf-8');res.end(body);});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const url=(name,params={})=>{const value=new URL(encodeURIComponent(name),origin+'/');value.search=new URLSearchParams(params);return value.href;};
  const forecastParams={subject:target,module:'sales_forecast',forecastStage:'launch',forecastView:'result'};
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  try{
    const context=await browser.newContext({viewport:{width:1366,height:1000},reducedMotion:'reduce'});
    const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>requests.push(r.url()));
    await page.goto(url(forecastName,forecastParams));await ready(page);await settled(page);
    check('独立入口只提供代际车型',await page.locator('#subjectSelect').evaluate(select=>[...select.options].length>0&&[...select.options].every(option=>window.DASHBOARD_DATA.subjects.find(s=>s.id===option.value)?.type==='generation')));
    check('独立入口不引用订单页面或旧草稿',await page.evaluate(()=>['order_page','forecast_page','forecast_legacy_page'].every(key=>!Object.hasOwn(window.DASHBOARD_DATA,key))));
    check('独立页面只含预测业务块',await page.evaluate(()=>window.DASHBOARD_DATA.app_mode==='forecast'&&Object.keys(window.DASHBOARD_BLOCKS_B64).every(key=>key.endsWith('|sales_forecast'))));
    check('首次进入不加载底表行或整本Excel',!requests.some(value=>value.includes('/forecast_assets/'))&&await page.evaluate(()=>Object.keys(window.DASHBOARD_RAW_B64).length===0));
    for(const stage of ['small','steady','launch']){
      await page.locator('[data-forecast-nav="'+stage+'"]').click();
      await page.waitForSelector('[data-forecast-stage-pane="'+stage+'"].active');
      const views=stage==='launch'?['params','evidence','score','result']:['evidence','score','result'];
      check(stage+'参数配置仅在有首销方法参数时显示',await page.locator('[data-forecast-tab="params"]').isVisible()===(stage==='launch'));
      for(const view of views){
        await page.locator('[data-forecast-tab="'+view+'"]').click();
        const selector=stage==='launch'?'[data-forecast-pane="'+view+'"].active':'[data-lifecycle-subpane="'+stage+'-'+view+'"].active';
        const pane=page.locator(selector);
        check(stage+' / '+view+'可见',await pane.isVisible());
        if(view==='evidence')check(stage+'公共参数位于预测依据',await pane.locator('.forecast-common-controls [data-bridge-stage="'+stage+'"]').isVisible());
      }
    }
    const launchDays=page.locator('.forecast-target [data-forecast-target="days"]');
    const originalDays=await launchDays.inputValue();
    const editedDays=originalDays==='5'?'6':'5';
    const launchStart=await page.locator('.forecast-target [data-forecast-target="launchDate"]').inputValue();
    const steadyStart=new Date(Date.parse(launchStart+'T00:00:00Z')+Number(editedDays)*86400000).toISOString().slice(0,10);
    await launchDays.fill(editedDays);
    await page.waitForFunction(({days,steady})=>{
      const text=document.querySelector('[data-forecast-time-summary]').textContent;
      return text.includes('共'+days+'天')&&text.includes('平销自 '+steady+' 起');
    },{days:editedDays,steady:steadyStart});
    check('预测结论页的页头天数输入实时更新首销与平销时间口径',true);
    await launchDays.fill(originalDays);
    await launchDays.press('Tab');
    // Edit the stage-specific controls in the dedicated params pane.
    await page.locator('[data-forecast-tab="params"]').click();
    const conversion=page.locator('[data-forecast-input="conversion"]');
    await conversion.fill('41.2');await conversion.dispatchEvent('change');
    await page.waitForFunction(()=>document.querySelector('[data-forecast-feedback]').dataset.state==='success');
    await page.locator('[data-forecast-tab="result"]').click();await page.locator('[data-forecast-tab="params"]').click();
    check('切换视图保留人工参数',await conversion.inputValue()==='41.2');
    await page.reload();await ready(page);
    check('刷新恢复独立看板人工参数',await conversion.inputValue()==='41.2');
    await page.locator('[data-forecast-tab="result"]').click();
    const importPanel=page.locator('[data-forecast-import="launch"]');
    if(!await importPanel.locator('.forecast-import-manager').evaluate(node=>node.open))await importPanel.locator('.forecast-import-manager > summary').click();
    const launchDate=await page.locator('.forecast-workspace').evaluate(n=>JSON.parse(n.dataset.forecastConfig).target.launch_date);
    await importPanel.locator('[data-forecast-import-file]').setInputFiles({name:'standalone.csv',mimeType:'text/csv',buffer:Buffer.from('车型（代际）,日期,预测大定\n'+target+','+launchDate+',100\n')});
    await page.waitForFunction(()=>document.querySelector('[data-forecast-import="launch"] [data-forecast-import-status]').textContent.includes('导入成功'));
    check('独立入口支持原外部预测导入',await page.evaluate(()=>JSON.parse(localStorage.getItem('sales-forecast-independent-v1:'+location.pathname)).imports.some(([,entry])=>entry.rows.some(row=>row.quantity===100&&row.source==='standalone.csv'))));
    // Editing an old project's storage namespace must not affect this project.
    const independentDraft = await page.evaluate(()=>localStorage.getItem('sales-forecast-independent-v1:'+location.pathname));
    await page.evaluate(()=>localStorage.setItem('harmony-forecast-v1:'+location.pathname,JSON.stringify({version:1,drafts:[],imports:[],scopes:[]})));
    await page.reload();await ready(page);
    check('旧项目草稿变化不影响独立参数与导入',await conversion.inputValue()==='41.2'&&await page.evaluate(raw=>localStorage.getItem('sales-forecast-independent-v1:'+location.pathname)===raw,independentDraft));
    await page.locator('[data-forecast-tab="evidence"]').click();
    await page.locator('[data-bridge-stage="launch"] [data-bridge-control="workday"]').fill('1.07');
    await page.locator('[data-workspace-source]').click();
    await page.waitForFunction(()=>document.querySelector('.forecast-workspace').getAttribute('aria-busy')==='false');
    check('改公共参数后可直接查看来源位置',await page.locator('.forecast-source-details[open] [data-forecast-source-location]:not([hidden])').isVisible()&&await page.locator('[data-forecast-day-source]').textContent());
    check('独立页不发布底表数据',await page.evaluate(()=>window.DASHBOARD_DATA.raw_files.length===0&&Object.keys(window.DASHBOARD_DATA.raw_block_urls).length===0&&Object.keys(window.DASHBOARD_RAW_B64).length===0));
    await page.goto(url(forecastName,{...forecastParams,module:'raw',rawFile:'旧底表.xlsx',rawSheet:'旧表'}));await ready(page);
    check('旧底表链接转回预测并保留车型和草稿',new URL(page.url()).searchParams.get('module')==='sales_forecast'&&await page.locator('#subjectSelect').evaluate(n=>n.selectedOptions[0].textContent)===target&&await conversion.inputValue()==='41.2');
    check('未请求底表资源',!requests.some(value=>value.includes('/forecast_assets/')));
    for(const width of [1366,1920,390]){
      await page.setViewportSize({width,height:1000});
      check(width+'px预测导航无返回订单分析入口',await page.locator('.forecast-order-link').count()===0&&await page.getByRole('link',{name:'返回订单分析'}).count()===0);
      check(width+'px预测导航仅含三阶段',JSON.stringify(await page.locator('[data-forecast-nav]').evaluateAll(nodes=>nodes.map(node=>node.dataset.forecastNav)))===JSON.stringify(['small','launch','steady'])&&JSON.stringify(await page.locator('#moduleSelect option').evaluateAll(nodes=>nodes.map(node=>node.value)))===JSON.stringify(['small','launch','steady']));
      const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,fields:[...document.querySelectorAll('.forecast-target>.forecast-target-settings [data-forecast-target]')].map(n=>{const b=n.getBoundingClientRect();return {left:b.left,right:b.right,width:b.width,height:b.height};})}));
      report.layout.push(layout);check(width+'px页头9个参数可见且无横向裁切',layout.scroll<=width+1&&layout.fields.length===9&&layout.fields.every(b=>b.left>=0&&b.right<=width+1&&b.width>0&&b.height>0));
      check(width+'px结果区域无整页横向溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
    const filePage=await context.newPage();filePage.on('pageerror',e=>report.errors.push(e.message));
    const fileUrl=pathToFileURL(path.join(output,forecastName));fileUrl.search=new URLSearchParams(forecastParams);
    await filePage.goto(fileUrl.href);await ready(filePage);
    check('单文件预测入口可打开',await filePage.locator('.forecast-workspace').isVisible());
    assert.deepEqual(report.errors,[]);check('浏览器无脚本异常',true);
    console.log(JSON.stringify({passed:true,checks:report.checks.length,layout:report.layout,pageErrors:report.errors},null,2));
    await context.close();
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
run().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
