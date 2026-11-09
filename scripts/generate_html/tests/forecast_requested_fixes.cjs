const assert=require('assert'),fs=require('fs'),path=require('path');
const script=fs.readFileSync(path.join(__dirname,'../templates/dashboard.js'),'utf8');
const section=(start,end)=>script.slice(script.indexOf(start),script.indexOf(end,script.indexOf(start)));
const brand=new Function(section('  const referenceBrand=','  function renderLifecycleReferenceCard(')+';return {referenceBrand,lifecycleUnavailable};')();
assert.equal(brand.referenceBrand({model:'RX 2027款',generation:'智界 RX 2027款',brand:'界'}),'智界');
assert.equal(brand.referenceBrand({model:'理想 L9',brand:'理想'}),'理想');
assert.equal(brand.referenceBrand({model:'外部车型',brand:'未维护'}),'其他');
assert.equal(brand.lifecycleUnavailable('hourly',{small_hourly_curve:[]}),true);
assert.equal(brand.lifecycleUnavailable('hourly',{small_hourly_curve:[null,.2,1]}),false);
const root={querySelector:()=>({value:'0'})},data={target:{small_end_date:'2026-10-01'}};
const small=new Function('root','data','todayIso','sameModel',section('    const scoringSmall=','    const targetState=')+';return scoringSmall;')(root,data,()=> '2026-09-28',(a,b)=>a===b);
root._smallForecastResult={name:'智界 RX 2027款',date:'2026-09-28',total:18000,error:null};
assert.deepEqual(small('智界 RX 2027款',{small:0}),{value:18000,estimated:true});
root._smallForecastLinked=true;
assert.equal(small('智界 RX 2027款',{small:0}).value,18000);
root._smallForecastResult.error='缺少分时数据';
assert.equal(small('智界 RX 2027款',{small:0}).value,0);
root._smallForecastResult.error=null;
assert.equal(small('另一车型',{small:0}).value,0);
assert.equal(small('智界 RX 2027款',{small:123,small_end_date:'2026-09-27'}).value,123);
// Exercise the scoring functions used by both the ranking table and reference controls.
const ForecastMath=require('../templates/forecast-math.js');
const target={name:'智界 RX 2027款',tier:'中大型SUV',energy:'增程',node:'全新发布',period:'未维护',
  launchDate:'2026-11-13',endDate:'2026-12-17',days:35,small:18000,smallEstimated:true};
const reference={model:'历史参考',tier:target.tier,energy:target.energy,node:target.node,launch_weekday:'周五',
  launch_period:'下午',days:35,small:20000,conversion:.5,direct_share:.2,
  small_progress:[.6,1],direct_progress:[.5,1],d1_small:5400,d1_small_share:.8,d1_direct_share:.2};
const historyList=[reference,{...reference,model:'终值缺失',direct_share:null},{...reference,model:'终值异常',direct_share:1}];
let asOf='2026-11-09',d1;
const {scoreSummary:score,scoredForTask,rankedForTask}=new Function(
  'window','sameModel','actualSignals','absoluteStage','calendarProfile','calendarSimilarity','fmt',
  'adaptationText','rebasedForecastCompletionCurve','historyList',
  section('    const observed=window.ForecastMath.observedQuantity','    const updateWeightSummary=')+
  section('    const minimumScoreCoverage=','    const scoreBar=')+
  ';return {scoreSummary,scoredForTask,rankedForTask};')(
  {ForecastMath},(a,b)=>a===b,()=>({days:d1?[d1]:[],d1}),
  candidate=>ForecastMath.launchStage(candidate,asOf),()=>({}),()=>NaN,String,
  ()=>'',(item,task)=>item[task],historyList);

const beforeShare=score(reference,'direct_share',target);
assert.equal(Math.round(beforeShare.configuredWeight*100),48);
assert.equal(Math.round(beforeShare.effectiveWeight*100),42);
assert(beforeShare.parts.some(part=>part.key==='size'&&part.label.includes('小订预测')));
assert.deepEqual(rankedForTask('direct_share',target).map(row=>row.item.model),[reference.model]);
for(const task of ['small_progress','direct_progress']){
  assert.deepEqual(score(reference,task,target).parts,[]);
  assert.deepEqual(scoredForTask(task,target),[]);
  assert.deepEqual(rankedForTask(task,target),[]);
}

const conversion=score(reference,'conversion',target);
assert(conversion.coverage>=.45);
assert(conversion.parts.some(part=>part.key==='size'&&part.label.includes('小订预测')));
assert(score(reference,'conversion',{...target,small:0,smallEstimated:false}).coverage<.45);

asOf='2026-11-13';
assert.equal(Math.round(score(reference,'direct_share',target).configuredWeight*100),100);
assert.deepEqual(rankedForTask('direct_share',target),[]);
assert(rankedForTask('small_progress',target).some(row=>row.item===reference));
asOf='2026-11-14';
d1={gross:6750,small_to_big:5400,direct:1350};
assert(score(reference,'direct_share',target).parts.some(part=>part.key==='earlyDirect'));
assert.deepEqual(rankedForTask('direct_share',target).map(row=>row.item.model),[reference.model]);
assert(rankedForTask('small_progress',target).some(row=>row.item===reference));
const chartCode=section('  function renderForecastEvidenceLines(','  function renderLifecycleScorePage(');
const chart=new Function('esc',chartCode+';return renderLifecycleLineChart;')(v=>String(v??''));
const single=chart({series:[{label:'外部预测',values:[1547],color:'#7C3AED'}],labels:['2026-09-28'],unit:'number',ariaLabel:'导入折线'});
assert(single.includes('<circle')&&single.includes('1,547')&&single.includes('2026-09-28'));
const multiple=chart({series:[{label:'外部预测',values:[1547,0,1600],color:'#7C3AED'}],labels:['2026-09-28','2026-09-29','2026-09-30'],unit:'number',ariaLabel:'导入折线'});
assert(multiple.includes('<polyline')&&multiple.includes('2026-09-29')&&multiple.includes('0单'));
console.log('PASS: stage-aware launch ranking, predicted-small scoring, brand classification, hourly eligibility and import charts');
