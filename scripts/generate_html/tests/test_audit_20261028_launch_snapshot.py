"""Daily and hourly launch snapshots describe overlapping, known orders."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('node'), 'Node.js required')
class LaunchSnapshotTests(unittest.TestCase):
    def evaluate(self, cases):
        script = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert'),math=require('./templates/forecast-math.js');
const source=require('./tests/template_source.cjs').readTemplate('templates/dashboard.js');
const section=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i+a.length);assert(i>=0&&j>i);return source.slice(i,j)};
const estimate=section('      const partialSmallRatio=', '      const validQuantity=');
const build=section('      const buildRows=(scenario,availableScenario,method)=>', '      const scenarios=');
function run(input){
 const day=input.day??null,hour=input.hour??null,hasSmall=input.hasSmall!==false,d1=!!input.d1;
 const latestHourly=hour?{last_hour:12,hours:[{hour:12,gross:hour.gross}],...hour}:null;
 const fixed=d1?[]:[{index:0,date:'2026-01-01',gross:100,small_to_big:hasSmall?50:0,direct:hasSmall?50:100,lock:0}];
 const share=hasSmall?.5:0,days=input.days??3,todayIndex=d1?0:1;
 const dateAt=i=>new Date(Date.parse('2026-01-01T00:00:00Z')+i*86400000).toISOString().slice(0,10);
 const ctx={window:{ForecastMath:math},root:{},actual:{},slotWeight:()=>1,refs:{daily:[],small_progress:[],direct_progress:[],
   hourly:input.noCurve?[]:[{hourly_curve:Array(24).fill(input.completion??1)}]},
  target:{hasSmall,days,launchDate:'2026-01-01'},hasSmall,small:10000,
  stageInfo:{key:'active'},todayRow:day,latestHourly:latestHourly?{...latestHourly,date:dateAt(todayIndex)}:null,noPartial:!!input.noPartial,
  todayIndex,dayIndex:todayIndex,elapsed:todayIndex,actualSmall:fixed.reduce((s,r)=>s+r.small_to_big,0),actualDirect:fixed.reduce((s,r)=>s+r.direct,0),
  partialFactor:input.completion??1,defaultSmallShare:share,baseShare:1-share,
  weighted:(a,b,c)=>c,dailyComponentShare:(a,b,c,d)=>d,resolvedFixed:fixed,
  endedComplete:false,d1InputError:'',lockRate:.1,observedLockFloor:0,
  calendarType:(start,i)=>({date:dateAt(i),type:'workday'}),dailyShape:()=>1,
  bridgeSettings:()=>({factors:{workday:1}}),calendarCompletedDays:todayIndex,
  planBridge:(_r,_c,_s,p)=>math.anchoredAllocate({...p,anchorFactor:1,factors:p.dates.map(()=>1),weights:math.defaultBridgeWeights(p.dates.length)}),
  d1Unavailable:!!input.noPartial,today:dateAt(todayIndex),validQuantity:v=>Number.isFinite(math.observedQuantity(v)),
  recomposeSources:()=>{}};
 vm.createContext(ctx);
 const pick=section("      let partial=stageInfo.key==='active'", "      const fixed=indexedDays");
 const hourlyCompletion=section('    const hourlyCompletion=', '    const distribute=');
 const curveGuard=section('      const ownHourly=', '      const sum=field');
 vm.runInContext(pick+'if(noPartial)partial=null;'+hourlyCompletion+curveGuard+estimate+build+`;globalThis.estimate=partialEstimate;
  globalThis.scenario=window.ForecastMath.launchParameterTerminal({rawDataError:false,endedComplete:false,componentsReady:true,
   hasSmall,small:hasSmall?100:0,baseConversion:1,baseShare:.5,directD1:100,d1Ratio:1,
   actualSmall,actualDirect,actualGross:actualSmall+actualDirect,anchorSmall,anchorDirect});
  globalThis.rows=buildRows(scenario,scenario.available,'parameter');`,ctx);
 return {estimate:ctx.estimate,scenario:ctx.scenario,rows:ctx.rows};
}
console.log(JSON.stringify(JSON.parse(process.argv[1]).map(run)));
'''
        result = subprocess.run(['node', '-e', script, json.dumps(cases)], cwd=ROOT,
                                text=True, capture_output=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def assert_conserved(self, result, gross, small, direct):
        estimate, scenario, rows = result['estimate'], result['scenario'], result['rows']
        self.assertGreaterEqual(estimate['gross'], gross)
        self.assertGreaterEqual(estimate['observedSmall'], small)
        self.assertGreaterEqual(estimate['observedDirect'], direct)
        self.assertEqual(estimate['observed'], estimate['observedSmall']+estimate['observedDirect'])
        self.assertEqual(sum(r['gross'] for r in rows), scenario['gross'])
        self.assertTrue(all(r['gross'] == r['small_to_big']+r['direct'] for r in rows))
        self.assertTrue(scenario['available'])

    def test_newer_daily_snapshot_bounds_both_components_and_terminal(self):
        result = self.evaluate([{'hour': {'gross': 200, 'small_to_big': 100, 'direct': 100},
                                 'day': {'gross': 800, 'small_to_big': 400, 'direct': 400}}])[0]
        self.assert_conserved(result, 800, 400, 400)
        self.assertEqual(result['scenario']['gross'], 900)
        self.assertEqual(result['rows'][0]['gross'], 100)
        self.assertEqual(result['rows'][1]['gross'], 800)
        self.assertFalse(result['rows'][1]['actual'])

    def test_open_day_without_timed_sales_keeps_normal_daily_forecast(self):
        results = self.evaluate([
            {}, {'day': {'gross': None, 'small_to_big': None, 'direct': None}},
            {'day': {'gross': 0, 'small_to_big': 0, 'direct': 0}},
            {'hour': {'gross': 0}, 'day': {'gross': 0}},
        ])
        for result in results:
            today = result['rows'][1]
            self.assertTrue(today['current_estimate'])
            self.assertFalse(today.get('partial'))
            self.assertEqual(today['gross'], results[0]['rows'][1]['gross'])
            self.assertGreater(today['gross'], 0)
            self.assertEqual(result['scenario']['gross'], 200)

    def test_open_day_estimate_uses_only_hourly_volume_for_extrapolation(self):
        timed, untimed = self.evaluate([
            {'hour': {'gross': 60, 'small_to_big': 30, 'direct': 30}, 'completion': .5},
            {'day': {'gross': 150, 'direct': 75, 'small_to_big': 75}, 'completion': .5},
        ])
        self.assertEqual(timed['rows'][1]['gross'], 120)
        self.assertTrue(timed['rows'][1]['partial'])
        self.assertEqual(untimed['rows'][1]['gross'], 150)
        self.assertTrue(untimed['rows'][1]['current_estimate'])
        self.assertEqual(untimed['scenario']['gross'], 250)

    def test_open_day_with_timed_sales_but_no_curve_uses_daily_plan_and_floor(self):
        base, missing, raised = self.evaluate([
            {'noCurve': True},
            {'hour': {'gross': 10}, 'noCurve': True},
            {'hour': {'gross': 150}, 'noCurve': True},
        ])
        today = missing['rows'][1]
        self.assertEqual(today['gross'], base['rows'][1]['gross'])
        self.assertGreater(today['gross'], 10)
        self.assertTrue(today['current_estimate'])
        self.assertFalse(today.get('partial'))
        self.assertEqual(raised['rows'][1]['gross'], 150)
        self.assertTrue(raised['rows'][1]['current_estimate'])
        for field in ('date', 'gross', 'small_to_big', 'direct', 'lock', 'actual'):
            self.assertEqual(raised['rows'][0][field], base['rows'][0][field])

    def test_overlapping_snapshots_are_not_summed_or_extrapolated_twice(self):
        results = self.evaluate([{'hour': {'gross': 200, 'small_to_big': 100, 'direct': 100},
                                  'day': {'gross': 800, 'small_to_big': 400, 'direct': 400}, 'completion': .5},
                                 {'hour': {'gross': 800, 'small_to_big': 400, 'direct': 400},
                                  'day': {'gross': 200, 'small_to_big': 100, 'direct': 100}},
                                 {'hour': {'gross': 800, 'small_to_big': 400, 'direct': 400},
                                  'day': {'gross': 800, 'small_to_big': 400, 'direct': 400}}])
        for result in results:
            self.assert_conserved(result, 800, 400, 400)
            self.assertEqual(result['estimate']['gross'], 800)
            self.assertEqual(result['scenario']['gross'], 900)

    def test_missing_or_invalid_snapshot_keeps_known_source_and_real_zero(self):
        for invalid in (None, '', ' ', True, False, -1, 'NaN', 'Infinity'):
            with self.subTest(value=invalid):
                result = self.evaluate([{'hour': {'gross': invalid, 'small_to_big': invalid, 'direct': invalid},
                                         'day': {'gross': 800, 'small_to_big': 0, 'direct': 800}}])[0]
                self.assert_conserved(result, 800, 0, 800)
                self.assertEqual(result['estimate']['small'], 0)

    def test_each_source_can_supply_known_component_lower_bounds(self):
        result = self.evaluate([{'hour': {'gross': 800, 'small_to_big': 100},
                                 'day': {'small_to_big': 400, 'direct': 400}}])[0]
        self.assert_conserved(result, 800, 400, 400)
        self.assertEqual(result['estimate']['gross'], 800)
        self.assertEqual(result['estimate']['small'], 400)
        self.assertEqual(result['estimate']['direct'], 400)

    def test_hourly_projection_above_snapshot_remains_a_forecast(self):
        result = self.evaluate([{'hour': {'gross': 200, 'small_to_big': 100, 'direct': 100},
                                 'day': {'gross': 300, 'small_to_big': 0, 'direct': 300}, 'completion': .25}])[0]
        self.assert_conserved(result, 300, 100, 300)
        self.assertEqual(result['estimate']['gross'], 800)
        self.assertEqual(result['estimate']['observed'], 400)

    def test_d1_without_usable_hourly_curve_still_respects_daily_snapshot(self):
        result = self.evaluate([{'d1': True, 'noPartial': True,
                                 'hour': {'gross': 100, 'small_to_big': 50, 'direct': 50},
                                 'day': {'gross': 800, 'small_to_big': 400, 'direct': 400}}])[0]
        self.assert_conserved(result, 800, 400, 400)
        self.assertEqual(result['rows'][0]['gross'], 800)
        self.assertFalse(result['rows'][0]['actual'])

    def test_intraday_estimate_sets_final_day_total_and_respects_current_hour(self):
        last = self.evaluate([{'days': 2, 'hour': {'gross': 10}, 'completion': .5}])[0]
        self.assertEqual(last['rows'][1]['gross'], 20)
        self.assertEqual(last['scenario']['gross'], 120)

        script = r"""
