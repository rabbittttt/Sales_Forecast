  function forecastSourceBrief(text){
    const value=String(text||''),short=name=>name.replaceAll('小订及首销数据整理','整理表').replaceAll('首销期订单节奏','首销节奏');
    if(/缺失|异常|不可用|原始数据错误/.test(value))return '数据缺失/异常';
    const main=value.match(/主来源([^，；（。]+)/)?.[1];
    if(main){
      const names=new Set([main]);
      const fields=value.split('字段来源：')[1]||'';
      fields.split('；').forEach(field=>{const match=field.match(/^(?:总小订|首销日明细|分时进度)：(.+)$/);if(match)names.add(match[1])});
      return names.size>1?'混合来源：'+[...names].map(short).join('＋'):'来源：'+short(main);
    }
    const finalSmall=value.match(/最终总小订取自([^。；]+)/)?.[1];
    if(finalSmall)return '总小订：'+short(finalSmall);
    const completed=value.match(/已发生(\d+)个完整日/)?.[1];
    if(completed)return '实绩：'+completed+'个完整日';
    if(/主辅参考|参考最终小订/.test(value))return '参考测算';
    if(/分时累计|分时进度/.test(value))return '分时实绩与估算';
    return '依据：'+(value.split(/[。；]/)[0]||'待核对');
  }
  function refreshForecastHeaderBrief(root){
    const source=(root._forecastToolbar || root).querySelector('[data-forecast-day-source]')?.textContent||'';
    const time=(root._forecastToolbar || root).querySelector('[data-forecast-time-summary]')?.textContent||'';
    const brief=(root._forecastToolbar || root).querySelector('[data-forecast-source-brief]'),date=(root._forecastToolbar || root).querySelector('[data-forecast-time-brief]');
    if(brief){brief.textContent=forecastSourceBrief(source);brief.title=source;brief.dataset.warning=String(/缺失|异常|不可用|原始数据错误/.test(source));}
    if(date){const day=time.match(/判定日期(\d{4}-\d{2}-\d{2})/)?.[1];date.textContent=day?'判定日 '+day:'判定日待核对';date.title=time;}
  }
  function showForecastStageSummary(root,id){
    if(!root)return;
    const suffix=id.charAt(0).toUpperCase()+id.slice(1),label=forecastStages.find(item=>item.id===id)?.label||"销量预测",badge=(root._forecastToolbar || root).querySelector('[data-forecast-current-day]'),source=(root._forecastToolbar || root).querySelector('[data-forecast-day-source]');
    if(badge)badge.textContent=root.dataset[`forecastStatus${suffix}`]||`${label}状态判定中`;
    if(source)source.textContent=root.dataset[`forecastSource${suffix}`]||`正在检查${label}的时间阶段与数据来源`;
    const sourceLocation=(root._forecastToolbar || root).querySelector('[data-forecast-source-location]');if(sourceLocation&&sourceLocation.dataset.forecastSourceStage!==id)sourceLocation.hidden=true;
    refreshForecastHeaderBrief(root);
  }
  function setForecastStageSummary(root,id,status,source){
    if(!root||!forecastStages.some(item=>item.id===id))return;
    const suffix=id.charAt(0).toUpperCase()+id.slice(1);
    if(status!==undefined)root.dataset[`forecastStatus${suffix}`]=status;
    if(source!==undefined)root.dataset[`forecastSource${suffix}`]=source;
    if(state.forecastStage===id)showForecastStageSummary(root,id);
  }
  function applyForecastView(root,id){
    id=normalizeForecastView(id);
    if(!root||!forecastViews.includes(id))return;
    const stage=forecastStages.some(item=>item.id===state.forecastStage)?state.forecastStage:"launch",prefix=stage==="launch"?"forecast":`${stage}-forecast`;
    state.forecastView=id;
    if(FORECAST_APP)document.body.dataset.forecastView=id;
    (root._forecastToolbar || root).querySelectorAll('[data-forecast-tab]').forEach(button=>{const active=button.dataset.forecastTab===id;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.setAttribute('aria-controls',`${prefix}-pane-${button.dataset.forecastTab}`);button.tabIndex=active?0:-1});
    root.querySelectorAll('[data-forecast-pane]').forEach(pane=>pane.classList.toggle('active',pane.dataset.forecastPane===id));
    root.querySelectorAll('[data-lifecycle-subpane]').forEach(pane=>pane.classList.toggle('active',pane.dataset.lifecycleSubpane===`${stage}-${id}`));
    if(stage==='launch'&&id==='score')root._renderLaunchScoreDashboard?.();
  }
  function mountForecastNavSettings(root){
    const menu = $('#forecastNavParameters');
    menu.querySelector('.forecast-target-settings')?.remove();
    const host = $('#forecastHeaderTools');
    host.replaceChildren();
    host.hidden = true;
    const settings = root?.querySelector('.forecast-target-settings');
    menu.hidden = !settings;
    if (settings) {
      menu.append(settings);
      root._forecastNavSettings = settings;
    }
  }
  function prepareForecastStandalone(root){
    mountForecastNavSettings(root);
    if(!root)return;
    root.querySelector('.forecast-source-details').insertAdjacentHTML('beforebegin','<button type="button" class="forecast-source-button" data-workspace-source>来源数据</button>');
    const host = $('#forecastHeaderTools');
    const meta = root.querySelector('.forecast-target-meta');
    const sources = meta.querySelector('.forecast-target-sources');
    const menu = document.createElement('details');
    menu.className = 'forecast-header-menu';
    const toggle = document.createElement('summary');
    toggle.textContent = '详情';
    toggle.append(sources.querySelector('[data-forecast-source-brief]'));
    sources.prepend(root.querySelector('[data-forecast-feedback]'));
    meta.append(menu, sources.querySelector('[data-forecast-reset]'));
    menu.append(toggle, sources);
    host.append(meta);
    host.hidden = false;
    root._forecastToolbar = meta;
    root.querySelector('.forecast-target').hidden = true;
    menu.onkeydown = event => {
      if (event.key === 'Escape' && menu.open) {
        menu.open = false;
        toggle.focus();
      }
    };
    const scale=root.querySelector('.forecast-scale-check');
    if(scale){const details=document.createElement('details');details.className='forecast-scale-details';const summary=document.createElement('summary');summary.textContent='总体量级合理性校验';details.append(summary);details.open=true;root.querySelector('.forecast-source-method').before(details);details.append(scale);}
  }
  async function activateForecastStage(id,writeHistory=true){
    if(!forecastStages.some(item=>item.id===id))return;
    state.module="sales_forecast";state.forecastStage=id;state.forecastStageAuto=false;
    document.querySelectorAll("[data-forecast-stage-pane]").forEach(pane=>pane.classList.toggle("active",pane.dataset.forecastStagePane===id));
    const root=document.querySelector('.forecast-workspace.forecast-v2');showForecastStageSummary(root,id);applyForecastView(root,state.forecastView||"result");
    root?.querySelectorAll("[data-forecast-stage-switch]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.forecastStageSwitch===id)));
    const page=$("#page");if(page)page.scrollTo({top:0,behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});
    const owner=DATA.subjects.find(item=>item.modules.includes("sales_forecast")),source=forecastDataFromBoard(boardCache[`${owner?.id}|sales_forecast`]);
    if(await renderFilters()===false)return;
    if((source?.targets||[]).some(t=>t.secondary_generation&&sameForecastModel(t.primary_generation,subject()?.name))){captureForecastDraft();await renderPage();}
    if(FORECAST_APP)renderNav();
    if(writeHistory)syncUrl("push");
  }
  function renderNav(){
    const item=subject();
    if(FORECAST_APP){
      const options=forecastStages.map(stage=>({id:stage.id,label:stage.label}));
      $('#moduleSelect').innerHTML=options.map(option=>`<option value="${option.id}">${option.label}</option>`).join('');
      $('#moduleSelect').value=state.forecastStage||'launch';
      $('#moduleSelect').onchange=event=>$('#moduleNav').querySelector(`[data-forecast-nav="${event.target.value}"]`)?.click();
      $('#moduleNav').innerHTML=options.map(option=>{
        const active=state.forecastStage===option.id;
        return `<button type="button" data-forecast-nav="${option.id}" class="${active?'active':''}"${active?' aria-current="page"':''}><svg class="module-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${forecastNavIcons[option.id]}"/></svg>${option.label}</button>`;
      }).join('');
      $('#moduleNav').onclick=async event=>{
        const button=event.target.closest('[data-forecast-nav]'),id=button?.dataset.forecastNav;if(!forecastStages.some(stage=>stage.id===id))return;captureForecastDraft();
        if(state.module!=='sales_forecast'){state.module='sales_forecast';state.forecastStage=id;state.forecastStageAuto=false;if(await ensureState()===false)return;await renderAll();syncUrl('push');}
        else await activateForecastStage(id);
      };return;
    }
    const navigationModules=DATA.config.module_order.filter(id=>id!=="sales_forecast");
    $('#moduleSelect').innerHTML=navigationModules.map(id=>`<option value="${esc(id)}" ${moduleAvailable(item,id)?'':'disabled'}>${esc(moduleLabels[id])}${moduleAvailable(item,id)?'':'（当前主体不可用）'}</option>`).join('');
    $('#moduleSelect').value=state.module;
    $('#moduleSelect').onchange=event=>$('#moduleNav').querySelector(`[data-module="${event.target.value}"]`)?.click();
    $("#moduleNav").innerHTML=navigationModules.map(id=>{
      const available=moduleAvailable(item,id),active=state.module===id;
      const hint=id==="sales_forecast"?"请选择具体车型（代际）后查看":"当前主体没有对应Sheet";
      return '<button data-module="'+id+'" class="'+(active?'active':'')+'" '+(active?'aria-current="page" ':'')+(available?'':'disabled ')+'title="'+(available?moduleLabels[id]:hint)+'">'+moduleLabels[id]+'</button>';
    }).join("");
    $("#moduleNav").onclick=async event=>{
      const button=event.target.closest("[data-module]");
      if(!button||button.disabled||button.dataset.module===state.module)return;
      captureForecastDraft();if(button.dataset.module==='sales_forecast'&&DATA.forecast_page){state.forecastStageAuto=true;location.assign(forecastPageUrl());return;}state.module=button.dataset.module;if(state.module==="sales_forecast")state.forecastStageAuto=true;if(state.module==="launch_rhythm")state.grain="day";if(await ensureState()===false)return;await renderAll();syncUrl("push");
    };
  }
