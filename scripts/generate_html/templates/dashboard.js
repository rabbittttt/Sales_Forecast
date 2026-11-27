(async () => {
  async function decompressJson(b64){
    const bin=atob(b64||""),bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }
  function unpackDashboard(value){
    if(value?.format!=='shared-v1')return value;
    const memo=new Map();
    function restore(item){
      if(!item||typeof item!=='object')return item;
      if(Array.isArray(item))return item.map(restore);
      if(Object.hasOwn(item,'$shared')){
        const index=item.$shared;
        if(!Number.isInteger(index)||index<0||index>=value.pool.length)throw new Error('Invalid shared dashboard reference');
        if(!memo.has(index))memo.set(index,restore(value.pool[index]));
        return memo.get(index);
      }
      const entries=Object.hasOwn(item,'$literal')?item.$literal:Object.entries(item);
      return Object.fromEntries(entries.map(([key,child])=>[key,restore(child)]));
    }
    return restore(value.root);
  }
  const DATA = await decompressJson(window.DASHBOARD_DATA_B64);
  const FORECAST_APP=DATA.app_mode==='forecast';
  document.body.classList.toggle('forecast-app',FORECAST_APP);
  DATA.dashboard_blocks=window.DASHBOARD_BLOCKS_B64||DATA.dashboard_blocks||{};
  window.DASHBOARD_DATA = DATA;
  const {protectCompletion,distributeInteger,genericDailyShape,isKnownAttribute,smallReferenceScore,steadyReferenceScore,completedSmallOrderDays}=window.ForecastMath;
  window.CHART_RENDER_MODE = DATA.config.chart_render_mode || "generated";
  const $ = selector => document.querySelector(selector);
  const displayText = value => String(value ?? "").replaceAll("净大定", "留存大定");
  const esc = value => displayText(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));
  const numberFormatter = new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 1});
  const fmt = value => typeof value === "number" ? numberFormatter.format(value) : esc(value);
  const colors = {blue:"#2859f5",green:"#249463",orange:"#cd681a",purple:"#7655bb",coral:"#b72d59"};
  const forecastNavIcons = {
    small:"M3 19h18M5 15l5-5 4 3 5-7m-4 0h4v4",
    launch:"M3 13h4l2-7 4 13 3-9 2 3h3",
    steady:"M4 20h16M7 16v-5m5 5V7m5 9V4"
  };
  const LABEL_SCALE_HEADROOM=1.18;
  const chartMax=values=>Math.max(...values.map(value=>Number(value||0)),1)*LABEL_SCALE_HEADROOM;
  const stackedBarWidth=step=>Math.min(42,step*.58);
  // One pixel-space renderer for all daily/hourly rhythm charts. Adapters below
  // retain their existing quantities, aggregation and formatting contracts.
  const RHYTHM_LAYOUT=Object.freeze({height:224,frameHeight:240,top:30,bottom:190,left:30,right:30,barWidth:28,minStep:40,lineWidth:2,pointRadius:3,fontSize:10,minFontSize:9,lineLabelMaxOffset:24,defaultWidth:960});
  const rhythmKnown=value=>typeof value==='number'&&Number.isFinite(value);
  function rhythmGeometry(count,availableWidth=RHYTHM_LAYOUT.defaultWidth,labelWidth=0){
    // Keep the plot's natural density; a wide viewport must not stretch the gaps.
    // Only unusually long totals may increase the step to preserve legibility.
    const n=Math.max(count,1),step=Math.max(RHYTHM_LAYOUT.minStep,labelWidth+8),width=RHYTHM_LAYOUT.left+RHYTHM_LAYOUT.right+n*step;
    return {...RHYTHM_LAYOUT,width,viewportWidth:Math.min(availableWidth,width),plotHeight:RHYTHM_LAYOUT.bottom-RHYTHM_LAYOUT.top,step};
  }
  const rhythmTextWidth=(text,fontSize=RHYTHM_LAYOUT.fontSize)=>Array.from(String(text)).reduce((width,char)=>width+(char.charCodeAt(0)>255?fontSize:fontSize*.62),0);
  const rhythmLabelBox=(text,x,y,fontSize=RHYTHM_LAYOUT.fontSize)=>({left:x-rhythmTextWidth(text,fontSize)/2-2,right:x+rhythmTextWidth(text,fontSize)/2+2,top:y-fontSize-2,bottom:y+3});
  const rhythmAxisText=text=>String(text).replace(/^\d{4}-(\d{2})-(\d{2})$/, '$1-$2');
  const rhythmBoxesOverlap=(a,b,gap=2)=>a.left<b.right+gap&&a.right>b.left-gap&&a.top<b.bottom+gap&&a.bottom>b.top-gap;
  function rhythmLabelClear(box,occupied,points,segments){
    if(occupied.some(other=>rhythmBoxesOverlap(box,other))||points.some(point=>rhythmBoxesOverlap(box,{left:point.x-4,right:point.x+4,top:point.y-4,bottom:point.y+4},1)))return false;
    return !segments.some(([a,b])=>{
      const left=Math.max(box.left,a.x),right=Math.min(box.right,b.x);if(left>right||a.x===b.x)return false;
      const y=x=>a.y+(b.y-a.y)*(x-a.x)/(b.x-a.x),low=Math.min(y(left),y(right)),high=Math.max(y(left),y(right));
      return high>=box.top-1&&low<=box.bottom+1;
    });
  }
  function rhythmLineLabel(point,text,occupied,points,segments,geometry,complete=false){
    for(const fontSize of [RHYTHM_LAYOUT.fontSize,RHYTHM_LAYOUT.minFontSize])for(const offset of [-10,-16,-RHYTHM_LAYOUT.lineLabelMaxOffset,18,RHYTHM_LAYOUT.lineLabelMaxOffset]){
      const y=point.y+offset,box=rhythmLabelBox(text,point.x,y,fontSize);
      if(box.top<5||box.bottom>geometry.bottom-4||!rhythmLabelClear(box,occupied,points,segments))continue;
      return {x:point.x,y,box,fontSize,pointY:point.y};
    }
    if(complete){
      // This two-rate chart must keep every label. Wider date columns isolate
      // their text; search nearby vertical slots before relaxing line avoidance.
      const fontSize=RHYTHM_LAYOUT.minFontSize,candidates=Array.from({length:geometry.bottom-fontSize-8},(_,index)=>index+fontSize+7).sort((a,b)=>Math.abs(a-point.y)-Math.abs(b-point.y));
      for(const avoidLines of [true,false])for(const y of candidates){
        if(avoidLines&&Math.abs(y-point.y)>48)continue;
        const box=rhythmLabelBox(text,point.x,y,fontSize);
        if(box.bottom>geometry.bottom-4||!rhythmLabelClear(box,occupied,points,avoidLines?segments:[]))continue;
        return {x:point.x,y,box,fontSize,pointY:point.y,leader:Math.abs(y-point.y)>RHYTHM_LAYOUT.lineLabelMaxOffset};
      }
    }
    return null;
  }
  function renderRhythmSvg(spec,availableWidth){
    const rows=spec.rows||[],complete=spec.kind==='cancel-day',labelWidths=rows.flatMap(row=>[rhythmTextWidth(rhythmKnown(row.total)?fmt(row.total):'—',complete?RHYTHM_LAYOUT.fontSize:RHYTHM_LAYOUT.minFontSize),...(complete?(spec.lines||[]).filter(line=>rhythmKnown(row.rates?.[line.key])).map(line=>rhythmTextWidth((row.rates[line.key]*100).toFixed(line.digits??1)+'%')):[])]),geometry=rhythmGeometry(rows.length,availableWidth,Math.max(0,...labelWidths)),{width,height,left,right,bottom,plotHeight,step,barWidth}=geometry;
    const x=index=>left+index*step+step/2,barY=value=>bottom-value/spec.maxValue*plotHeight,rateY=value=>bottom-Math.min(Math.max(value,0),1)*plotHeight;
    const series=spec.series||[],lines=spec.lines||[],occupied=[],labels=[],points=[],segments=[],barAreas=[];
    const lineData=lines.map(line=>{
      let previous=null,path='';const dots=rows.map((row,index)=>{
        const value=row.rates?.[line.key];if(!rhythmKnown(value)){previous=null;return null;}
        const point={x:x(index),y:rateY(value),value,index,line};path+=(previous?'L':'M')+point.x+','+point.y+' ';
        if(previous)segments.push([previous,point]);previous=point;points.push(point);return point;
      });return {line,path,dots};
    });
    const saveLabel=label=>{occupied.push(label.box);labels.push(label);};
    // Reserve every column's total first. Never sample away a known value (or
    // turn a missing value into zero) just because the viewport is narrow.
    rows.forEach((row,index)=>{
      const text=rhythmKnown(row.total)?fmt(row.total):'—',top=rhythmKnown(row.total)?barY(row.total):bottom,cx=x(index);
      let placement=null;
      for(const fontSize of [RHYTHM_LAYOUT.fontSize,RHYTHM_LAYOUT.minFontSize]){
        for(const offset of [-8,-20,-32,16,28]){
          const y=top+offset,box=rhythmLabelBox(text,cx,y,fontSize);
          if(box.top<5||box.bottom>bottom-4||!rhythmLabelClear(box,occupied,points,segments))continue;
          placement={text,x:cx,y,box,fontSize,kind:'total',index};break;
        }
        if(placement)break;
      }
      // A steep curve can cross every nearby position. The total still belongs
      // above its column; never silently remove it as the old collision pass did.
      if(!placement){const y=Math.max(RHYTHM_LAYOUT.fontSize+8,top-8),fontSize=RHYTHM_LAYOUT.minFontSize;placement={text,x:cx,y,box:rhythmLabelBox(text,cx,y,fontSize),fontSize,kind:'total',index};}
      saveLabel(placement);
    });
    rows.forEach((_,index)=>{
      const column=points.filter(point=>point.index===index).sort((a,b)=>b.y-a.y),rotation=index%Math.max(column.length,1);
      // Rotate label priority: two close curves must not permanently hide one another.
      [...column.slice(rotation),...column.slice(0,rotation)].forEach(point=>{
        if(complete&&point.value===0)return;
        const text=(point.value*100).toFixed(point.line.digits??1)+'%',placement=rhythmLineLabel(point,text,occupied,points,segments,geometry,complete);
        if(placement)saveLabel({...placement,text,kind:'line',color:point.line.color,series:point.line.key,index});
      });
    });
    const bars=rows.map((row,index)=>{
      const cx=x(index),title=esc(row.tooltip||'');
      if(!rhythmKnown(row.total))return `<g data-rhythm-row="${index}" data-total=""><title>${title}</title></g>`;
      let stack=0;const rectangles=series.map(item=>{
        const value=row.values[item.key],displayValue=Math.max(value,0),barHeight=displayValue/spec.maxValue*plotHeight,top=barY(stack+displayValue);stack+=displayValue;
        if(barHeight>0)barAreas.push({left:cx-barWidth/2,right:cx+barWidth/2,top,bottom:top+barHeight});
        const text=fmt(value);
        for(const fontSize of [RHYTHM_LAYOUT.fontSize,RHYTHM_LAYOUT.minFontSize]){
          if(value<=0||barHeight<fontSize+8||rhythmTextWidth(text,fontSize)>barWidth-4)continue;
          const y=top+barHeight/2+fontSize*.35,box=rhythmLabelBox(text,cx,y,fontSize);
          if(!rhythmLabelClear(box,occupied,points,segments))continue;
          saveLabel({text,x:cx,y,box,fontSize,kind:'segment',index});break;
        }
        return `<rect data-rhythm-bar="${esc(item.key)}" data-value="${value}" x="${cx-barWidth/2}" y="${top}" width="${barWidth}" height="${barHeight}" fill="${item.color}"><title>${esc(row.tips?.[item.key]||item.label+' '+fmt(value))}</title></rect>`;
      }).join('');
      return `<g data-rhythm-row="${index}" data-total="${row.total}"><title>${title}</title>${rectangles}</g>`;
    }).join('');
    const curves=lineData.map(({line,path,dots})=>`<path data-rhythm-series="${esc(line.key)}" d="${path}" fill="none" stroke="${line.color}" stroke-width="${RHYTHM_LAYOUT.lineWidth}"/>${dots.filter(Boolean).map(point=>`<circle data-rhythm-point="${esc(line.key)}" data-index="${point.index}" data-value="${point.value}" cx="${point.x}" cy="${point.y}" r="${RHYTHM_LAYOUT.pointRadius}" fill="#fff" stroke="${line.color}" stroke-width="${RHYTHM_LAYOUT.lineWidth}"><title>${esc(rows[point.index].label)} · ${esc(line.label)} ${(point.value*100).toFixed(line.digits??1)}%</title></circle>`).join('')}`).join('');
    const labelLinks=labels.filter(label=>label.leader).map(label=>`<line data-rhythm-label-link="${esc(label.series)}" data-index="${label.index}" aria-hidden="true" x1="${label.x}" x2="${label.x}" y1="${label.pointY+(label.y<label.pointY?-4:4)}" y2="${label.y+(label.y<label.pointY?4:-label.fontSize-2)}" stroke="${label.color}" stroke-width="1" opacity=".55"/>`).join('');
    const valueLabels=labels.map(label=>{
      // Only bar labels use dark text over colored stacks. Line percentages
      // always retain their series color, matching the line and legend.
      const color=label.kind==='line'?label.color:(barAreas.some(area=>rhythmBoxesOverlap(label.box,area,0))?'#102238':label.color);
      return `<text class="rhythm-value-label rhythm-${label.kind}-label" data-rhythm-label="${label.kind}" data-index="${label.index}"${label.pointY==null?'':` data-point-y="${label.pointY}" data-series="${esc(label.series)}"`} x="${label.x}" y="${label.y}" text-anchor="middle" style="font-size:${label.fontSize}px${color?`;fill:${color}`:''}">${esc(label.text)}</text>`;
    }).join('');
    const axisStride=Math.max(1,Math.ceil((Math.max(...rows.map(row=>rhythmTextWidth(rhythmAxisText(row.label),9)),0)+10)/step)),axisBoxes=[],axisIndices=[];
    [0,rows.length-1,...rows.map((_,index)=>index).filter(index=>index%axisStride===0)].forEach(index=>{
      if(!rows[index]||axisIndices.includes(index))return;const box=rhythmLabelBox(rhythmAxisText(rows[index].label),x(index),bottom+20,9);
      if(axisBoxes.some(other=>rhythmBoxesOverlap(box,other)))return;axisBoxes.push(box);axisIndices.push(index);
    });
    const axis=axisIndices.sort((a,b)=>a-b).map(index=>`<text class="rhythm-axis-label" x="${x(index)}" y="${bottom+20}" text-anchor="middle">${esc(rhythmAxisText(rows[index].label))}<title>${esc(rows[index].label)}</title></text>`).join('');
    return `<svg class="rhythm-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="width:${width}px;height:${height}px" data-plot-left="${left}" data-plot-right="${right}" data-plot-height="${plotHeight}" role="img" aria-label="${esc(spec.title)}"><line aria-hidden="true" class="rhythm-axis-line" x1="${left}" y1="${bottom}" x2="${width-right}" y2="${bottom}"/>${bars}${curves}${labelLinks}${valueLabels}${axis}</svg>`;
  }
  function renderRhythmChart(spec){
    const legend=[...(spec.series||[]),...(spec.lines||[]).map(line=>({...line,line:true}))].map(item=>`<span><i${item.line?' class="line-key"':''} style="background:${item.color}"></i>${esc(item.label)}</span>`).join('');
    return `<div class="rhythm-chart" data-rhythm-kind="${esc(spec.kind)}" data-rhythm-config="${esc(JSON.stringify(spec))}" style="--rhythm-frame-height:${RHYTHM_LAYOUT.frameHeight}px" role="region" tabindex="0" aria-label="${esc(spec.title)}，可横向滚动">${renderRhythmSvg(spec)}</div><div class="legend rhythm-legend">${legend}</div>`;
  }
  let rhythmObserver=null;
  function bindRhythmCharts(){
    rhythmObserver?.disconnect();rhythmObserver=null;
    const charts=[...document.querySelectorAll('#page [data-rhythm-config]')];
    const paint=chart=>{
      const width=Math.floor(chart.clientWidth);if(width<=0||width===chart._rhythmWidth)return;
      chart._rhythmSpec??=JSON.parse(chart.dataset.rhythmConfig);chart._rhythmWidth=width;
      chart.innerHTML=renderRhythmSvg(chart._rhythmSpec,width);
    };
    charts.forEach(paint);
    if(charts.length&&typeof ResizeObserver!=='undefined'){
      rhythmObserver=new ResizeObserver(entries=>entries.forEach(entry=>paint(entry.target)));
      charts.forEach(chart=>rhythmObserver.observe(chart));
    }
  }
  function renderLaunchRateTrends(rows,lines){
    if(!lines.length)return '';
    const series=lines.map(line=>({...line,points:rows.map((row,index)=>rhythmKnown(row.rates?.[line.key])?{index,value:row.rates[line.key],label:row.label}:null)})),known=series.flatMap(line=>line.points.filter(Boolean));
    const text=(value,line)=>(value*100).toFixed(line.digits??1)+'%',labelWidth=Math.max(0,...series.flatMap(line=>line.points.filter(Boolean).map(point=>rhythmTextWidth(text(point.value,line),10))));
    const left=48,right=30,step=Math.max(40,labelWidth+12),width=left+right+Math.max(rows.length,1)*step,x=index=>left+index*step+step/2;
    const min=known.length?Math.min(...known.map(point=>point.value)):0,max=known.length?Math.max(...known.map(point=>point.value)):1;
    const padding=max>min?(max-min)*.12:Math.max(Math.abs(max)*.1,.01),low=min>=0?Math.max(0,min-padding):min-padding,high=max<=1?Math.min(1,max+padding):max+padding;
    const rough=Math.max(high-low,.0001)/4,magnitude=10**Math.floor(Math.log10(rough)),tick=([1,2,5,10].find(value=>value>=rough/magnitude)||10)*magnitude;
    const axisMin=known.length?Math.floor(low/tick+1e-9)*tick:0,axisMax=known.length?Math.max(axisMin+tick,Math.ceil(high/tick-1e-9)*tick):1,y=value=>170-(value-axisMin)/(axisMax-axisMin)*140;
    const axisText=value=>Number((value*100).toPrecision(4))+'%',bounds=`<text class="launch-rate-bound" data-rate-bound="max" x="${left-6}" y="33" text-anchor="end">${axisText(axisMax)}</text><text class="launch-rate-bound" data-rate-bound="min" x="${left-6}" y="173" text-anchor="end">${axisText(axisMin)}</text>`;
    const labelY=new Map();
    rows.forEach((_,index)=>{
      const column=series.filter(line=>line.points[index]).map(line=>({line,point:line.points[index]})).sort((a,b)=>y(a.point.value)-y(b.point.value)),occupied=[];
      column.forEach(({line,point})=>{
        const value=text(point.value,line),pointY=y(point.value);let cy=pointY-10,box=rhythmLabelBox(value,x(index),cy,10);
        if(occupied.some(other=>rhythmBoxesOverlap(box,other))){cy=pointY+18;box=rhythmLabelBox(value,x(index),cy,10)}
        occupied.push(box);labelY.set(line.key+'|'+index,cy);
      });
    });
    const legend=series.map(line=>`<span data-launch-rate-legend="${esc(line.key)}" title="${esc(line.label)}"><i class="line-key" style="background:${line.color}"></i>${esc(line.label.split('（')[0])}</span>`).join('');
    const curves=series.map(line=>{
      let path='',previous=false;line.points.forEach(point=>{if(!point){previous=false;return}path+=(previous?'L':'M')+x(point.index)+','+y(point.value)+' ';previous=true});
      const values=line.points.filter(Boolean),dots=values.map(point=>{const tip=`${point.label} · ${line.label} ${text(point.value,line)}`;return `<circle data-launch-rate-point="${esc(line.key)}" data-index="${point.index}" data-value="${point.value}" cx="${x(point.index)}" cy="${y(point.value)}" r="3" tabindex="0" role="img" aria-label="${esc(tip)}"><title>${esc(tip)}</title></circle>`}).join('');
      const labels=values.map(point=>`<text class="launch-rate-value" data-launch-rate-label="${esc(line.key)}" data-index="${point.index}" data-point-y="${y(point.value)}" x="${x(point.index)}" y="${labelY.get(line.key+'|'+point.index)}" text-anchor="middle">${text(point.value,line)}</text>`).join('');
      return `<g data-launch-rate="${esc(line.key)}" style="--rate-color:${line.color}"><path data-launch-rate-line="${esc(line.key)}" d="${path}" fill="none"/>${dots}${labels}</g>`;
    }).join('');
    const stride=Math.max(1,Math.ceil((Math.max(0,...rows.map(row=>rhythmTextWidth(rhythmAxisText(row.label),9)))+10)/step)),axisBoxes=[];
    const axis=[...new Set([0,rows.length-1,...rows.map((_,index)=>index).filter(index=>index%stride===0)])].map(index=>{
      const value=rhythmAxisText(rows[index].label),box=rhythmLabelBox(value,x(index),210,9);if(axisBoxes.some(other=>rhythmBoxesOverlap(box,other)))return '';axisBoxes.push(box);
      return `<text class="rhythm-axis-label" x="${x(index)}" y="210" text-anchor="middle">${esc(value)}<title>${esc(rows[index].label)}</title></text>`;
    }).join('');
    return `<section class="launch-rate-trends" aria-label="累计比例趋势"><div class="launch-rate-history" tabindex="0" role="region" aria-label="累计比例趋势，可横向滚动"><svg width="${width}" height="224" viewBox="0 0 ${width} 224" style="width:${width}px;height:224px" data-rate-min="${axisMin}" data-rate-max="${axisMax}" role="img" aria-label="${esc(lines.map(line=>line.label).join('、'))}，共享百分比范围${axisText(axisMin)}至${axisText(axisMax)}"><line class="rhythm-axis-line" x1="${left}" y1="170" x2="${width-right}" y2="170"/>${bounds}${curves}${axis}</svg></div><div class="legend rhythm-legend">${legend}</div></section>`;
  }
  function avoidLabelY(baseY,occupied=[],minY=12,maxY=280,gap=14){
    let y=Math.min(Math.max(baseY,minY),maxY);
    for(let attempt=0;attempt<occupied.length*2+2;attempt++){
      const conflict=occupied.find(value=>Math.abs(value-y)<gap);
      if(conflict==null)break;
      const above=conflict-gap,below=conflict+gap;
      y=above>=minY?above:Math.min(below,maxY);
    }
    return Math.min(Math.max(y,minY),maxY);
  }
  // 通用浅色图表色板。
  const chartPalette = {blue:"#BDD7EE",cyan:"#B5DDE5",green:"#C6E0B4",yellow:"#FFE699",orange:"#F8CBAD",rose:"#F0CCCC",violet:"#CCC0DA"};
  // 留存大定/锁单堆叠趋势图按系列出现顺序取色，不按能源类型固定颜色。
  const stackedTrendPalette=["#FFF2CC","#E2F0D9","#C8E8E8","#A8D8EA","#A0C1E8","#DCC5ED","#F0C8C8","#F8D8B0"];
  const moduleLabels = DATA.config.module_labels;
  const forecastStages=[{id:"small",label:"小订预测"},{id:"launch",label:"首销预测"},{id:"steady",label:"平销预测"}];
  const forecastViews=["result","evidence","score"];
  const normalizeForecastView=id=>id==='params'?'evidence':id;
  const state = {subject:null,module:"overview",forecastStage:null,forecastStageAuto:true,forecastView:"result",forecastCampaign:null,grain:"week",period:null};
  const forecastDrafts=new Map();
  const forecastDraftSelector='[data-forecast-target],[data-forecast-input],[data-forecast-allocation],[data-forecast-ref],[data-forecast-ref-weight],[data-forecast-chart-ref],[data-small-ref],[data-small-weight],[data-small-input],[data-steady-ref],[data-steady-weight],[data-bridge-control],[data-lifecycle-ref],[data-lifecycle-weight],[data-lifecycle-chart-ref]';
  const forecastImportScopes=new Map();
  let forecastStorageWarning='';
  const forecastStorageKey='sales-forecast-independent-v1:'+location.pathname;
  const lastSubjectKey=forecastStorageKey+':last-subject';
  const forecastDraftControlKey=control=>`${control.closest('[data-bridge-stage]')?.dataset.bridgeStage||''}|${control.tagName}|${[...control.attributes].filter(attr=>attr.name.startsWith('data-')||attr.name==='type'||(attr.name==='value'&&['checkbox','radio'].includes(control.type))).map(attr=>`${attr.name}=${attr.value}`).sort().join('|')}`;
  function forecastSubjectId(value){
    const aliases=DATA.forecast_subject_aliases||{},mapped=Object.hasOwn(aliases,value)?aliases[value]:null;
    return typeof mapped==='string'?mapped:value;
  }
  function forecastDraftSubjectKey(key){
    const separator=key.indexOf('|'),id=separator<0?key:key.slice(0,separator);
    return forecastSubjectId(id)+(separator<0?'':key.slice(separator));
  }
  function forecastRequestedSubject(requested){
    const id=forecastSubjectId(requested);
    return DATA.subjects.find(item=>item.id===id||item.name===requested);
  }
  function remapForecastDraftEntries(entries){
    const drafts=new Map();
    for(const [key,value] of entries){const current=forecastDraftSubjectKey(key);if(!drafts.has(current)||current===key)drafts.set(current,value);}
    return drafts;
  }
  function forecastDraftControls(root){
    const controls = [...root.querySelectorAll(forecastDraftSelector)];
    if (root._forecastNavSettings) controls.push(...root._forecastNavSettings.querySelectorAll('[data-forecast-target]'));
    return controls;
  }
  function captureForecastDraft(){
    const root=document.querySelector('.forecast-workspace.forecast-v2');
    if(state.module!=="sales_forecast"||!root||root.dataset.forecastDirty!=="true")return;
    const meta=root._forecastDraftState?.()||{};
    forecastDrafts.set(root._forecastSubjectId||state.subject,{generatedAt:DATA.meta?.generated_at,meta,controls:forecastDraftControls(root).filter(control=>root._forecastTouched?.has(forecastDraftControlKey(control))||meta.parameterOverrides?.includes(control.dataset.forecastInput)).map(control=>({key:forecastDraftControlKey(control),value:control.value,checked:control.type==='checkbox'?control.checked:null}))});
    return persistForecastState();
  }
  function sameForecastReferenceValue(left,right){
    if(left===right)return true;
    const leftParts=String(left).split('|'),rightParts=String(right).split('|');
    if(leftParts.length===1&&rightParts.length===1)return sameForecastModel(left,right);
    const modelParts={small:2,steady:1,'steady-lock':1}[leftParts[0]];
    if(!modelParts||leftParts.length<=modelParts+1||leftParts.length!==rightParts.length||leftParts[0]!==rightParts[0])return false;
    return leftParts.slice(1).every((part,index)=>index<modelParts?sameForecastModel(part,rightParts[index+1]):part===rightParts[index+1]);
  }
  function forecastDraftForSubject(key){
    if(!key)return;
    const current=forecastDraftSubjectKey(key),separator=current.indexOf('|'),id=separator<0?current:current.slice(0,separator),suffix=separator<0?'':current.slice(separator+1);
    const aliases=[...forecastDrafts.keys()].filter(candidate=>{
      if(candidate===current)return false;
      const normalized=forecastDraftSubjectKey(candidate),split=normalized.indexOf('|');
      if(normalized===current)return true;
      return !!suffix&&split>=0&&normalized.slice(0,split)===id&&sameForecastReferenceValue(normalized.slice(split+1),suffix);
    });
    if(aliases.length){
      if(!forecastDrafts.has(current))forecastDrafts.set(current,forecastDrafts.get(aliases[0]));
      for(const alias of aliases)forecastDrafts.delete(alias);
      persistForecastState();
    }
    return forecastDrafts.get(current);
  }
  function restoreForecastDraft(){
    const root=document.querySelector('.forecast-workspace.forecast-v2'),draft=forecastDraftForSubject(root?._forecastSubjectId||state.subject);
    if(!root||!draft)return;
    const controls=new Map(forecastDraftControls(root).map(control=>[forecastDraftControlKey(control),control]));
    root._forecastTouched=new Set();
    draft.controls.forEach(saved=>{
      let control=controls.get(saved.key),value=saved.value;
      if(!control&&saved.checked!==null&&/data-(forecast|lifecycle)-chart-ref=/.test(saved.key)){
        const key=saved.key.replace(/\|value=.*$/,'');
        const matches=[...controls].filter(([current,item])=>current.replace(/\|value=.*$/,'')===key&&sameForecastReferenceValue(saved.value,item.value));
        if(matches.length===1)control=matches[0][1];
      }
      if(!control||control.disabled)return;
      if(control.tagName==='SELECT'){
        let option=[...control.options].find(item=>item.value===value);
        if(!option&&control.matches('[data-forecast-ref],[data-lifecycle-ref]')){
          const matches=[...control.options].filter(item=>sameForecastReferenceValue(value,item.value));
          if(matches.length===1)option=matches[0];
        }
        if(!option||option.disabled)return;value=option.value;
      }
      if(saved.checked!==null)control.checked=saved.checked;else control.value=value;
      root._forecastTouched.add(forecastDraftControlKey(control));
    });
    root.dataset.forecastDirty="true";root._forecastRestoreDraft?.(draft.meta||{});
    const feedback=(root._forecastToolbar || root).querySelector('[data-forecast-feedback]');if(feedback){feedback.dataset.state=forecastStorageWarning?'loading':'success';feedback.querySelector('span').textContent=forecastStorageWarning?'仅当前页保存':'已恢复本机草稿';feedback.title=forecastStorageWarning||(draft.generatedAt!==DATA.meta?.generated_at?'数据版本已更新：只恢复人工修改项，真实订单和未修改参数采用本次生成数据。':'已恢复当前浏览器保存的人工参数。');}
  }

  const importedForecastRows = new Map();
  const importedForecastUndo = new Map();
  const sharedForecastUndo = new Map();
  // Per-page local storage: no uploads, and never store actual-order payloads.
  function persistForecastState(){
    try{
      localStorage.setItem(forecastStorageKey,JSON.stringify({version:1,drafts:[...forecastDrafts],imports:[...importedForecastRows],scopes:[...forecastImportScopes]}));
      forecastStorageWarning='';return true;
    }catch(error){
      forecastStorageWarning='本机保存失败（浏览器限制或空间不足）；当前页仍可使用，刷新可能恢复到上次成功保存的状态。';
      return false;
    }
  }
  function loadForecastState(){
    try{
      let raw=localStorage.getItem(forecastStorageKey),migrated=false;
      if(raw===null&&FORECAST_APP&&location.protocol==='file:'&&location.pathname.includes('/output_file/static/')){
        const oldPath=location.pathname.replace('/output_file/static/','/output_file/');
        raw=localStorage.getItem('sales-forecast-independent-v1:'+oldPath);migrated=raw!==null;
      }
      if(raw===null&&FORECAST_APP&&DATA.forecast_legacy_page){
        const oldPath=new URL(DATA.forecast_legacy_page,location.href).pathname;
        raw=localStorage.getItem('harmony-forecast-v1:'+oldPath);migrated=raw!==null;
      }
      if(!raw)return;
      if(raw.length>8*1024*1024)throw Error('保存的数据过大');
      const saved=JSON.parse(raw);
      if(saved?.version!==1||!['drafts','imports','scopes'].every(key=>Array.isArray(saved[key])&&saved[key].length<=500))throw Error('保存格式不兼容');
      const drafts=[],imports=[],scopes=[];
      for(const entry of saved.drafts){
        if(!Array.isArray(entry)||entry.length!==2)throw Error('参数草稿损坏');
        const [key,draft]=entry;
        if(typeof key!=='string'||!Array.isArray(draft?.controls)||draft.controls.length>3000||!draft.controls.every(item=>typeof item?.key==='string'&&typeof item.value==='string'&&[null,true,false].includes(item.checked)))throw Error('参数草稿损坏');
        drafts.push([key,draft]);
      }
      for(const entry of saved.imports){
        if(!Array.isArray(entry)||entry.length!==2)throw Error('外部预测保存记录损坏');
        const [key,item]=entry,seen=new Set();
        if(typeof key!=='string'||!Array.isArray(item?.rows)||item.rows.length>20000)throw Error('外部预测保存记录损坏');
        for(const row of item.rows){
          const identity=(row.metric||row.stage)+'|'+row.date,validDate=typeof row.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.date)&&Number.isFinite(Date.parse(row.date+'T00:00:00Z'))&&new Date(row.date+'T00:00:00Z').toISOString().slice(0,10)===row.date;
          if(!validDate||typeof row.model!=='string'||!forecastStages.some(stage=>stage.id===row.stage)||(row.metric&&!['small','gross','lock'].includes(row.metric))||(!Number.isFinite(row.quantity)||row.quantity>Number.MAX_SAFE_INTEGER)||row.quantity<0||seen.has(identity))throw Error('外部预测保存记录损坏');
          seen.add(identity);
        }
        imports.push([key,item]);
      }
      for(const [key,value] of saved.scopes){
        if(typeof key!=='string'||!value||!Object.values(value).every(scope=>['future','all'].includes(scope)))throw Error('导入范围保存记录损坏');
        scopes.push([key,value]);
      }
      for(const [key,value] of remapForecastDraftEntries(drafts))forecastDrafts.set(key,value);
      if(drafts.some(([key])=>forecastDraftSubjectKey(key)!==key))migrated=true;
      for(const [key,value] of imports)importedForecastRows.set(key,value);
      for(const [key,value] of scopes)forecastImportScopes.set(key,value);
      if(migrated)persistForecastState();
    }catch(error){
      if(error instanceof ReferenceError || error instanceof TypeError)console.debug('[销量预测] 读取本机草稿失败',error);
      forecastStorageWarning='本机保存内容不可读取，已使用系统默认值；原保存内容未删除。';
    }
  }
  loadForecastState();
  window.addEventListener('pagehide',()=>captureForecastDraft());
  window.addEventListener('beforeunload',()=>captureForecastDraft());
  function reconcileForecastImportState(name,sameModel){
    let changed=false;
    for(const records of [importedForecastRows,importedForecastUndo,forecastImportScopes]){
      const aliases=[...records.keys()].filter(key=>key!==name&&sameModel(key,name));
      if(!aliases.length)continue;
      // A saved import is one user-selected dataset; prefer the current label,
      // without combining independent snapshots or resurrecting a cleared alias.
      if(!records.has(name))records.set(name,records.get(aliases[0]));
      for(const key of aliases)records.delete(key);
      changed=true;
    }
    return changed;
  }
  function selectForecastImportRows(rows,name,sameModel){
    const selected=new Map();
    for(const row of rows){
      if(!sameModel(row.model,name))continue;
      const key=row.metric+'|'+row.date;
      if(selected.has(key))throw Error(row.date+'同指标重复（含别名映射后的重复）');
      selected.set(key,row);
    }
    return [...selected.values()];
  }
  function bindForecastImport(root, context) {
    const endpoint=document.querySelector?.('meta[name="forecast-import-api"]')?.content;
    const datasets=endpoint?new Map():importedForecastRows, undoRows=endpoint?sharedForecastUndo:importedForecastUndo;
    const name=context.targetState().name;
    const url=endpoint?new URL(endpoint,location.href):null;
    if(url)url.searchParams.set('model',forecastModelKey(name));
    let revision=null, serial=0, writing=false, readFailed=false;
    const statusAll=(message,state)=>{for(const {card} of cards){
      const notice=card.querySelector('[data-forecast-import-status]');
      notice.dataset.state=state;notice.textContent=message;
    }};
    async function sync(){
      if(!url||writing||!root.isConnected)return;
      const token=++serial, readUrl=new URL(url);
      readUrl.searchParams.set('known',revision??-1);
      try{
        const response=await fetch(readUrl,{cache:'no-store'});
        if(!response.ok)throw Error();
        const result=await response.json();
        if(token!==serial||!root.isConnected)return;
        if(result.revision===revision){
          if(readFailed)statusAll('共享导入已同步。','success');
          readFailed=false;return;
        }
        readFailed=false;
        if(result.record)datasets.set(name,result.record);else datasets.delete(name);
        revision=result.revision;
        if(undoRows.get(name)?.revision!==revision)undoRows.delete(name);
        statusAll(result.record?'已载入 '+result.record.rows.length+' 条共享预测':'','success');
        render();
      }catch{
        if(token===serial){readFailed=true;statusAll('共享导入暂时无法读取，请稍后重试。','error');}
      }
    }
    async function save(name,record){
      if(url){
        if(revision===null||writing)throw Error('共享数据正在同步，请稍后重试');
        writing=true;++serial;
        try{
          const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Forecast-Import':'1'},
            body:JSON.stringify({revision,record})});
          const result=await response.json();
          if(!response.ok)throw Error(result.error||'共享保存失败');
          revision=result.revision;
        }catch(error){
          writing=false;await sync();throw error;
        }finally{writing=false;}
      }
      if(record)datasets.set(name,record);else datasets.delete(name);
      return !!url||persistForecastState();
    }
    const importName=()=>{const name=context.targetState().name;if(!endpoint&&reconcileForecastImportState(name,context.sameModel))persistForecastState();return name;};
    const stages={small:['小订','小订量'],launch:['首销','总大定'],steady:['平销','交车锁单']};
    const stageFor=(date,target,preferred)=>{
      const windows={small:!!target.smallStartDate&&date>=target.smallStartDate&&date<=target.smallEndDate,launch:!!target.launchDate&&date>=target.launchDate&&date<=context.stageInfo(target).end,steady:!!target.steadyStartDate&&date>=target.steadyStartDate};
      return windows[preferred]?preferred:Object.keys(windows).find(key=>windows[key])||'';
    };
    const displayCount=value=>fmt(Number.isFinite(value)?Math.round(value):null);
    const metricOf=row=>row.metric||(row.stage==='small'?'small':row.stage==='steady'?'lock':'gross');
    const cards=[];
    for(const [stage,[label,unit]] of Object.entries(stages)){
      const anchor=root.querySelector(`[data-forecast-import-anchor="${stage}"]`);if(!anchor)continue;
      const card=document.createElement('section');card.className='forecast-import';card.dataset.forecastImport=stage;
      card.innerHTML=`<h4 class="forecast-import-head">外部逐日预测</h4>
        <details class="forecast-import-manager"><summary>管理导入（${endpoint?'全员共享':'仅当前浏览器'}）</summary>
          <div class="forecast-import-actions">
            <label>导入方式<select data-forecast-import-mode aria-label="外部预测导入方式"><option value="merge">合并（同指标同日更新）</option><option value="replace">替换该车型全部外部预测</option></select></label>
            <label>选择 Excel/CSV<input type="file" accept=".xlsx,.csv" data-forecast-import-file aria-label="导入${label}逐日预测"></label>
            <button type="button" data-forecast-import-template>下载 CSV 模板</button>
            <button type="button" data-forecast-import-clear>清除该车型全部导入</button>
          </div>
        </details>
        <p role="status" aria-live="polite" data-forecast-import-status></p>
        <div data-forecast-import-result></div>`;
      card.querySelector('.forecast-import-manager').open=!datasets.get(importName())?.rows.length;
      anchor.append(card);cards.push({stage,unit,card});
      const undo=document.createElement('button');undo.type='button';undo.dataset.forecastImportUndo='';undo.textContent='撤销清除';undo.hidden=true;
      card.querySelector('.forecast-import-actions').append(undo);
      undo.onclick=async()=>{
        const name=importName(),previous=undoRows.get(name);if(!previous)return;
        try{const saved=await save(name,endpoint?previous.record:previous);undoRows.delete(name);
          statusAll(saved?'已恢复清除前的外部预测。':forecastStorageWarning,saved?'success':'error');render();
        }catch(error){statusAll(error.message,'error');}
      };
      const status=card.querySelector('[data-forecast-import-status]'),input=card.querySelector('[data-forecast-import-file]');
      input.onchange=async()=>{
        const file=input.files?.[0];if(!file)return;
        const mode=card.querySelector('[data-forecast-import-mode]').value;
        for(const {card:other} of cards)other.querySelectorAll('[data-forecast-import-file],[data-forecast-import-mode],[data-forecast-import-clear],[data-forecast-import-undo]').forEach(control=>control.disabled=true);
        card.setAttribute('aria-busy','true');status.dataset.state='loading';status.textContent='正在读取并校验…';
        try{
          const target=context.targetState(),all=await window.ForecastImport.read(file),rows=selectForecastImportRows(all.flatMap(row=>{
            const entries=row.quantity!==undefined?[[stage==='small'?'small':'gross',row.quantity]]:[['small',row.small],['gross',row.gross]];
            return entries.filter(([,quantity])=>quantity!==undefined).map(([metric,quantity])=>({model:row.model,date:row.date,metric,quantity,stage:metric==='small'?'small':stageFor(row.date,target,'launch')||'launch',source:file.name}));
          }),target.name,context.sameModel);
          if(!rows.length)throw Error('没有匹配当前车型“'+target.name+'”的记录，请使用当前代际名或已映射的历史传播名');
          if(!root.isConnected)return;
          const previous=datasets.get(target.name);
          if(mode==='replace'&&previous?.rows.length&&!window.confirm('替换当前车型全部阶段的外部预测？原有'+previous.rows.length+'条记录将被本文件替换。真实订单和算法结果不受影响。')){status.dataset.state='';status.textContent='已取消替换，原导入数据保持不变。';return;}
          const merged=new Map((mode==='merge'?previous?.rows||[]:[]).map(row=>[metricOf(row)+'|'+row.date,row]));
          let updated=0;for(const row of rows){const key=metricOf(row)+'|'+row.date;if(merged.has(key))updated++;merged.set(key,row);}
          if(merged.size>20000)throw Error('合并后超过20000条记录，请清理旧外部预测或选择替换');
          const saved=await save(target.name,{filename:file.name,rows:[...merged.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.stage.localeCompare(b.stage))});
          undoRows.delete(target.name);

          status.dataset.state=saved?'success':'loading';status.textContent='导入成功：'+rows.length+'条；'+(mode==='merge'?'合并后共'+merged.size+'条，同指标同日更新'+updated+'条':'已替换当前车型全部外部预测')+(all.some(row=>!context.sameModel(row.model,target.name))?'；其他车型记录未导入':'')+'。'+(saved?(endpoint?'已共享。':'已保存本机，刷新可恢复。'):forecastStorageWarning);
          render();
        }catch(error){status.dataset.state='error';status.textContent='导入失败：'+error.message+'；原导入数据保持不变。';}
        finally{for(const {card:other} of cards){other.querySelectorAll('[data-forecast-import-file],[data-forecast-import-mode],[data-forecast-import-clear],[data-forecast-import-undo]').forEach(control=>control.disabled=false);other.querySelector('[data-forecast-import-clear]').disabled=!datasets.get(importName())?.rows.length;}input.value='';card.setAttribute('aria-busy','false');}
      };
      card.querySelector('[data-forecast-import-clear]').onclick=async()=>{
        const name=importName(),previous=datasets.get(name);if(!previous?.rows.length)return;
        try{const saved=await save(name,null);undoRows.set(name,endpoint?{revision,record:previous}:previous);
          statusAll(saved?'已清除当前车型外部预测，可撤销。':forecastStorageWarning,saved?'success':'error');render();
        }catch(error){statusAll(error.message,'error');}
      };
      card.querySelector('[data-forecast-import-template]').onclick=()=>{
        const target=context.targetState(),date=stage==='small'?target.smallStartDate:stage==='launch'?target.launchDate:target.steadyStartDate;
        const text='\uFEFF车型（代际）,日期,预测小订,预测大定\r\n'+[target.name,date||context.todayIso(),'',0].map(csvCell).join(',')+'\r\n';
        downloadBlob(new Blob([text],{type:'text/csv;charset=utf-8'}),'逐日预测导入模板.csv');
      };
    }
    function render(){
      const target=context.targetState(),imported=datasets.get(importName()),today=context.todayIso(),actual=context.actualForTarget(target);
      const rawRate=root.querySelector('[data-forecast-input="lock"]')?.value;
      const lockRate=rawRate!=null&&rawRate.trim()!==''?Number(rawRate)/100:NaN,validRate=Number.isFinite(lockRate)&&lockRate>=0&&lockRate<=1;
      for(const {stage,unit,card} of cards){
        card.querySelector('[data-forecast-import-clear]').disabled=!imported?.rows.length;
        card.querySelector('[data-forecast-import-undo]').hidden=!undoRows.has(target.name)||(endpoint&&revision===null);
        const node=card.querySelector('[data-forecast-import-result]'),notice=card.querySelector('[data-forecast-import-status]');
        const rows=(imported?.rows||[]).filter(row=>(stage==='small'?metricOf(row)==='small':['gross','lock'].includes(metricOf(row)))&&stageFor(row.date,target,stage)===stage&&(metricOf(row)!=='lock'||stage==='steady'));
        const forecasts=new Map();
        for(const row of rows){
          const value=stage==='steady'&&metricOf(row)==='gross'?(validRate?row.quantity*lockRate:null):row.quantity;
          if(metricOf(row)==='lock'&&forecasts.has(row.date))continue;
          forecasts.set(row.date,{...row,value});
        }
        const actualRows=context.actualRows(stage,target,actual).filter(row=>row.date<=today&&stageFor(row.date,target,stage)===stage);
        const actualMap=new Map(actualRows.filter(row=>Number.isFinite(row.value)&&row.value>=0).map(row=>[row.date,row.value]));
        const dates=[...new Set([...forecasts.keys(),...actualMap.keys()])].sort();
        if(!notice.dataset.state&&imported){notice.dataset.state='success';notice.textContent='已载入 '+imported.rows.length+' 条本地预测';}
        if(!dates.length){node.innerHTML='<p>本阶段暂无逐日数据</p>';continue;}
        const values=dates.map(date=>forecasts.get(date)?.value??null),known=values.filter(Number.isFinite),total=known.reduce((a,b)=>a+b,0);
        const showRate=stage==='steady'&&rows.some(row=>metricOf(row)==='gross');
        const rateNote=showRate?(validRate?'锁单预测 = 总大定 × '+(lockRate*100).toFixed(1)+'%':'锁单率缺失或无效，无法换算'):'';
        node.innerHTML='<p><b>外部预测合计：'+(known.length?fmt(Math.round(total)):'—')+' 单（'+unit+'）</b>'+(rateNote?' · '+esc(rateNote):'')+'</p>'+renderLifecycleLineChart({
          series:[{label:'实际'+unit+(actualMap.has(today)?'（今日未结束）':''),values:dates.map(date=>actualMap.get(date)??null),color:'#2859f5',role:'actual'},{label:'外部预测',values:values.map(v=>v==null?null:Math.round(v)),color:'#7C3AED',role:'reference',dashed:true}],
          labels:dates,unit:'number',compact:true,table:false,readoutHint:'',ariaLabel:stages[stage][0]+'外部逐日预测折线图'
        })+'<details><summary>查看逐日预测</summary><div class="forecast-score-table"><table><thead><tr><th>日期</th><th>实际'+unit+'</th><th>外部预测'+unit+'</th>'+(stage==='steady'?'<th>导入总大定</th>':'')+'<th>来源文件</th></tr></thead><tbody>'+dates.map(date=>'<tr><td>'+esc(date)+(date===today?'（当日未结束）':'')+'</td><td>'+fmt(actualMap.get(date)??null)+'</td><td>'+displayCount(forecasts.get(date)?.value)+'</td>'+(stage==='steady'?'<td>'+displayCount(metricOf(forecasts.get(date)||{})==='gross'?forecasts.get(date)?.quantity:null)+'</td>':'')+'<td>'+esc(forecasts.get(date)?.source||'')+'</td></tr>').join('')+'</tbody></table></div></details>';
      }
    }
    root._renderImportedForecast=render;render();
    if(endpoint){root._syncSharedImports=sync;sync();}
  }

  const boardCache={};
  async function getDashboard(subjectId=state.subject,moduleId=state.module){
    if(moduleId==="sales_forecast"&&!moduleAvailable(DATA.subjects.find(item=>item.id===subjectId),moduleId))return null;
    const ownerId=moduleId==="sales_forecast"?(DATA.subjects.find(item=>item.modules.includes("sales_forecast"))?.id||subjectId):subjectId;
    const key=`${ownerId}|${moduleId}`;
    if(!(key in boardCache)){
      const b64=(DATA.dashboard_blocks||{})[key];
      boardCache[key]=b64?unpackDashboard(await decompressJson(b64)):null;
    }
    return boardCache[key];
  }
  function subject(){return DATA.subjects.find(item=>item.id===state.subject)}
  const quickBrandOrder=['问界','智界','享界','尊界','尚界'];
  const generationYear=name=>Math.max(...[...String(name||'').matchAll(/(20\d{2})\s*款/g)].map(match=>Number(match[1])),0);
  const generationAggregate=name=>String(name||'').match(/(总计|汇总|合计)\s*$/)?.[1]||'';
  const generationModelKey=name=>String(name||'').replace(/20\d{2}\s*款/g,'').replace(/总计|汇总|合计/g,'').replace(/\s+/g,'').toLowerCase();
  const quickGenerationExcluded=name=>/beta|预订|直订|盲订/i.test(String(name||''));
  const quickGenerationFamilyKey=name=>generationModelKey(name).replace(/增程|纯电|智驾版|标准版/g,'');
  const generationShortName=name=>{const raw=String(name||'').trim(),aggregate=generationAggregate(raw),value=raw.replace(/(总计|汇总|合计)\s*$/,'').trim(),year=generationYear(value),brand=quickBrandOrder.find(item=>value.startsWith(item))||value.match(/^[\u4e00-\u9fff]{1,3}界/)?.[0]||'',model=value.slice(brand.length).replace(/20\d{2}\s*款/g,'').replace(/\s+Ultimate\b/ig,'U').replace(/\s+典藏大观\b/g,'大观').replace(/\s+/g,' ').trim(),yearLabel=year?` ${String(year).slice(-2)}`:'';return `${model||value}${yearLabel}${aggregate}`};
  function latestQuickGenerations(){
    const candidates=DATA.subjects.filter(item=>item.type==='generation').filter(item=>!quickGenerationExcluded(item.name));
    const newestYear=new Map();
    candidates.forEach(item=>{const key=quickGenerationFamilyKey(item.name);newestYear.set(key,Math.max(newestYear.get(key)||0,generationYear(item.name)))});
    const latest=new Map();
    candidates.forEach(item=>{const year=generationYear(item.name);if(year<newestYear.get(quickGenerationFamilyKey(item.name)))return;const key=generationModelKey(item.name)+'|'+generationAggregate(item.name),old=latest.get(key);if(!old||year>generationYear(old.name)||(year===generationYear(old.name)&&item.name.localeCompare(old.name,'zh-CN')<0))latest.set(key,item)});
    return [...latest.values()].sort((left,right)=>{const brandLeft=quickBrandOrder.indexOf(left.parent),brandRight=quickBrandOrder.indexOf(right.parent);return (brandLeft<0?quickBrandOrder.length:brandLeft)-(brandRight<0?quickBrandOrder.length:brandRight)||generationModelKey(left.name).localeCompare(generationModelKey(right.name),'en')||left.name.localeCompare(right.name,'zh-CN')});
  }
  function syncTopbarQuickLayout(){
    const topbar=document.querySelector('.topbar'),list=$('#quickGenerationList');if(!topbar||!list)return;
    const rows=new Set([...list.children].map(button=>button.offsetTop));
    topbar.classList.toggle('quick-generation-wrapped',rows.size>1);
  }
  function renderQuickGenerationLinks(){
    const list=$('#quickGenerationList');if(!list)return;
    list.innerHTML=latestQuickGenerations().map(item=>`<button type="button" class="quick-generation-button${item.id===state.subject?' active':''}" data-quick-generation="${esc(item.id)}" title="${esc(item.name)}" aria-label="${esc(item.name)}" aria-pressed="${item.id===state.subject}">${esc(generationShortName(item.name))}</button>`).join('');
    syncTopbarQuickLayout();
  }
  const rawForecastModelKey=value=>String(value||"").toLowerCase().replace(/鸿蒙智行|车型|款|总计|汇总|合计|\s|[()（）/\\_&-]/g,"");
  const forecastModelAliases=()=>{const owner=DATA.subjects.find(item=>item.modules.includes("sales_forecast")),board=owner?boardCache[`${owner.id}|sales_forecast`]:null;return forecastDataFromBoard(board)?.model_aliases||{}};
  const forecastModelKey=(value,aliases=forecastModelAliases())=>{const raw=rawForecastModelKey(value);return rawForecastModelKey(aliases[raw]||value)};
  const sameForecastModel=(leftValue,rightValue,aliases=forecastModelAliases())=>{const left=forecastModelKey(leftValue,aliases),right=forecastModelKey(rightValue,aliases);return !!left&&!!right&&left===right};
  const moduleAvailable=(item,moduleId)=>moduleId==="sales_forecast"
    ?item?.type==="generation"&&(item.modules.includes(moduleId)||DATA.subjects.some(candidate=>candidate.modules.includes("sales_forecast")))
    :!FORECAST_APP&&!!item?.modules.includes(moduleId);
  function forecastPageUrl(){
    const url=new URL(DATA.forecast_page,location.href);url.searchParams.set('subject',state.subject||'');url.searchParams.set('module','sales_forecast');
    if(!state.forecastStageAuto&&state.forecastStage)url.searchParams.set('forecastStage',state.forecastStage);
    url.searchParams.set('forecastView',state.forecastView||'result');if(state.forecastCampaign)url.searchParams.set('forecastCampaign',state.forecastCampaign);
    return url.href;
  }
  function forecastDataFromBoard(board){const view=Object.values(board?.views||{})[0],page=Object.values(view?.pages||{})[0];return page?.workspace?.data}
  function linkedForecastData(data){
    const selected=subject();
    if(!data||selected?.type!=="generation")return data;
    const campaigns=(data.targets||[]).filter(item=>sameForecastModel(item.primary_generation||item.name,selected.name));
    const steady=(data.steady_targets||[]).find(item=>sameForecastModel(item.name,selected.name));
    const option=state.forecastStage==='steady'&&steady?steady:campaigns.find(item=>item.name===state.forecastCampaign)||campaigns.find(item=>item.stage==='active')||campaigns.toSorted((a,b)=>String(b.launch_date||'').localeCompare(String(a.launch_date||'')))[0];
    if(!option)return data;
    const original=data.target||{};
    if(sameForecastModel(option.name,original.name))return {...data,target:{...original,...option,name:option.name,launch_days:option.days??original.launch_days,total_small:Number(option.small??0)}};
    const reference=(data.history||[]).find(item=>sameForecastModel(item.model,option.history_model||option.name));
    return {...data,target:{
      name:option.name,primary_generation:option.primary_generation||option.name,secondary_generation:option.secondary_generation||"",has_small:option.has_small,history_model:option.history_model||reference?.model||"",
      tier:option.tier||reference?.tier||"未维护",energy:option.energy||reference?.energy||"未维护",
      launch_node:option.node||reference?.node||"未维护",launch_date:option.launch_date??reference?.launch_date??"",
      end_date:option.end_date??reference?.end_date??"",stage:option.stage||"unknown",stage_label:option.stage_label||"时间缺失",calendar_day:Number(option.calendar_day||0),date_source_label:option.date_source_label||"日期数据缺失",
      small_start_date:option.small_start_date||"",small_end_date:option.small_end_date||"",small_stage:option.small_stage||"unknown",small_stage_label:option.small_stage_label||"小订时间缺失",small_calendar_day:Number(option.small_calendar_day||0),small_days:Number(option.small_days||0),steady_start_date:option.steady_start_date||"",
      selected_source:option.selected_source||"missing",selected_source_label:option.selected_source_label||"数据缺失",data_missing:!!option.data_missing,
      field_sources:option.field_sources||{},missing_fields:option.missing_fields||[],source_latest_date:option.source_latest_date||"",
      launch_weekday:option.launch_weekday||reference?.launch_weekday||"未维护",launch_period:option.launch_period||reference?.launch_period||"未维护",small_period:option.small_period||"未维护",
      small_release_start_hour:option.small_release_start_hour,launch_release_start_hour:option.launch_release_start_hour,
      launch_days:Number(option.days??reference?.days??0),total_small:Number(option.small??0),
      conversion:Number(reference?.conversion??0),direct_share:Number(reference?.direct_share??0),lock_rate:Number(reference?.lock_rate??0),
    }};
  }

  function linkedForecastSource(workspace){
    const data=workspace?.data||{},target=data.target||{},actual=(data.actuals||[]).find(item=>sameForecastModel(item.model,target.name,data.model_aliases||{}));
    return actual?.day_source||workspace?.source;
  }

  function forecastStageFromTarget(target){
    if(target?.stage==="ended")return "steady";
    if(target?.stage==="active")return "launch";
    if(target?.stage==="before")return "small";
    return ["before","d1","active","ended"].includes(target?.small_stage)?"small":"launch";
  }
  async function syncForecastStageToTarget(){
    if(state.module!=="sales_forecast"||!state.forecastStageAuto)return;
    const subjectId=state.subject,campaign=state.forecastCampaign;
    const board=await getDashboard();
    if(subjectId!==state.subject||campaign!==state.forecastCampaign||state.module!=="sales_forecast"||!state.forecastStageAuto)return;
    const data=linkedForecastData(forecastDataFromBoard(board));
    state.forecastStage=forecastStageFromTarget(data?.target);
  }
  function syncUrl(mode="replace"){
    if(FORECAST_APP)state.module="sales_forecast";
    try{
      const url=new URL(location.href),params=url.searchParams;
      params.set("subject",state.subject||"");params.set("module",state.module);
      if(state.module==="sales_forecast"){params.set("forecastStage",state.forecastStage||"launch");params.set("forecastView",state.forecastView||"result");if(state.forecastCampaign)params.set("forecastCampaign",state.forecastCampaign);else params.delete("forecastCampaign")}else{params.delete("forecastStage");params.delete("forecastView");params.delete("forecastCampaign")}
      if(!["sales_forecast","generic"].includes(state.module)){params.set("grain",state.grain);if(state.period)params.set("period",state.period)}else{params.delete("grain");params.delete("period")}
      for(const key of ['rawFile','rawSheet','rawQuery'])params.delete(key);
      history[`${mode}State`]({...(mode==='replace'?history.state:{}),dashboard:true},"",url);
      rememberReadingPosition();
    }catch(error){console.debug("[导航状态] 当前环境不支持写入网址",error)}
  }
  let restoringReadingPosition=false;
  function rememberReadingPosition(){
    if(restoringReadingPosition||$('#page')?.getAttribute('aria-busy')==='true')return;
    const page=$('#page');
    try{history.replaceState({...history.state,reading:{page:page?.scrollTop||0}},'',location.href)}catch{}
  }
  async function restoreLocationState(){
    captureForecastDraft();
    const reading=history.state?.reading;restoringReadingPosition=true;
    const params=new URLSearchParams(location.search),requested=params.get("subject"),requestedSubject=forecastRequestedSubject(requested);
    if(requestedSubject&&(!FORECAST_APP||requestedSubject.type==='generation'))state.subject=requestedSubject.id;
    state.module=FORECAST_APP?"sales_forecast":params.get("module")||state.module;
    state.grain=params.get("grain")||state.grain;state.period=params.get("period")||null;
    if(state.module==="launch_rhythm"&&!params.get("grain"))state.grain="day";
    const requestedStage=params.get("forecastStage");state.forecastStageAuto=!forecastStages.some(item=>item.id===requestedStage);if(!state.forecastStageAuto)state.forecastStage=requestedStage;
    state.forecastCampaign=params.get("forecastCampaign")||null;
    const requestedView=normalizeForecastView(params.get("forecastView"));state.forecastView=forecastViews.includes(requestedView)?requestedView:"result";
    try{if(await ensureState()===false)return;await renderAll();if(FORECAST_APP)syncUrl('replace');if(reading&&(!FORECAST_APP||params.get('module')==='sales_forecast')){$('#page').scrollTop=reading.page||0;}}
    finally{restoringReadingPosition=false;}
  }

  function initialSubject(requested){
    const linked=forecastRequestedSubject(requested);
    if(!FORECAST_APP)return linked||DATA.subjects.find(item=>item.modules.includes("overview"))||DATA.subjects[0];
    if(linked?.type==='generation')return linked;
    try{
      const remembered=forecastRequestedSubject(localStorage.getItem(lastSubjectKey));
      if(remembered?.type==='generation')return remembered;
    }catch(error){console.debug("[预测代际] 无法读取上次选择",error)}
    return DATA.subjects.find(item=>moduleAvailable(item,'sales_forecast'))||
      DATA.subjects.find(item=>item.type==='generation')||DATA.subjects[0];
  }
  async function selectSubject(id){
    captureForecastDraft();
    state.subject=id;
    if(FORECAST_APP){
      try{localStorage.setItem(lastSubjectKey,id)}
      catch(error){console.debug("[预测代际] 无法保存本次选择",error)}
    }
    if(state.module==="sales_forecast")state.forecastStageAuto=true;
    if(await ensureState()===false)return;
    await renderAll();
    syncUrl("push");
  }
  async function init(){
    const params=new URLSearchParams(location.search),requested=params.get("subject");
    state.subject=initialSubject(requested).id;
    state.module=FORECAST_APP?'sales_forecast':params.get("module")||state.module;
    state.grain=params.get("grain")||state.grain;state.period=params.get("period")||state.period;
    if(state.module==="launch_rhythm"&&!params.get("grain"))state.grain="day";
    if(forecastStages.some(item=>item.id===params.get("forecastStage"))){state.forecastStage=params.get("forecastStage");state.forecastStageAuto=false}
    state.forecastCampaign=params.get("forecastCampaign")||null;
    const requestedView=normalizeForecastView(params.get("forecastView"));if(forecastViews.includes(requestedView))state.forecastView=requestedView;
    if(!FORECAST_APP&&DATA.forecast_page&&state.module==='sales_forecast'&&moduleAvailable(subject(),'sales_forecast')){location.replace(forecastPageUrl());return;}
    if (FORECAST_APP) {
      const modelSelect = $('#subjectSelect');
      const caption = modelSelect.labels[0].querySelector('span');
      caption.textContent = '预测车型';
      caption.classList.remove('sr-only');
      modelSelect.removeAttribute('aria-label');
    }
    $("#updatedAt").textContent=`生成时间 ${DATA.meta.generated_at.replace("T"," ")}`;
    bindStatic();renderSubjectSelect();if(await ensureState()===false)return;await renderAll();syncUrl("replace");
  }
  function bindForecastParameterMenu(menu){
    const wide = matchMedia('(min-width: 1280px)');
    const syncLayout = () => { menu.open = wide.matches; };
    wide.addEventListener('change', syncLayout);
    syncLayout();
    document.addEventListener('click', event => {
      if (menu.open && !wide.matches && !menu.contains(event.target)) menu.open = false;
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.open && !wide.matches) {
        menu.open = false;
        menu.querySelector('summary').focus();
        event.stopPropagation();
      }
    });
  }
  function bindStatic(){
    if (FORECAST_APP) {
      const bar = $('.module-bar');
      $('.topbar').append($('#forecastNavParameters'));
      bar.append($('.top-actions'), $('#forecastHeaderTools'));
      bindForecastParameterMenu($('#forecastNavParameters'));
      document.addEventListener('click', event => {
        const menu = document.querySelector('.forecast-header-menu[open]');
        if (menu && !menu.contains(event.target)) menu.open = false;
      }, true);
    }
    history.scrollRestoration='manual';
    let readingTimer;
    document.addEventListener('scroll',event=>{if(event.target.matches?.('#page')&&!readingTimer)readingTimer=setTimeout(()=>{readingTimer=null;rememberReadingPosition()},500)},true);
    document.addEventListener('click',event=>{if(event.target.closest('[data-module],[data-panel-source],[data-workspace-source],[data-forecast-stage-switch],[data-forecast-tab],[data-file],[data-grain],[data-quick-generation]'))rememberReadingPosition()},true);
    document.addEventListener('change',event=>{if(event.target.matches('#subjectSelect,#periodSelect'))rememberReadingPosition()},true);
    $("#subjectSelect").onchange=event=>selectSubject(event.target.value);
    $("#quickGenerationList").onclick=event=>{
      const button=event.target.closest('[data-quick-generation]');
      if(button)return selectSubject(button.dataset.quickGeneration);
    };
    $("#grainSelect").onclick=async event=>{const button=event.target.closest("button");if(!button||button.disabled)return;state.grain=button.dataset.grain;const board=await getDashboard();const view=board?.views?.[state.grain];state.period=view?.default_period||null;await renderAll();syncUrl("push")};
    $("#periodSelect").onchange=async event=>{if(state.module==="sales_forecast"){captureForecastDraft();state.forecastCampaign=event.target.value;await renderAll()}else{state.period=event.target.value;await renderPage()}syncUrl("push")};
    window.addEventListener("popstate",()=>restoreLocationState());
    window.addEventListener("resize",syncTopbarQuickLayout,{passive:true});
    document.addEventListener('click',event=>document.querySelectorAll('.forecast-chart-picker[open]').forEach(picker=>{if(!picker.contains(event.target))picker.open=false}));
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){const picker=document.querySelector('.forecast-chart-picker[open]');if(picker){event.preventDefault();picker.open=false;picker.querySelector('summary').focus({preventScroll:true});}}});
    document.addEventListener('focusin',event=>{
      const point=event.target;if(!point.matches?.('.forecast-evidence-line-scroll circle[aria-label]'))return;
      const svg=point.closest('svg');svg.querySelectorAll('circle[aria-label]').forEach(node=>node.setAttribute('tabindex',node===point?'0':'-1'));
      const readout=svg.closest('.forecast-evidence-line-scroll').nextElementSibling;
      if(readout?.matches('[data-chart-readout]'))readout.textContent='← → 切换 · '+point.getAttribute('aria-label');
    });
    document.addEventListener('keydown',event=>{
      if(!event.target.matches?.('.forecast-evidence-line-scroll circle[aria-label]')||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const points=[...event.target.closest('svg').querySelectorAll('circle[aria-label]')],index=points.indexOf(event.target);
      points[event.key==='Home'?0:event.key==='End'?points.length-1:Math.max(0,Math.min(points.length-1,index+(event.key==='ArrowRight'?1:-1)))].focus();
    });
  }
  function bindReferencePickers(root){
    root.querySelectorAll('.forecast-chart-picker').forEach(picker=>{
      if(picker.dataset.pickerReady)return;picker.dataset.pickerReady='true';
      const panel=picker.querySelector('.forecast-chart-picker-panel');
      panel.insertAdjacentHTML('afterbegin','<div class="reference-picker-tools"><label>搜索对比车型<input type="search" data-reference-search placeholder="输入代际名或年份" autocomplete="off"></label><button type="button" data-reference-done>完成</button></div>');
      panel.insertAdjacentHTML('beforeend','<p class="reference-search-empty" data-reference-empty hidden role="status">没有匹配车型，请调整关键词。</p>');
      const input=panel.querySelector('[data-reference-search]');
      input.oninput=()=>{const key=input.value.trim().toLocaleLowerCase();let count=0;panel.querySelectorAll('fieldset').forEach(group=>{let visible=0;group.querySelectorAll('label').forEach(label=>{label.hidden=!!key&&!label.textContent.toLocaleLowerCase().includes(key);if(!label.hidden)visible++});group.hidden=!visible;count+=visible;});panel.querySelector('[data-reference-empty]').hidden=count>0;};
      panel.querySelector('[data-reference-done]').onclick=()=>{picker.open=false;picker.querySelector('summary').focus({preventScroll:true});};
      picker.addEventListener('toggle',()=>{if(picker.open)root.querySelectorAll('.forecast-chart-picker[open]').forEach(other=>{if(other!==picker)other.open=false;});});
    });
  }
  async function ensureState(){
    const revision=ensureState.revision=(ensureState.revision||0)+1;
    if(FORECAST_APP)state.module="sales_forecast";
    let item=subject();
    if(DATA.app_mode==='forecast'&&(DATA.forecast_disabled||!Object.keys(DATA.dashboard_blocks||{}).some(key=>key.endsWith('|sales_forecast')))){state.module='sales_forecast';return true;}
    if(!FORECAST_APP&&!moduleAvailable(item,state.module))state.module=item.modules.find(id=>id!=="raw"&&moduleAvailable(item,id))||null;
    if(!state.module)return true;
    const subjectId=state.subject,moduleId=state.module;
    const board=await getDashboard();
    // A previous subject/module may finish decompressing after the next one.
    // Check request identity too: switching A -> B -> A invalidates the first A.
    if(revision!==ensureState.revision||subjectId!==state.subject||moduleId!==state.module)return false;
    const grains=Object.keys(board?.views||{});
    if(!grains.includes(state.grain))state.grain=grains[0]||"week";
    const view=board?.views?.[state.grain];
    if(!(view?.periods||[]).includes(state.period))state.period=view?.default_period||null;
    await syncForecastStageToTarget();
    return revision===ensureState.revision&&subjectId===state.subject&&moduleId===state.module;
  }
  function renderSubjectSelect(){
    const order=[["group","集团"],["brand","品牌"],["generation","代际"]];
    const subjects=FORECAST_APP?DATA.subjects.filter(item=>item.type==='generation'):DATA.subjects;
    $("#subjectSelect").innerHTML=order.map(([type,label])=>`<optgroup label="${label}">${subjects.filter(item=>item.type===type).map(item=>`<option value="${item.id}">${esc(item.name)}</option>`).join("")}</optgroup>`).join("");
    $("#subjectSelect").value=state.subject;
  }
  let navigationRevision=0,pageRevision=0;
  async function renderAll(){
    const revision=++navigationRevision,status=$("#pageStatus"),page=$("#page");
    const viewKey=state.subject+'|'+state.module,changed=page.dataset.viewKey!==viewKey;
    page.setAttribute("aria-busy","true");
    const timer=setTimeout(()=>{if(revision===navigationRevision&&status){status.textContent=`正在加载${subject()?.name||''} · ${moduleLabels[state.module]||'分析'}…`;status.classList.add("show")}},180);
    try{renderSubjectSelect();renderQuickGenerationLinks();renderNav();if(await renderFilters()===false)return;if(revision===navigationRevision){await renderPage();page.dataset.viewKey=viewKey;if(changed&&!restoringReadingPosition)page.scrollTop=0;}}
    finally{clearTimeout(timer);if(revision===navigationRevision){page.setAttribute("aria-busy","false");status?.classList.remove("show");page.getAnimations().forEach(animation=>animation.cancel());if(!matchMedia('(prefers-reduced-motion: reduce)').matches)page.animate([{opacity:.78},{opacity:1}],{duration:160,easing:'ease-out'});}}
  }
  // Display-only summary of the existing explanation; never selects or changes data.
