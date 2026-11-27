  function forecastReferenceOptions(data,selected){
    return `<option value="">证据不足时请人工选择</option>`+(data.history||[]).map(item=>`<option value="${esc(item.model)}"${item.model===selected?" selected":""}>${esc(item.model)}${item.mapped===false?' · 未映射':''}</option>`).join("");
  }
  function lifecycleReferenceOptions(history,selected=''){
    const counts=new Map();history.forEach(item=>counts.set(item.model,(counts.get(item.model)||0)+1));
    return '<option value="">证据不足时请人工选择</option>'+history.map(item=>{const key=item.event_id||item.model,date=item.small_start_date||item.steady_start_date;return `<option value="${esc(key)}" data-model="${esc(item.generation||item.model)}"${key===selected?' selected':''}>${esc(item.model)}${counts.get(item.model)>1&&date?`（${esc(date)}开始）`:''}${item.mapped===false?' · 未映射':''}</option>`}).join('');
  }
  const referenceBrand=item=>{
    const known=['问界','智界','享界','尊界','尚界'],declared=String(item.brand||'').trim();
    if(known.includes(declared))return declared;
    const inferred=known.find(brand=>[item.generation,item.model].some(name=>String(name||'').trim().startsWith(brand)));
    return inferred||(!['','界','其他','未维护','待维护','未知'].includes(declared)?declared:'其他');
  };
  const lifecycleUnavailable=(task,item)=>task==='hourly'&&!((item.small_hourly_curve||[]).some(value=>Number.isFinite(value)&&value>0));
  function renderLifecycleReferenceCard(stage,task,title,purpose,history,refAttr,weightAttr,chartAttr){
    const id=stage+'-'+task,options=lifecycleReferenceOptions(history),brands=[...new Set(history.map(referenceBrand))];
    return `<article class="forecast-ref-card" data-lifecycle-reference="${id}"><div class="forecast-ref-card-head"><div><span>${esc(title)}</span><small>${esc(purpose)}</small></div><i aria-hidden="true"></i></div><div class="forecast-ref-selects">${['主参考','辅助参考'].map((label,index)=>`<label>${label}<select ${refAttr}="${index}" data-lifecycle-ref="${id}" data-ref-slot="${index}">${options}</select></label>`).join('')}<div class="forecast-ref-weights">${['主','辅'].map((label,index)=>`${index?'<b>＋</b>':''}<label>${label}<input type="number" min="0" max="100" step="1" value="${index?30:70}" ${weightAttr}="${index}" data-lifecycle-weight="${id}" data-ref-slot="${index}"><small>%</small></label>`).join('')}<em data-lifecycle-weight-total>合计100%</em></div></div><details class="forecast-ref-score-details"><summary>查看评分对比表</summary><div class="forecast-ref-comparison" data-lifecycle-ref-reason></div></details><div class="forecast-ref-actions"><button type="button" data-lifecycle-score-jump>查看评分明细</button><details class="forecast-chart-picker"><summary>图表对比车型 <b data-lifecycle-picker-count>0项</b></summary><div class="forecast-chart-picker-panel"><div class="forecast-chart-quick">${[['primary','主辅'],['all','全选'],['none','清空']].map(([mode,label])=>`<button type="button" data-lifecycle-ref-quick="${mode}">${label}</button>`).join('')}${brands.map(brand=>`<button type="button" data-lifecycle-ref-quick="brand" data-brand="${esc(brand)}">${esc(brand)}</button>`).join('')}</div><small>额外勾选仅用于图表比较，不参与预测加权。同名后的开始日期用于区分不同传播事件。</small><div class="forecast-chart-options">${brands.map(brand=>`<fieldset><legend>${esc(brand)}</legend>${history.filter(item=>referenceBrand(item)===brand).map(item=>`<label><input type="checkbox" data-lifecycle-chart-ref="${id}" data-brand="${esc(brand)}" value="${esc(item.event_id||item.model)}"${lifecycleUnavailable(task,item)?' disabled title="该车型没有D1分时数据"':''}><span>${esc(item.model)}${lifecycleUnavailable(task,item)?' · 无D1分时数据':''}${history.filter(other=>other.model===item.model).length>1?`（${esc(item.small_start_date||item.steady_start_date||'日期未维护')}开始）`:''}</span></label>`).join('')}</fieldset>`).join('')}</div></div></details></div><div class="forecast-task-chart" ${chartAttr}></div></article>`;
  }
  function lifecycleChartReferences(card,history,selected){
    if(!card?.querySelectorAll)return selected.map((row,index)=>({...row,label:`${index?'辅助':'主参考'}${row.weight}% · ${row.item.model}`,color:index?'#7C3AED':'#FF8A00'}));
    const palette=['#D9485F','#00A6A6','#B7791F','#6B7280','#DB2777','#65A30D'];
    return [...card.querySelectorAll('[data-lifecycle-chart-ref]:checked:not(:disabled)')].map((input,index)=>{const item=history.find(item=>(item.event_id||item.model)===input.value),slot=selected.findIndex(row=>(row.item.event_id||row.item.model)===input.value),weight=slot>=0?selected[slot].weight:0;return item?{item,weight,label:`${slot>=0?(slot?'辅助':'主参考')+weight+'%':'对比'} · ${item.model}`,color:slot===0?'#FF8A00':slot===1?'#7C3AED':palette[index%palette.length]}:null}).filter(Boolean);
  }
  function renderLifecycleReferenceScores(rows,scoreFor,currentName='当前预测对象'){
    const labels={tier:'产品档位',energy:'能源类型',node:'发布类型',days:'小订窗口天数',d1:'D1 小订量',size:'同期累计小订量',release_hour:'发布时间',hour_slope:'小时增量斜率',hour_progress:'前几小时累计占比',lock:'首销期大定到锁单率',launch_shape:'全首销直接大定曲线',steady_shape:'平销实际趋势'};
    const scored=rows.map(row=>({...row,result:scoreFor(row.item)})),main=scored[0],aux=scored[1],partOf=(result,key)=>result?.parts?.find(part=>part.key===key),display=part=>{const evidence=String(part?.evidence||'数据不足'),pieces=evidence.split('↔');return pieces.length>1?{current:pieces.shift().trim()||'数据不足',reference:pieces.join('↔').trim()||'数据不足'}:{current:'当前数据',reference:evidence}};
    const parts=[...new Map(scored.flatMap(row=>row.result?.parts||[]).map(part=>[part.key,part])).values()],score=(part)=>part&&Number.isFinite(Number(part.value))?`${Math.round(Number(part.value)*100)}分`:'—',name=(item,fallback)=>item?.model||fallback,total=(row,prefix,kind)=>`<span class="${kind}">${prefix} ${row&&Number.isFinite(Number(row.result?.score))&&row.result.score>=0?`${Math.round(row.result.score*100)}分`:'—'}</span>`;
    const body=parts.map(part=>{const mainPart=partOf(main?.result,part.key),auxPart=partOf(aux?.result,part.key),mainView=display(mainPart),auxView=display(auxPart),currentView=display(mainPart||auxPart);return `<tr><td><b>${esc(labels[part.key]||part.label||part.key)}</b></td><td>${esc(currentView.current)}</td><td>${esc(mainView.reference)}</td><td>${esc(auxView.reference)}</td><td><div class="forecast-ref-row-scores"><span class="primary">主 ${score(mainPart)}</span><span class="auxiliary">辅 ${score(auxPart)}</span></div></td></tr>`}).join('');
    return `<table><thead><tr><th>参与打分参数</th><th>当前 · ${esc(currentName)}</th><th>主参考 · ${esc(name(main?.item,'未选择'))}</th><th>辅助参考 · ${esc(name(aux?.item,'未选择'))}</th><th>单项打分</th></tr></thead><tbody>${body||'<tr><td colspan="5">暂无已选参考</td></tr>'}</tbody><tfoot><tr><td><b>综合得分</b></td><td>—</td><td>${esc(name(main?.item,'未选择'))}</td><td>${esc(name(aux?.item,'未选择'))}</td><td><div class="forecast-ref-row-scores">${total(main,'主','primary')}${total(aux,'辅','auxiliary')}</div></td></tr></tfoot></table>`;
  }
  function refreshLifecycleRecommendationCharts(workspace,root){
    workspace.querySelectorAll('[data-lifecycle-reference]').forEach(card=>{
      const inputs=[...card.querySelectorAll('[data-lifecycle-chart-ref]')];
      if(inputs.some(input=>root._forecastTouched?.has(forecastDraftControlKey(input))))return;
      const chosen=new Set([...card.querySelectorAll('[data-lifecycle-ref]')].map(select=>select.value));
      inputs.forEach(input=>input.checked=!input.disabled&&chosen.has(input.value));
      card._refreshLifecycleControls?.();
    });
  }
  function bindLifecycleReferenceCards(workspace,root,update){
    workspace.querySelectorAll('[data-lifecycle-reference]').forEach(card=>{
      const selects=[...card.querySelectorAll('[data-lifecycle-ref]')],inputs=[...card.querySelectorAll('[data-lifecycle-chart-ref]')];
      const refresh=()=>{const sum=[...card.querySelectorAll('[data-lifecycle-weight]')].reduce((n,input)=>n+Math.max(Number(input.value)||0,0),0);card.querySelector('[data-lifecycle-weight-total]').textContent=`合计${sum}%${sum===100?'':' · 自动归一'}`;card.querySelector('[data-lifecycle-picker-count]').textContent=inputs.filter(input=>input.checked).length+'项';};
      const choose=mode=>{const primary=new Set(selects.map(select=>select.value));inputs.forEach(input=>input.checked=!input.disabled&&(mode==='all'||mode==='primary'&&primary.has(input.value)));refresh();};
      choose('primary');
      selects.forEach(select=>select.onchange=()=>{selects.forEach(other=>{if(other!==select&&select.value&&other.value===select.value)other.value='';});const input=inputs.find(input=>input.value===select.value);if(input)input.checked=true;inputs.forEach(input=>root._forecastTouched?.add(forecastDraftControlKey(input)));refresh();update();});
      card.querySelectorAll('[data-lifecycle-weight]').forEach(input=>input.oninput=()=>{refresh();update();});
      inputs.forEach(input=>input.onchange=()=>{root._forecastTouched?.add(forecastDraftControlKey(input));root.dataset.forecastDirty='true';refresh();update();captureForecastDraft();});
      card.querySelectorAll('[data-lifecycle-ref-quick]').forEach(button=>button.onclick=()=>{const mode=button.dataset.lifecycleRefQuick;if(mode==='brand')inputs.forEach(input=>input.checked=!input.disabled&&input.dataset.brand===button.dataset.brand);else choose(mode);inputs.forEach(input=>root._forecastTouched?.add(forecastDraftControlKey(input)));root.dataset.forecastDirty='true';refresh();update();captureForecastDraft();});
      card.querySelector('[data-lifecycle-score-jump]').onclick=()=>{applyForecastView(root,'score');syncUrl('push');};
      card._refreshLifecycleControls=refresh;
    });
  }
  function renderForecastEvidenceGroup(title,note,cards,count){
    return `<section class="forecast-evidence-group"><div class="forecast-evidence-group-head"><div><small>${esc(note)}</small><h4>${esc(title)}</h4></div><span>${count}个参考模块</span></div><div class="forecast-ref-grid">${cards}</div></section>`;
  }
  function renderForecastScenarioCard({title,note,variant='',status,metrics,meta=''}){
    return `<article class="forecast-scenario ${variant}"><div class="forecast-scenario-head"><div><h4>${esc(title)}</h4><small>${esc(note)}</small></div><span ${status}>等待计算</span></div><div class="forecast-metric-strip">${metrics.map((item,index)=>`<div class="forecast-metric${index===0?' primary':''}"><span>${esc(item.label)}</span><div><strong ${item.attribute}>—</strong>${item.unit?`<em>${esc(item.unit)}</em>`:''}</div>${item.noteAttribute?`<small ${item.noteAttribute}></small>`:''}</div>`).join('')}</div>${meta?`<div class="forecast-scenario-meta">${meta}</div>`:''}</article>`;
  }
  function renderLifecycleConclusion(stage,title,note,metrics){
    return renderForecastScenarioCard({title,note,variant:'forecast-lifecycle-conclusion',status:`data-${stage}-confidence`,metrics:metrics.map(item=>({...item,attribute:`data-${stage}-kpi="${item.key}"`}))});
  }
  function renderSmallOrderWorkspace(data){
    const history=data.small_order_history||[];
    const progress=renderLifecycleReferenceCard('small','progress','小订累计完成度','按已发生进度反推最终总小订',history,'data-small-ref','data-small-weight','data-small-reference-chart')
      .replace('<div class="forecast-ref-comparison" data-lifecycle-ref-reason></div></details>', '<div class="forecast-ref-comparison" data-lifecycle-ref-reason></div><div class="forecast-reference-context" data-small-evidence></div></details>');
    const hourly=renderLifecycleReferenceCard('small','hourly','D1 小订分时预测','按发布时间、分时斜率和累计占比选参考；不比较D1绝对量',history,'data-small-hourly-ref','data-small-hourly-weight','data-small-hourly-reference-chart');
    const daily=renderLifecycleReferenceCard('small','daily','小订到天基础曲线','分配未来逐日小订；历史日历影响先剔除，再应用目标日期系数',history,'data-small-daily-ref','data-small-daily-weight','data-small-daily-reference-chart');
    const slope=renderLifecycleReferenceCard('small','slope','每日斜率（仅展示）','剔除日历影响后的日量环比；独立主辅选择，不参与预测计算',history,'data-small-slope-ref','data-small-slope-weight','data-small-slope-reference-chart');
    return `<div class="forecast-lifecycle-workspace forecast-small-order" data-small-order-workspace>
      <div class="forecast-data-error" data-small-error role="alert" aria-live="assertive" hidden></div>
      <section id="small-forecast-pane-result" aria-labelledby="forecast-tab-result" class="forecast-lifecycle-subpane${state.forecastView==='result'?' active':''}" role="tabpanel" data-lifecycle-subpane="small-result">
        <div class="forecast-result-shell"><div class="forecast-result-main">
          <section class="forecast-result-section" data-forecast-region="summary"><div class="forecast-scenarios">${renderLifecycleConclusion('small','小订预测结论','已发生数量与未来预测分开显示',[
            {key:'total',label:'预计最终总小订',unit:'单'},{key:'actual',label:'当前已发生',unit:'单'},{key:'d1',label:'D1小订终值',unit:'单'}])}</div></section>
          <section class="forecast-decision-card forecast-result-section" data-forecast-region="curves"><div class="forecast-pane-head"><div><small>真实值冻结，未来按参考曲线分配</small><h4>小订逐日实际与预测</h4></div></div><div data-small-chart></div></section>
          <div data-forecast-import-anchor="small" data-forecast-region="import"></div>
        </div></div>
      </section>
      <section id="small-forecast-pane-evidence" aria-labelledby="forecast-tab-evidence" class="forecast-lifecycle-subpane${state.forecastView==='evidence'?' active':''}" role="tabpanel" data-lifecycle-subpane="small-evidence">
        <aside class="forecast-evidence-controls" data-forecast-region="controls" aria-label="预测参数">
          <p class="forecast-progress-source forecast-evidence-source" data-small-source>正在检查小订窗口和历史曲线。</p>
          ${renderStageCommonControls('small')}
        </aside>
        <div class="forecast-evidence-groups">
          ${renderForecastEvidenceGroup('终局预测参考','累计完成度用于日进度反推；D1分时用于首日滚动预测',progress+hourly,2)}
          ${renderForecastEvidenceGroup('逐日分配与走势对照','到天曲线参与分配，斜率仅作展示',daily+slope,2)}
        </div>
        <details class="forecast-method"><summary>查看小订预测逻辑与回退规则</summary><ol>${(data.small_order_rules||[]).map(item=>`<li>${esc(item)}</li>`).join('')}</ol></details>
      </section>
      <section id="small-forecast-pane-score" aria-labelledby="forecast-tab-score" class="forecast-lifecycle-subpane${state.forecastView==='score'?' active':''}" role="tabpanel" data-lifecycle-subpane="small-score"><div data-small-score></div></section>
    </div>`;
  }
  function renderSteadyWorkspace(data){
    const history=data.steady_history||[];
    const reference=renderLifecycleReferenceCard('steady','weekly','首销规律与平销承接','两张趋势图共用此处的主辅参考与权重；额外对比不参与预测',history,'data-steady-ref','data-steady-weight','data-steady-reference-chart')
      .replace('<article class="forecast-ref-card" data-lifecycle-reference="steady-weekly">','<article class="forecast-ref-card forecast-steady-shared-reference" data-lifecycle-reference="steady-weekly">')
      .replace('<div class="forecast-task-chart" data-steady-reference-chart></div>', '<p class="forecast-steady-chart-note">首销全周期直接大定形状决定参考；历史车型提供进入平销后的相对承接关系。本车型平销实际逐步校准规模和趋势，不套历史绝对量。</p><div class="forecast-task-chart" data-steady-reference-chart></div><div class="forecast-task-chart" data-steady-evidence></div>');
    return `<div class="forecast-lifecycle-workspace forecast-steady" data-steady-workspace>
      <div class="forecast-data-error" data-steady-error role="alert" aria-live="assertive" hidden></div>
      <section id="steady-forecast-pane-result" aria-labelledby="forecast-tab-result" class="forecast-lifecycle-subpane${state.forecastView==='result'?' active':''}" role="tabpanel" data-lifecycle-subpane="steady-result">
        <div class="forecast-result-shell"><div class="forecast-result-main">
          <section class="forecast-result-section" data-forecast-region="summary"><div class="forecast-scenarios">${renderLifecycleConclusion('steady','平销预测结论','本车型实际校准规模，历史参考提供相对趋势',[
            {key:'total',label:'预测区间锁单（含已实现）',unit:'单'},{key:'daily',label:'近期真实日均锁单',unit:'单／天'},
            {key:'change',label:'未来日均较近期实际',unit:'%'},{key:'basis',label:'当前预测依据'}])}</div></section>
          <section class="forecast-decision-card forecast-result-section" data-forecast-region="curves"><div class="forecast-pane-head"><div><small>交车锁单口径：按天预测、按周汇总，已结束日冻结</small><h4>平销交车锁单by周</h4></div></div><p class="forecast-progress-source" data-steady-source>正在读取《锁单选配比例分析》的平销期交车锁单。</p><div data-steady-chart></div></section>
          <div data-forecast-import-anchor="steady" data-forecast-region="import"></div>
        </div></div>
      </section>
      <section id="steady-forecast-pane-evidence" aria-labelledby="forecast-tab-evidence" class="forecast-lifecycle-subpane${state.forecastView==='evidence'?' active':''}" role="tabpanel" data-lifecycle-subpane="steady-evidence">
        <aside class="forecast-evidence-controls" data-forecast-region="controls" aria-label="预测参数">${renderStageCommonControls('steady')}</aside>
        <div class="forecast-evidence-groups">${renderForecastEvidenceGroup('趋势参考','比较首销全周期直接大定规律和进入平销后的相对承接，不套用历史绝对量',reference,1)}</div>
        <details class="forecast-method"><summary>查看平销预测逻辑与取数规则</summary><ol>${(data.steady_rules||[]).map(item=>`<li>${esc(item)}</li>`).join('')}</ol></details>
      </section>
      <section id="steady-forecast-pane-score" aria-labelledby="forecast-tab-score" class="forecast-lifecycle-subpane${state.forecastView==='score'?' active':''}" role="tabpanel" data-lifecycle-subpane="steady-score"><div data-steady-score></div></section>
    </div>`;
  }
  function renderForecastWorkspaceV2(data){
    const target=data.target||{},tasks=data.tasks||[];
    const activeForecastStage=forecastStages.some(item=>item.id===state.forecastStage)?state.forecastStage:"launch";
    const activeForecastView=forecastViews.includes(state.forecastView)?state.forecastView:"result";
    const tierValues=[...new Set([target.tier,...(data.tiers||[])].filter(Boolean))];
    const tierOptions=tierValues.map(value=>`<option value="${esc(value)}"${value===target.tier?' selected':''}>${esc(value)}</option>`).join('');
    const nodeValues=[...new Set([target.launch_node,...(data.nodes||[])].filter(Boolean))];
    const nodeOptions=nodeValues.map(value=>`<option value="${esc(value)}"${value===target.launch_node?' selected':''}>${esc(value)}</option>`).join('');
    const energyValues=[...new Set([target.energy,...(data.energies||[]),'未维护'].filter(Boolean))];
    const energyOptions=energyValues.map(value=>`<option value="${esc(value)}"${value===target.energy?' selected':''}>${esc(value)}</option>`).join('');
    const periodOptions=selected=>{const value=['上午','下午','晚上'].includes(String(selected||'').trim())?String(selected).trim():'未维护';return ['上午','下午','晚上','未维护'].map(period=>`<option value="${period}"${period===value?' selected':''}>${period==='未维护'?'自动（D1首单）':period}</option>`).join('')};
    const noSmall=target.has_small===false?' disabled':'';
    const referenceModels=data.history||[],brands=[...new Set(referenceModels.map(referenceBrand))];
    const chartPicker=task=>{const defaults=new Set((task.recommended||[]).slice(0,2));return `<details class="forecast-chart-picker" data-forecast-chart-picker="${esc(task.key)}"><summary>图表对比车型 <b data-forecast-picker-count>${defaults.size}项</b></summary><div class="forecast-chart-picker-panel"><div class="forecast-chart-quick"><button type="button" data-forecast-ref-quick="primary">主辅</button><button type="button" data-forecast-ref-quick="all">全选</button><button type="button" data-forecast-ref-quick="none">清空</button>${brands.map(brand=>`<button type="button" data-forecast-ref-quick="brand" data-brand="${esc(brand)}">${esc(brand)}</button>`).join('')}</div><small>额外勾选仅用于图表比较，不参与主辅权重计算；“未映射”历史记录不会自动绑定当前订单分析代际。</small><div class="forecast-chart-options">${brands.map(brand=>`<fieldset><legend>${esc(brand)}</legend>${referenceModels.filter(item=>referenceBrand(item)===brand).map(item=>`<label><input type="checkbox" data-forecast-chart-ref="${esc(task.key)}" data-brand="${esc(brand)}" value="${esc(item.model)}"${defaults.has(item.model)?' checked':''}><span>${esc(item.model)}${item.mapped===false?' · 未映射':''}</span></label>`).join('')}</fieldset>`).join('')}</div></div></details>`};
    const refCard=task=>`<article class="forecast-ref-card" data-forecast-task="${esc(task.key)}"><div class="forecast-ref-card-head"><div><span>${esc(task.label)}</span><small>${esc(task.purpose)}</small></div><i aria-hidden="true"></i></div><div class="forecast-ref-selects"><label>主参考<select data-forecast-ref="${esc(task.key)}" data-ref-slot="0">${forecastReferenceOptions(data,task.recommended?.[0])}</select></label><label>辅助参考<select data-forecast-ref="${esc(task.key)}" data-ref-slot="1">${forecastReferenceOptions(data,task.recommended?.[1])}</select></label><div class="forecast-ref-weights"><label>主<input type="number" min="0" max="100" step="1" value="70" data-forecast-ref-weight="${esc(task.key)}" data-ref-slot="0"><small>%</small></label><b>＋</b><label>辅<input type="number" min="0" max="100" step="1" value="30" data-forecast-ref-weight="${esc(task.key)}" data-ref-slot="1"><small>%</small></label><em data-forecast-weight-total>合计100%</em></div></div><details class="forecast-ref-score-details"><summary>查看评分对比表</summary><div class="forecast-ref-comparison" data-forecast-ref-reason><div class="forecast-ref-comparison-empty">等待计算参与打分的参数</div></div></details><div class="forecast-ref-actions"><button type="button" data-forecast-score-jump="${esc(task.key)}">查看评分明细</button>${chartPicker(task)}</div><div class="forecast-task-chart" data-forecast-task-chart="${esc(task.key)}"></div></article>`;
    const slopeTask={key:'daily_slope',label:'每日斜率（仅展示）',purpose:'剔除日历影响后的日量较前一天变化率；D1及前日为0时无值。独立评分只用于选择斜率对比车型，不参与终局或剩余量分配。',recommended:tasks.find(task=>task.key==='daily')?.recommended||[]};
    const slopeCard=()=>refCard(slopeTask).replace(/<div class="forecast-ref-weights">.*?<\/div>/,'');
    const evidenceGroups=[
      {title:'方法一参考',note:'决定同期完成率反推所采用的历史曲线',keys:['small_progress','direct_progress']},
      {title:'方法二参考',note:'决定小订转化率与直接大定占比',keys:['conversion','direct_share']},
      {title:'公共参考',note:'共同影响D1、锁单换算与未来到天分配',keys:['hourly','lock','daily','daily_slope']},
    ].map(group=>{const cards=group.keys.map(key=>key==='daily_slope'?slopeTask:tasks.find(task=>task.key===key)).filter(Boolean).map(task=>task.key==='daily_slope'?slopeCard():refCard(task)).join('');return cards?renderForecastEvidenceGroup(group.title,group.note,cards,group.keys.length):''}).join('');
    const defaults=data.day_type_defaults||{};
    const smallOrderWorkspace=renderSmallOrderWorkspace(data),steadyWorkspace=renderSteadyWorkspace(data);
    const scenario=(key,title,subtitle)=>renderForecastScenarioCard({title,note:subtitle,variant:key,status:`data-forecast-method-status="${key}"`,metrics:[
      {label:'首销期大定',attribute:`data-forecast-value="${key}-gross"`,unit:'单',noteAttribute:`data-forecast-kpi-note="${key}-gross"`},
      {label:'预计首销期锁单',attribute:`data-forecast-value="${key}-lock"`,unit:'单'},
      {label:'小订转大',attribute:`data-forecast-value="${key}-small"`,unit:'单',noteAttribute:`data-forecast-kpi-note="${key}-small"`},
      {label:'直接大定',attribute:`data-forecast-value="${key}-direct"`,unit:'单',noteAttribute:`data-forecast-kpi-note="${key}-direct"`}
    ],meta:`<span>小订转化率 <b data-forecast-value="${key}-conversion">—</b>%</span><span>直接大定占比 <b data-forecast-value="${key}-share">—</b>%</span>`});
    return `<div class="forecast-workspace forecast-v2 forecast-studio" data-forecast-config="${esc(JSON.stringify(data))}">
      <div class="forecast-scroll-body">
      <section class="forecast-target">
        <div class="forecast-target-heading"><small>销量预测 · 工作台</small><h3 data-forecast-target-title>${esc(target.name)}</h3></div>
        <div class="forecast-target-settings" role="group" aria-label="车型与时间参数"><span class="sr-only">车型与时间参数</span><div class="forecast-target-form">
          <label>产品档位<select data-forecast-target="tier">${tierOptions}</select></label>
          <label>能源类型<select data-forecast-target="energy">${energyOptions}</select></label>
          <label>发布类型<select data-forecast-target="node">${nodeOptions}</select></label>
          <label>小订开始日期<input type="date" data-forecast-target="smallStartDate" value="${esc(target.small_start_date||'')}"${noSmall}></label>
          <label>小订发布时段<select data-forecast-target="smallPeriod" title="表格时段优先；自动模式取小订D1首个正数订单小时，没有则不推断"${noSmall}>${periodOptions(target.small_period)}</select></label>
          <label>小订天数<input type="number" min="1" max="366" data-forecast-target="smallDays" value="${target.small_days||''}"${noSmall}><small>天</small></label>
          <label>首销开始<input type="date" data-forecast-target="launchDate" value="${esc(target.launch_date||'')}"></label>
          <label>首销发布时段<select data-forecast-target="period" title="表格时段优先；自动模式取首销D1首个正数大定小时，没有则不推断">${periodOptions(target.launch_period)}</select></label>
          <label>首销天数<input type="number" min="1" max="90" data-forecast-target="days" value="${target.launch_days||''}"><small>天</small></label>
        </div></div>
        <span class="forecast-status confirmed" data-forecast-feedback role="status" aria-live="polite"><i></i><span>参数实时生效</span></span>
        <div class="forecast-target-meta"><div class="forecast-stage-switcher" role="group" aria-label="选择预测阶段">${forecastStages.map(stage=>`<button type="button" data-forecast-stage-switch="${stage.id}" aria-pressed="${activeForecastStage===stage.id}">${stage.label}</button>`).join("")}</div><div class="forecast-tabs forecast-target-tabs" role="tablist" aria-label="预测内容"><button id="forecast-tab-result" class="${activeForecastView==='result'?'active':''}" role="tab" aria-selected="${activeForecastView==='result'}" tabindex="${activeForecastView==='result'?0:-1}" data-forecast-tab="result">预测结论</button><button id="forecast-tab-evidence" class="${activeForecastView==='evidence'?'active':''}" role="tab" aria-selected="${activeForecastView==='evidence'}" tabindex="${activeForecastView==='evidence'?0:-1}" data-forecast-tab="evidence">预测依据</button><button id="forecast-tab-score" class="${activeForecastView==='score'?'active':''}" role="tab" aria-selected="${activeForecastView==='score'}" tabindex="${activeForecastView==='score'?0:-1}" data-forecast-tab="score">预测打分</button></div><div class="forecast-target-sources"><b class="forecast-stage-status" data-forecast-current-day aria-live="polite">${esc(forecastStages.find(item=>item.id===activeForecastStage)?.label||'销量预测')}状态判定中</b><span class="forecast-source-brief" data-forecast-source-brief></span><span class="forecast-time-brief" data-forecast-time-brief></span><details class="forecast-source-details"><summary>来源与时间详情</summary><div class="forecast-source-decision"><b>数据来源</b><span data-forecast-day-source>正在检查当前预测阶段的时间窗口与数据来源</span></div><div class="forecast-source-decision"><b>时间口径</b><span data-forecast-time-summary>正在核对当前时间与各阶段窗口</span></div><p>人工参数仅保存到当前浏览器；重新生成同路径页面后，人工修改项仍保留，真实值按最新数据读取。</p></details><button type="button" data-forecast-reset title="恢复当前车型三个阶段的参数、参考和权重；保留外部导入">恢复系统推荐</button></div></div>
      </section>
      <section class="forecast-stage-pane${activeForecastStage==='small'?' active':''}" role="tabpanel" data-forecast-stage-pane="small">${smallOrderWorkspace}</section>
      <section class="forecast-stage-pane${activeForecastStage==='launch'?' active':''}" role="tabpanel" data-forecast-stage-pane="launch">
      <div class="forecast-data-error" data-forecast-data-error role="alert" aria-live="assertive" tabindex="-1" hidden></div>
      <section id="forecast-pane-result" aria-labelledby="forecast-tab-result" class="forecast-pane${activeForecastView==='result'?' active':''}" role="tabpanel" data-forecast-pane="result">
        <div class="forecast-result-shell">
          <main class="forecast-result-main">
            <section class="forecast-result-section" data-forecast-region="summary"><div class="forecast-scenarios">${scenario('progress','方法一 · 同期完成率反推','真实累计量 ÷ 参考传播名同期完成率')}${scenario('parameter','方法二 · 转化参数测算','总小订 × 转化率，并按直接大定占比换算')}</div><p class="forecast-progress-source">首销结论为总大定（小转大＋直接大定，未扣大定退订）；锁单单独展示。累计小转大率＝累计小转大÷总小订；真实累计与当日滚动估算分开显示。</p></section>
            <section class="forecast-scale-check"><div class="forecast-pane-head"><div><small>不参与公式，只检查预测是否偏离可比传播名区间</small><h4>总体量级合理性校验</h4></div></div><div data-forecast-scale-check></div></section>
            <div class="forecast-decision-grid forecast-result-section" data-forecast-region="curves">
              <section class="forecast-decision-card progress"><div class="forecast-pane-head"><div><small>方法一：已发生进度决定终局，未来只分配剩余量</small><h4>同期完成率法 · 到天拆解</h4></div><span>每个未来Dn基础权重 × 日期调整系数</span></div><div data-forecast-decision-chart="progress"></div><details class="forecast-weekly"><summary>查看方法一by周预测汇总</summary><div data-forecast-weekly="progress"></div></details></section>
              <section class="forecast-decision-card parameter"><div class="forecast-pane-head"><div><small>方法二：总小订、转化率和直接大定占比决定终局</small><h4>转化参数法 · 到天拆解</h4></div><span>与方法一独立展示，不合并、不平均</span></div><div data-forecast-decision-chart="parameter"></div><details class="forecast-weekly"><summary>查看方法二by周预测汇总</summary><div data-forecast-weekly="parameter"></div></details></section>
             </div>
             <div data-forecast-import-anchor="launch" data-forecast-region="import"></div>
          </main>
        </div>
        <details class="forecast-method forecast-source-method"><summary>当前第几天与数据来源如何判断</summary><ol>${(data.source_rules||[]).map(item=>`<li>${esc(item)}</li>`).join('')}</ol></details>
      </section>
      <section id="forecast-pane-evidence" aria-labelledby="forecast-tab-evidence" class="forecast-pane${activeForecastView==='evidence'?' active':''}" role="tabpanel" data-forecast-pane="evidence">
        <aside class="forecast-evidence-controls" data-forecast-region="controls" aria-label="预测参数">
          <section class="forecast-parameter-rail forecast-result-section" data-forecast-region="parameters">
            <div class="forecast-rail-head"><div><small>逐项调整，即时生效</small><h4>预测参数</h4></div><span>修改后实时重算</span></div>
            <div class="forecast-result-grid forecast-control-grid">
              <div class="forecast-assumptions forecast-progress-controls"><div class="forecast-block-head"><div><h4>方法一 · 同期完成率</h4></div></div><div class="forecast-progress-actuals"><span>已结束日真实小转大 <b data-forecast-progress-actual-small>—</b></span><span>已结束日真实直接大定 <b data-forecast-progress-actual-direct>—</b></span><span data-forecast-progress-intraday></span></div><div class="forecast-input-grid">
                <label>参考车型同期小转大完成率<input data-forecast-input="progressSmallCompletion" type="number" min="0.1" max="100" step="0.1" placeholder="等待参考"><small>%</small></label>
                <label>参考车型同期直接大定完成率<input data-forecast-input="progressDirectCompletion" type="number" min="0.1" max="100" step="0.1" placeholder="等待参考"><small>%</small></label>
              </div><details class="forecast-parameter-details"><summary>完成率口径与周期适配</summary><p class="forecast-progress-source" data-forecast-progress-source>当前车型只提供真实累计量；完成率来自主辅历史参考车型，可以人工覆盖。</p></details></div>
              <div class="forecast-assumptions forecast-parameter-controls"><div class="forecast-block-head"><div><h4>方法二 · 转化参数</h4></div></div><div class="forecast-input-grid">
                <label>总小订<input data-forecast-input="small" type="number" min="0" value="${target.total_small}"><small>份</small></label>
                <label>小订转化率<input data-forecast-input="conversion" type="number" min="0" max="100" step="0.1" value="${(target.conversion*100).toFixed(1)}"><small>%</small></label>
                <label>直接大定占比<input data-forecast-input="direct" type="number" min="0" max="99.9" step="0.1" value="${(target.direct_share*100).toFixed(1)}"><small>%</small></label>
              </div></div>
            </div>
            <div class="forecast-suggestion" data-forecast-suggestion></div>
          </section>
          <section class="forecast-common-controls forecast-result-section" data-forecast-region="common"><div class="forecast-block-head"><div><small>首日锚点、锁单换算与逐日分配</small><h4>公共参数</h4></div><span>修改后实时重算</span></div><div class="forecast-common-grid">
            <div class="forecast-d1-card" data-forecast-d1-card><div class="forecast-block-head"><div><small>首日锚点</small><h4 data-forecast-d1-title>D1大定</h4></div><span data-forecast-d1-stage>判定中</span></div><label data-forecast-d1-input-wrap>D1预测大定<input data-forecast-input="d1Gross" type="number" min="0" placeholder="系统自动"><small>单</small></label><div class="forecast-d1-value"><strong data-forecast-d1-value>—</strong><em>单</em><details class="forecast-d1-details"><summary>来源与状态</summary><small data-forecast-d1-note></small></details></div><div class="forecast-d1-components"><span>小转大 <b data-forecast-d1-small>—</b></span><span>直接大定 <b data-forecast-d1-direct>—</b></span></div></div>
            <label class="forecast-common-lock">大定到锁单率<span>首销期锁单 ÷ 总大定</span><span class="forecast-common-lock-input"><input data-forecast-input="lock" type="number" min="0" max="100" step="0.1" value="${(target.lock_rate*100).toFixed(1)}"><small>%</small></span><em>用于两种方法的首销期锁单测算</em></label>
          </div><details class="forecast-parameter-details forecast-allocation-details"><summary>当前预测的日历与分配说明</summary><p data-forecast-allocation-note></p></details>${renderBridgeControls('launch')}</section>
        </aside>
        <div class="forecast-evidence-groups">${evidenceGroups}</div><details class="forecast-method"><summary>查看完整预测逻辑（7步）</summary><ol>${(data.method||[]).map(item=>`<li>${esc(item)}</li>`).join('')}</ol></details>
      </section>
      <section id="forecast-pane-score" aria-labelledby="forecast-tab-score" class="forecast-pane${activeForecastView==='score'?' active':''}" role="tabpanel" data-forecast-pane="score"><div data-forecast-score-dashboard></div></section>
      </section>
      <section class="forecast-stage-pane${activeForecastStage==='steady'?' active':''}" role="tabpanel" data-forecast-stage-pane="steady">${steadyWorkspace}</section>
      </div>
    </div>`;
  }