const m=require('./templates/forecast-math.js'),assert=require('node:assert/strict');
const bucket={date:'2026-11-24',last_hour:23,orders:40,hours:[{hour:10,orders:40},{hour:23,orders:0}]};
const result=m.asOfHourlyBucket(bucket,'orders','2026-11-24T10:55:00');
assert.equal(result.last_hour,10);
assert.equal(bucket.last_hour,23);
assert(m.usableHourlySnapshot(result,'orders'));
assert(!m.usableHourlySnapshot({...result,orders:0},'orders'));
const history=m.intradayReference({buckets:[{date:'2026-11-23',hours:[{hour:10,orders:50},{hour:18,orders:50}]}],
  days:[{date:'2026-11-23',orders:100}],launchDate:'2026-11-20',today:'2026-11-24',metric:'orders'});
assert.equal(history.curve[10],.5);
assert.deepEqual(m.allocateIntraday([120,80],40,result.orders/history.curve[10]),[80,120]);
assert.deepEqual(m.allocateIntraday([120],40,80),[80]);
assert.deepEqual(m.allocateIntraday([120,80],0,null),[120,80]);
assert.deepEqual(m.allocateIntraday([120,80],170,80),[170,30]);
"""
        run = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_final_launch_day_and_no_reservation_preserve_total(self):
        results = self.evaluate([{'days': 2, 'hour': {'gross': 200}, 'day': {'gross': 800}},
                                 {'hasSmall': False, 'hour': {'gross': 200}, 'day': {'gross': 800}}])
        for result in results:
            self.assert_conserved(result, 800, 0, 0)
            self.assertEqual(result['scenario']['gross'], 900)
        self.assertEqual(results[1]['scenario']['small'], 0)
        self.assertEqual(results[1]['rows'][1]['direct'], 800)

    def test_duplicate_or_older_snapshots_keep_existing_rounding_and_inputs(self):
        script = r'''
const assert=require('assert'),m=require('./templates/forecast-math.js');
for(let i=0;i<1000;i++){
 const small=i%101,direct=i%83,source={gross:small+direct,small_to_big:small,direct};
 const before=JSON.stringify(source),completion=(i%99+1)/100,share=(i%101)/100;
 const baseline=m.intradayComponents(source,completion,share);
 assert.deepStrictEqual(m.intradayComponents(source,completion,share,[source]),baseline);
 assert.deepStrictEqual(m.intradayComponents(source,completion,share,[{gross:0,small_to_big:0,direct:0}]),baseline);
 assert.equal(JSON.stringify(source),before);
}
'''
        result = subprocess.run(['node', '-e', script], cwd=ROOT, text=True,
                                capture_output=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
