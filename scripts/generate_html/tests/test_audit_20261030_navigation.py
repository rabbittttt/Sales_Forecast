"""Late asynchronous navigation must not overwrite the latest user's selection."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('node'), 'Node.js required')
class NavigationOrderTests(unittest.TestCase):
    def run_js(self, body, *, forecast=False):
        script = r'''
const fs=require('fs'),assert=require('assert');
const source=require('./tests/template_source.cjs').readTemplate('templates/dashboard.js');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const state={subject:'A',module:'overview',grain:'week',period:null};
const pending=[];
const getDashboard=()=>new Promise(resolve=>pending.push(resolve));
const board=(grain,period)=>({views:{[grain]:{periods:[period],default_period:period}}});
const ensure=new Function('DATA','state','subject','moduleAvailable','getDashboard','syncForecastStageToTarget','FORECAST_APP',
 extract('  async function ensureState()','  function renderSubjectSelect()')+';return ensureState;')(
 {app_mode:process.argv[1],dashboard_blocks:{'A|sales_forecast':true}},state,()=>({modules:['overview','sku','sales_forecast']}),()=>true,getDashboard,async()=>{},process.argv[1]==='forecast');
''' + '\n(async()=>{\n' + body + '\n})().catch(e=>{console.error(e);process.exitCode=1});'
        result = subprocess.run(['node', '-e', script, 'forecast' if forecast else 'legacy'], cwd=ROOT, capture_output=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_late_subject_cannot_replace_current_grain_or_period(self):
        result = self.run_js(r'''
const old=ensure();state.subject='B';const latest=ensure();
pending[1](board('week','26WK43'));await latest;
pending[0](board('day','2025-05-01'));await old;
console.log(JSON.stringify(state));
''')
        self.assertEqual((result['subject'], result['grain'], result['period']), ('B', 'week', '26WK43'))

    def test_old_raw_link_reopens_forecast_and_discards_stale_period(self):
        result = self.run_js(r'''
const old=ensure();state.module='raw';const latest=ensure();
pending[1](board('week','26WK43'));await latest;
pending[0](board('day','2025-05-01'));await old;
console.log(JSON.stringify(state));
''', forecast=True)
        self.assertEqual((result['module'], result['grain'], result['period']), ('sales_forecast', 'week', '26WK43'))

    def test_returning_to_same_subject_discards_first_request(self):
        result = self.run_js(r'''
const first=ensure();state.subject='B';const middle=ensure();state.subject='A';const latest=ensure();
pending[2](board('week','26WK43'));await latest;
pending[1](board('month','25-01'));await middle;
pending[0](board('day','2025-05-01'));await first;
console.log(JSON.stringify(state));
''')
        self.assertEqual((result['subject'], result['grain'], result['period']), ('A', 'week', '26WK43'))

    def test_normal_navigation_still_uses_available_default_period(self):
        result = self.run_js(r'''
const current=ensure();pending[0](board('day','2026-10-30'));await current;
console.log(JSON.stringify(state));
''')
        self.assertEqual((result['grain'], result['period']), ('day', '2026-10-30'))

    def test_obsolete_subject_handler_does_not_redraw_or_lose_new_edits(self):
        result = self.run_js(r'''
const draws=[];let editor='';
const select=new Function('captureForecastDraft','state','ensureState','renderAll','syncUrl','FORECAST_APP',
 extract('  async function selectSubject(', '  async function init()')+';return selectSubject;')(
 ()=>{},state,ensure,async()=>{draws.push(state.subject);editor='default';},()=>{},false);
const old=select('A'),latest=select('B');
pending[1](board('week','26WK43'));await latest;editor='new user input';
pending[0](board('day','2025-05-01'));await old;
console.log(JSON.stringify({draws,editor}));
''')
        self.assertEqual(result, {'draws': ['B'], 'editor': 'new user input'})

    def test_late_filters_cannot_replace_current_period_choices(self):
        result = self.run_js(r'''
const elements=new Map();
const $=selector=>{if(!elements.has(selector))elements.set(selector,{
 dataset:{},style:{},hidden:false,innerHTML:'',value:'',closest(){return this;}
});return elements.get(selector)};
const DATA={config:{grain_labels:{day:'日',week:'周',month:'月'}}};
const render=new Function('state','$','DATA','getDashboard','sortPeriods','esc','FORECAST_APP',
 extract('  async function renderFilters()','  function alignOverviewChartScrollbars()')+';return renderFilters;')(
 state,$,DATA,getDashboard,p=>p,String,false);
const old=render();state.subject='B';state.period='26WK43';const latest=render();
pending[1](board('week','26WK43'));await latest;
pending[0](board('day','2025-05-01'));await old;
console.log(JSON.stringify({periods:$('#periodSelect').innerHTML,grain:$('#grainSelect').innerHTML}));
''')
        self.assertIn('26WK43', result['periods'])
        self.assertNotIn('2025-05-01', result['periods'])

    def test_pending_auto_stage_does_not_override_manual_selection(self):
        result = self.run_js(r'''
state.module='sales_forecast';state.forecastStageAuto=true;state.forecastStage='small';
const sync=new Function('state','getDashboard','linkedForecastData','forecastDataFromBoard','forecastStageFromTarget',
 extract('  async function syncForecastStageToTarget()','  function syncUrl(')+';return syncForecastStageToTarget;')(
 state,getDashboard,x=>x,x=>x,()=> 'launch');
const old=sync();state.forecastStageAuto=false;state.forecastStage='steady';
pending[0]({target:{}});await old;console.log(JSON.stringify(state));
''')
        self.assertEqual(result['forecastStage'], 'steady')

    def test_pending_auto_stage_does_not_change_new_subject(self):
        result = self.run_js(r'''
state.module='sales_forecast';state.forecastStageAuto=true;state.forecastStage='small';
const sync=new Function('state','getDashboard','linkedForecastData','forecastDataFromBoard','forecastStageFromTarget',
 extract('  async function syncForecastStageToTarget()','  function syncUrl(')+';return syncForecastStageToTarget;')(
 state,getDashboard,x=>x,x=>x,()=> 'launch');
const old=sync();state.subject='B';pending[0]({target:{}});await old;
console.log(JSON.stringify(state));
''')
        self.assertEqual(result['forecastStage'], 'small')


if __name__ == '__main__':
    unittest.main()