/* @include forecast-navigation.js */
  function parseDay(text){
    const value=String(text||"").trim();
    let match=value.match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})/);
    if(match)return new Date(+match[1],+match[2]-1,+match[3]).getTime();
    match=value.match(/^(\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
    if(match)return new Date(2000+ +match[1],+match[2]-1,+match[3]).getTime();
    return null;
  }
  function sortPeriods(periods,grain){
    if(grain!=="day"||!(periods&&periods.length))return periods;
    return [...periods].sort((a,b)=>{
      const pa=parseDay(a),pb=parseDay(b);
      if(pa===null||pb===null)return 0;
      return pa-pb;
    });
  }
  async function renderFilters(){
    const revision=renderFilters.revision=(renderFilters.revision||0)+1;
    const subjectId=state.subject,moduleId=state.module,stage=state.forecastStage,campaign=state.forecastCampaign;
    const isCurrent=()=>revision===renderFilters.revision&&subjectId===state.subject&&moduleId===state.module&&stage===state.forecastStage&&campaign===state.forecastCampaign;
    $('#filters').dataset.mode='period';
    $('#grainSelect').closest('.filter-group').hidden=false;
    $('#periodSelect').closest('label').hidden=false;
    $('#periodContext').hidden=true;
    $("#filters").style.display=FORECAST_APP?"":"grid";
    $("#subjectSelect").closest("label").style.display="";
    $("#grainSelect").closest(".filter-group").style.display="";
    $("#periodSelect").closest("label").style.display="";
    if(["sales_forecast","generic"].includes(state.module)){
      $('#filters').dataset.mode='window';
      $('#grainSelect').closest('.filter-group').hidden=true;
      $("#grainSelect").innerHTML=Object.entries(DATA.config.grain_labels).map(([id,label])=>`<button data-grain="${id}" disabled>${label}</button>`).join("");
      const board=state.module==="sales_forecast"?await getDashboard():null;
      if(!isCurrent())return false;
      const data=forecastDataFromBoard(board),selected=subject(),campaigns=(data?.targets||[]).filter(t=>sameForecastModel(t.primary_generation||t.name,selected?.name));
      const period=$("#periodSelect");
      if(state.module==="sales_forecast"&&state.forecastStage!=='steady'&&campaigns.some(t=>t.secondary_generation)){
        const current=linkedForecastData(data)?.target,small=state.forecastStage==='small';
        period.innerHTML=campaigns.map(t=>{const label=t.secondary_generation?.startsWith(t.primary_generation)?t.secondary_generation.slice(t.primary_generation.length).trim():t.secondary_generation||t.name;return `<option value="${esc(t.name)}">${esc(label)} · ${esc((small?t.small_start_date:t.launch_date)||'日期未维护')}—${esc((small?t.small_end_date:t.end_date)||'日期未维护')}</option>`}).join('');
        period.value=current?.name||campaigns[0]?.name;period.disabled=false;
      }else{period.innerHTML=`<option>${state.module==="sales_forecast"?(state.forecastStage==='steady'?'一级代际合并 · 平销':'按预测阶段窗口'):"按所选表格范围"}</option>`;period.disabled=true;}
      $('#periodSelect').closest('label').hidden=period.disabled;
      $('#periodContext').hidden=!period.disabled;
      $('#periodContext').textContent=period.selectedOptions[0]?.textContent||'';
      $("#grainSelect").title="此模块不使用日周月筛选";return;
    }
    $("#periodSelect").disabled=false;$("#grainSelect").title="";
    const board=await getDashboard();
    if(!isCurrent())return false;
    const grains=Object.keys(board?.views||{});
    $("#grainSelect").innerHTML=Object.entries(DATA.config.grain_labels).map(([id,label])=>`<button data-grain="${id}" class="${state.grain===id?"active":""}" ${grains.includes(id)?"":"disabled"}>${label}</button>`).join("");
    const view=board?.views?.[state.grain];
    const periodList=sortPeriods(view?.periods||[],state.grain);
    $("#periodSelect").innerHTML=periodList.map(period=>`<option value="${esc(period)}">${esc(period)}</option>`).join("");
    $("#periodSelect").value=state.period||"";
  }
  function alignOverviewChartScrollbars(){
    if(state.module!=="overview")return;
    document.querySelectorAll("#page .stacked-chart").forEach(chart=>{
      const align=()=>{chart.scrollLeft=Math.max(0,chart.scrollWidth-chart.clientWidth)};
      align();
      requestAnimationFrame(align);
    });
  }
  async function renderPage(){
    rhythmObserver?.disconnect();rhythmObserver=null;
    channelPanelResizeObserver?.disconnect();channelPanelResizeObserver=null;
    const revision=++pageRevision,moduleId=state.module,subjectId=state.subject;
    const board=await getDashboard(),page=board?.views?.[state.grain]?.pages?.[state.period];
    if(revision!==pageRevision||moduleId!==state.module||subjectId!==state.subject)return;
    if(!board||!page){
      if (FORECAST_APP) mountForecastNavSettings(null);
      $("#page").innerHTML=`<div class="empty-page">${FORECAST_APP&&DATA.forecast_disabled?'本次生成已关闭销量预测，请启用后重新生成。':'当前主体暂无该分析'}</div>`;return}
    if(page.layout==="workspace"&&page.workspace){
      const workspace=state.module==="sales_forecast"?{...page.workspace,data:linkedForecastData(page.workspace.data)}:page.workspace;
      if(state.module==="sales_forecast")workspace.source=linkedForecastSource(workspace);
      $("#page").innerHTML=renderWorkspacePage(workspace);
      if(FORECAST_APP)prepareForecastStandalone($('#page .forecast-workspace'));
      if(state.module!=="sales_forecast")document.querySelector("[data-workspace-source]")?.addEventListener("click",()=>jumpToSource(workspace.source));
      bindForecastWorkspaceV2();restoreForecastDraft();bindReferencePickers($('#page'));
      return;
    }
    channelPanelData.clear();
    $("#page").innerHTML=`${renderKpis(page.kpis)}<div class="sections">${renderSections(page.sections)}</div>`;
    bindRhythmCharts();
    bindChannelPanels();
    bindSkuHeatmaps();
    alignOverviewChartScrollbars();
    document.querySelectorAll("[data-panel-source]").forEach(button=>button.onclick=()=>jumpToSource(page.sections[Number(button.dataset.panelSource)]?.source));
    document.querySelectorAll("[data-combo-switch]").forEach(button=>button.onclick=()=>{
      const root=button.closest(".combo-matrix"),target=button.dataset.comboSwitch;
      root.querySelectorAll("[data-combo-switch]").forEach(item=>{const active=item.dataset.comboSwitch===target;item.classList.toggle("active",active);item.setAttribute("aria-pressed",String(active))});
      root.querySelectorAll("[data-combo-panel]").forEach(item=>item.hidden=item.dataset.comboPanel!==target);
      bindSkuHeatmaps();
    });
    document.querySelectorAll("[data-hourly-select]").forEach(select=>select.onchange=()=>{
      const rows=JSON.parse(select.dataset.hourlyRows||"[]");
      select.closest(".hourly-wrap").querySelector("[data-hourly-body]").innerHTML=renderHourlyChart(rows,select.value);
      bindRhythmCharts();
    });
    document.querySelectorAll("[data-launch-hourly-select]").forEach(select=>select.onchange=()=>{
      const rows=JSON.parse(select.dataset.launchHourlyRows||"[]");
      select.closest(".hourly-wrap").querySelector("[data-launch-hourly-body]").innerHTML=renderLaunchHourlyChart(rows,select.value);
      bindRhythmCharts();
    });
    bindForecastWorkspaceV2();
  }
  function renderKpis(items){return `<div class="kpis ${items.length===5?"five":""}">${items.map(item=>`<article class="kpi" style="--accent:${colors[item.color]||colors.blue}"><span>${esc(item.label)}</span><strong>${item.value==null?"—":fmt(item.value)}</strong><em>${esc(item.unit)}</em><small class="kpi-note">${esc(item.note)}</small>${renderKpiComparison(item)}</article>`).join("")}</div>`}
  function renderKpiComparison(item){
    const comparison=item.comparison;
    if(!comparison||comparison.status!=="available")return '<div class="kpi-compare neutral"><span>较上周期</span><b>暂无可比数据</b></div>';
    const direction=comparison.direction||"flat",verb=direction==="up"?"上涨":direction==="down"?"下降":"持平",arrow=direction==="up"?"↑":direction==="down"?"↓":"—";
    const movement=comparison.rate==null?`${fmt(Math.abs(comparison.delta))}${esc(item.unit)}`:`${Math.abs(comparison.rate*100).toFixed(1)}%`;
    return `<div class="kpi-compare ${direction}"><span>较上周期</span><b>${arrow} ${verb} ${movement}</b><em>上期 ${fmt(comparison.previous)}</em></div>`;
  }
  function renderSections(items){
    const rankingIndex=state.module==='cancellation'?items.findIndex(item=>item.kind==='bars'&&item.title==='选配退订率排行'):-1;
    const trendIndex=rankingIndex>=0?items.findIndex(item=>item.kind==='daily_cancel'):-1;
    return items.map((item,index)=>{
      if(trendIndex>=0&&index===rankingIndex)return '';
      const ranking=index===trendIndex?items[rankingIndex]:null;
      const appendix=ranking?`<section class="cancel-ranking" aria-label="${esc(ranking.title)}"><div class="cancel-ranking-head"><div><h3>${esc(ranking.title)}</h3><span>${esc(ranking.meta)}</span></div>${renderPanelSource(ranking,rankingIndex)}</div>${renderBars(ranking.data)}</section>`:'';
      return renderSection(item,index,appendix);
    }).join('');
  }
  function renderPanelSource(item,index){
    return item.source?`<button class="panel-source" data-panel-source="${index}" aria-label="查看${esc(item.title)}的来源数据" title="跳转到底表"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7m0-7-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></svg><span>来源数据</span></button>`:"";
  }
  function renderSection(item,index,appendix=''){
    const pieBars=item.kind==='bars'&&item.title==='门店渠道订单量';
    const renderer=pieBars?renderPieChart:({channel_panel:renderChannelPanel,stacked_trend:renderStackedTrend,table:renderTable,bars:renderBars,donut:renderPieChart,structure_cards:renderStructureCards,funnel:renderFunnel,cohort_matrix:renderCohortMatrix,rank_cards:renderRankCards,rise_rank_cards:data=>renderRankCards(data,'rise'),drop_rank_cards:data=>renderRankCards(data,'drop'),rights:renderRights,fee_band_structure:renderFeeBandStructure,fee_period_bands:renderFeePeriodBands,fee_heatmap:renderFeeHeatmap,heat_table:renderTable,sku_heatmap:renderSkuHeatmap,combo_heatmap:renderComboHeatmap,combo_matrix:renderComboMatrix,tail_distribution:renderTailDistribution,launch_composite:renderLaunch,launch_hourly:renderLaunchHourly,matrix:renderTable,trend:renderTrend,hourly:renderHourly,small_order_rhythm:renderSmallOrderRhythm,cancel_cards:renderCancelCards,history_table:renderHistoryTable,daily_cancel:renderDailyCancel}[item.kind]||renderUnknown);
    const body=renderer(item.data);
    return `<article class="panel ${item.width==="half"?"":"full"}${appendix?' has-cancel-ranking':''}" data-section-kind="${esc(item.kind||"")}"><div class="panel-head"><div><h2>${esc(item.title)}</h2><span>${esc(item.meta)}</span></div>${renderPanelSource(item,index)}</div><div class="panel-body">${body}${appendix}</div></article>`;
  }
  function renderWorkspacePage(item){
    const renderer={forecast_workspace:renderForecastWorkspaceV2}[item.kind]||renderUnknown;
    return `<section class="page-workspace forecast-page"><div class="page-workspace-body">${renderer(item.data)}</div></section>`;
  }
  const channelPanelData=new Map();
  let channelPanelResizeObserver=null;
  const channelKnown=value=>typeof value==='number'&&Number.isFinite(value);
  const channelColors={"华为授权体验店":"#3173B4","华为智能生活馆":"#218C8C","华为旗舰店":"#C27B38","鸿蒙智行用户中心":"#7B61A8","问界用户中心":"#507F3A","智界用户中心":"#C35A66","享界用户中心":"#88743B","尊界用户中心":"#4D6088","尚界用户中心":"#A55F95","未知门店类型":"#738191","综合店":"#547D9A","尊界体验中心":"#9F5943"};
/* @include dashboard-panels.js */
/* @include forecast-views.js */





  function forecastDateRanges(values){
    const dates=[...new Set(values)].sort(),ranges=[];let start=dates[0],last=start;
    const emit=()=>{if(start)ranges.push(start===last?start:`${start}～${last}`);};
    for(const day of dates.slice(1)){if(Date.parse(day)-Date.parse(last)===86400000)last=day;else{emit();start=last=day;}}emit();
    return ranges.join('、');
  }
  function showForecastCondition(node,{stage,state='条件不足',reasons=[],impact='该阶段暂不输出预测；已知实际数据保留。'}={}){
    if(!node)return;
    reasons=[...new Set(reasons.filter(Boolean))];node.hidden=!reasons.length;
    node.dataset.conditionState=state;node.setAttribute('role','status');node.setAttribute('aria-live','polite');
    node.innerHTML=reasons.length?`<strong>${esc(stage)} · ${esc(state)}</strong><span>原因：${reasons.map(esc).join('；')}</span><small>影响：${esc(impact)}</small>`:'';
  }
/* @include small-order-workspace.js */

/* @include steady-workspace.js */


  function renderForecastReferenceChartV2(root,data,history,scopeCard=null){
    const referencePalette=['#FF8A00','#7C3AED','#D9485F','#00A6A6','#B7791F','#6B7280','#DB2777','#65A30D','#C2410C','#475569','#9333EA','#0F766E'],referenceColor=index=>referencePalette[index%referencePalette.length],actualColor='#2859f5',forecastColor='#00A878',comparison=root._forecastComparison||null;
    const taskSpecs={
      hourly:{metric:'hourly_curve',title:comparison?.hourly?.date?`D${comparison.hourly.day} · ${comparison.hourly.date} 分时累计进度`:'D1 分时累计参考',unit:'rate',hourly:true},
      small_progress:{metric:'daily_small',title:'小转大真实斜率与预测完成度',unit:'rate',observableShape:true,component:'small_to_big'},
      direct_progress:{metric:'daily_direct',title:'直接大定真实斜率与预测完成度',unit:'rate',observableShape:true,component:'direct'},
      daily:{metric:'daily_orders',title:'首销每日大定相对D1（基础曲线）',unit:'rate',normalize:true},
      daily_slope:{metric:'daily_orders',title:'每日斜率 · 较前一天变化率（仅展示）',unit:'rate',slope:true},
    };
    const splitCurrent=(values,actualFlags)=>{const actual=values.map((value,index)=>actualFlags[index]?value:null),forecast=values.map((value,index)=>actualFlags[index]?null:value),firstForecast=actualFlags.findIndex(value=>!value);if(firstForecast>0&&Number.isFinite(values[firstForecast-1]))forecast[firstForecast-1]=values[firstForecast-1];return {actual,forecast}};
    const currentTaskSeries=(task,spec)=>{
      if(!comparison)return {actual:[],forecast:[]};
      if(task==='hourly')return {actual:comparison.hourlyActual||[],forecast:comparison.hourlyForecast||[]};
      const rows=spec.observableShape?(comparison.progressRows||[]):(comparison.rows||[]);let values=[];
      if(spec.observableShape){const terminal=rows.reduce((sum,row)=>sum+Math.max(Number(row[spec.component]||0),0),0);let running=0;const actual=rows.map(row=>{if(!row.actual)return null;running+=Math.max(Number(row[spec.component]||0),0);return terminal>0?running/terminal:null});return {actual,forecast:[]}}
      if(task==='daily'||spec.slope)values=rows.map(row=>window.ForecastMath.observedQuantity(row.daily_gross));
      else if(task==='small_progress')values=rows.map(row=>Number(row.small_completion||0));
      else if(task==='direct_progress')values=rows.map(row=>Number(row.direct_completion||0));
      if(task==='daily'||spec.slope){if(root._forecastDailyEvidence?.targetFactor)values=values.map((value,index)=>value/root._forecastDailyEvidence.targetFactor(index));if(task==='daily'){const anchor=values[0];values=values.map(value=>anchor>0?value/anchor:NaN)}}else if(spec.normalize){const anchor=values.find(value=>value>0)||1;values=values.map(value=>value/anchor)}
      if(spec.slope)values=window.ForecastMath.dailySlope(values);
      return splitCurrent(values,rows.map(row=>!!row.actual));
    };
    const referenceMeta=(card,item,index)=>{const selects=[...card.querySelectorAll('[data-forecast-ref]')],main=selects[0]?.value,aux=selects[1]?.value,mainWeight=Number(card.querySelector('[data-forecast-ref-weight][data-ref-slot="0"]')?.value||0),auxWeight=Number(card.querySelector('[data-forecast-ref-weight][data-ref-slot="1"]')?.value||0);if(item.model===main)return {label:card.dataset.forecastTask==='daily_slope'?`主参考 · ${item.model}`:`主参考${mainWeight}% · ${item.model}`,color:'#FF8A00',core:true};if(item.model===aux)return {label:card.dataset.forecastTask==='daily_slope'?`辅助参考 · ${item.model}`:`辅助参考${auxWeight}% · ${item.model}`,color:'#7C3AED',core:true};return {label:`对比 · ${item.model}`,color:referenceColor(index+2),core:false}};
    const renderLockChart=(target,items,card)=>{
      const fields=[['net_rate','留存大定率'],['lock_rate','大定到锁单率']],W=920,H=245,left=48,right=20,top=28,bottom=46,plotW=W-left-right,plotH=H-top-bottom,groupW=plotW/fields.length,currentName=comparison?.name||'当前预测代际';
      const series=[];
      if(comparison&&Object.values(comparison.actualRates||{}).some(Number.isFinite))series.push({name:`${currentName} · 真实`,values:comparison.actualRates,color:actualColor,kind:'actual'});
      if(comparison)series.push({name:`${currentName} · 预测`,values:comparison.forecastRates,color:forecastColor,kind:'forecast'});
      items.forEach((item,index)=>{const meta=referenceMeta(card,item,index);series.push({name:meta.label,values:item,color:meta.color,kind:'reference'})});
      const barW=Math.max(5,Math.min(34,(groupW-18)/Math.max(series.length,1)-3)),barGap=Math.max(1,Math.min(8,barW*.25));
      const grid=[0,.25,.5,.75,1].map(rate=>{const y=top+plotH*(1-rate);return `<line x1="${left}" y1="${y}" x2="${W-right}" y2="${y}" stroke="#E8F0F7"/><text x="${left-8}" y="${y+4}" text-anchor="end" font-size="9" fill="#7890A6">${Math.round(rate*100)}%</text>`}).join('');
      const bars=fields.map(([field,label],fieldIndex)=>{const center=left+(fieldIndex+.5)*groupW,content=series.map((item,itemIndex)=>{const raw=window.ForecastMath.weightedObserved([{value:item.values?.[field],weight:1}]);if(!Number.isFinite(raw))return '';const value=Math.min(Math.max(raw,0),1),x=center+(itemIndex-(series.length-1)/2)*(barW+barGap)-barW/2,y=top+plotH*(1-value),forecast=item.kind==='forecast',showLabel=series.length<=8||item.kind!=='reference';return `<rect x="${x}" y="${y}" width="${barW}" height="${top+plotH-y}" rx="${Math.min(4,barW/2)}" fill="${forecast?'#E7F8F1':item.color}" stroke="${item.color}" stroke-width="${forecast?2:1}" ${forecast?'stroke-dasharray="5 3"':''} opacity=".9"><title>${esc(item.name)} · ${label} ${(value*100).toFixed(1)}%</title></rect>${showLabel?`<text x="${x+barW/2}" y="${Math.max(y-7,12)}" text-anchor="middle" font-size="9" font-weight="700" fill="${item.color}">${(value*100).toFixed(1)}%</text>`:''}`}).join('');return `${content}<text x="${center}" y="${H-18}" text-anchor="middle" font-size="10" fill="#60778D">${label}</text>`}).join('');
      const legend=series.map(item=>`<span><i class="${item.kind==='forecast'?'forecast-outline-key':''}" style="background:${item.kind==='forecast'?'#E7F8F1':item.color};border-color:${item.color}"></i>${esc(item.name)}</span>`).join('');
      target.innerHTML=`<div class="forecast-task-chart-title"><strong>留存大定率与大定到锁单率对比</strong><span>大定到锁单率＝首销期锁单÷总大定；实心柱为真实/历史，绿色描边柱为当前预测</span></div><div class="forecast-svg-scroll"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="当前预测代际与参考传播名留存大定率和大定到锁单率比较">${grid}${bars}</svg></div><div class="legend forecast-task-legend">${legend}</div>`;
    };
    const renderParameterDailyChart=(target,items,card,task)=>{
      const conversionTask=task==='conversion',title=conversionTask?'方法二 · 小订转化率 by天':'方法二 · 直接大定占比 by天',currentName=comparison?.name||'当前预测代际',parameterRows=comparison?.parameterRows||[],series=[];
      const currentValues=parameterRows.map(row=>row[conversionTask?'small_conversion':'direct_share']??NaN),split=splitCurrent(currentValues,parameterRows.map(row=>!!row.actual));
      if(split.actual.some(Number.isFinite))series.push({name:currentName+' · 真实',values:split.actual,color:actualColor,kind:'actual',dash:''});
      if(split.forecast.some(Number.isFinite))series.push({name:currentName+' · 方法二预测',values:split.forecast,color:'#00A878',kind:'parameter',dash:'7 5'});
      items.forEach((item,index)=>{const dailySmall=observedDailyPrefix(item.daily_small||[]),dailyDirect=observedDailyPrefix(item.daily_direct||[]),dailyGross=observedDailyPrefix(item.daily_orders||[]),length=conversionTask?dailySmall.length:Math.min(dailyDirect.length,dailyGross.length),values=[];let cumulativeSmall=0,cumulativeDirect=0,cumulativeGross=0;for(let day=0;day<length;day+=1){cumulativeSmall+=Math.max(Number(dailySmall[day]||0),0);cumulativeDirect+=Math.max(Number(dailyDirect[day]||0),0);cumulativeGross+=Math.max(Number(dailyGross[day]||0),0);values.push(conversionTask?(Number(item.small)>0?cumulativeSmall/Number(item.small):NaN):(cumulativeGross>0?cumulativeDirect/cumulativeGross:NaN))}const meta=referenceMeta(card,item,index);if(values.some(Number.isFinite))series.push({name:meta.label,values,color:meta.color,kind:'reference',dash:''})});
      const finiteValues=series.flatMap(item=>item.values.filter(Number.isFinite));if(!finiteValues.length){target.innerHTML='<div class="empty-image">暂无可比较的by天比例曲线</div>';return}
      const maxPoints=Math.max(...series.map(item=>item.values.length),1),peak=Math.max(...finiteValues,.01),rangeMax=Math.min(1,Math.max(.1,Math.ceil(peak*1.12*10)/10));
      const note=(conversionTask?'逐日累计小转大 ÷ 总小订':'逐日累计直接大定 ÷ 逐日累计总大定')+'；历史曲线按各自首销天数展示，未取得最终比例的车型仅作曲线对比、不参与终值加权。蓝色实线为真实，绿色虚线为预测。未来每日总大定仍按到天基础曲线分配，来源结构参考分项走势并校准至方法二终局。'+(comparison?.scenarios?.parameter?.sourceMixWarnings||[]).join('；');
      target.innerHTML=renderForecastEvidenceLines({series:series.map(curve=>({...curve,role:curve.kind==='parameter'?'forecast':curve.kind,core:true})),labels:Array.from({length:maxPoints},(_,i)=>`D${i+1}`),ariaLabel:title,title,note,table:true,rangeMax,ratePrecision:1});
    };
    const cards=scopeCard?[scopeCard]:[...root.querySelectorAll('[data-forecast-task]')];
    cards.forEach(card=>{
      const task=card.dataset.forecastTask,target=card.querySelector('[data-forecast-task-chart]'),selectedNames=[...card.querySelectorAll(`[data-forecast-chart-ref="${task}"]:checked`)].map(node=>node.value),items=[...new Set(selectedNames)].map(name=>history.get(name)).filter(Boolean);
      if(!target)return;
      if(!items.length&&!comparison){target.innerHTML='<div class="empty-image">暂无可比较的车型曲线</div>';return}
      if(task==='lock'){renderLockChart(target,items,card);return}
      if(task==='conversion'||task==='direct_share'){renderParameterDailyChart(target,items,card,task);return}
      const spec=taskSpecs[task]||taskSpecs.daily,current=currentTaskSeries(task,spec),targetDays=Math.max(1,Number(comparison?.progressRows?.length||data.target?.launch_days||data.target?.days||1));
      const references=items.map((item,index)=>{let displayOnly=false,values=(item[spec.metric]||[]).map(value=>value==null?NaN:Number(value));if(spec.observableShape){const completionField=task==='small_progress'?'small_progress':'direct_progress';values=rebasedForecastCompletionCurve(item,completionField,targetDays)}else if(spec.slope){values=values.map((value,day)=>value/(root._forecastDailyEvidence?.historicalFactor(item,day)||1))}else if(task==='daily'&&root._forecastDailyEvidence){const adapted=root._forecastDailyEvidence.naturalDailyOrders(item,targetDays),orders=adapted.length?adapted:root._forecastDailyEvidence.referenceStatus(item).observed;displayOnly=!adapted.length;const first=Number(orders[0]||0)/(displayOnly?root._forecastDailyEvidence.historicalFactor(item,0):1);values=orders.map((order,day)=>{const adjusted=Number(order||0)/(displayOnly?root._forecastDailyEvidence.historicalFactor(item,day):1);return first>0&&adjusted>=0?adjusted/first:NaN})}else if(spec.hourly){values=window.ForecastMath.smallHourlyCurve(window.ForecastMath.launchHourlyItem(item));}else{values=values.filter(Number.isFinite);if(spec.normalize){const anchor=values.find(value=>value>0)||1;values=values.map(value=>value/anchor)}}if(spec.slope)values=window.ForecastMath.dailySlope(values);const meta=referenceMeta(card,item,index);return {name:meta.label+(displayOnly?'（仅已发生，不参与分配）':''),values,color:meta.color,role:'reference',dash:'',core:meta.core}}).filter(item=>item.values.some(Number.isFinite));
      if(spec.hourly&&comparison?.hourly?.referenceCurve?.length)references.push({name:comparison.hourly.referenceLabel,values:comparison.hourly.referenceCurve,color:'#60768D',role:'reference',dash:'',core:true});
      const currentSeries=[];
      if((current.actual||[]).some(Number.isFinite))currentSeries.push({name:spec.observableShape?(task==='small_progress'?'小转大真实归一化累计斜率':'直接大定真实归一化累计斜率'):`当前 ${comparison?.name||''} · 真实`,values:current.actual,color:actualColor,role:'actual',dash:''});
      if(spec.observableShape){const completionField=task==='small_progress'?'small_completion':'direct_completion',completionValues=(comparison?.progressRows||[]).map(row=>Number(row[completionField]));if((comparison?.progressRows||[]).some(row=>!row.actual))currentSeries.push({name:task==='small_progress'?'参考确认后的小转大预测完成度':'参考确认后的直接大定预测完成度',values:splitCurrent(completionValues,(comparison?.progressRows||[]).map(row=>!!row.actual)).forecast,color:forecastColor,role:'forecast',dash:'7 5'})}
      if(!spec.observableShape&&(current.forecast||[]).some(Number.isFinite))currentSeries.push({name:`当前 ${comparison?.name||''} · 预测`,values:current.forecast,color:forecastColor,role:'forecast',dash:'7 5'});
      const series=[...references,...currentSeries],hourStarts=spec.hourly?series.map(row=>row.values.findIndex(Number.isFinite)).filter(i=>i>=0):[],hourOffset=hourStarts.length?Math.min(...hourStarts):0;if(hourOffset)series.forEach(row=>row.values=row.values.slice(hourOffset));const finiteValues=series.flatMap(item=>item.values.filter(Number.isFinite));
      if(!finiteValues.length){target.innerHTML='<div class="empty-image">当前预测代际及所选参考暂无对应曲线（分时缺失时：无D1分时数据）</div>';return}
      const maxPoints=Math.max(...series.map(item=>item.values.length),1),format=value=>spec.unit==='rate'?`${(value*100).toFixed(value<.1?1:0)}%`:Math.round(value).toLocaleString('zh-CN');
      const note=spec.hourly?`${comparison?.hourly?.missing?'无D1分时数据。':''}参考发布起点优先采用表格首销发布时段，留白才取D1首个正数大定小时；起点前留空，实际订单不改写。分子为截至各小时真实大定；${comparison?.hourly?.ongoing?'分母为当日预计全天大定，因此蓝线百分比也受预测分母影响':'分母为同一天实际大定，数据未齐时不强行拉到100%'}。绿色虚线为后续小时估算；橙/紫线为历史D1对比。滚动采用${comparison?.hourly?.referenceLabel||'历史D1参考'}。${comparison?.hourly?.date?`当前累计${fmt(comparison.hourly.observed)}单 / 全天${fmt(comparison.hourly.terminal)}单。`:''}`:spec.slope?'斜率＝（剔除日历影响后的当天日量÷前一天日量－1）×100%；D1、前一天为0或数据缺失时不计算；独立评分仅用于选择对比车型，不参与销量预测。蓝色为真实、绿色虚线为预测。':spec.observableShape?`蓝色实线＝截至各日真实累计量÷方法一预测终局，因此当前真实日不会提前归一到100%；绿色虚线和历史参考均按预测对象首销周期重定基，只有首销结束日达到100%；预测完成度仅用于方法一展示和反推，不参与参考车型评分`:(task==='daily'?`只有已结束且逐日大定收齐的首销参考才参与分配；未收齐参考仅展示已发生走势、不拉伸。有效曲线值＝适配到当前首销周期后的每日总大定÷历史日期类型系数，再除以剔除日历影响后的D1；D1=100%，用于未来余量的基础形状，当前日期系数在分配时另乘`:'蓝色实线为当前真实，绿色虚线为当前预测');
      target.innerHTML=renderForecastEvidenceLines({series,labels:Array.from({length:maxPoints},(_,index)=>spec.hourly?`${index+hourOffset}时`:`D${index+1}`),ariaLabel:spec.title,title:spec.title,note:note+(spec.observableShape?'周期对齐：D1、D2及最后两天的日占比保持不变，中间部分按剩余周期比例拉伸后重新累计；仅对齐参考曲线，不改写历史真实销量。同长度不拉伸；不同长度且任一周期不足5天时不自动推荐该完成度参考。':''),unit:spec.unit,slope:!!spec.slope,hourly:!!spec.hourly,extra:'',table:true});
    });
  }

  // All stages share chart geometry, actual/forecast styling, legend and data access.
  // Adapters select existing fields only; no forecast or aggregation is performed here.
  function renderForecastQuantityChart(rows,{valueKey,labelKey='label',metric='销量',method='parameter',launch=false}={}){
    if(!rows.length)return '<div class="empty-image">暂无可绘制数据</div>';
    const known=value=>typeof value==='number'&&Number.isFinite(value),values=rows.map(row=>row[valueKey]),showDaily=launch&&valueKey!=='daily_gross';
    const label=row=>String(row[labelKey]||row.date||''),shortLabel=row=>label(row).split('（')[0];
    const spacing=Math.max(30,...rows.map(row=>shortLabel(row).length*6+6),...values.filter(known).map(value=>fmt(value).length*6.5+8));
    const H=320,left=60,right=launch?50:24,top=26,bottom=42,plotW=Math.max(100,rows.length*spacing),W=left+plotW+right,plotH=H-top-bottom,max=Math.max(...values.filter(known),1)*1.12;
    const x=i=>left+plotW/2+(i-(rows.length-1)/2)*spacing,y=value=>top+plotH*(1-value/max),rateY=value=>top+plotH*(1-Math.min(Math.max(value,0),1)),barW=Math.min(18,spacing*.45);
    const stateLabel=row=>row.missing?'数据缺失':row.actual?'真实':row.past_missing?'历史缺失估算':row.partial?'分时滚动':row.current_estimate?'当日估算':'预测',futureColor=method==='progress'?'#0D9488':'#D97706';
    const grid=[0,.25,.5,.75,1].map(rate=>{const gy=top+plotH*(1-rate);return `<line x1="${left}" y1="${gy}" x2="${W-right}" y2="${gy}" stroke="#E5EAF0"/><text x="${left-9}" y="${gy+4}" text-anchor="end" font-size="10" fill="#64748B">${fmt(Math.round(max*rate))}</text>${launch?`<text x="${W-right+9}" y="${gy+4}" font-size="10" fill="#64748B">${Math.round(rate*100)}%</text>`:''}`}).join('');
    const bars=rows.map((row,index)=>{const value=values[index];if(!known(value))return '';const actual=!!row.actual,color=actual?'#3979CB':futureColor;return `<rect x="${x(index)-barW/2}" y="${y(value)}" width="${barW}" height="${Math.max(top+plotH-y(value),0)}" rx="2" fill="${actual?color:'#FFF7ED'}" stroke="${color}" ${actual?'':'stroke-dasharray="4 2"'}><title>${esc(label(row))} ${esc(row.date||'')} · ${stateLabel(row)} · ${esc(metric)} ${fmt(value)}${showDaily?` · 当日大定 ${fmt(row.daily_gross)}`:''}</title></rect><text data-forecast-quantity-label x="${x(index)}" y="${Math.max(y(value)-7,12)}" text-anchor="middle" font-size="11" fill="#334155" stroke="#fff" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${fmt(value)}</text>`}).join('');
    const rateFields=launch?[['small_conversion','累计小转大率','#2563EB'],['direct_share','累计直接大定占比','#BE4B53']]:[];
    const lines=rateFields.map(([field,title,color])=>{
      const segments=actual=>{const result=[];let current=[];rows.forEach((row,i)=>{if(!!row.actual===actual&&known(row[field]))current.push(i);else if(current.length){result.push(current);current=[]}});if(current.length)result.push(current);return result;};
      const paths=[true,false].map(actual=>segments(actual).map(indexes=>{if(!actual&&indexes[0]>0&&rows[indexes[0]-1].actual&&known(rows[indexes[0]-1][field]))indexes=[indexes[0]-1,...indexes];return `<polyline points="${indexes.map(i=>`${x(i)},${rateY(rows[i][field])}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" ${actual?'':'stroke-dasharray="6 4"'}/>`}).join('')).join('');
      const dots=rows.map((row,i)=>known(row[field])&&(i===rows.length-1||row.cut||(i+1)%7===0)?`<circle cx="${x(i)}" cy="${rateY(row[field])}" r="3" fill="white" stroke="${color}"><title>${esc(label(row))} · ${title} ${(row[field]*100).toFixed(1)}%</title></circle>`:'').join('');
      return paths+dots;
    }).join('');
    const ticks=rows.map((row,i)=>`<text x="${x(i)}" y="${H-25}" text-anchor="middle" font-size="10" fill="#64748B">${esc(shortLabel(row))}</text><text x="${x(i)}" y="${H-10}" text-anchor="middle" font-size="9" fill="#64748B">${esc(row.day_type_short||'')}</text>`).join('');
    const legend=`<div class="legend forecast-chart-legend"><span><i style="background:#3979CB"></i>真实${esc(metric)}</span><span><i class="forecast-outline-key" style="border-color:${futureColor};background:#FFF7ED"></i>估算／预测${esc(metric)}</span>${rateFields.map(([,title,color])=>`<span><i class="line-key" style="border-color:${color}"></i>${title}</span>`).join('')}<span class="forecast-chart-key-note">实心为真实，虚线为估算／预测</span></div>`;
    const table=`<details class="forecast-ref-score-details forecast-result-values"><summary>查看图表数值</summary><div class="forecast-score-table"><table><thead><tr><th scope="col">周期／日期</th><th scope="col">状态</th><th scope="col">${esc(metric)}（单）</th>${showDaily?'<th scope="col">当日大定（单）</th>':''}${rateFields.map(([,title])=>`<th scope="col">${title}</th>`).join('')}</tr></thead><tbody>${rows.map((row,i)=>`<tr><th scope="row">${esc(label(row))}${row.date?` · ${esc(row.date)}`:''}</th><td>${stateLabel(row)}</td><td>${known(values[i])?fmt(values[i]):'—'}</td>${showDaily?`<td>${known(row.daily_gross)?fmt(row.daily_gross):'—'}</td>`:''}${rateFields.map(([field])=>`<td>${known(row[field])?(row[field]*100).toFixed(1)+'%':'—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
    return `<div class="forecast-svg-scroll forecast-result-chart-scroll" style="--forecast-chart-width:${W}px" tabindex="0" role="region" aria-label="${esc(metric)}图表，可横向滚动"><svg class="forecast-decision-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(metric)}实际与预测，实心为真实、虚线为估算或预测">${grid}${bars}${lines}${ticks}</svg></div>${legend}${table}`;
  }
  function renderForecastDecisionChartV2(root,rows,method='parameter'){
    const target=root.querySelector(`[data-forecast-decision-chart="${method}"]`);if(!target)return;
    target.innerHTML=renderForecastQuantityChart(rows,{valueKey:'daily_gross',labelKey:'day',metric:'单日大定',method,launch:true});
  }

  function renderForecastWeeklyV2(root,rows,method='parameter'){
    const target=root.querySelector(`[data-forecast-weekly="${method}"]`);if(!target)return;
    const groups=new Map(),weekKey=value=>{const date=value?new Date(`${value}T00:00:00`):null;if(!date||Number.isNaN(date.getTime()))return '';const utc=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())),day=utc.getUTCDay()||7;utc.setUTCDate(utc.getUTCDate()+4-day);const yearStart=new Date(Date.UTC(utc.getUTCFullYear(),0,1)),week=Math.ceil((((utc-yearStart)/86400000)+1)/7);return `${utc.getUTCFullYear()}W${String(week).padStart(2,'0')}`};
    rows.forEach((row,index)=>{const key=weekKey(row.date)||`第${Math.floor(index/7)+1}周`,group=groups.get(key)||{key,daily:0,end:null,actual:0,forecast:0,backfill:0,missing:0},known=typeof row.daily_gross==='number'&&Number.isFinite(row.daily_gross);if(known){group.daily+=row.daily_gross;if(row.actual)group.actual+=row.daily_gross;else if(row.past_missing)group.backfill+=row.daily_gross;else group.forecast+=row.daily_gross;}else group.missing++;group.end=typeof row.cumulative_gross==='number'&&Number.isFinite(row.cumulative_gross)?row.cumulative_gross:null;groups.set(key,group)});
    target.innerHTML=[...groups.values()].map(group=>`<article><span>${esc(group.key)}</span><strong>${group.missing?'—':fmt(group.daily)}</strong><small>周大定</small><em>${group.missing?`已知${fmt(group.daily)}单，缺失${group.missing}天`:group.backfill?`含过期补估${fmt(group.backfill)}${group.forecast?` · 未来预测${fmt(group.forecast)}`:''}`:group.forecast?`含预测${fmt(group.forecast)}`:'全部真实'}</em></article>`).join('');
  }

/* @include launch-workspace.js */
  function renderUnknown(){return '<div class="empty-image">暂不支持该组件</div>'}

  function downloadBlob(blob,name){
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    try{link.href=url;link.download=name;document.body.appendChild(link);link.click()}
    finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),500)}
  }
  function csvCell(value){const text=String(value??"");return /[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text}
  function openForecastSourceDetails(source){
    const details=document.querySelector('.forecast-source-details');if(!details)return;
    let location=details.querySelector('[data-forecast-source-location]');
    if(!location){location=document.createElement('div');location.className='forecast-source-decision';location.dataset.forecastSourceLocation='';const label=document.createElement('b');label.textContent='原始位置';location.append(label,document.createElement('span'));details.querySelector('summary').after(location);}
    const sourceText=typeof source==='string'?source:[source?.file,source?.sheet,source?.cell||source?.range,source?.note].filter(Boolean).join('｜');
    location.dataset.forecastSourceStage=state.forecastStage;
    location.querySelector('span').textContent=sourceText;location.hidden=!sourceText;
    const menu=details.closest('.forecast-header-menu');
    if(menu)menu.open=true;
    details.open=true;details.querySelector('summary').focus({preventScroll:true});details.scrollIntoView({block:'nearest'});
  }
  function jumpToSource(source){
    openForecastSourceDetails(source);
  }
  function showToast(message){const node=$("#toast");if(!node)return;node.textContent=message;node.classList.add("show");clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>node.classList.remove("show"),4000)}
  function renderBridgeControls(stage){
    return `<section class="forecast-day-allocation" data-bridge-stage="${stage}"><div class="forecast-calendar-heading"><h4>日历影响与逐日分配</h4><span>真实日衔接 · 差额渐进</span></div><div class="forecast-allocation-inputs">${[['workday','工作日',1],['weekend','周末',1.15],['holiday','节假日',1.3]].map(([key,label,value])=>`<label>${label}<input data-bridge-control="${key}" type="number" min="0.01" max="5" step="0.05" value="${value}"><small>倍</small></label>`).join('')}</div><label class="forecast-weights-field">逐日差额权重<input data-bridge-control="weights" type="text" placeholder="自动：0, 0.5, 1, 1, …"><small>默认前两天渐进，第3天起封顶</small></label><details class="forecast-parameter-details"><summary>如何应用这些参数</summary><p>调休按工作日，节假日不叠加周末。差额权重从首个待预测日开始，填写时须覆盖全部待预测日期，以逗号分隔；0表示优先保护该日。实际分配还乘当日基础量。留空使用系统默认。</p></details><p data-bridge-notice aria-live="polite"></p></section>`;
  }
  function renderStageCommonControls(stage){
    return `<section class="forecast-common-controls forecast-stage-common forecast-result-section" data-forecast-region="common"><div class="forecast-block-head"><div><small>日历影响与逐日分配</small><h4>公共参数</h4></div><span>修改后实时重算</span></div>${renderBridgeControls(stage)}</section>`;
  }
  function bridgeSettings(root,stage,count){
    const panel=root.querySelector(`[data-bridge-stage="${stage}"]`),factors={workday:1,weekend:1.15,holiday:1.3};
    let error='';
    for(const key of Object.keys(factors)){const control=panel?.querySelector(`[data-bridge-control="${key}"]`);if(control){const value=Number(control.value);if(!control.value.trim()||!Number.isFinite(value)||value<=0||value>5)error='日历系数需为大于0且不超过5的数字';else factors[key]=value}}
    const text=panel?.querySelector('[data-bridge-control="weights"]')?.value.trim()||'',weights=text?text.split(/[,，\s]+/).map(Number):window.ForecastMath.defaultBridgeWeights(count);
    if(count>0&&text&&(weights.length!==count||!weights.every(value=>Number.isFinite(value)&&value>=0)))error=`请填写${count}个非负差额权重，对应全部待预测日期`;
    return {factors,weights:count?weights:[],error,panel};
  }
  function planBridge(root,calendarType,stage,{remaining,anchor=null,anchorDate='',anchorShape=1,dates=[],shapes=[]}){
    const settings=bridgeSettings(root,stage,dates.length),factor=date=>settings.factors[calendarType(date,0).type];
    const result=settings.error?{values:[],warnings:[],error:settings.error}:window.ForecastMath.anchoredAllocate({remaining,anchor,anchorFactor:anchorDate?factor(anchorDate):1,anchorShape,shapes,factors:dates.map(factor),weights:settings.weights});
    const notice=settings.panel?.querySelector('[data-bridge-notice]');if(notice)notice.textContent=result.error||`${dates.length}个待预测日；权重${settings.weights.join(', ')}；${result.warnings.join('；')||'以前一完整真实日为基准，按渐进权重和基础量分配差额，合计保持不变'}。`;
    return result;
  }
  function bindForecastLifecycleNavigation(root){
    const bindTabset=(buttons,panes,idOf,paneIdOf)=>{
      const activate=id=>{buttons.forEach(button=>{const active=idOf(button)===id;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1});panes.forEach(pane=>pane.classList.toggle('active',paneIdOf(pane)===id))};
      buttons.forEach((button,index)=>{button.onclick=()=>activate(idOf(button));button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;buttons[next].focus();activate(idOf(buttons[next]))}});
    };
    root.querySelectorAll('[data-small-order-workspace],[data-steady-workspace]').forEach(workspace=>bindTabset([...workspace.querySelectorAll('[data-lifecycle-subtab]')],[...workspace.querySelectorAll('[data-lifecycle-subpane]')],button=>button.dataset.lifecycleSubtab,pane=>pane.dataset.lifecycleSubpane));
  }
  function renderLifecycleBars(rows,valueKey,labelKey='label'){
    return renderForecastQuantityChart(rows,{valueKey,labelKey,metric:valueKey==='lock'?'周交车锁单':'当日小订'});
  }
  function renderForecastEvidenceLines({series,labels,ariaLabel,title='',note='',unit='rate',slope=false,hourly=false,extra='',lifecycle=false,table=false,rangeMax=null,ratePrecision=null,compact=false,readoutHint='横向滚动查看完整曲线；键盘 Tab 进入，← → 查看数值，Tab 离开。',empty='暂无可比较曲线'}){
    const heading=title||note?`<div class="forecast-task-chart-title"><strong>${esc(title)}</strong>${note?`<details class="forecast-chart-notes"><summary>${note.includes('拉伸')?'周期对齐与拉伸说明':'口径与曲线说明'}</summary><p>${esc(note)}</p></details>`:''}</div>`:'';
    const usable=series.filter(item=>(item.values||[]).some(Number.isFinite));if(!usable.length||!labels.length)return `${heading}<div class="empty-image">${esc(empty)}</div>`;
    const format=value=>unit==='rate'?`${(value*100).toFixed(ratePrecision??(value<.1?1:0))}%`:Math.round(value).toLocaleString('zh-CN')+(lifecycle?'单':'');
    const sameYear=compact&&labels.every(date=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&date.slice(0,4)===labels[0].slice(0,4));
    const axisLabels=sameYear?labels.map(date=>date.slice(5)):labels;
    const finiteValues=usable.flatMap(item=>item.values.filter(Number.isFinite));
    const spacing=compact?Math.max(32,...axisLabels.map(label=>String(label).length*5.5+6),...finiteValues.map(value=>format(value).length*6.5+10)):0;
    const maxPoints=Math.max(labels.length,...usable.map(item=>item.values.length),1),left=compact?60:48,right=compact?32:20,inset=compact?spacing/2+4:0,W=compact?(maxPoints-1)*spacing+left+right+2*inset:920,H=compact?320:245,top=30,bottom=42,plotW=W-left-right,plotH=H-top-bottom,rawMax=Math.max(...finiteValues,1),yMax=Number.isFinite(rangeMax)&&rangeMax>0?rangeMax:unit==='rate'?Math.max(rawMax,1):rawMax*1.12,yMin=slope?Math.min(...finiteValues,0):0;
    const x=index=>left+inset+(maxPoints===1?(compact?0.5:0):index/(maxPoints-1))*(plotW-2*inset),y=value=>top+plotH*(1-Math.min(Math.max((value-yMin)/(yMax-yMin),0),1));
    const grid=[0,.25,.5,.75,1].map(rate=>{const gy=top+plotH*(1-rate);return `<line x1="${left}" y1="${gy}" x2="${W-right}" y2="${gy}" stroke="#E8F0F7"/><text x="${left-8}" y="${gy+4}" text-anchor="end" font-size="9" fill="#7890A6">${format(yMin+(yMax-yMin)*rate)}</text>`}).join('');
    const placedLabels=new Map(),placeLabel=(index,preferred)=>{const occupied=placedLabels.get(index)||[],start=Math.min(Math.max(preferred,12),H-bottom+13),candidates=[0,-14,14,-28,28,-42,42,-56,56,-70,70].map(delta=>start+delta),chosen=candidates.find(value=>value>=12&&value<=H-bottom+13&&occupied.every(other=>Math.abs(value-other)>=12))??start;occupied.push(chosen);placedLabels.set(index,occupied);return chosen;};
    const lines=usable.map((curve,seriesIndex)=>{
      const indexes=curve.values.map((value,index)=>Number.isFinite(value)?index:-1).filter(index=>index>=0),segments=[];let segment=[];
      curve.values.forEach((value,index)=>{if(Number.isFinite(value))segment.push(`${x(index)},${y(value)}`);else if(segment.length){segments.push(segment);segment=[];}});if(segment.length)segments.push(segment);
      const step=curve.role==='reference'?(hourly?8:14):(hourly?4:7),dots=indexes.map((index,position)=>{const value=curve.values[index],show=compact||(curve.role!=='reference'||curve.core?position===0||position===indexes.length-1||(index+1)%step===0:false),offset=curve.role==='actual'?-10:curve.role==='forecast'?15:seriesIndex%2?-19:25,labelY=show?placeLabel(index,y(value)+offset):0,tooltip=`${curve.name} · ${labels[index]||''} · ${format(value)}`;return `<circle cx="${x(index)}" cy="${y(value)}" r="${show?(curve.role==='reference'?2.2:3):2}" fill="#fff" stroke="${curve.color}" stroke-width="${curve.role==='reference'?1.5:2}" tabindex="${seriesIndex===0&&position===0?0:-1}" role="img" aria-label="${esc(tooltip)}"><title>${esc(tooltip)}</title></circle>${show?`<text${compact?' data-forecast-external-label':''} x="${x(index)}" y="${labelY}" text-anchor="middle" font-size="${compact?11:9.5}" font-weight="700" fill="${curve.color}">${format(value)}</text>`:''}`}).join('');
      return segments.map(points=>`<polyline points="${points.join(' ')}" fill="none" stroke="${curve.color}" stroke-width="${curve.role==='reference'?(curve.core?2.2:1.35):3}" opacity="${curve.role==='reference'&&!curve.core?'.62':'1'}" ${curve.dash?`stroke-dasharray="${curve.dash}"`:''}><title>${esc(curve.name)}</title></polyline>`).join('')+dots;
    }).join('');
    const tickCount=compact?maxPoints:Math.min(maxPoints,8),ticks=Array.from({length:tickCount},(_,slot)=>{const index=Math.round(slot*(maxPoints-1)/Math.max(tickCount-1,1));return `<text x="${x(index)}" y="${H-15}" text-anchor="middle" font-size="9" fill="#7890A6">${esc(axisLabels[index]||'')}</text>`}).join('');
    const legend=usable.map(curve=>{const lastIndex=curve.values.reduce((found,value,index)=>Number.isFinite(value)?index:found,-1),latest=lastIndex>=0?format(curve.values[lastIndex]):'—';return `<span><i class="line-key${curve.dash?' dotted':''}" style="border-color:${curve.color}"></i>${esc(curve.name)} · 最新${latest}</span>`}).join('');
    const valuesTable=table?`<details class="forecast-ref-score-details"><summary>查看图表数值</summary><div class="forecast-score-table"><table><thead><tr><th scope="col">车型／曲线</th>${labels.map(label=>`<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody>${usable.map(curve=>`<tr><th scope="row">${esc(curve.name)}</th>${labels.map((_,index)=>`<td>${Number.isFinite(curve.values[index])?format(curve.values[index]):'—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`:'';
    return `${heading}<div class="forecast-svg-scroll forecast-evidence-line-scroll${lifecycle?' forecast-lifecycle-line-scroll':''}${compact?' forecast-compact-line-scroll':''}"${compact?` style="--forecast-chart-width:${W}px"`:''}><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">${grid}${lines}${ticks}</svg></div><p class="forecast-chart-readout" data-chart-readout role="status" aria-live="polite">${esc(readoutHint)}</p><div class="legend forecast-task-legend${lifecycle?' forecast-lifecycle-line-legend':''}">${legend}</div>${extra}${valuesTable}`;
  }
  function renderLifecycleLineChart({series,labels,ariaLabel,unit='percent',hourly=false,slope=false,title='',note='',compact=false,table=true,readoutHint,empty='暂无可比较曲线'}){
    return renderForecastEvidenceLines({series:series.map(item=>({...item,name:item.label,role:item.role||'reference',core:true,dash:item.dashed?'7 5':''})),labels,ariaLabel,unit:unit==='percent'?'rate':'number',hourly,slope,title,note,lifecycle:true,table,compact,readoutHint,empty});
  }
  function compactForecastScorePage(container){
    const pages=[...container.querySelectorAll('.forecast-score-page')].filter(page=>!page.dataset.compactScore);
    if(!pages.length)return;
    const methodology=document.createElement('details');methodology.className='forecast-score-methodology';
    methodology.open=true;
    const summary=document.createElement('summary');summary.textContent='评分规则与缺失处理';methodology.append(summary);
    for(const page of pages){
      page.dataset.compactScore='true';
      for(const table of page.querySelectorAll('.forecast-score-summary-table table')){
        const headings=[...table.querySelectorAll('thead th')].map(th=>th.textContent);
        for(const row of table.querySelectorAll('tbody tr')){
          [...row.cells].forEach((cell,i)=>cell.dataset.label=headings[i]||'');
          if(row.cells.length<5)continue;
          const cell=row.cells[3];
          const details=document.createElement('details');details.className='forecast-score-row-details';
          const summary=document.createElement('summary');summary.textContent='查看得分原因';
          summary.setAttribute('aria-label',summary.textContent+'：'+(row.cells[1]?.textContent||''));details.append(summary);
          while(cell.firstChild)details.append(cell.firstChild);cell.append(details);
        }
      }
      if(pages.length>1){
        const heading=page.querySelector('.forecast-score-detail h4');
        if(heading)methodology.append(heading.cloneNode(true));
      }
      for(const block of page.querySelectorAll('.forecast-score-rules,.forecast-score-rule-box,.forecast-score-formula,[data-score-explanation]'))methodology.append(block);
    }
    pages.at(-1).append(methodology);
  }
  function renderLifecycleScorePage(...groups){
    const container=document.createElement('div');
    container.innerHTML=groups.map(lifecycleScoreMarkup).join('');
    compactForecastScorePage(container);
    return container.innerHTML;
  }
  function renderScoreCandidate({rank,model,status,score,coverage,meta,parts}){
    const available=parts.filter(item=>item.part).sort((a,b)=>b.contribution-a.contribution);
    const missing=parts.filter(item=>!item.part).map(item=>esc(item.label));
    const rows=available.map(({label,part,contribution})=>{
      const barWidth=Math.min(100,Math.max(0,contribution));
      return `<tr class="forecast-score-part">
        <th scope="row">${esc(label)}</th><td class="forecast-candidate-evidence">${esc(part.evidence)}</td>
        <td class="forecast-candidate-similarity"><span>相似度 </span>${Math.round(part.value*100)}%</td>
        <td class="forecast-candidate-points"><i aria-hidden="true"><i style="width:${barWidth}%"></i></i><b>${contribution.toFixed(1)}<small> 分</small></b></td>
      </tr>`;
    }).join('');
    const total=Number.isFinite(score)&&score>=0?`${Math.round(score*100)}<small> 分</small>`:'—';
    return `<details open class="forecast-score-row-details forecast-score-candidate">
      <summary><span class="forecast-candidate-rank">第 ${rank} 名</span>
        <span class="forecast-candidate-identity"><strong>${esc(model)}</strong><span>${esc(status)}</span>${meta?`<small>${esc(meta)}</small>`:''}</span>
        <span class="forecast-candidate-result"><strong class="forecast-candidate-total">${total}</strong><span class="forecast-candidate-coverage">${esc(coverage)}</span></span>
      </summary><div class="forecast-score-parts">
      ${rows?`<table class="forecast-candidate-metrics" aria-label="${esc(model)}评分明细"><thead><tr><th scope="col">评分指标</th><th scope="col">实际对比</th><th scope="col">相似度</th><th scope="col">得分贡献</th></tr></thead><tbody>${rows}</tbody></table>`:''}
      ${missing.length?`<p class="forecast-score-missing"><strong>缺少可比数据</strong> ${missing.join('、')}</p>`:''}</div></details>`;
  }
  function lifecycleScoreMarkup({title,referenceScope='',orderLabel='按有效总分降序',description,rules,rows,selected,empty,minimumEvidence=3,weighted=false}){
    const ruleRows=rules.map(rule=>`<tr><td><b>${esc(rule.label)}</b></td><td>${weighted?Math.round((rule.weight||0)*100)+'%':'等权'}</td><td>${esc(rule.rule)}</td><td>${esc(rule.missing||'任一侧缺失时不参与，并按剩余有效项重新平均')}</td></tr>`).join('');
    const detailRows=rows.map((row,index)=>{const partMap=new Map(row.parts.map(part=>[part.key,part])),effective=row.parts.length,totalWeight=row.parts.reduce((sum,part)=>sum+(weighted?(part.weight||0):1),0),itemKey=row.item.event_id||row.item.model,selectedRole=itemKey===selected[0]?'主参考':itemKey===selected[1]?'辅助参考':'',role=selectedRole?(row.eligible===false?`${selectedRole}·人工`:selectedRole):(row.eligible===false?'证据不足':'候选'),parts=rules.map(rule=>{
      const part=partMap.get(rule.key);
      const contribution=part?part.value*(weighted?part.weight:1)/Math.max(totalWeight,.001)*100:0;
      return {label:rule.label,part,contribution};
    });
      return renderScoreCandidate({rank:index+1,model:row.item.model,status:role,score:row.score,coverage:`有效项 ${effective}/${rules.length}`,meta:row.meta,parts});
    }).join('');
    const markup=`<div class="forecast-score-page"><div class="forecast-score-formula"><span>${weighted?'有效相似度 × 对应权重之和':'有效单项相似度之和'}</span><i>÷</i><span>${weighted?'有效权重之和':'有效项数'}</span><strong>= 有效总分</strong></div><p data-score-explanation>${esc(description)} 自动推荐至少需 ${minimumEvidence} 项有效证据，证据不足的车型仍可人工选择。</p><section class="forecast-score-detail"><div class="forecast-score-section-head"><div><h4>${esc(title)}</h4>${referenceScope?`<p class="forecast-score-scope">${esc(referenceScope)}</p>`:''}</div><span>${esc(orderLabel)}</span></div><div class="forecast-score-rule-box"><div class="forecast-score-rule-head"><div><small>评分口径</small><b>为什么这样打分</b></div><span>${rules.length}个候选指标 · 自动推荐至少${minimumEvidence}项</span></div><div class="forecast-score-table forecast-score-rule-table"><table><thead><tr><th>评分指标</th><th>权重</th><th>相似度计算规则</th><th>缺失处理</th></tr></thead><tbody>${ruleRows}</tbody></table></div><p>各项贡献相加即为有效总分。</p></div><div class="forecast-score-detail-table">${detailRows||`<p class="forecast-score-empty">${esc(empty)}</p>`}</div></section></div>`;
    return markup;
  }
  const observedDailyPrefix=values=>{const gap=values.findIndex(value=>value===null||value===undefined||value===''||!Number.isFinite(Number(value))||Number(value)<0);return gap<0?values:values.slice(0,gap)};
  // Preserve observed decreases: stretchCompletion must reject, not repair, invalid cumulative curves.
  const forecastReferenceCurve=(item,field)=>{const dailyField={small_progress:'daily_small',direct_progress:'daily_direct',gross_progress:'daily_orders'}[field],observed=dailyField&&item?.[dailyField]?.length?observedDailyPrefix(item[dailyField]).length:null,raw=observedDailyPrefix(item?.[field]||[]),days=Math.max(0,Math.min(raw.length,Number(item?.days||raw.length),observed??raw.length));return raw.slice(0,days).map(Number)};
  const extendForecastCurve=(curve,length)=>{const result=[...curve];if(!result.length)return result;const increments=result.map((value,index)=>Math.max(value-(index?result[index-1]:0),0)),recent=increments.filter(value=>value>0).slice(-7),ratios=recent.slice(1).map((value,index)=>value/recent[index]).filter(Number.isFinite).sort((a,b)=>a-b),median=ratios.length?ratios[Math.floor(ratios.length/2)]:.88,decay=Math.min(Math.max(median,.65),.98);let increment=recent.slice(-3).reduce((sum,value)=>sum+value,0)/Math.max(Math.min(recent.length,3),1);while(result.length<length){increment*=decay;result.push(result.at(-1)+Math.max(increment,.000001))}return result};
  const adaptedForecastCompletion=(item,field,targetDays)=>{const curve=forecastReferenceCurve(item,field),horizon=Math.max(1,Math.round(targetDays||1)),values=curve.length===Number(item?.days||curve.length)?window.ForecastMath.stretchCompletion(curve,horizon):[];return {values,horizon,sourceDays:curve.length}};
  const rebasedForecastCompletion=(item,field,day,targetDays)=>{const adapted=adaptedForecastCompletion(item,field,targetDays),current=Math.min(Math.max(1,Math.round(day||1)),adapted.horizon);return {value:adapted.values[current-1]??NaN,extrapolated:false,sourceDays:adapted.sourceDays}};
  const rebasedForecastCompletionCurve=(item,field,targetDays)=>{const adapted=adaptedForecastCompletion(item,field,targetDays);return Array.from({length:adapted.horizon},(_,index)=>adapted.values[index]??NaN)};
  function createForecastEstimateLogger(owner){
    const logs=owner._forecastEstimateLogs||(owner._forecastEstimateLogs=new Map());
    return (key,message)=>{
      if(!message){logs.delete(key);return}
      if(logs.get(key)===message)return;
      logs.set(key,message);
      console.warn(`[销量预测估算] ${key} | ${message}`);
      (window.__FORECAST_ESTIMATE_LOGS=window.__FORECAST_ESTIMATE_LOGS||[]).push({time:new Date().toISOString(),key,message});
    };
  }

  init();
})();
