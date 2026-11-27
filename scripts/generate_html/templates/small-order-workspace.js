  function bindSmallOrderForecast(root,data,context){
    const workspace=root.querySelector('[data-small-order-workspace]');if(!workspace)return;
    const history=(data.small_order_history||[]).map(item=>item.daily_actual===false
      ? {...item,daily_orders:[],dates:[],small_progress:[],d1_share:null} : item);
    const sameModel=context.sameModel,targetState=context.targetState,findActual=context.findActual,findStageActual=context.findStageActual,today=context.todayIso;
    const setEstimate=createForecastEstimateLogger(workspace);
    const targetItem=()=>{const target=targetState(),matches=history.filter(item=>sameModel(item.generation||item.model,target.name)||sameModel(item.model,target.name));return matches.find(item=>item.small_start_date===target.smallStartDate)||matches[0]||null};
    const minimumEvidence=3;
    const smallScoreRules=[
      {key:'d1',label:'D1 小订量',rule:'D1 当天对齐发布后已结束的小时，首日结束后比较双方 D1 全天小订量。',missing:'缺少对应时段的实绩时，此项不计分。'},
      {key:'size',label:'同期累计小订量',rule:'从 D1 起比较相同完整天数的实际累计量，至少两天。',missing:'未满两个完整日或缺少同期实绩时，此项不计分。'},
      {key:'tier',label:'产品档位',rule:'完全一致100%；同为SUV、MPV或轿车85%；其他已维护档位45%。'},
      {key:'node',label:'发布类型',rule:'完全一致100%；不一致62%。'},
      {key:'energy',label:'能源类型',rule:'完全一致100%；不一致55%。'},
      {key:'days',label:'小订窗口天数',rule:'1 − |两车小订天数差| ÷ max（当前小订天数，36），最低为0%。'},
    ].map(rule=>({...rule,weight:window.ForecastMath.smallScoreWeights[rule.key]}));
    const scoreObservation=target=>{
      const event=targetItem(),start=event?.small_start_date||event?.dates?.[0];
      return window.ForecastMath.smallScoreObservation(target,today(),findActual(target.name),start===target.smallStartDate?event:null,context.generatedAt);
    };
    const scoreResult=(item,target,current)=>smallReferenceScore(item,target,current,minimumEvidence);
    const smallHourlyBucket=(actual,date)=>window.ForecastMath.asOfHourlyBucket((actual?.small_hourly_days||[]).find(row=>row.date===date),'orders',context.generatedAt);
    const hourlyContext=()=>{const target=targetState(),bucket=smallHourlyBucket(findActual(target.name),target.smallStartDate),hours=bucket?.hourly_valid===false?[]:bucket?.hours||[],startHour=window.ForecastMath.releaseHourForTarget(target,'small',hours);return {hours,startHour};};
    const ranked=(task='progress')=>{
      const target=targetState(),hourly=task==='hourly';
      const current=hourly?hourlyContext():scoreObservation(target);
      return history.filter(item=>!sameModel(item.generation||item.model,target.name)&&window.ForecastMath.smallReferenceAvailable(item,task))
        .map(item=>({item,...(hourly?window.ForecastMath.smallHourlyReferenceScore(item,current):scoreResult(item,target,current))}))
        .filter(row=>row.parts.length)
        .sort((a,b)=>(hourly?0:Number(b.eligible)-Number(a.eligible))||b.score-a.score);
    };
    const selects=[...workspace.querySelectorAll('[data-small-ref]')],weights=[...workspace.querySelectorAll('[data-small-weight]')];
    const groups={progress:{selects,weights},daily:{selects:[...workspace.querySelectorAll('[data-small-daily-ref]')],weights:[...workspace.querySelectorAll('[data-small-daily-weight]')]},hourly:{selects:[...workspace.querySelectorAll('[data-small-hourly-ref]')],weights:[...workspace.querySelectorAll('[data-small-hourly-weight]')]}};
    const referenceDailyShape=(item,index,days)=>{const factors=context.factors('small'),factor=i=>factors[context.calendarType(item.small_start_date||item.dates?.[0]||'',i).type]||1,orders=window.ForecastMath.adaptSmallDailyOrders(item,days,factor),first=orders[0];return first>0?orders[index]/first:NaN;};
    groups.slope={selects:[...workspace.querySelectorAll('[data-small-slope-ref]')],weights:[...workspace.querySelectorAll('[data-small-slope-weight]')]};
    const itemKey=item=>item.event_id||item.model;
    const stageEligible=(item,stage)=>stage.key==='d1'?(Number(item.d1_share)>0&&(item.small_hourly_curve||[]).some(Number)):stage.key==='active'?(item.small_progress||[]).some(Number):true;
    const initializeReferences=()=>{const target=targetState();Object.entries(groups).forEach(([task,group])=>{const rows=ranked(task).filter(row=>row.eligible&&(task==='hourly'||task==='slope'||(task==='daily'?referenceDailyShape(row.item,0,target.smallDays)>0:(stageEligible(row.item,{key:'active'})&&rebasedForecastCompletionCurve(row.item,'small_progress',target.smallDays).some(Number.isFinite)))));group.selects.forEach((select,index)=>{[...select.options].forEach(option=>option.disabled=!!option.value&&(sameModel(option.dataset.model||option.textContent,target.name)||lifecycleUnavailable(task,history.find(item=>itemKey(item)===option.value)||{})));if(!select.value)select.value=rows[index]?itemKey(rows[index].item):'';});});};
    const selectedRefs=(task='progress')=>{const group=groups[task]?.selects.length?groups[task]:groups.progress;return group.selects.map((select,index)=>({item:history.find(candidate=>itemKey(candidate)===select.value),weight:Math.max(Number(group.weights[index]?.value||0),0)})).filter(row=>row.item&&window.ForecastMath.smallReferenceAvailable(row.item,task)&&row.weight>0);};
    const weightedValue=(getter,fallback=NaN,task='progress')=>window.ForecastMath.weightedObserved(selectedRefs(task).map(row=>({value:getter(row.item),weight:row.weight})),fallback);
    const stageFor=target=>window.ForecastMath.smallStage(target,today());
    const referenceCompletion=(day,days)=>weightedValue(item=>rebasedForecastCompletion(item,'small_progress',day,days).value);
    const referenceHourlyCompletion=hour=>weightedValue(item=>window.ForecastMath.smallHourlyCurve(item,hourlyContext().startHour)[hour],NaN,'hourly');
    const renderEvidence=(target,stage,forecast)=>{
      const refs=selectedRefs(),chartRefs=lifecycleChartReferences(workspace.querySelector('[data-lifecycle-reference="small-progress"]'),history,refs),body=refs.map(({item},index)=>`<div><b>${index?'辅助':'主参考'} · ${esc(item.model)}</b><span>最终小订 ${fmt(item.total)}单</span><span>周期 ${item.days||0}天</span><span>D1占比 ${Number.isFinite(item.d1_share)?(item.d1_share*100).toFixed(1)+'%':'—'}</span><span>D1分时 ${(item.small_hourly_curve||[]).some(Number)?'可用':'缺失'}</span></div>`).join('');
      const days=Math.max(Number(forecast?.targetDays||target.smallDays||1),1),labels=Array.from({length:days},(_,index)=>`D${index+1}`),total=Number(forecast?.total||0),evidence=window.ForecastMath.smallDailyEvidence({rows:forecast.rows||[],startDate:target.smallStartDate,days,total,factor:index=>context.factors('small')[context.calendarType(target.smallStartDate,index).type]||1}),actualValues=evidence.cumulative.map((value,index)=>evidence.rows[index]?.actual?Math.min(value,1):null),forecastValues=Array(days).fill(null);
      if(!forecast.error&&total>0){evidence.cumulative.forEach((value,index)=>{if(evidence.rows[index]?.actual===false)forecastValues[index]=value;});const anchor=evidence.anchorIndex;if(anchor>=0&&forecastValues.some(Number.isFinite))forecastValues[anchor]=actualValues[anchor];}
      const chartSeries=[];if(actualValues.some(Number.isFinite))chartSeries.push({label:`${target.name} · 真实累计`,values:actualValues,color:'#2859f5',role:'actual'});if(forecastValues.some(Number.isFinite))chartSeries.push({label:`${target.name} · 预测累计`,values:forecastValues,color:'#00A878',role:'forecast',dashed:true});
      chartRefs.forEach(({item,label,color})=>chartSeries.push({label,values:rebasedForecastCompletionCurve(item,'small_progress',days),color,role:'reference'}));
      workspace.querySelector('[data-small-evidence]').innerHTML=`<div class="forecast-reference-facts">${body||'暂无有效参考车型'}</div><p>当前阶段：${esc(stage.label)}。自动推荐至少需${minimumEvidence}项有效证据；已有小订量时还需同期实绩可比。主辅权重不改变候选得分。</p>`;
      workspace.querySelector('[data-small-reference-chart]').innerHTML=renderLifecycleLineChart({series:chartSeries,labels,unit:'percent',title:'当前真实进度与主辅参考累计完成度',note:'蓝色实线为已结束完整日真实累计÷本次预测终局；绿色虚线为本次预测的后续累计。橙/紫线为主辅参考按当前小订窗口重定基的完成度，与预测使用同一条参考曲线。周期对齐：D1、D2及最后两天的日占比保持不变，中间部分按剩余周期比例拉伸后重新累计；仅对齐参考曲线，不改写历史真实销量。同长度不拉伸；不同长度且任一周期不足5天时不自动推荐该完成度参考。',ariaLabel:`${target.name}当前真实累计小订完成度与主辅参考累计曲线对比`,empty:'当前与所选参考均没有可绘制的小订累计曲线'});
      const dailyNode=workspace.querySelector('[data-small-daily-reference-chart]');
      if(dailyNode){
        const selected=selectedRefs('daily'),dailyRefs=lifecycleChartReferences(workspace.querySelector('[data-lifecycle-reference="small-daily"]'),history,selected),dailySeries=dailyRefs.map(({item,label,color})=>({label,values:Array.from({length:days},(_,index)=>referenceDailyShape(item,index,days)),color,role:'reference'}));
        const current=evidence.daily;
        const actual=current.map((value,index)=>evidence.rows[index]?.actual?value:null),predicted=current.map((value,index)=>evidence.rows[index]?.actual===false?value:null);
        const last=evidence.anchorIndex;if(last>=0&&predicted.some(Number.isFinite))predicted[last]=actual[last];
        if(actual.some(Number.isFinite))dailySeries.push({label:target.name+' · 真实',values:actual,color:'#2859f5',role:'actual'});
        if(!forecast.error&&predicted.some(Number.isFinite))dailySeries.push({label:target.name+' · 预测',values:predicted,color:'#00A878',role:'forecast',dashed:true});
        dailyNode.innerHTML=renderLifecycleLineChart({series:dailySeries,labels,unit:'percent',title:'小订每日数量相对D1（到天基础曲线）',note:'主辅基础曲线决定未来逐日形状；先剔除历史日期系数，再按当前节假日、周末、工作日系数分配，日历影响只应用一次。',ariaLabel:'小订到天基础曲线'});
      }
      const hourlyNode=workspace.querySelector('[data-small-hourly-reference-chart]');
      const slopeNode=workspace.querySelector('[data-small-slope-reference-chart]');
      if(slopeNode){
        const slopeOf=(values,start)=>window.ForecastMath.dailySlope(values.map((value,index)=>{const day=context.calendarType(start,index).date;return day<today()&&Number.isFinite(value)?value/(context.factors('small')[context.calendarType(start,index).type]||1):null;}));
        const series=lifecycleChartReferences(workspace.querySelector('[data-lifecycle-reference="small-slope"]'),history,selectedRefs('slope')).map(({item,label,color})=>({label,color,role:'reference',values:slopeOf(item.daily_orders||[],item.small_start_date)}));
        const rows=evidence.rows,values=evidence.slope;
        series.unshift({label:target.name+' · 真实斜率',color:'#2859f5',role:'actual',values:values.map((v,i)=>rows[i]?.actual?v:null)});
        if(!forecast.error)series.push({label:target.name+' · 预测斜率',color:'#00A878',role:'forecast',dashed:true,values:values.map((v,i)=>rows[i]?.actual===false?v:null)});
        const count=Math.max(days,...series.map(row=>row.values.length));
        slopeNode.innerHTML=renderLifecycleLineChart({series,slope:true,labels:Array.from({length:count},(_,i)=>'D'+(i+1)),title:'每日斜率 · 较前一天变化率（仅展示）',note:'斜率＝剔除日历影响后的当天日量÷前一天日量－1。D1、前一天为0或数据缺失时留空。进行中参考仅展示已结束真实日；此处主辅与权重仅控制对照，不参与总量或逐日分配。'});
      }
      if(hourlyNode){
        const actual=findActual(target.name),bucket=smallHourlyBucket(actual,target.smallStartDate),hourlySeries=[],ongoing=stage.key==='d1',d1Row=(forecast.actualRows||[]).find(row=>row.date===target.smallStartDate),terminal=ongoing&&!forecast.error?Number(forecast.d1):today()>target.smallStartDate?d1Row?.orders:NaN;
        const sampled=(bucket?.hourly_valid===false?[]:bucket?.hours||[]).filter(row=>Number.isInteger(row.hour)&&row.hour>=0&&row.hour<24&&Number.isFinite(row.orders)&&row.orders>=0),lastHour=sampled.length?Math.max(...sampled.map(row=>row.hour)):-1,firstHour=sampled.filter(row=>row.orders>0).reduce((start,row)=>Math.min(start,row.hour),24);
        if(sampled.length&&Number.isFinite(terminal)&&terminal>0){const byHour=new Map();sampled.forEach(row=>byHour.set(row.hour,(byHour.get(row.hour)||0)+row.orders));const values=Array(24).fill(null);let cumulative=0;for(let hour=firstHour;hour<=lastHour;hour++){cumulative+=byHour.get(hour)||0;values[hour]=cumulative/terminal;}hourlySeries.push({label:target.name+' · D1真实累计',values,color:'#2859f5',role:'actual'});}
        if(!forecast.hourly?.dailyFloorRaised&&forecast.hourly?.forecast?.some(Number.isFinite))hourlySeries.push({label:target.name+' · 后续小时预测',values:forecast.hourly.forecast,color:'#00A878',role:'forecast',dashed:true});
        lifecycleChartReferences(workspace.querySelector('[data-lifecycle-reference="small-hourly"]'),history,selectedRefs('hourly')).forEach(({item,label,color})=>{const start=window.ForecastMath.smallHourlyStart(item),values=Array.from({length:24},(_,hour)=>hour>=start&&Number.isFinite(item.small_hourly_curve?.[hour])?item.small_hourly_curve[hour]:null);if(values.some(Number.isFinite))hourlySeries.push({label:label+' · D1',values,color,role:'reference'});});
        const first=Math.min(...hourlySeries.map(row=>row.values.findIndex(Number.isFinite)).filter(hour=>hour>=0),23),hours=Array.from({length:24-first},(_,index)=>`${first+index}时`);
        const note=sampled.length?`分时数据已采集至${lastHour}时，累计${fmt(forecast.hourly?.observed??sampled.reduce((sum,row)=>sum+row.orders,0))}单。${forecast.hourly?.dailyFloorRaised?`同日最新观测为${fmt(forecast.hourly.latestObserved)}单，D1预测已按此下限抬升；新增订单的小时归属未知，暂不绘制后续小时预测。`:`按已采集累计与最近3小时增量拟合历史曲线，后续小时预测${forecast.hourly?fmt(forecast.hourly.remaining):'—'}单。${forecast.hourly?.latestObserved>forecast.hourly?.observed?`同日最新观测为${fmt(forecast.hourly.latestObserved)}单，实际累计已更新；分时曲线仍只使用已知小时数据。`:''}`}发布起点优先采用表格小订发布时段；留白才取D1首个正数订单小时，实际订单不改写。`:bucket?.hourly_valid===false?(bucket.hourly_status||'小订D1分时数据异常')+'；原始小时保留核对，不参与分时拟合。':'当前车型D1分时数据缺失，仅展示可用历史参考；不使用整日数据冒充分时。';
        hourlyNode.innerHTML=renderLifecycleLineChart({series:hourlySeries.map(row=>({...row,values:row.values.slice(first)})),labels:hours,hourly:true,unit:'percent',title:'D1 小订分时累计进度',note,ariaLabel:target.name+'小订D1分时累计与主辅参考对比',empty:note});
      }
      const observation=scoreObservation(target);
      workspace.querySelectorAll('[data-lifecycle-reference]').forEach(card=>{const task=card.dataset.lifecycleReference.split('-').at(-1),rows=selectedRefs(task);card.querySelector('[data-lifecycle-ref-reason]').innerHTML=renderLifecycleReferenceScores(rows,item=>task==='hourly'?window.ForecastMath.smallHourlyReferenceScore(item,hourlyContext()):scoreResult(item,target,observation),target.name);card._refreshLifecycleControls?.();});










      const dailyScore={
        title:'小订参考车型排名与逐项得分',orderLabel:'评分达标优先，组内按得分降序',
        referenceScope:'用于小订累计完成度、小订到天基础曲线、每日斜率（仅展示）。本榜主辅标记对应累计完成度。',
        description:'小订量相似度取同期实绩的较小值÷较大值，双方为零计100%，仅一方为零计0%。缺项按有效权重归一；当前有同期实绩而候选缺失时，该候选不自动推荐。',
        rules:smallScoreRules,rows:ranked().slice(0,10),selected:selects.map(select=>select.value),
        empty:'暂无同时具备历史最终小订和可评分字段的候选车型',minimumEvidence,weighted:true
      };
      const hourlyRules=[{key:'release_hour',label:'发布时间',weight:.2,rule:'起始小时差越小越相似，差12小时为0分。'},{key:'hour_slope',label:'小时增量斜率',weight:.5,rule:'已发生小时新增占比的差异越小越相似；不比较D1绝对量。'},{key:'hour_progress',label:'前几小时累计占比',weight:.3,rule:'各小时累计占已发生总量的比例，与历史同期归一化曲线比较。'}];
      const hourlyScore={title:'按发布时间与分时曲线选择参考',referenceScope:'用于 D1 小订分时预测。',description:'比较发布后的相对小时；发布时间20%、小时增量斜率50%、累计占比30%。缺项后按有效权重归一。',rules:hourlyRules,rows:ranked('hourly').slice(0,10),selected:groups.hourly.selects.map(select=>select.value),empty:'暂无可比较的真实分时曲线',minimumEvidence:1,weighted:true};
      workspace.querySelector('[data-small-score]').innerHTML=renderLifecycleScorePage(dailyScore,hourlyScore);
    };
    const enforceDistinctRefs=()=>{const used=new Set();selects.forEach(select=>{if(select.value&&used.has(select.value))select.value='';if(select.value)used.add(select.value)});selects.forEach(select=>{for(const option of select.options)option.disabled=!!option.value&&(sameModel(option.dataset.model||option.textContent,targetState().name)||selects.some(other=>other!==select&&other.value===option.value))})};
    const update=()=>{enforceDistinctRefs();const target=targetState(),stage=stageFor(target),current=targetItem(),actual=findActual(target.name),transition=findStageActual(target.name,'before'),transitionTotal=Number(transition?.total_small||0),transitionSource=transition?.field_sources?.['总小订']||transition?.selected_source_label||'数据缺失',targetDays=Math.max(stage.days||target.smallDays||current?.daily_orders?.length||1,1),refs=selectedRefs();
      const stageLabel=stage.key==='active'?`${stage.label} · D${stage.day}`:stage.label,error=root.querySelector('[data-small-error]');let message='',confidence='中置信度',d1=NaN,total=0,actualTotal=0,completion=NaN,intradayFloorInfo='',hourly=null,finalSource=transitionSource;
      setForecastStageSummary(root,'small',stageLabel,'按小订日期校验已结束完整日；最终总小订由预测得出。');
      const dates=current?.dates||[],daily=current?.daily_orders||[],fallback=current?.daily_actual===true?daily.map((orders,index)=>({date:dates[index],orders})):[],checked=completedSmallOrderDays(target.smallStartDate,target.smallEndDate,today(),actual?.small_daily_days||[],fallback),actualRows=checked.rows;actualTotal=actualRows.length?actualRows.reduce((sum,row)=>sum+row.orders,0):NaN;
      // Known D1 observations remain actuals even when forecasting lacks an
      // hourly curve or reference. Snapshots overlap; never add their totals.
      let d1DailyObserved=NaN;
      if(stage.key==='d1'&&target.hasSmall!==false){
        const dailySnapshot=source=>{const rows=source.filter(row=>row.date===target.smallStartDate);return rows.length===1?window.ForecastMath.observedQuantity(rows[0].orders):NaN;};
        d1DailyObserved=[dailySnapshot(actual?.small_daily_days||[]),dailySnapshot(fallback)].find(Number.isFinite)??NaN;
        const bucket=smallHourlyBucket(actual,target.smallStartDate),hours=bucket?.hours||[];
        const hourlyKnown=bucket?.hourly_valid!==false&&hours.length&&hours.every(row=>Number.isInteger(row.hour)&&row.hour>=0&&row.hour<24&&Number.isFinite(row.orders)&&row.orders>=0);
        const snapshots=[d1DailyObserved,bucket?.hourly_valid===false?null:bucket?.orders,hourlyKnown?hours.reduce((sum,row)=>sum+row.orders,0):null].map(window.ForecastMath.observedQuantity).filter(Number.isFinite);
        actualTotal=snapshots.length?Math.max(...snapshots):NaN;
      }
      if(target.hasSmall===false){message='该车型没有小订阶段，直接进入大定；不需要小订数量或转化率。';}
      else if(target.windowInputErrors?.small){message=target.windowInputErrors.small;}
      else if(stage.key==='unknown'){message=!target.smallStartDate?'小订开始日期未维护，无法确定小订预测窗口。':!target.smallEndDate?'小订结束日期未维护，无法确定小订预测窗口。':'小订结束日期早于开始日期，请核对时间窗口。';}
      else if(checked.error){message=checked.error;}else if(stage.key==='active'&&checked.missing.length){
        const latest=actualRows.at(-1)?.date||'',present=new Set([...(actual?.small_daily_days||[]),...fallback].map(row=>row.date)),unupdated=latest?checked.missingDates.filter(day=>day>latest&&!present.has(day)):[],gaps=checked.missingDates.filter(day=>!unupdated.includes(day));
        message=[gaps.length?`已结束日小订数量缺失或无效：${forecastDateRanges(gaps)}（共${gaps.length}天）`:'',unupdated.length?`小订尚未更新：${forecastDateRanges(unupdated)}（最新完整真实日${latest}）；未更新日期不补0`:'','仅需要过去完整日，不要求最终总小订'].filter(Boolean).join('；');
      }else if(!refs.length&&stage.key!=='ended'){message='没有达到要求的可比小订历史，无法形成预测。'}else if(stage.key==='before'){
        const estimates=refs.map(({item,weight})=>{const value=Number(item.total||0);return {value,weight}}).filter(row=>row.value>0),weightTotal=estimates.reduce((sum,row)=>sum+row.weight,0);total=weightTotal?estimates.reduce((sum,row)=>sum+row.value*row.weight,0)/weightTotal:0;d1=total*weightedValue(item=>item.d1_share);confidence='低置信度 · 尚无本车型实绩';
      }else if(stage.key==='d1'){
        const bucket=smallHourlyBucket(actual,target.smallStartDate);if(bucket?.hourly_valid===false){message=bucket.hourly_status||'小订D1分时数据异常，暂不参与拟合。';}else if(!bucket?.hours?.length){message='小订D1分时数据缺失，当前不使用完整日数据冒充分时快照。';}else{hourly=window.ForecastMath.smallHourlyForecast({hours:bucket.hours,references:selectedRefs('hourly'),startHour:hourlyContext().startHour});if(hourly.error)message=hourly.error;else{
          // A newer daily snapshot is a lower bound, not an hourly observation.
          // Overlapping day/hour snapshots must never be added or assigned to D2.
          const dailyObserved=d1DailyObserved;
          actualTotal=Math.max(hourly.observed,...[dailyObserved,bucket.orders].map(window.ForecastMath.observedQuantity).filter(Number.isFinite));
          d1=Math.max(hourly.total,actualTotal);hourly.latestObserved=actualTotal;hourly.dailyFloorRaised=d1>hourly.total;
          if(hourly.dailyFloorRaised)intradayFloorInfo=`同日最新观测${fmt(actualTotal)}单，D1预测已按此下限抬升；重叠快照不相加，当日仍未结束。`;
          const d1Share=referenceCompletion(1,targetDays);if(!Number.isFinite(d1Share)||d1Share<=0)message='所选累计参考缺少有效D1占比，无法由D1推算总小订。';else{total=targetDays===1?d1:d1/d1Share;completion=actualTotal/Math.max(total,1);confidence='中高置信度 · 已发生＋剩余小时预测';}}}
      }else if(stage.key==='ended'){
        const maintained=current?.reported_total===0?0:current?.total_complete!==false?current?.total:null;
        const daySum=actualRows.length&&!checked.missing.length?actualTotal:null;
        total=(transitionTotal>0?transitionTotal:null)??maintained??daySum??NaN;
        d1=actualRows.find(row=>row.date===target.smallStartDate)?.orders??NaN;
        if(Number.isFinite(total))actualTotal=total;
        completion=total>0?1:NaN;confidence='真实终值';
        if(!Number.isFinite(total))message='小订期已结束，但汇总中没有明确最终总量或完整真实日合计。';
      }else{
        if(!actualRows.length){message='小订D1已过，但汇总中没有已结束日期的真实小订。'}else{completion=referenceCompletion(checked.expected,targetDays);if(!Number.isFinite(completion)||completion<=0)message=`参考车型D${checked.expected}累计完成率不可用。`;else{total=Math.max(actualTotal,actualTotal/completion);d1=actualRows[0].orders;confidence=actualRows.length>=3?'高置信度 · 真实进度':'中置信度 · 早期进度';}}
      }
      total=Math.round(total);d1=Number.isFinite(d1)?Math.round(d1):NaN;const rows=[...actualRows];
      if(!message&&stage.key!=='ended'){
        if(stage.key==='d1'&&Number.isFinite(d1))rows.push({label:'D1',date:target.smallStartDate,orders:d1,actual:false,partial:true,observed:actualTotal});
        const startIndex=rows.length,indices=Array.from({length:Math.max(targetDays-startIndex,0)},(_,i)=>startIndex+i),calendar=context.calendarType,factors=context.factors('small');
        const shape=index=>weightedValue(item=>referenceDailyShape(item,index,targetDays),NaN,'daily');
        const anchor=rows.at(-1),result=context.planBridge('small',{remaining:Math.max(total-rows.reduce((sum,row)=>sum+row.orders,0),0),anchor:anchor?.orders??null,anchorDate:anchor?.date||'',anchorShape:anchor?shape(startIndex-1):1,dates:indices.map(i=>calendar(target.smallStartDate,i).date),shapes:indices.map(shape)});
        if(result.error)message=result.error;
        else {
          let allocated=result.values,observed=0;
          if(stage.key==='active'){
            const date=today(),buckets=actual?.small_hourly_days||[];
            const daily=actual?.small_daily_days?.find(row=>row.date===date)?.orders;
            const bucket=smallHourlyBucket(actual,date);
            observed=Math.max(0,...[daily,bucket?.hourly_valid===false?null:bucket?.orders].map(window.ForecastMath.observedQuantity).filter(Number.isFinite));
            let projected=null;
            if(window.ForecastMath.usableHourlySnapshot(bucket,'orders')){
              const own=window.ForecastMath.intradayReference({buckets,days:actualRows,today:date,launchDate:target.smallStartDate,metric:'orders',dayType:day=>calendar(day,0).type});
              const ownRate=own.curve[bucket.last_hour];
              const rate=ownRate>0?ownRate:referenceHourlyCompletion(bucket.last_hour);
              if(rate>0 && rate<=1){
                projected=bucket.orders/rate;
                intradayFloorInfo=`截至${bucket.last_hour}时累计${fmt(bucket.orders)}单，按${ownRate>0?'本车型完整日':'参考车型D1'}同期完成率${(rate*100).toFixed(1)}%推算全天，保留同日实绩下限。`;
              }else{
                intradayFloorInfo='当前采集小时缺少可用的同期完成率，保留逐日预测和当日实绩下限。';
              }
            }
            allocated=window.ForecastMath.allocateIntraday(result.values,observed,projected);
            total=actualTotal+allocated.reduce((sum,value)=>sum+value,0);
            if(!intradayFloorInfo&&observed>Number(result.values[0]||0))intradayFloorInfo=`当日已发生${fmt(observed)}单，全天预测已按此下限调整。`;
          }
          allocated.forEach((orders,i)=>rows.push({label:`D${indices[i]+1}`,date:calendar(target.smallStartDate,indices[i]).date,orders,actual:false,observed:stage.key==='active'&&i===0?observed:undefined}));
        }
      }
      if(stage.key==='ended'&&!(transitionTotal>0))finalSource=current?.reported_total!=null||current?.total_complete?current.total_source||'车型汇总':'完整真实日合计';
      const displayActual=Number.isFinite(actualTotal)?actualTotal:current?.reported_total;
      const setKpi=(key,value,suffix='')=>{const node=workspace.querySelector(`[data-small-kpi="${key}"]`);if(node)node.textContent=value};setKpi('d1',message||!Number.isFinite(d1)?'—':fmt(d1));setKpi('total',message?'—':fmt(total));setKpi('actual',Number.isFinite(displayActual)?fmt(displayActual):'—');setKpi('completion',message||!Number.isFinite(completion)?'—':(completion*100).toFixed(1));workspace.querySelector('[data-small-confidence]').textContent=message?(target.hasSmall===false?'无小订阶段':'预测条件不足'):confidence;workspace.querySelector('[data-small-chart]').innerHTML=message?(actualRows.length?renderLifecycleBars(actualRows,'orders'):'<div class="empty-image">暂无可绘制的小订数据，具体原因见上方提示</div>'):renderLifecycleBars(rows,'orders');showForecastCondition(error,{stage:'小订预测',state:target.hasSmall===false?'不适用':'条件不足',reasons:[message],impact:target.hasSmall===false?'不执行小订预测；首销和平销仍可预测。':'小订暂不输出预测；已知实际小订保留。'});const source=workspace.querySelector('[data-small-source]'),sourceText=message?message:stage.key==='before'?`按主辅参考最终小订量级测算；不把预测值当作真实进度。`:stage.key==='d1'?'按有效分时快照拟合D1全天，同日最新观测作为下限；再按参考D1占比推算最终总小订。':stage.key==='ended'?`小订期已结束，真实日量按“整理表→小订选配比例→小订退订分时汇总”取值；最终总小订取自${finalSource}。${actualRows.length?'逐日走势取自真实日量。':'当前缺少真实逐日小订。'}`:`已发生${actualRows.length}个完整日，真实累计${fmt(actualTotal)}单 ÷ 参考同期完成率${Number.isFinite(completion)?(completion*100).toFixed(1)+'%':'—'}。`;source.textContent=sourceText+(intradayFloorInfo?' '+intradayFloorInfo:'');setForecastStageSummary(root,'small',stageLabel,source.textContent);
      setEstimate('small_before_estimate',stage.key==='before'&&!message?`${target.name} | 小订终局总量为估算：主辅参考加权；D1=总量×参考D1占比`:'');
      setEstimate('small_d1_extrapolation',stage.key==='d1'&&!message?`${target.name} | D1全天=max(分时拟合${fmt(hourly?.total||0)}, 同日最新观测${fmt(actualTotal)})；总小订=D1÷累计参考D1占比`:'');
      setEstimate('small_active_completion',stage.key==='active'&&!message&&Number.isFinite(completion)?`${target.name} | 小订终局总量=真实累计${fmt(actualTotal)}÷参考同期完成率${(completion*100).toFixed(1)}%`:'');
      root._smallForecastResult={name:target.name,stage:stage.key,total:message?null:total,error:message,date:today(),rows};
      renderEvidence(target,stage,{total,actualRows,targetDays,rows,d1,hourly,error:message});context.onForecast?.();};
    root._smallForecastRefreshReferences=()=>{workspace.querySelectorAll('[data-small-ref],[data-small-daily-ref],[data-small-hourly-ref],[data-small-slope-ref]').forEach(select=>{if(!root._forecastTouched?.has(forecastDraftControlKey(select)))select.value='';});initializeReferences();refreshLifecycleRecommendationCharts(workspace,root);};
    initializeReferences();[...workspace.querySelectorAll('[data-small-input]')].forEach(control=>control.oninput=control.onchange=update);bindLifecycleReferenceCards(workspace,root,update);root._smallForecastUpdate=update;update();
  }
