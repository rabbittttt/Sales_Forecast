import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('node'), 'Node.js required')
class SmallForecastRuntimeTests(unittest.TestCase):
    def test_requested_forecast_fixes(self):
        result = subprocess.run(['node', str(ROOT / 'tests/forecast_requested_fixes.cjs')], capture_output=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_end_day_links_small_prediction_even_when_launch_has_started(self):
        script = r'''
const fs=require('fs'),assert=require('assert');
const source=fs.readFileSync(DASHBOARD,'utf8');
global.window={ForecastMath:require(require('path').join(require('path').dirname(DASHBOARD),'forecast-math.js'))};
const linkStart=source.indexOf('      const smallInput=root.querySelector');
const linkEnd=source.indexOf('      const linkedSignature=',linkStart);
const blockStart=source.indexOf('      const validQuantity=');
const blockEnd=source.indexOf('      const hasSmall=',blockStart);
const methodStart=source.indexOf('      const parameterResult=');
const methodEnd=source.indexOf('      const referenceSmallEstimate=',methodStart);
assert(linkStart>=0&&linkEnd>linkStart&&blockStart>=0&&blockEnd>blockStart);
const link=new Function('root','targetState','absoluteStage','todayIso','sameModel','actualForTarget','findTarget',
 source.slice(linkStart,linkEnd)+'return {linkSmall,smallOngoing};');
const check=new Function('root','actual','target','stageInfo','small','resolvedFixed','pastMissingIndexes','smallOngoing','esc','forecastDateRanges',
 source.slice(blockStart,blockEnd)+'return {rawDataError,componentsReady:componentIssues.length===0};');
const method=new Function('rawDataError','small','baseConversion','componentsReady',
 'const endedComplete=false,hasSmall=true,baseShare=.2,actualSmall=0,actualDirect=0,actualGross=0,anchorSmall=0,anchorDirect=0,directD1=0,d1Ratio=0;'+
 source.slice(methodStart,methodEnd)+'return {available:parameterAvailable,gross:parameterGross,rawSmall:parameterRawSmall,rawDirect:parameterRawDirect};');
const probe=(end,total,error='',invalidDay=false,stage='active')=>{
 const input={value:0},root={_smallForecastResult:{name:'RX',date:'2026-09-28',stage:'active',total,error},querySelector:key=>key==='[data-forecast-input="small"]'?input:null};
 const target={name:'RX',smallEndDate:end,validationIssues:[{code:'TOTAL_SMALL_REQUIRED',message:'总小订缺失或不大于0'}]};
 const linked=link(root,()=>target,()=>({key:'active'}),()=> '2026-09-28',(a,b)=>a===b,()=>null,()=>({small:0}));
 const checked=check(root,null,target,{key:stage},Number(input.value),invalidDay?[{date:'2026-09-27',gross:1,small_to_big:null,direct:1}]:[],[],linked.smallOngoing,String,dates=>dates.join('、'));
 return {linked:!!linked.linkSmall,value:Number(input.value),rawError:checked.rawDataError,...method(checked.rawDataError,Number(input.value),.5,checked.componentsReady)};
};
console.log(JSON.stringify({ongoing:probe('2026-09-28',1000),pending:probe('2026-09-28',null,'等待参考'),
 ended:probe('2026-09-27',null),invalid:probe('2026-09-28',1000,'',true),before:probe('2026-09-30',1000,'',false,'before')}));
'''.replace('DASHBOARD', json.dumps(str(ROOT / 'templates/dashboard.js')))
        result = subprocess.run(['node', '-e', script], capture_output=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertTrue(data['ongoing']['linked'])
        self.assertEqual(data['ongoing']['value'], 1000)
        self.assertFalse(data['ongoing']['rawError'])
        self.assertTrue(data['ongoing']['available'])
        self.assertEqual(data['ongoing']['gross'], 625)
        self.assertEqual(data['ongoing']['rawSmall'], 500)
        self.assertEqual(data['ongoing']['rawDirect'], 125)
        self.assertTrue(data['before']['linked'])
        self.assertFalse(data['before']['rawError'])
        self.assertTrue(data['before']['available'])
        self.assertEqual(data['before']['gross'], 625)
        self.assertFalse(data['pending']['rawError'])
        self.assertFalse(data['pending']['available'])
        self.assertFalse(data['ended']['rawError'])
        self.assertFalse(data['ended']['available'])
        self.assertFalse(data['invalid']['rawError'])
        self.assertFalse(data['invalid']['available'])

    def test_active_small_initializes_and_predicts_without_current_final_total(self):
        script = r'''
const fs=require('fs');
const {smallReferenceScore,distributeInteger,completedSmallOrderDays,anchoredAllocate}=require(MATH);
const source=fs.readFileSync(DASHBOARD,'utf8');
const start=source.indexOf('  function bindSmallOrderForecast(');
const end=source.indexOf('  function bindSteadyForecast(',start);
const nodes=new Map(),node=key=>{if(!nodes.has(key))nodes.set(key,{value:'',textContent:'',innerHTML:'',hidden:true});return nodes.get(key)};
const select={value:'',options:[{value:'ref',dataset:{model:'reference'}}]},weight={value:'100'};
const workspace={querySelector:node,querySelectorAll:key=>key==='[data-small-ref]'?[select]:key==='[data-small-weight]'?[weight]:[]};
const root={querySelector:()=>workspace};
const lifecycleUnavailable=(task,item)=>task==='hourly'&&!((item.small_hourly_curve||[]).some(value=>Number.isFinite(value)&&value>0));
const status={};
const setForecastStageSummary=(root,id,label,text)=>{status[id]={label,text}};
const esc=String,fmt=String,renderLifecycleBars=()=>'',renderLifecycleLineChart=()=>'',renderLifecycleScorePage=()=>'';
const rebasedForecastCompletion=()=>({value:.5}),rebasedForecastCompletionCurve=()=>[.25,.5,.75,1];
const observedDailyPrefix=values=>values,extendForecastCurve=values=>values;
const window={ForecastMath:require(MATH)};console.warn=()=>{};
const forecastDateRanges=dates=>dates.join('、'),showForecastCondition=(node,{reasons})=>{node.hidden=!reasons.filter(Boolean).length;node.textContent=reasons.filter(Boolean).join('；');};
eval(source.slice(source.indexOf('  function createForecastEstimateLogger('),source.lastIndexOf('  init();')));
eval(source.slice(source.indexOf('  function lifecycleReferenceOptions('),source.indexOf('  function renderSmallOrderWorkspace(')));
eval(source.slice(start,end));
const target={name:'current',smallStartDate:'2026-09-01',smallEndDate:'2026-09-04',smallDays:4,tier:'SUV',energy:'增程',node:'年度换代'};
const reference={model:'reference',event_id:'ref',total:1000,days:4,tier:'SUV',energy:'增程',node:'年度换代',small_progress:[.25,.5,.75,1]};
const actual={total_small:0,small_daily_days:[{date:'2026-09-01',orders:100},{date:'2026-09-02',orders:200},{date:'2026-09-03',orders:999}]};
const calendarType=(start,index)=>({date:new Date(Date.parse(start+'T00:00:00Z')+index*86400000).toISOString().slice(0,10),type:'workday'});
const planBridge=(stage,args)=>anchoredAllocate({...args,factors:args.dates.map(()=>1),weights:args.dates.map((_,i)=>i===0?0:i===1?.5:1)});
reference.small_start_date='2026-08-01';
bindSmallOrderForecast(root,{small_order_history:[reference]},{sameModel:(a,b)=>a===b,targetState:()=>target,findActual:()=>actual,findStageActual:()=>actual,todayIso:()=> '2026-09-03',calendarType,planBridge,factors:()=>({workday:1,weekend:1,holiday:1})});
console.log(JSON.stringify({status,total:node('[data-small-kpi="total"]').textContent,actual:node('[data-small-kpi="actual"]').textContent,error:node('[data-small-error]').textContent,hidden:node('[data-small-error]').hidden}));
'''.replace('MATH', json.dumps(str(ROOT / 'templates/forecast-math.js'))).replace('DASHBOARD', json.dumps(str(ROOT / 'templates/dashboard.js')))
        result = subprocess.run(['node','-e',script], capture_output=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        # Today's 999 is not a complete real day, but the forecast cannot be lower.
        self.assertEqual(data['total'], '1299')
        self.assertEqual(data['actual'], '300')
        self.assertTrue(data['hidden'])
        self.assertIn('D3', data['status']['small']['label'])
        self.assertNotIn('判定中', data['status']['small']['label'])

    def test_static_page_move_migrates_only_valid_same_project_file_state(self):
        script = r"""
const fs=require('fs'),assert=require('assert');
const source=fs.readFileSync(DASHBOARD,'utf8');
const start=source.indexOf('  function persistForecastState(){');
const end=source.indexOf('  loadForecastState();',start);
assert(start>=0&&end>start,'production state loader must be found');
const load=new Function('location','localStorage','FORECAST_APP',`
  const DATA={},forecastStages=[{id:'small'},{id:'launch'},{id:'steady'}];
  const forecastStorageKey='sales-forecast-independent-v1:'+location.pathname;
  const forecastDrafts=new Map(),importedForecastRows=new Map(),forecastImportScopes=new Map();
  let forecastStorageWarning='';
  ${source.slice(start,end)}
  loadForecastState();
  return {drafts:[...forecastDrafts],imports:[...importedForecastRows],
    scopes:[...forecastImportScopes],warning:forecastStorageWarning};
`);
const prefix='sales-forecast-independent-v1:';
const page=new URL('file:///D:/workspace/forecast/output_file/static/report.html');
const oldKey=prefix+'/D:/workspace/forecast/output_file/report.html';
const newKey=prefix+page.pathname;
const harmonyKey='harmony-forecast-v1:/D:/workspace/forecast/output_file/report.html';
const saved={version:1,
  drafts:[['generation-test',{generatedAt:'2026-11-11T00:00:00',meta:{parameterOverrides:['direct']},
    controls:[{key:'|INPUT|data-forecast-input=direct|type=number',value:'42',checked:null}]}]],
  imports:[['测试车型',{filename:'预测.csv',rows:[
    {model:'测试车型',date:'2026-11-13',metric:'gross',quantity:25,stage:'launch',source:'预测.csv'},
    {model:'测试车型',date:'2026-11-14',metric:'small',quantity:0,stage:'small',source:'预测.csv'}]}]],
  scopes:[['测试车型',{launch:'all',small:'future'}]]};
const raw=JSON.stringify(saved);
function probe(location,initial,app=true){
  const storage=new Map(Object.entries(initial)),reads=[],writes=[];
  const result=load(location,{
    getItem:key=>{reads.push(key);return storage.has(key)?storage.get(key):null},
    setItem:(key,value)=>{writes.push(key);storage.set(key,value)}
  },app);
  return {result,storage,reads,writes};
}
const moved=probe(page,{[oldKey]:raw,[harmonyKey]:'not forecast state'});
assert.deepEqual(moved.result.drafts,saved.drafts);
assert.deepEqual(moved.result.imports,saved.imports);
assert.deepEqual(moved.result.scopes,saved.scopes);
assert.equal(moved.result.warning,'');
assert.deepEqual(moved.writes,[newKey]);
assert.deepEqual(JSON.parse(moved.storage.get(newKey)),saved);
assert.equal(moved.storage.get(oldKey),raw,'migration copies, never deletes the old state');
assert.deepEqual(moved.reads,[newKey,oldKey]);
const newer=JSON.parse(raw);newer.drafts[0][1].controls[0].value='73';newer.imports[0][1].rows[0].quantity=99;
const preferred=probe(page,{[newKey]:JSON.stringify(newer),[oldKey]:raw});
assert.deepEqual(preferred.result.drafts,newer.drafts);
assert.deepEqual(preferred.result.imports,newer.imports);
assert.deepEqual(preferred.reads,[newKey]);
assert.deepEqual(preferred.writes,[]);
for(const location of [
  new URL('http://127.0.0.1:8780/output_file/static/report.html'),
  new URL('http://127.0.0.1:8780/'),
  new URL('file:///D:/workspace/forecast/output_file/dynamic/report.html'),
  new URL('file:///D:/workspace/forecast/reports/static/report.html')]){
  const blocked=probe(location,{[oldKey]:raw});
  assert.deepEqual(blocked.reads,[prefix+location.pathname]);
  assert.deepEqual(blocked.writes,[]);
  assert.deepEqual(blocked.result.drafts,[]);
  assert.deepEqual(blocked.result.imports,[]);
}
const wrongApp=probe(page,{[oldKey]:raw},false);
assert.deepEqual(wrongApp.reads,[newKey]);assert.deepEqual(wrongApp.writes,[]);
const otherProject=probe(page,{[prefix+'/D:/workspace/another/output_file/report.html']:raw,[harmonyKey]:raw});
assert.deepEqual(otherProject.result.drafts,[]);
assert.deepEqual(otherProject.result.imports,[]);
assert.deepEqual(otherProject.writes,[]);
assert(!otherProject.reads.some(key=>key.startsWith('harmony-forecast-v1:')));
const invalid=JSON.parse(raw);invalid.imports[0][1].rows[0].quantity=-1;
for(const bad of ['{broken json',JSON.stringify(invalid)]){
  const rejected=probe(page,{[oldKey]:bad});
  assert(rejected.result.warning);
  assert.deepEqual(rejected.result.drafts,[],'invalid imported state cannot partly restore its valid draft');
  assert.deepEqual(rejected.result.imports,[]);
  assert.deepEqual(rejected.writes,[]);
  assert.equal(rejected.storage.get(oldKey),bad);
  assert(!rejected.storage.has(newKey));
}
const corruptNew=probe(page,{[newKey]:'{broken json',[oldKey]:raw});
assert(corruptNew.result.warning);assert.deepEqual(corruptNew.reads,[newKey]);
assert.deepEqual(corruptNew.writes,[]);assert.deepEqual(corruptNew.result.drafts,[]);
console.log('PASS static file state migration, new-state priority, protocol/project isolation and validation');
""".replace('DASHBOARD', json.dumps(str(ROOT / 'templates/dashboard.js')))
        result = subprocess.run(['node', '-e', script], capture_output=True, encoding='utf-8', timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
