  function bindSteadyForecast(root,data,context){
    const workspace=root.querySelector('[data-steady-workspace]');if(!workspace)return;
    const history=data.steady_history||[],launchHistory=[...data.steady_launch_history||[],...data.history||[]],sameModel=context.sameModel,targetState=context.targetState;
    const setEstimate=createForecastEstimateLogger(workspace);
    const targetSteady=target=>history.find(item=>sameModel(item.generation||item.model,target.name)||sameModel(item.model,target.name));
    const targetLaunch=target=>launchHistory.find(item=>sameModel(item.generation||item.model,target.name)||sameModel(item.model,target.name));
    const minimumEvidence=3;
    const steadyScoreRules=[
      {key:'tier',label:'产品档位',weight:.05,rule:'完全一致100%；其他已维护档位50%。'},
      {key:'energy',label:'能源类型',weight:.05,rule:'完全一致100%；不一致55%。'},
      {key:'node',label:'发布类型',weight:.05,rule:'完全一致100%；不一致62%。'},
      {key:'lock',label:'首销期大定到锁单率',weight:.1,rule:'1 − |当前锁单率 − 历史锁单率|，结果限制在0～100%。'},
      {key:'launch_shape',label:'全首销直接大定曲线',weight:.55,rule:'全周期按相对进度适配，仅比较当前已有真实段；日历还原后比较归一化形状，不比较绝对量。'},
      {key:'steady_shape',label:'平销实际趋势',weight:.2,rule:'以首销开始日为起点，每7天一周，仅比较双方完整的同龄周，剔除日历影响并归一，不比较绝对量。'},
    ];
    const directFeature=(item,target=null)=>{
      const launch=target?targetLaunch(target):launchHistory.find(row=>sameModel(row.generation||row.model,item.generation||item.model));
      const settings=context.factors('launch'),launchDate=target?.launchDate||launch?.launch_date,endDate=target?.endDate||launch?.end_date,days=target?.days||launch?.days;
      const currentRows=target?(context.findStageActual(target.name,context.todayIso()>target.endDate?'ended':'active')?.days||[]):launchDate?(launch?.daily_direct||[]).map((direct,index)=>({date:context.calendarType(launchDate,index).date,direct})):[];
      const curve=window.ForecastMath.launchDirectObservations({rows:currentRows,launchDate,endDate,days,today:context.todayIso(),factor:(_,index)=>settings[context.calendarType(launchDate,index).type]||1});
      const releaseWeeks=window.ForecastMath.releaseWeeks({rows:item?.daily||[],launchDate:target?.launchDate||launch?.launch_date,today:context.todayIso(),factor:day=>context.factors('steady')[context.calendarType(day,0).type]||1});
      return {lock_rate:launch?.lock_rate,launch_days:target?.days||launch?.days,direct_curve:curve,release_weeks:releaseWeeks,launch};
    };
    const scoreResult=(item,target)=>{
      const current=targetSteady(target),left=directFeature(current,target),right=directFeature(item);
      return steadyReferenceScore({...item,...right},target,left,minimumEvidence);
    };
    const score=(item,target)=>scoreResult(item,target).score;
    const ranked=()=>{const target=targetState();return history.filter(item=>!sameModel(item.generation||item.model,target.name)&&directFeature(item).release_weeks.length).map(item=>({item,...scoreResult(item,target)})).filter(row=>row.parts.length).sort((a,b)=>b.score-a.score)};
    const selects=[...workspace.querySelectorAll('[data-steady-ref]')],weights=[...workspace.querySelectorAll('[data-steady-weight]')];
    const itemKey=item=>item.event_id||item.model;
    const initializeReferences=()=>{const target=targetState(),rows=ranked().filter(row=>row.eligible);selects.forEach((select,index)=>{[...select.options].forEach(option=>option.disabled=!!option.value&&sameModel(option.dataset.model||option.textContent,target.name));if(!select.value)select.value=rows[index]?itemKey(rows[index].item):''})};
    const refs=()=>selects.map((select,index)=>({item:history.find(candidate=>itemKey(candidate)===select.value),weight:Math.max(Number(weights[index]?.value||0),0)})).filter(row=>row.item&&row.weight>0);
    const weighted=(getter,fallback=NaN)=>window.ForecastMath.weightedObserved(refs().map(row=>({value:getter(row.item),weight:row.weight})),fallback);
    const lockValues=item=>(item?.weeks||[]).map(row=>Number(row.lock)).filter(value=>Number.isFinite(value)&&value>=0);
    const recentAverage=item=>{const values=lockValues(item).slice(-4);return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:NaN};
    const recentRatio=item=>{const values=lockValues(item),ratios=values.slice(1).map((value,index)=>values[index]>0?value/values[index]:NaN).filter(Number.isFinite).slice(-4);return ratios.length?ratios.reduce((sum,value)=>sum+value,0)/ratios.length:NaN};
    const isoWeekLabel=value=>{const date=value?new Date(`${value}T00:00:00`):null;if(!date||Number.isNaN(date.getTime()))return '';const utc=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())),day=utc.getUTCDay()||7;utc.setUTCDate(utc.getUTCDate()+4-day);const year=utc.getUTCFullYear(),yearStart=new Date(Date.UTC(year,0,1)),week=Math.ceil((((utc-yearStart)/86400000)+1)/7);return `${String(year).slice(-2)}WK${String(week).padStart(2,'0')}`};
    const firstFutureMonday=(target,actualWeeks)=>{if(actualWeeks.length){const last=new Date(`${actualWeeks.at(-1).start_date}T00:00:00`);last.setDate(last.getDate()+7);return last}const start=target.steadyStartDate?new Date(`${target.steadyStartDate}T00:00:00`):null;if(!start||Number.isNaN(start.getTime()))return null;const day=start.getDay(),offset=(8-(day||7))%7;if(offset)start.setDate(start.getDate()+offset);return start};
    const renderEvidence=(target,actualWeeks=[])=>{
      const selected=refs(),chartRefs=lifecycleChartReferences(workspace.querySelector('[data-lifecycle-reference="steady-weekly"]'),history,selected);
      const normalize=values=>{const first=values.find(v=>Number.isFinite(v)&&v>0);return first?values.map(v=>Number.isFinite(v)?v/first:null):values.map(()=>null);};
      const currentFeature=directFeature(targetSteady(target),target),series=[];
      series.push({label:target.name+' · 首销直接大定实际',values:normalize(currentFeature.direct_curve),color:'#2859f5',role:'actual'});
      chartRefs.forEach(({item,label,color})=>series.push({label,values:normalize(directFeature(item).direct_curve),color,role:'reference'}));
      const count=Math.max(...series.map(row=>row.values.length),1);
      workspace.querySelector('[data-steady-reference-chart]').innerHTML=renderLifecycleLineChart({series,labels:Array.from({length:count},(_,i)=>'D'+(i+1)),title:'全首销直接大定曲线规律',note:'各车型先剔除日历影响，再以首个正数日归一；实际历史不改写。评分按周期适配后比较形状，不比较绝对销量。'});
      const ageSeries=chartRefs.map(({item,label,color})=>({label,color,role:'reference',weeks:directFeature(item).release_weeks}));
      ageSeries.unshift({label:target.name+' · 平销实际',color:'#2859f5',role:'actual',weeks:currentFeature.release_weeks});
      const ages=[...new Set(ageSeries.flatMap(row=>row.weeks.map(week=>week.week)))].sort((a,b)=>a-b);
      const firstAge=ages[0]||1,lastAge=ages.at(-1)||firstAge,ageAxis=Array.from({length:lastAge-firstAge+1},(_,i)=>firstAge+i);
      const commonAnchor=ages.find(age=>ageSeries.filter(row=>row.weeks.length).every(row=>row.weeks.some(week=>week.week===age&&week.level>0)));
      const transitionSeries=ageSeries.map(({weeks,...series})=>{const base=weeks.find(row=>row.week===commonAnchor)?.level;return {...series,values:ageAxis.map(age=>{const value=weeks.find(row=>row.week===age)?.level;return base>0&&Number.isFinite(value)?value/base:null;})};});
      workspace.querySelector('[data-steady-evidence]').innerHTML=renderLifecycleLineChart({series:transitionSeries,labels:ageAxis.map(age=>'发布W'+age),title:'发布后同龄周平销趋势',note:'以首销开始为D1，W1为D1–D7，W2为D8–D14。仅完整七天且锁单已收齐的平销周，剔除日历影响；共同首个正数同龄周＝100%。缺失或未结束周留空，不截取各车最近4周。',empty:'所选车型暂无共同的正数同龄完整周，不能归一比较。'});
      workspace.querySelectorAll('[data-lifecycle-reference]').forEach(card=>{card.querySelector('[data-lifecycle-ref-reason]').innerHTML=renderLifecycleReferenceScores(selected,item=>scoreResult(item,target),target.name);card._refreshLifecycleControls?.();});
      workspace.querySelector('[data-steady-score]').innerHTML=renderLifecycleScorePage({eyebrow:'平销趋势独立评分',title:'全首销直接大定与平销承接参考',description:'以全首销直接大定归一化形状为主，结合已发生平销趋势；无首销形状证据不自动推荐。',rules:steadyScoreRules,rows:ranked().slice(0,10),selected:selects.map(select=>select.value),empty:'暂无有效趋势参考',minimumEvidence,weighted:true});
    };
    const update=()=>{
      const target=targetState(),own=targetSteady(target),actualWeeks=[...(own?.weeks||[])].filter(row=>row.end_date<context.todayIso()).sort((a,b)=>String(a.start_date).localeCompare(String(b.start_date))),error=root.querySelector('[data-steady-error]'),future=[],calendar=context.calendarType,factors=context.factors('steady'),today=context.todayIso(),steadyNotStarted=!!target.steadyStartDate&&target.steadyStartDate>today,dateAt=(date,i)=>calendar(date,i).date,factor=date=>factors[calendar(date,0).type]||1;
      workspace._steadyDaily=[];
      let message='',warnings=[];
      const monday=value=>{const d=new Date(value+'T00:00:00');return dateAt(value,-((d.getDay()+6)%7))};
      const horizonStart=target.steadyStartDate>today?target.steadyStartDate:monday(today),first=target.steadyStartDate>horizonStart?target.steadyStartDate:horizonStart,weekStart=monday(first),dates=Array.from({length:28},(_,i)=>dateAt(weekStart,i)).filter(date=>date>=first),completed=dates.filter(date=>date<today),pending=dates.filter(date=>date>=today);
      const daily=new Map();for(const row of own?.daily||[])daily.set(row.date,daily.has(row.date)?null:row.lock);
      const valid=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value))&&Number(value)>=0;
      // 预测展示窗口只覆盖当前滚动的 4 周，但真实日完整性校验不能被这个窗口截断。
      // 平销开始以来的每一个已结束自然日都必须有真实锁单；否则不能把缺口静默当成预测值。
      const steadyElapsedDays=target.steadyStartDate&&target.steadyStartDate<today?Math.max(0,Math.round((new Date(`${today}T00:00:00`)-new Date(`${target.steadyStartDate}T00:00:00`))/86400000)):0,
        expectedSteadyDates=steadyElapsedDays?Array.from({length:steadyElapsedDays},(_,i)=>dateAt(target.steadyStartDate,i)):[],
        missing=expectedSteadyDates.filter(date=>!valid(daily.get(date))),yesterday=dateAt(today,-1),needsAnchor=target.steadyStartDate&&target.steadyStartDate<today;
      const compactMissingRanges=dates=>{if(!dates.length)return '';const distance=(left,right)=>Math.round((Date.parse(`${right}T00:00:00Z`)-Date.parse(`${left}T00:00:00Z`))/86400000),ranges=[],format=(start,end)=>start===end?start:`${start}～${end}（${distance(start,end)+1}天）`;let start=dates[0],previous=dates[0];for(const date of dates.slice(1)){if(distance(previous,date)===1){previous=date;}else{ranges.push(format(start,previous));start=previous=date;}}ranges.push(format(start,previous));return ranges.join('、')};
      const weekFactor=row=>Array.from({length:7},(_,i)=>factor(dateAt(row.start_date,i))).reduce((a,b)=>a+b,0);
      const normalWeeks=item=>(item?.weeks||[]).filter(row=>row.end_date<today).map(row=>Number(row.lock)/weekFactor(row));
      const normalLevel=item=>{const values=normalWeeks(item).slice(-4);return values.length?values.reduce((a,b)=>a+b,0)/values.length:NaN};
      const normalRatio=item=>{const rows=(item?.weeks||[]).filter(row=>row.end_date<today),values=normalWeeks(item),ratios=values.slice(1).map((value,i)=>values[i]>0&&Date.parse(rows[i+1].start_date)-Date.parse(rows[i].start_date)===604800000?value/values[i]:NaN).filter(Number.isFinite).slice(-4);return ratios.length?ratios.reduce((a,b)=>a+b,0)/ratios.length:NaN};
      const launchProfile=context.findStageActual(target.name,today>target.endDate?'ended':'active');
      // Remove the calendar effect of the source stage before applying steady factors.
      const launchCalendarFactor=date=>context.factors('launch')[calendar(date,0).type]||1;
      const upstream=root._forecastComparison,upstreamScenario=upstream?.scenarios?.progress?.available?upstream.scenarios.progress:upstream?.scenarios?.parameter,upstreamMethod=upstreamScenario===upstream?.scenarios?.progress?'方法一':'方法二';
      const projectedRows=steadyNotStarted&&upstream?.name===target.name&&upstreamScenario?.available&&!upstreamScenario.bridgeError?(upstreamScenario.rows||[]).map(row=>({...row,lock:row.actual&&Number.isFinite(row.lock)?row.lock:row.gross*(upstreamScenario.gross>0?upstreamScenario.lock/upstreamScenario.gross:0)})):[];
      const projectedBaseline=window.ForecastMath.launchDirectLockBaseline({rows:projectedRows,launchDate:target.launchDate,endDate:target.endDate,today:target.steadyStartDate,factor:launchCalendarFactor});
      const useProjection=steadyNotStarted&&projectedBaseline.available;
      const launchBaseline=window.ForecastMath.launchDirectLockBaseline({rows:launchProfile?.days||[],launchDate:target.launchDate,endDate:target.endDate,today,factor:launchCalendarFactor});
      const hasLaunch=!!target.launchDate&&today>target.launchDate;
      const ownDaily=window.ForecastMath.recentSteadyBaseline({rows:own?.daily||[],startDate:target.steadyStartDate,today,factor});
      const ownLevel=normalLevel(own),ownRatio=normalRatio(own),hasOwn=ownDaily.available||Number.isFinite(ownLevel);
      const launchBasis=useProjection?projectedBaseline:launchBaseline;
      // Reference volumes become dimensionless transfer factors, never target volumes.
      const transfer=weighted(item=>{
        const feature=directFeature(item),curve=feature.direct_curve;
        if(curve.length!==Number(feature.launch_days)||!curve.every(v=>Number.isFinite(v)&&v>=0)||!(feature.lock_rate>0))return NaN;
        const directMean=curve.reduce((a,b)=>a+b,0)/curve.length;
        const relativeWeek=Math.floor((Date.parse(first)-Date.parse(target.launchDate))/604800000)+1;
        const aligned=feature.release_weeks.filter(row=>row.week>=relativeWeek&&row.week<relativeWeek+4);
        if(!aligned.length||!(directMean>0))return NaN;
        const rates=aligned.map(row=>{
          const level=Number.isFinite(row.gross_level)?row.gross_level:row.level/feature.lock_rate;
          return level/directMean;
        }).filter(Number.isFinite);
        return rates.length?rates.reduce((a,b)=>a+b,0)/rates.length:NaN;
      });
      const referenceRatio=weighted(item=>{
        const relative=Math.floor((Date.parse(first)-Date.parse(target.launchDate))/604800000)+1;
        const rows=directFeature(item).release_weeks.filter(row=>row.week>=relative&&row.week<relative+4);
        const ratios=rows.slice(1).map((row,i)=>row.week===rows[i].week+1&&rows[i].level>0?row.level/rows[i].level:NaN).filter(Number.isFinite);
        return ratios.length?ratios.reduce((a,b)=>a+b,0)/ratios.length:NaN;
      }),ownBase=ownDaily.available?ownDaily.level:ownLevel;
      const ownTrend=ownDaily.available?ownDaily.ratio:ownRatio;
      const predictedLevel=launchBasis.available?launchBasis.level*(Number.isFinite(transfer)?transfer:1):NaN;
      const actualWeight=hasOwn?(Number.isFinite(predictedLevel)?Math.min((ownDaily.days||actualWeeks.length*7)/14,1):1):0;
      const level=actualWeight===1?ownBase:actualWeight>0?ownBase*actualWeight+predictedLevel*(1-actualWeight):predictedLevel;
      const historicalTrend=Number.isFinite(referenceRatio)?referenceRatio:launchBasis.ratio;
      const ratio=actualWeight===1?(Number.isFinite(ownTrend)?ownTrend:1):actualWeight>0?(Number.isFinite(ownTrend)?ownTrend:1)*actualWeight+historicalTrend*(1-actualWeight):historicalTrend;
      const basisText=(useProjection?'首销预测全周期直接大定':'首销全周期真实直接大定')+' × 大定到锁单率'+(Number.isFinite(transfer)?' × 历史相似曲线的平销承接系数 '+transfer.toFixed(3):'；缺少可比承接窗口，暂按1倍、全曲线趋势外推（低置信度）')+'；本车型近期平销实际校准权重'+(actualWeight*100).toFixed(0)+'%';
      workspace._steadyBasis={...launchBasis,level,ratio,actualWeight,transfer,source:actualWeight>=.5?'own_steady':useProjection?'launch_forecast':'launch_direct'};
      if(!target.steadyStartDate)message='平销开始日期缺失。';
      else if(!useProjection&&!hasOwn&&!launchBaseline.available)message=launchBaseline.reason;
      else if(missing.length){
        const latest=[...daily].filter(([day,value])=>day<today&&valid(value)).map(([day])=>day).sort().at(-1)||'',unupdated=latest?missing.filter(day=>day>latest&&!daily.has(day)):[],gaps=missing.filter(day=>!unupdated.includes(day));
        message=[gaps.length?`已结束日交车锁单缺失或无效：${compactMissingRanges(gaps)}（共${gaps.length}天）`:'',unupdated.length?`交车锁单尚未更新：${compactMissingRanges(unupdated)}（最新完整真实日${latest}）；未更新日期不补0`:''].filter(Boolean).join('；');
      }
      else if(needsAnchor&&!valid(daily.get(yesterday)))message=`缺少昨天${yesterday}真实交车锁单，无法以前一天真实值衔接。`;
      else if(!Number.isFinite(level)||!Number.isFinite(ratio)||ratio<0)message='参考完整周不足，无法确定日历修正后的滚动量级与趋势。';
      const actualTotal=completed.reduce((sum,date)=>sum+(valid(daily.get(date))?Number(daily.get(date)):0),0);
      if(!message){
        const dailyRatio=Math.pow(ratio,1/7),shape=date=>Math.pow(dailyRatio,Math.round((Date.parse(date)-Date.parse(first))/86400000)),rawTarget=Math.round(dates.reduce((sum,date)=>sum+level*shape(date)*factor(date),0)),targetTotal=Math.max(rawTarget,actualTotal);
        if(rawTarget<actualTotal)warnings.push('滚动区间总量低于已实现锁单，按真实累计抬升；未来剩余为0');
        const plan=context.planBridge('steady',{remaining:targetTotal-actualTotal,anchor:needsAnchor?Number(daily.get(yesterday)):null,anchorDate:needsAnchor?yesterday:'',anchorShape:needsAnchor?shape(yesterday):1,dates:pending,shapes:pending.map(shape)});
        if(plan.error)message=plan.error;else{
          warnings.push(...plan.warnings);const todayObserved=pending[0]===today&&valid(daily.get(today))?Number(daily.get(today)):0,bounded=window.ForecastMath.applyObservedFloor(plan.values,todayObserved);if(bounded.raised)warnings.push('当日已发生锁单突破原预测，滚动总量已按真实下限抬升');const forecastByDate=new Map(pending.map((date,i)=>[date,bounded.values[i]]));
          for(let week=0;week<4;week++){const start=dateAt(weekStart,week*7),weekDates=dates.filter(date=>date>=start&&date<dateAt(start,7)),real=weekDates.filter(date=>date<today).reduce((sum,date)=>sum+Number(daily.get(date)||0),0),estimate=weekDates.filter(date=>date>=today).reduce((sum,date)=>sum+(forecastByDate.get(date)||0),0);future.push({label:isoWeekLabel(start),date:start,lock:real+estimate,actual:false,real,estimate})}
          workspace._steadyDaily=dates.map(date=>({date,lock:date<today?Number(daily.get(date)):forecastByDate.get(date),actual:date<today}));
        }
      }
      const rows=actualWeeks.filter(row=>row.end_date<weekStart).map(row=>({label:row.period,lock:row.lock,actual:true}));
      rows.push(...future.map(row=>({...row,label:`${row.label}（实际${row.real}＋预测${row.estimate}）`})));
      const blocked=!!message;
      const realRecent=(own?.daily||[]).filter(row=>row.date<today&&row.date>=target.steadyStartDate&&Number.isFinite(row.lock)).sort((a,b)=>a.date.localeCompare(b.date)).slice(-7),realMean=realRecent.length?realRecent.reduce((sum,row)=>sum+row.lock,0)/realRecent.length:NaN;
      const futureMean=pending.length?workspace._steadyDaily.filter(row=>!row.actual).reduce((sum,row)=>sum+row.lock,0)/pending.length:NaN;
      workspace.querySelector('[data-steady-kpi="daily"]').textContent=Number.isFinite(realMean)?fmt(Math.round(realMean)):'—';
      workspace.querySelector('[data-steady-kpi="change"]').textContent=!blocked&&realMean>0&&Number.isFinite(futureMean)?((futureMean/realMean-1)*100).toFixed(1):'—';
      workspace.querySelector('[data-steady-kpi="basis"]').textContent=blocked?'等待有效数据':actualWeight>=.5?'平销实际主导':'首销曲线推算主导';
      workspace.querySelector('[data-steady-kpi="total"]').textContent=blocked?'—':fmt(future.reduce((sum,row)=>sum+row.lock,0));
      workspace.querySelector('[data-steady-chart]').innerHTML=blocked?(rows.length?renderLifecycleBars(rows,'lock'):'<div class="empty-image">暂无可绘制的平销数据，具体原因见上方提示</div>'):renderLifecycleBars(rows,'lock');
      workspace.querySelector('[data-steady-confidence]').textContent=message?'预测条件不足':steadyNotStarted?'平销前预测 · 上游估算输入':'按天衔接 · 按周汇总';
      showForecastCondition(error,{stage:'平销预测',reasons:[message],impact:'平销暂不输出预测；已知实际交车锁单保留。'});
      const sourceText=message||`${basisText}。本周起4周滚动区间，已实现${fmt(actualTotal)}单；日历修正的滚动总量减去真实累计，再以前一天真实锁单衔接并渐进分配。真实日不变。${warnings.join('；')}`;
      const stageLabel=target.steadyStartDate>today?'平销尚未开始':'平销期进行中';workspace.querySelector('[data-steady-source]').textContent=sourceText;setForecastStageSummary(root,'steady',stageLabel,sourceText);renderEvidence(target,actualWeeks);
    };
    root._steadyForecastRefreshReferences=()=>{selects.forEach(select=>{if(!root._forecastTouched?.has(forecastDraftControlKey(select)))select.value='';});initializeReferences();refreshLifecycleRecommendationCharts(workspace,root);};
    initializeReferences();bindLifecycleReferenceCards(workspace,root,update);root._steadyForecastUpdate=update;update();
  }
