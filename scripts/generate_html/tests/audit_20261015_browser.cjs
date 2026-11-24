// Formal main.py output only; synthetic records stay in isolated browser memory.
const path=require('path'),assert=require('assert'),{pathToFileURL}=require('url');
const project=path.resolve(__dirname,'../../..'),{chromium}=require(process.env.PLAYWRIGHT_MODULE || path.join(project,'.test_runtime/node_modules/playwright'));
const base=pathToFileURL(process.env.FORECAST_HTML || path.join(project,'output_file/static/鸿蒙智行销量预测.html'));
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'}),errors=[],checks=[];
 try{
  for(const today of ['2026-05-05','2026-05-03']){
   const context=await browser.newContext({viewport:{width:1440,height:1000}});
   await context.addInitScript(({today})=>{
    const parse=JSON.parse,same=name=>String(name||'').replace(/\s/g,'')==='问界M92026款';
    JSON.parse=function(text,...args){
     const value=parse.call(this,text,...args),seen=new WeakSet();
     const visit=data=>{
      if(!data||typeof data!=='object'||seen.has(data))return;seen.add(data);
      if(data.config&&data.subjects)data.config.forecast_as_of_date=today;
      if(data.target&&Array.isArray(data.history)&&Array.isArray(data.actuals)){
       for(const target of [data.target,...data.targets||[],...data.steady_targets||[]])if(same(target.name))Object.assign(target,{
        has_small:false,launch_date:'2026-05-01',end_date:'2026-05-03',days:3,steady_start_date:'2026-05-04',
        hard_errors:[],validation_issues:[],data_error:false
       });
       for(const item of [...data.history,...data.steady_launch_history||[]])if(same(item.model)||same(item.generation))Object.assign(item,{
        launch_date:'2026-05-01',end_date:'2026-05-03',days:3,lock_rate:.5,
        daily_orders:[100,null,200],daily_direct:[100,null,200],daily_small:[0,null,0]
       });
       for(const profile of data.actuals)if(same(profile.model))for(const item of [profile,...Object.values(profile.stage_profiles||{})])Object.assign(item,{
        days:[{date:'2026-05-01',gross:100,direct:100,small_to_big:0,lock:50},{date:'2026-05-03',gross:200,direct:200,small_to_big:0,lock:100}],
        hard_errors:[],validation_issues:[],data_error:false
       });
       data.steady_history=(data.steady_history||[]).filter(item=>!same(item.model)&&!same(item.generation));
       data.steady_history.push({model:'问界 M9 2026款',generation:'问界 M9 2026款',event_id:'audit15-own',weeks:[],
        daily:[{date:'2026-05-04',lock:30,gross:60,complete:true}]});
      }
      Object.values(data).forEach(visit);
     };visit(value);return value;
    };
   },{today});
   const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
   const url=new URL(base);url.search=new URLSearchParams({module:'sales_forecast',subject:'问界 M9 2026款',forecastStage:'steady',forecastView:'evidence'});
   await page.goto(url.href);await page.waitForSelector('[data-steady-reference-chart] svg');
   await page.evaluate(()=>document.querySelectorAll('[data-bridge-stage="launch"] [data-bridge-control]').forEach(input=>{
    if(input.dataset.bridgeControl!=='weights'){input.value='1';input.dispatchEvent(new Event('change',{bubbles:true}));}
   }));
   const cells=await page.locator('[data-steady-reference-chart] tbody tr').filter({hasText:'问界 M9 2026款 · 首销直接大定实际'}).first().locator('td').allTextContents();
   assert.deepEqual(cells,today==='2026-05-05'?['100%','—','200%']:['100%','—']);
   const labels=await page.locator('[data-steady-reference-chart] circle[aria-label]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')).filter(label=>label.includes('问界 M9 2026款 · 首销直接大定实际')));
   assert(!labels.some(label=>label.includes('D2')));
   assert.equal(labels.some(label=>label.includes('D3')&&label.includes('200%')),today==='2026-05-05');
   checks.push('steady calendar gap and cutoff '+today);await context.close();
  }
  const context=await browser.newContext();
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  const url=new URL(base);
  url.search=new URLSearchParams({module:'raw',rawFile:'旧工作簿.xlsx'});
  await page.goto(url.href);
  await page.waitForFunction(()=>window.DASHBOARD_DATA && document.querySelector('#page')?.getAttribute('aria-busy')==='false');
  assert.equal(new URL(page.url()).searchParams.get('module'),'sales_forecast');
  assert.equal(await page.locator('#rawTable, #exportRawWorkbook').count(),0);
  assert(await page.evaluate(()=>window.DASHBOARD_RAW_B64===undefined && window.DASHBOARD_DATA.raw_files.length===0));
  checks.push('legacy raw URL opens the forecast without a workbook export');
  await context.close();assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,errors}));
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
