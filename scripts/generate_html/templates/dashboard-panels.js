  function channelColor(name){
    if(channelColors[name])return channelColors[name];
    const hash=Array.from(String(name)).reduce((value,char)=>(value*31+char.charCodeAt(0))>>>0,0);
    return Object.values(channelColors)[hash%Object.keys(channelColors).length];
  }
  function channelValue(value,format='number',signed=false){
    if(!channelKnown(value))return '—';
    const prefix=signed&&value>0?'+':'';
    if(format==='percent')return prefix+(value*100).toFixed(1)+'%';
    if(format==='points')return prefix+(value*100).toFixed(1)+' 个百分点';
    if(format==='capacity')return prefix+value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
    return prefix+fmt(value);
  }
  function channelHistory(data){
    const history=Array.isArray(data.history)?data.history:[],index=history.findIndex(item=>String(item.period)===String(data.period));
    return index>=0?history.slice(0,index+1):[{period:data.period,rows:data.rows||[],totals:data.totals||{}}];
  }
  function channelNames(data,history){return [...new Set([...(data.rows||[]),...history.flatMap(entry=>entry.rows||[])].filter(row=>row.store_count!==0).map(row=>row.channel).filter(Boolean))]}
  function channelRow(entry,name){return (entry.rows||[]).find(row=>row.channel===name)}
  function channelHistoryMatrix(data,history,names,key,label,format,unit,totalKey){
    const showStores=key==='productivity';
    const storeCell=value=>showStores?`<td class="channel-store-count" data-store-count="${channelKnown(value)?value:''}">${channelValue(value)}</td>`:'';
    const valuesFor=name=>history.map(entry=>channelRow(entry,name)?.[key]);
    const cells=values=>values.map((value,index)=>`<td data-period="${esc(history[index].period)}" data-value="${channelKnown(value)?value:''}"${index===history.length-1?' class="channel-current-period"':''}>${channelValue(value,format)}</td>`).join('');
    const body=names.map(name=>{
      const current=channelRow({rows:data.rows},name),stores=key==='active_rate'?`<small>配置 ${channelValue(current?.store_count)} 家</small>`:'';
      return `<tr data-channel="${esc(name)}"><th scope="row"><span class="channel-row-heading"><i style="background:${channelColor(name)}" aria-hidden="true"></i><span>${esc(name)}${stores}</span></span></th>${storeCell(current?.store_count)}${cells(valuesFor(name))}</tr>`;
    }).join('');
    const total=totalKey?`<tfoot><tr data-channel="__total__"><th scope="row">${key==='active_rate'?'整体出单率':key==='productivity'?'整体单店产能':'合计'}</th>${storeCell(data.totals?.store_count)}${cells(history.map(entry=>entry.totals?.[totalKey]))}</tr></tfoot>`:'';
    return `<section class="channel-table-block"><div class="channel-subhead"><h3>${esc(label)}</h3><span>${esc(unit)}</span></div><div class="channel-matrix-scroll" data-channel-scroll tabindex="0" role="region" aria-label="${esc(label)}历史表，渠道${showStores?'及门店数':''}列固定，可横向滚动"><table class="channel-matrix" data-channel-table="${key}"><caption class="sr-only">${esc(label)}，${showStores?'门店数为当前配置，':''}各渠道为行、历史周期为列</caption><colgroup><col class="channel-name-col">${showStores?'<col class="channel-store-col">':''}${history.map(()=>'<col class="channel-period-col">').join('')}</colgroup><thead><tr><th scope="col">门店渠道</th>${showStores?'<th scope="col" class="channel-store-count" title="当前配置门店数（家）">门店数</th>':''}${history.map((entry,index)=>`<th scope="col" data-period="${esc(entry.period)}"${index===history.length-1?' class="channel-current-period"':''}>${esc(entry.period)}</th>`).join('')}</tr></thead><tbody>${body}</tbody>${total}</table></div></section>`;
  }
  function channelAxisMax(values){
    const maximum=Math.max(0,...values.filter(channelKnown));if(!maximum)return 1;
    const power=10**Math.floor(Math.log10(maximum)),scaled=maximum/power;
    return (scaled<=1?1:scaled<=2?2:scaled<=5?5:10)*power;
  }
  function channelChartGeometry(history,names,pairedTables){
    const height=pairedTables?Math.min(570,Math.max(330,names.length*28+180)):330;
    return {width:Math.max(360,history.length*52),height,top:26,bottom:height-46,step:Math.max(360,history.length*52)/Math.max(history.length,1)};
  }
  function channelAxisMarkup(maximum,format,g,side){
    return `<div class="channel-y-axis ${side}" aria-hidden="true">${[0,.25,.5,.75,1].map(ratio=>`<span style="top:${g.bottom-ratio*(g.bottom-g.top)}px">${channelValue(maximum*ratio,format)}</span>`).join('')}</div>`;
  }
  function channelLinePath(values,g,maximum){
    let connected=false,path='';
    values.forEach((value,index)=>{if(!channelKnown(value)){connected=false;return}path+=`${connected?'L':'M'}${((index+.5)*g.step).toFixed(2)} ${(g.bottom-value/maximum*(g.bottom-g.top)).toFixed(2)} `;connected=true;});
    return path;
  }
  function channelPeriodDescription(data,entry,names){
    const parts=[String(entry.period)];
    if(data.metric==='sales')parts.push('总留存大定 '+channelValue(entry.totals?.count)+' 单');
    names.forEach(name=>{const row=channelRow(entry,name);parts.push(data.metric==='sales'?`${name} ${channelValue(row?.count)} 单，占比 ${channelValue(row?.share,'percent')}`:data.metric==='stores'?`${name} 出单率 ${channelValue(row?.active_rate,'percent')}，${channelValue(row?.active_count)} / ${channelValue(row?.store_count)} 家`:`${name} ${channelValue(row?.productivity,'capacity')} 单/店/本周期`)});
    return parts.join('；');
  }
  function channelPointOverlays(data,history,names,g){
    return history.map((entry,index)=>`<g class="channel-period-target" data-channel-point="${index}" data-period="${esc(entry.period)}" tabindex="${index===history.length-1?'0':'-1'}" role="img" aria-label="${esc(channelPeriodDescription(data,entry,names))}"><rect x="${index*g.step}" y="${g.top-10}" width="${g.step}" height="${g.bottom-g.top+16}" fill="transparent"/><title>${esc(channelPeriodDescription(data,entry,names))}</title></g>`).join('');
  }
  function channelLegend(names,sales){
    return `<div class="channel-legend">${names.map(name=>`<span><i style="background:${channelColor(name)}" aria-hidden="true"></i>${esc(name)}</span>`).join('')}${sales?'<span class="channel-total-key"><i aria-hidden="true"></i>总留存大定（右轴）</span>':''}</div>`;
  }
  function channelHistoryChart(data,history,names){
    const sales=data.metric==='sales',stores=data.metric==='stores',key=stores?'active_rate':'productivity',format=stores?'percent':'capacity',g=channelChartGeometry(history,names,sales||stores);
    const totals=history.map(entry=>entry.totals?.count),totalMax=channelAxisMax(totals);
    const sums=history.map(entry=>{const values=names.map(name=>channelRow(entry,name)?.share);return values.every(channelKnown)?values.reduce((sum,value)=>sum+value,0):null});
    const lineValues=names.map(name=>history.map(entry=>channelRow(entry,name)?.[key]));
    const leftMax=sales?Math.max(1,Math.ceil(Math.max(0,...sums.filter(channelKnown))*4-1e-10)/4):channelAxisMax(lineValues.flat());
    if(!sales&&!lineValues.flat().some(channelKnown)){
      const unconfigured=!(data.rows||[]).some(row=>channelKnown(row.store_count)),title=stores?'各渠道出单门店比例趋势':'各渠道单店产能趋势',message=unconfigured?'未配置该主体的门店总数':stores?'暂无可用的出单门店比例数据':'暂无可用的单店产能数据';
      return `<section class="channel-chart-block"><div class="channel-subhead"><h3>${title}</h3></div><div class="channel-chart-empty" data-channel-chart role="status"><strong>${message}</strong><p>${unconfigured?'维护当前主体的渠道门店总数后，重新生成看板即可查看。':'当前历史范围内数据缺失，表格以 — 保留。'}</p></div>${channelLegend(names,false)}<div class="channel-tooltip" data-channel-tooltip hidden role="tooltip"></div></section>`;
    }
    const grid=[0,.25,.5,.75,1].map(ratio=>{const y=g.bottom-ratio*(g.bottom-g.top);return `<line x1="0" x2="${g.width}" y1="${y}" y2="${y}"/>`}).join('');
    let marks='';
    if(sales){
      marks=history.map((entry,index)=>{
        if(!channelKnown(sums[index]))return `<text class="channel-missing-mark" x="${(index+.5)*g.step}" y="${g.bottom-8}" text-anchor="middle" data-channel-missing-stack data-period="${esc(entry.period)}">缺失</text>`;
        let cumulative=0;
        return names.map(name=>{const row=channelRow(entry,name),value=row.share,barHeight=value/leftMax*(g.bottom-g.top),y=g.bottom-(cumulative+value)/leftMax*(g.bottom-g.top);cumulative+=value;return `<rect data-channel="${esc(name)}" data-period="${esc(entry.period)}" data-value="${value}" x="${(index+.5)*g.step-17}" y="${y}" width="34" height="${Math.max(0,barHeight)}" fill="${channelColor(name)}"><title>${esc(name)} · ${esc(entry.period)} · ${channelValue(value,'percent')}</title></rect>${barHeight>=19?`<text class="channel-stack-label" x="${(index+.5)*g.step}" y="${y+barHeight/2+3}" text-anchor="middle">${(value*100).toFixed(0)}%</text>`:''}`}).join('');
      }).join('');
      marks+=`<path class="channel-total-line" d="${channelLinePath(totals,g,totalMax)}"/>`+totals.map((value,index)=>channelKnown(value)?`<circle class="channel-total-point" data-channel="__total__" data-period="${esc(history[index].period)}" data-value="${value}" cx="${(index+.5)*g.step}" cy="${g.bottom-value/totalMax*(g.bottom-g.top)}" r="3.5"><title>${esc(history[index].period)} · 总留存大定 ${channelValue(value)} 单</title></circle>`:'').join('');
    }else{
      marks=names.map((name,series)=>`<path class="channel-series-line" data-channel="${esc(name)}" d="${channelLinePath(lineValues[series],g,leftMax)}" stroke="${channelColor(name)}"/>${lineValues[series].map((value,index)=>channelKnown(value)?`<circle class="channel-series-point" data-channel="${esc(name)}" data-period="${esc(history[index].period)}" data-value="${value}" cx="${(index+.5)*g.step}" cy="${g.bottom-value/leftMax*(g.bottom-g.top)}" r="2.6" fill="${channelColor(name)}"><title>${esc(name)} · ${esc(history[index].period)} · ${channelValue(value,format)}</title></circle>`:'').join('')}`).join('');
      if(!stores){
        const clipId=`channel-capacity-plot-${channelPanelData.size}`;
        marks=`<defs><clipPath id="${clipId}"><rect x="0" y="${g.top}" width="${g.width}" height="${g.bottom-g.top}"/></clipPath></defs><g clip-path="url(#${clipId})">${marks}</g>`;
      }
    }
    const xLabels=history.map((entry,index)=>{const x=(index+.5)*g.step,label=String(entry.period).replace(/^20(\d{2})[-/](\d{2})[-/](\d{2})$/,'$2-$3');return `<text class="channel-axis-label" x="${x}" y="${g.bottom+20}" text-anchor="middle">${esc(label)}<title>${esc(entry.period)}</title></text>`}).join('');
    const title=sales?'渠道占比与留存大定总量':stores?'各渠道出单门店比例趋势':'各渠道单店产能趋势',leftUnit=sales?'渠道销量占比（%）':stores?'出单门店比例（%）':'单店产能（单/店/本周期）';
    return `<section class="channel-chart-block"><div class="channel-subhead"><h3>${title}</h3></div><div class="channel-axis-units"><span>${leftUnit}</span>${sales?'<span>总留存大定（单）</span>':''}</div><div class="channel-chart-frame ${sales?'channel-dual-axis':'channel-single-axis'}" data-channel-chart style="--channel-chart-height:${g.height}px">${channelAxisMarkup(leftMax,sales||stores?'percent':'capacity',g,'left')}<div class="channel-plot-scroll" data-channel-scroll tabindex="0" role="region" aria-label="${title}，左右方向键可查看各周期"><svg width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}" role="group" aria-label="${title}"><g class="channel-chart-grid">${grid}</g>${marks}${xLabels}${channelPointOverlays(data,history,names,g)}</svg></div>${sales?channelAxisMarkup(totalMax,'number',g,'right'):''}</div>${channelLegend(names,sales)}<p class="channel-chart-note">${sales?'柱：原始销量占比；线：总留存大定。':'每条线对应一个渠道。'}悬停或聚焦周期查看明细，缺失数据保留空缺。</p><div class="channel-tooltip" data-channel-tooltip hidden role="tooltip"></div></section>`;
  }
  function renderChannelPanel(data){
    const id=String(channelPanelData.size),history=channelHistory(data),names=channelNames(data,history);channelPanelData.set(id,data);
    const tables=data.metric==='sales'?channelHistoryMatrix(data,history,names,'count','渠道留存大定','number','单','count')+channelHistoryMatrix(data,history,names,'share','渠道销量占比','percent','%'):data.metric==='stores'?channelHistoryMatrix(data,history,names,'active_count','贡献订单门店数量','number','家','active_count')+channelHistoryMatrix(data,history,names,'active_rate','贡献订单门店比例','percent','%','active_rate'):channelHistoryMatrix(data,history,names,'productivity','渠道单店产能','capacity','单/店/本周期','productivity');
    const note=data.metric==='sales'?'留存大定数量和占比直接读取门店类型指标。':data.metric==='stores'?'出单门店比例 = 当期出单门店数 ÷ 该渠道配置门店总数。':'单店产能 = 当期渠道留存大定 ÷ 该渠道配置门店总数。';
    return `<div class="channel-panel" data-channel-panel="${id}" data-channel-metric="${esc(data.metric)}"><div class="channel-panel-intro"><p>${note}</p><span>截至 ${esc(data.period)} · ${history.length} 个周期 · 向左查看历史</span></div><div class="channel-history-grid"><div class="channel-history-tables">${tables}</div>${channelHistoryChart(data,history,names)}</div></div>`;
  }
  function refreshChannelCapacityAxis(scroll){
    if(!scroll.classList.contains('channel-plot-scroll'))return;
    const root=scroll.closest('[data-channel-panel]'),data=channelPanelData.get(root?.dataset.channelPanel);
    if(data?.metric!=='capacity'||!scroll.clientWidth)return;
    const history=channelHistory(data),names=channelNames(data,history),g=channelChartGeometry(history,names,false),chart=scroll.closest('[data-channel-chart]');
    const first=Math.max(0,Math.ceil(scroll.scrollLeft/g.step-.5)),last=Math.min(history.length-1,Math.floor((scroll.scrollLeft+scroll.clientWidth)/g.step-.5));
    const series=names.map(name=>history.map(entry=>channelRow(entry,name)?.productivity));
    const visible=series.flatMap(values=>values.slice(first,last+1)),peak=Math.max(0,...visible.filter(channelKnown));
    // Keep zero as the baseline, with modest headroom and stable rounded steps.
    const step=channelAxisMax([peak])/5,maximum=peak?Math.ceil(peak*1.08/step-1e-10)*step:1;
    if(Number(chart.dataset.channelAxisMax)===maximum)return;
    chart.dataset.channelAxisMax=String(maximum);
    chart.querySelectorAll('.channel-y-axis.left span').forEach((label,index)=>{label.textContent=channelValue(maximum*index/4,'capacity')});
    chart.querySelectorAll('.channel-series-line').forEach((line,index)=>{line.setAttribute('d',channelLinePath(series[index],g,maximum))});
    chart.querySelectorAll('.channel-series-point').forEach(point=>{point.setAttribute('cy',g.bottom-Number(point.dataset.value)/maximum*(g.bottom-g.top))});
  }
  function bindChannelScrollers(scrollers){
    channelPanelResizeObserver?.disconnect();channelPanelResizeObserver=null;
    if(!scrollers.length)return;
    const positions=new WeakMap();
    channelPanelResizeObserver=new ResizeObserver(entries=>entries.forEach(({target:scroll})=>{
      const saved=positions.get(scroll);if(!saved)return;
      const width=scroll.clientWidth,max=Math.max(0,scroll.scrollWidth-width);
      if(width===saved.width&&max===saved.max)return;
      // Preserve a user's historical position; only a previously anchored view follows the end.
      saved.width=width;saved.max=max;
      scroll.scrollLeft=saved.atEnd?max:Math.min(saved.left,max);
      saved.expected=scroll.scrollLeft;
      if(saved.atEnd)saved.left=scroll.scrollLeft;
      refreshChannelCapacityAxis(scroll);
    }));
    scrollers.forEach(scroll=>{
      scroll.scrollLeft=scroll.scrollWidth;
      const saved={width:scroll.clientWidth,max:Math.max(0,scroll.scrollWidth-scroll.clientWidth),left:scroll.scrollLeft,expected:scroll.scrollLeft,atEnd:true};
      positions.set(scroll,saved);
      refreshChannelCapacityAxis(scroll);
      scroll.addEventListener('scroll',()=>{
        refreshChannelCapacityAxis(scroll);
        const max=Math.max(0,scroll.scrollWidth-scroll.clientWidth);
        // Resize-induced/clamped scroll events must not be mistaken for a user choosing the end.
        if(scroll.clientWidth!==saved.width||max!==saved.max||Math.abs(scroll.scrollLeft-saved.expected)<1)return;
        saved.left=scroll.scrollLeft;saved.expected=scroll.scrollLeft;saved.atEnd=max-scroll.scrollLeft<=2;
      },{passive:true});
      channelPanelResizeObserver.observe(scroll);
    });
  }
  function bindChannelPanels(){
    bindChannelScrollers([...document.querySelectorAll('.channel-panel [data-channel-scroll]')]);
    document.querySelectorAll('[data-channel-panel]').forEach(root=>{
      const data=channelPanelData.get(root.dataset.channelPanel);if(!data)return;
      const history=channelHistory(data),names=channelNames(data,history),chart=root.querySelector('.channel-chart-block'),tooltip=root.querySelector('[data-channel-tooltip]');
      const showPoint=target=>{
        const entry=history[Number(target.dataset.channelPoint)];if(!entry)return;
        tooltip.innerHTML=`<strong>${esc(entry.period)}${data.metric==='sales'?` · 总留存大定 ${channelValue(entry.totals?.count)} 单`:''}</strong><ul>${names.map(name=>{const row=channelRow(entry,name),value=data.metric==='sales'?`${channelValue(row?.count)} 单 · ${channelValue(row?.share,'percent')}`:data.metric==='stores'?`${channelValue(row?.active_rate,'percent')} · ${channelValue(row?.active_count)} / ${channelValue(row?.store_count)} 家`:`${channelValue(row?.productivity,'capacity')} 单/店`;return `<li><span><i style="background:${channelColor(name)}"></i>${esc(name)}</span><b>${value}</b></li>`}).join('')}</ul>`;
        tooltip.hidden=false;
        const chartBox=chart.getBoundingClientRect(),pointBox=target.getBoundingClientRect(),left=Math.min(Math.max(4,pointBox.left-chartBox.left+pointBox.width/2-tooltip.offsetWidth/2),Math.max(4,chart.clientWidth-tooltip.offsetWidth-4));
        tooltip.style.left=left+'px';tooltip.style.top=Math.max(46,pointBox.top-chartBox.top+16)+'px';
      };
      chart.addEventListener('pointerover',event=>{const point=event.target.closest('[data-channel-point]');if(point)showPoint(point)});
      chart.addEventListener('pointerleave',()=>{tooltip.hidden=true});
      chart.addEventListener('focusin',event=>{const point=event.target.closest('[data-channel-point]');if(point)showPoint(point)});
      chart.addEventListener('focusout',event=>{if(!event.relatedTarget?.closest('[data-channel-point]'))tooltip.hidden=true});
      chart.addEventListener('keydown',event=>{
        if(event.key==='Escape'){tooltip.hidden=true;return}
        const point=event.target.closest('[data-channel-point]');if(!point||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();const points=[...chart.querySelectorAll('[data-channel-point]')],index=points.indexOf(point),next=event.key==='Home'?0:event.key==='End'?points.length-1:Math.max(0,Math.min(points.length-1,index+(event.key==='ArrowRight'?1:-1)));
        points.forEach((item,slot)=>item.setAttribute('tabindex',slot===next?'0':'-1'));points[next]?.focus({preventScroll:true});points[next]?.scrollIntoView({block:'nearest',inline:'nearest'});
      });
    });
  }
  function renderStackedTrend(data){
    if(!data?.periods?.length)return '<div class="empty-image">图表Sheet暂无可绘制数据</div>';
    const originalImage=DATA.chart_assets?.[data.image_key];
    if(window.CHART_RENDER_MODE==="original"&&originalImage)return `<div class="original-chart"><img src="${originalImage}" alt="${esc(data.headline||"Excel原始图表")}"/></div>`;
    const trendLine="#0070C0",seriesFill=index=>stackedTrendPalette[index%stackedTrendPalette.length],periods=data.periods,series=data.series||[],totals=data.totals||[],maxTotal=chartMax(totals),labelMax=Math.max(...periods.map(period=>String(period||"").length),1),left=52,bottom=252,plotH=218,step=Math.max(42,Math.min(labelMax*4.8,90)),W=Math.max(380,periods.length*step+50),H=Math.max(310,bottom+Math.min(labelMax*4.2,80)+14),barW=stackedBarWidth(step);
    const segmentLabelYs=periods.map(()=>[]);
    const bars=periods.map((period,index)=>{const rates=series.map(item=>Math.max(0,Number(item.values[index]||0))),stackHeight=rates.reduce((sum,rate)=>sum+rate,0)*plotH;let y=bottom-stackHeight;const stacks=series.map((item,sIndex)=>{const rate=rates[sIndex],height=rate*plotH,segmentY=y;y+=height;if(!rate)return "";const labelY=avoidLabelY(segmentY+height/2,segmentLabelYs[index],12,bottom-4,12);segmentLabelYs[index].push(labelY);return `<rect x="${left+index*step+(step-barW)/2}" y="${segmentY}" width="${barW}" height="${height}" fill="${seriesFill(sIndex)}"/><text class="chart-data-label stack-segment-label" x="${left+index*step+step/2}" y="${labelY}" text-anchor="middle">${(rate*100).toFixed(0)}%</text>`}).join("");const lx=left+index*step+step-2,ly=bottom+13;return `${stacks}<text x="${lx}" y="${ly}" text-anchor="end" transform="rotate(-40 ${lx} ${ly})" font-size="9" fill="#718396">${esc(period)}</text>`}).join("");
    const points=totals.map((value,index)=>`${left+index*step+step/2},${bottom-Number(value)/maxTotal*plotH}`).join(" ");
    const values=totals.map((value,index)=>{const baseY=bottom-Number(value)/maxTotal*plotH-8,labelY=avoidLabelY(baseY,segmentLabelYs[index],12,bottom-8);return `<text class="chart-data-label total-label" x="${left+index*step+step/2}" y="${labelY}" text-anchor="middle">${fmt(value)}</text>`}).join("");
    const legend=series.map((item,index)=>`<span><i style="background:${seriesFill(index)}"></i>${esc(item.name)}</span>`).join("")+`<span><i class="line-key"></i>总计</span>`;
    return `<div class="stacked-chart"><svg viewBox="0 0 ${W} ${H}" style="width:${W}px;height:${H}px"><line x1="${left}" y1="${bottom}" x2="${W-20}" y2="${bottom}" stroke="#e6ebf1"/>${bars}<polyline points="${points}" fill="none" stroke="${trendLine}" stroke-width="2.5"/>${values}</svg></div><div class="legend trend-legend">${legend}</div>`;
  }
  function renderTable(data){
    if(!data?.columns)return '<div class="empty-image">暂无表格数据</div>';
    const formats=data.formats||[];
    const bodyRows=data.rows.map(row=>`<tr>${row.map((value,index)=>`<td class="${formats[index]&&formats[index]!=="text"?"num":""}">${formatTableCell(value,formats[index])}</td>`).join("")}</tr>`).join("")||`<tr><td class="table-empty" colspan="${data.columns.length}">暂无数据</td></tr>`;
    return `<div class="table-wrap${data.scrollable?' is-scrollable':''}"><table class="data-table"><thead><tr>${data.columns.map((column,index)=>`<th class="${formats[index]&&formats[index]!=="text"?"num":""}">${esc(column)}</th>`).join("")}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
  }
  function renderHistoryBody(options,grain){
    const source=options[grain]||{columns:["周期"],rows:[]};
    return renderTable({columns:source.columns,rows:source.rows.slice().reverse(),formats:source.formats});
  }
  function renderHistoryTable(data){
    const options=data.granularities||{};
    const current=options[state.grain]?state.grain:(options[data.default]?data.default:(Object.keys(options)[0]||"week"));
    return `<div class="history-wrap"><div data-history-body>${renderHistoryBody(options,current)}</div></div>`;
  }
  function formatTableCell(value,type){if(["number","percent","signed_percent"].includes(type)&&(value==null||typeof value==="string"&&!value.trim()))return '—';const number=Number(value);if(type==="percent"&&Number.isFinite(number))return `${(number*100).toFixed(1)}%`;if(type==="signed_percent"&&Number.isFinite(number)){const result=number*100;return `<span class="change ${result>=0?"pos":"neg"}">${result>=0?"+":""}${result.toFixed(1)}%</span>`}if(type==="number"&&Number.isFinite(number))return number.toLocaleString("zh-CN",{maximumFractionDigits:1});return fmt(value)}
  function shareValue(row){const value=Number(row.share??row.value??0);return Math.abs(value)<=1.5?value*100:value}
  function renderBars(data){
    const rows=data?.rows||[],max=Math.max(...rows.map(shareValue),1),color=colors[data.color]||colors.blue;
    return `<div class="bars">${rows.map(row=>{const value=shareValue(row);return `<div class="bar-row"><label title="${esc(row.label)}">${esc(row.label)}</label><div class="track"><div class="fill" style="width:${Math.max(value/max*100,1)}%;background:${color}"></div></div><b>${value.toFixed(1)}%${row.count!=null?` (${fmt(row.count)})`:""}</b></div>`}).join("")}</div>`;
  }
  function renderPieChart(data){
    const source=(data?.rows||[]).map(row=>{const share=Number(row.share),count=Number(row.count),value=Number.isFinite(share)?share:Number.isFinite(count)?count:0;return {...row,value}}).filter(row=>row.value>0),total=source.reduce((sum,row)=>sum+row.value,0);
    if(!source.length||!total)return '<div class="empty-image">暂无可绘制数据</div>';
    const palette=Object.values(colors),radius=70,circumference=2*Math.PI*radius;let offset=0;
    const slices=source.map((row,index)=>{const length=row.value/total*circumference,markup=`<circle cx="100" cy="100" r="${radius}" stroke="${palette[index%palette.length]}" stroke-width="30" stroke-dasharray="${length} ${circumference-length}" stroke-dashoffset="${-offset}"/>`;offset+=length;return markup}).join('');
    offset=0;
    const sliceLabels=source.map((row,index)=>{const length=row.value/total*circumference,percent=row.value/total*100,angle=(offset+length/2)/circumference*2*Math.PI-Math.PI/2,x=100+Math.cos(angle)*radius,y=100+Math.sin(angle)*radius;offset+=length;return `<text class="pie-slice-label" x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" aria-label="${esc(row.label)} ${percent.toFixed(1)}%">${percent.toFixed(1)}%</text>`}).join('');
    const totalCount=source.every(row=>Number.isFinite(Number(row.count)))?source.reduce((sum,row)=>sum+Number(row.count||0),0):null;
    const legend=source.map((row,index)=>{const percent=row.value/total*100,count=Number.isFinite(Number(row.count))?` · ${fmt(Number(row.count))}单`:'';return `<div class="pie-legend-row"><span><i style="background:${palette[index%palette.length]}"></i><b title="${esc(row.label)}">${esc(row.label)}</b></span><strong>${percent.toFixed(1)}%${count}</strong></div>`}).join('');
    return `<div class="pie-chart"><div class="pie-visual"><svg viewBox="0 0 200 200" role="img" aria-label="占比圆环图"><circle class="pie-track" cx="100" cy="100" r="${radius}"/><g transform="rotate(-90 100 100)">${slices}</g><g class="pie-slice-labels">${sliceLabels}</g><text class="pie-total" x="100" y="96" text-anchor="middle">${totalCount!=null?fmt(totalCount):`${total.toFixed(1)}%`}</text><text class="pie-total-label" x="100" y="113" text-anchor="middle">${totalCount!=null?'合计':'占比'}</text></svg></div><div class="pie-legend">${legend}</div></div>`;
  }
  function renderStructureCards(groups){return `<div class="structure-grid">${groups.map((group,index)=>`<section class="structure-card"><h3>${esc(group.name)}</h3><div class="bars">${group.rows.map(row=>{const value=shareValue(row),change=Number(row.change||0)*100;return `<div class="bar-row"><label>${esc(row.label)}<span class="change ${change>=0?"pos":"neg"}">${change>=0?"+":""}${change.toFixed(1)}%</span></label><div class="track"><div class="fill" style="width:${Math.min(value,100)}%;background:${Object.values(colors)[index%5]}"></div></div><b>${value.toFixed(1)}%</b></div>`}).join("")}</div></section>`).join("")}</div>`}
  function renderFunnel(stages){
    const palette=Object.values(colors),rate=value=>Number.isFinite(value)?`${(value*100).toFixed(1)}%`:'—',quantity=value=>Number.isFinite(value)?fmt(value):'—';
    return `<div class="funnel"><div class="funnel-row head"><span>阶段</span><span>规模</span><span>数量</span><span>总占比</span><span>阶段转化</span><span>流失</span></div>${stages.map((stage,index)=>`<div class="funnel-row"><span>${esc(stage.label)}</span><div class="funnel-track">${Number.isFinite(stage.total_rate)?`<div class="funnel-fill" style="width:${Math.max(stage.total_rate*100,1)}%;background:${palette[index%palette.length]}">${rate(stage.total_rate)}</div>`:'<span title="数据缺失或分母为0">—</span>'}</div><b>${quantity(stage.value)}</b><b>${rate(stage.total_rate)}</b><b>${rate(stage.stage_rate)}</b><b>${quantity(stage.loss)}</b></div>`).join("")}</div>`}
  function renderCohortMatrix(cohorts){
    const columns=["大定批次",...cohorts[0].stages.slice(1).map(stage=>stage.label),"大定→锁单","锁单→交付"];
    const rows=cohorts.map(cohort=>[cohort.period,...cohort.stages.slice(1).map(stage=>stage.total_rate),cohort.order_to_lock_days,cohort.lock_to_delivery_days]);
    return `<div class="table-wrap"><table class="data-table"><thead><tr>${columns.map(column=>`<th>${esc(column)}</th>`).join("")}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map((value,index)=>index>0&&index<row.length-2?(Number.isFinite(value)?`<td class="heat-cell" style="background:rgba(39,133,232,${.05+Math.pow(value,1.6)*.7})">${(value*100).toFixed(1)}%</td>`:'<td title="数据缺失或分母为0">—</td>'):`<td>${index>=row.length-2?(Number.isFinite(value)?fmt(value)+"天":'—'):esc(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  function renderRankCards(cards,kind){const directional=kind==='rise'||kind==='drop',directionalClass=directional?` rank-grid-${kind}`:'';return `<div class="rank-grid${directionalClass}">${Object.entries(cards||{}).map(([name,entry])=>{const rows=Array.isArray(entry)?entry:entry.rows||[];if(!rows.length)return `<article class="rank-card"><h3>${esc(name)} · 暂无上榜车型</h3><p class="empty">${esc(entry.empty_reason||"暂无可比排名")}</p></article>`;const maxRate=Math.max(...rows.map(row=>Math.abs(Number(row.rate)||0)),0);return `<article class="rank-card"><h3>${esc(name)} · TOP${rows.length}</h3><ol>${rows.map(row=>{const meta=[row.rate!=null?`${(Number(row.rate)*100).toFixed(1)}%`:"",row.amount!=null?`${fmt(row.amount)}元`:""].filter(Boolean).join(" · ");if(!directional)return `<li><b>${row.rank}</b><span>${esc(row.label)}${meta?`<small>${esc(meta)}</small>`:""}</span></li>`;const rate=Number(row.rate),rateLabel=row.rate!=null&&Number.isFinite(rate)?`${(rate*100).toFixed(1)}%`:'—',width=maxRate>0&&Number.isFinite(rate)?Math.min(Math.abs(rate)/maxRate*100,100):0,amount=row.amount!=null?`${fmt(row.amount)}元`:'';return `<li><b class="rank-index">${row.rank}</b><span class="rank-name">${esc(row.label)}${amount?`<small>${esc(amount)}</small>`:''}</span><div class="rank-bar" aria-hidden="true"><i style="width:${width.toFixed(1)}%"></i></div><strong class="rank-rate">${rateLabel}</strong></li>`}).join("")}</ol></article>`}).join("")}</div>`}
  function renderRights(data){return `<div class="rights"><strong>权益金额 ${fmt(data.amount)} 元</strong><p>${esc(data.text)}</p></div>`}
  function renderFeeBandStructure(data){
    const bands=data?.bands||[],rows=data?.rows||[],palette=["#2859f5","#00C2FF","#00B578","#FFB020","#FF4D6D","#7C3AED","#ED7D31","#70AD47","#4472C4"];
    const legend=`<div class="legend fee-legend">${bands.map((band,index)=>`<span><i style="background:${palette[index%palette.length]}"></i>${esc(band)}</span>`).join("")}</div>`;
    const body=rows.map(row=>{const total=row.values.reduce((sum,value)=>sum+Number(value||0),0),denominator=total||1;return `<div class="fee-band-row"><label title="${esc(row.label)}">${esc(row.label)}</label><div class="fee-band-chart"><div class="fee-band-track">${row.values.map((value,index)=>{const share=Number(value||0)/denominator*100;return `<i style="width:${share}%;background:${palette[index%palette.length]}" title="${esc(bands[index])} ${share.toFixed(1)}%"></i>`}).join("")}</div><div class="segment-data-labels">${row.values.map((value,index)=>{const share=Number(value||0)/denominator*100;return `<span><i style="background:${palette[index%palette.length]}"></i>${share.toFixed(1)}%</span>`}).join("")}</div></div><b>${fmt(total)}单</b></div>`}).join("");
    return `${legend}<div class="fee-band-list">${body}</div>`;
  }
  function renderFeePeriodBands(data){
    const periods=data?.periods||[],series=data?.series||[],palette=[chartPalette.yellow,chartPalette.green,chartPalette.blue,chartPalette.violet,chartPalette.rose];
    const legend=`<div class="legend fee-legend">${series.map((item,index)=>`<span><i style="background:${palette[index%palette.length]}"></i>${esc(item.name)}</span>`).join("")}</div>`;
    const columns=periods.map((period,index)=>{const actual=Object.prototype.hasOwnProperty.call(data,'actual_totals')?data.actual_totals?.[index]:data.actual_total,amount=actual!==null&&actual!==undefined&&typeof actual!=='boolean'&&String(actual).trim()!==''&&Number.isFinite(Number(actual))?fmt(actual):'\u2014';const total=series.reduce((sum,item)=>sum+Number(item.values[index]||0),0)||1;return `<div class="fee-period-col"><div class="fee-period-stack">${series.map((item,sIndex)=>{const share=Number(item.values[index]||0)/total*100;return `<i style="height:${share}%;background:${palette[sIndex%palette.length]}" title="${esc(item.name)} ${share.toFixed(1)}%"><span>${share.toFixed(1)}%</span></i>`}).join("")}</div><b>${esc(period)}</b><small>实际金额总计 ${amount}元</small></div>`}).join("");
    return `${legend}<div class="fee-period-chart" style="--periods:${Math.max(periods.length,1)}">${columns}</div>`;
  }
  function renderFeeHeatmap(data){
    const periods=data?.periods||[],rows=data?.rows||[],columns=Math.max(periods.length,1);
    return `<div class="fee-heatmap"><div class="fee-heat-row" style="--cols:${columns}"><div class="heat-head">选配项</div>${periods.map(period=>`<div class="heat-head">${esc(period)}</div>`).join("")}</div>${rows.map(row=>`<div class="fee-heat-row" style="--cols:${columns}"><div class="heat-label" title="${esc(row.group)} · ${esc(row.label)}"><small>${esc(row.group)}</small>${esc(row.label)}</div>${periods.map((_,index)=>{const value=Number(row.values[index]||0);return `<div class="fee-heat-cell" style="background:rgba(22,119,255,${.08+Math.min(value,1)*.68})">${(value*100).toFixed(1)}%</div>`}).join("")}</div>`).join("")}</div>`;
  }
  function bindSkuHeatmaps(){
    document.querySelectorAll('[data-sku-scroll]').forEach(scroll=>{
      // Hidden combination tabs must wait until their first visible layout.
      // Initialize once so switching tabs does not reset a user's history view.
      if(scroll._skuHeatmapBound||!scroll.clientWidth)return;scroll._skuHeatmapBound=true;
      scroll.scrollLeft=scroll.scrollWidth;
      let drag=null;
      const stop=event=>{
        if(!drag||event.pointerId!==drag.id)return;
        const id=drag.id;drag=null;scroll.classList.remove('is-dragging');
        if(scroll.hasPointerCapture(id))scroll.releasePointerCapture(id);
      };
      scroll.addEventListener('pointerdown',event=>{
        if(event.pointerType!=='mouse'||event.button!==0||scroll.scrollWidth<=scroll.clientWidth+1)return;
        const box=scroll.getBoundingClientRect();
        if(event.clientY>=box.top+scroll.clientHeight||event.clientX>=box.left+scroll.clientWidth)return;
        drag={id:event.pointerId,x:event.clientX,left:scroll.scrollLeft};
        scroll.focus({preventScroll:true});scroll.classList.add('is-dragging');scroll.setPointerCapture(event.pointerId);event.preventDefault();
      });
      scroll.addEventListener('pointermove',event=>{
        if(!drag||event.pointerId!==drag.id)return;
        scroll.scrollLeft=drag.left+drag.x-event.clientX;event.preventDefault();
      });
      ['pointerup','pointercancel','lostpointercapture'].forEach(type=>scroll.addEventListener(type,stop));
      scroll.addEventListener('keydown',event=>{
        if(event.target!==scroll||event.altKey||event.ctrlKey||event.metaKey)return;
        const targets={ArrowLeft:scroll.scrollLeft-75,ArrowRight:scroll.scrollLeft+75,Home:0,End:scroll.scrollWidth};
        if(!Object.hasOwn(targets,event.key))return;
        scroll.scrollLeft=targets[event.key];event.preventDefault();
      });
    });
  }
  function renderSkuHeatmap(data){
    const periods=data?.periods||[],rows=data?.rows||[],columns=Math.max(periods.length,1);
    return `<div class="sku-heatmap-scroll" data-sku-scroll tabindex="0" role="region" aria-label="SKU累计锁单占比历史表，首列固定，可左右拖动或使用左右方向键查看全部周期"><div class="heatmap sku-heatmap"><div class="heatmap-row" style="--cols:${columns}"><div class="heat-head">累计锁单</div>${periods.map(p=>`<div class="heat-head" data-sku-period="${esc(p)}">${esc(p)}</div>`).join("")}</div>${rows.map(row=>`<div class="heatmap-row" style="--cols:${columns}"><div class="heat-label">${esc(row.label)}</div>${periods.map((_,index)=>{const raw=row.values[index];if(raw==null||!Number.isFinite(Number(raw)))return '<div title="该周期未提供累计锁单占比">—</div>';const value=Number(raw);return `<div style="background:rgba(0,181,120,${.12+value*.72})">${(value*100).toFixed(1)}%</div>`}).join("")}</div>`).join("")}</div></div>`;
  }
  function renderComboHeatmap(data){
    const periods=data?.periods||[],rows=data?.rows||[],index=Math.max(periods.length-1,0);
    return `<div class="combo-grid">${rows.map(row=>`<div class="combo-cell"><b>${esc(row.rank)}</b><br>${row.labels.map(esc).join(" × ")}<br><strong>${esc(periods[index]||"总计")} ${(Number(row.values[index]??row.total)*100).toFixed(1)}%</strong></div>`).join("")}</div>`;
  }
  function renderComboMatrix(data){
    const groups=data?.groups||[];
    if(!groups.length)return '<div class="empty-image">组合Sheet暂无可绘制数据</div>';
    const controls=`<div class="combo-controls" role="group" aria-label="配置组合维度">${groups.map((group,index)=>`<button data-combo-switch="${index}" class="${index===0?"active":""}" aria-pressed="${index===0}">${esc(group.name)}</button>`).join("")}</div>`;
    const panels=groups.map((group,groupIndex)=>{const columns=Math.max(group.periods.length,1);const rows=group.rows||[];return `<div class="combo-matrix-panel sku-heatmap-scroll" data-combo-panel="${groupIndex}" data-sku-scroll tabindex="0" role="region" aria-label="${esc(group.name)}配置组合历史表，可左右拖动或使用左右方向键查看全部周期" ${groupIndex?"hidden":""}><div class="combo-matrix-grid" style="--cols:${columns}"><div class="combo-matrix-head">组合</div>${group.periods.map(period=>`<div class="combo-matrix-head" data-sku-period="${esc(period)}">${esc(period)}</div>`).join("")}${rows.map(row=>`<div class="combo-matrix-label" title="${esc(row.rank)} · ${esc(row.label)}"><b>${esc(row.rank)}</b><span>${esc(row.label)}</span></div>${row.values.map(value=>{if(value==null||!Number.isFinite(Number(value)))return '<div class="combo-matrix-cell" title="该周期未提供配置组合占比">—</div>';const number=Number(value),alpha=.04+Math.min(number,1)*.6;return `<div class="combo-matrix-cell" style="background:rgba(0,181,120,${alpha.toFixed(2)})"><b>${(number*100).toFixed(1)}%</b></div>`}).join("")}`).join("")}</div></div>`}).join("");
    return `<div class="combo-matrix">${controls}${panels}</div>`;
  }
  function renderTailDistribution(rows){return renderColumns(rows||[],colors.purple)}
  function cumulative(values){let total=0;return values.map(value=>(total+=Number(value||0)))}
  function renderLaunch(data){
    if(!data?.periods?.length)return '<div class="empty-image">暂无首销期节奏数据</div>';
    const known=rhythmKnown,periods=data.periods,metrics=data.metrics,dailyBig=metrics["当日大定数量"]||[],small=metrics["当日小订转大数量"]||metrics["当日小订转大定数量"]||[];
    const direct=metrics["当日直接大定数量"]||dailyBig.map((value,index)=>known(value)&&known(small[index])?value-small[index]:null),unit=data.grain==='week'?'当周':'当日';
    const smallRate=metrics["累计小订转化率"]||metrics["累计小转大率"]||null,bigRate=metrics["累计直接大定占比"]||null;
    const rows=periods.map((label,index)=>{
      const total=known(small[index])&&known(direct[index])?small[index]+direct[index]:null;
      return {label,total,values:{small:small[index],direct:direct[index]},rates:{smallRate:smallRate?.[index],bigRate:bigRate?.[index]},tooltip:known(total)?`${label} · ${unit}直接大定 ${fmt(direct[index])} · ${unit}小订转大 ${fmt(small[index])} · 来源合计 ${fmt(total)}`:`${label} · ${unit}来源数据尚未更新或不完整，不按0绘制`};
    });
    const lines=[];
    if(Array.isArray(smallRate)&&smallRate.length)lines.push({key:'smallRate',label:'累计小转大率（累计小转大÷总小订）',color:'#A65300',textColor:'#A65300',digits:1});
    if(Array.isArray(bigRate)&&bigRate.length)lines.push({key:'bigRate',label:'累计直接大定占比',color:'#200036',textColor:'#200036',digits:1});
    return renderRhythmChart({kind:'launch-day',title:`首销期${unit}订单来源`,rows,maxValue:chartMax(rows.map(row=>row.total)),series:[{key:'small',label:unit+'小订转大',color:colors.green},{key:'direct',label:unit+'直接大定',color:colors.blue}],lines:[]})+renderLaunchRateTrends(rows,lines);
  }
  function renderSmallOrderRhythm(rows){
    if(!rows?.length)return '<div class="empty-image">暂无小订期节奏数据</div>';
    const data=rows.map(row=>{
      const total=Math.max(Number(row.orders||0),0),retained=Math.max(Number(row.retained||0),0),cancel=Math.max(Number(row.cancel||0),0),retention=Number(row.retention_rate||0);
      return {label:row.period,total,values:{retained,cancel},rates:{retention},tooltip:`${row.period} · 订单 ${fmt(total)} · 留存小订 ${fmt(retained)} · 退订 ${fmt(cancel)} · 留存率 ${(retention*100).toFixed(0)}%`};
    });
    return renderRhythmChart({kind:'small-day',title:'小订期间订单、留存、退订与留存率趋势',rows:data,maxValue:chartMax(rows.flatMap(row=>[row.orders,row.retained,row.cancel])),series:[{key:'retained',label:'留存小订',color:colors.green},{key:'cancel',label:'退订',color:colors.coral}],lines:[{key:'retention',label:'留存率',color:'#0070C0',textColor:'#075fa8',digits:0}]});
  }
  function renderTrend(rows){return renderColumns(rows.map(row=>({label:row.period,value:row.daily||0})),colors.coral)}
  function renderDailyCancel(rows){
    if(!rows?.length)return '<div class="empty-image">暂无日度退订数据</div>';
    const data=rows.map(row=>{
      const small=Math.max(Number(row.daily||0),0),big=Math.max(Number(row.big_daily||0),0),small_rate=row.small_rate==null||row.small_rate===''?null:Number(row.small_rate),big_rate=row.big_rate==null||row.big_rate===''?null:Number(row.big_rate);
      const rateText=value=>rhythmKnown(value)?(value*100).toFixed(1)+'%':'—';
      return {label:row.period,total:small+big,values:{small,big},rates:{small_rate,big_rate},tooltip:`${row.period} · 当日小订退 ${fmt(small)} · 当日大定退 ${fmt(big)} · 退订合计 ${fmt(small+big)} · 小订退率 ${rateText(small_rate)} · 大定退率 ${rateText(big_rate)}`};
    });
    return renderRhythmChart({kind:'cancel-day',title:'日度退订与退订率趋势',rows:data,maxValue:chartMax(rows.map(row=>Number(row.daily||0)+Number(row.big_daily||0))),series:[{key:'small',label:'当日小订退',color:colors.coral},{key:'big',label:'当日大定退',color:colors.orange}],lines:[{key:'small_rate',label:'累计小订退率',color:'#0070C0',textColor:'#075fa8',digits:1},{key:'big_rate',label:'大定退率',color:colors.purple,textColor:'#6930bd',digits:1}]});
  }
  function renderHourlyChart(rows,day){
    const filtered=day==="总计"?(rows||[]):(rows||[]).filter(row=>String(row.period||"")===day);
    const grouped=new Map();filtered.forEach(row=>{const key=String(row.hour),item=grouped.get(key)||{hour:key,count:0,cancel:0};item.count+=Number(row.count||0);item.cancel+=Number(row.cancel||0);grouped.set(key,item)});
    const data=Array.from({length:24},(_,hour)=>grouped.get(String(hour))||{hour:String(hour),count:0,cancel:0});
    const points=data.map(row=>{
      const count=Number(row.count||0),cancel=Number(row.cancel||0),kept=Math.max(count-cancel,0);
      return {label:row.hour+'时',total:count,values:{kept,cancel},tips:{kept:`小订留存 ${fmt(kept)}`,cancel:`退订 ${fmt(cancel)} · 总计 ${fmt(count)}`},tooltip:`${row.hour}时 · 小订留存 ${fmt(kept)} · 退订 ${fmt(cancel)} · 总计 ${fmt(count)}`};
    });
    return renderRhythmChart({kind:'small-hour',title:'分时小订与退订节奏',rows:points,maxValue:chartMax(data.map(row=>row.count)),series:[{key:'kept',label:'留存小订',color:colors.green},{key:'cancel',label:'退订',color:colors.coral}]});
  }
  function renderHourly(rows){
    const days=[...new Set((rows||[]).map(row=>String(row.period||"")).filter(Boolean))];
    const options=["总计",...days].map(day=>`<option value="${esc(day)}">${esc(String(day).replace(/[ T]00:00:00$/, ""))}</option>`).join("");
    return `<div class="hourly-wrap"><div class="hourly-toolbar"><span>分时口径</span><select data-hourly-select aria-label="分时口径" data-hourly-rows="${esc(JSON.stringify(rows||[]))}">${options}</select></div><div data-hourly-body>${renderHourlyChart(rows,"总计")}</div></div>`;
  }
  function renderLaunchHourlyChart(rows,day){
    const filtered=day==="总计"?(rows||[]):(rows||[]).filter(row=>String(row.period||"")===day);
    const grouped=new Map();filtered.forEach(row=>{const key=String(row.hour),item=grouped.get(key)||{hour:key,orders:0,small:0,direct:0};item.orders+=Number(row.orders||0);item.small+=Number(row.small||0);item.direct+=Number(row.direct||0);grouped.set(key,item)});
    const data=Array.from({length:24},(_,hour)=>grouped.get(String(hour))||{hour:String(hour),orders:0,small:0,direct:0});
    const points=data.map(row=>{
      const orders=Number(row.orders||0),small=Number(row.small||0),direct=Number(row.direct||0);
      return {label:row.hour+'时',total:orders,values:{small,direct},tips:{small:`小订转大 ${fmt(small)}`,direct:`直接大定 ${fmt(direct)} · 总计 ${fmt(orders)}`},tooltip:`${row.hour}时 · 小订转大 ${fmt(small)} · 直接大定 ${fmt(direct)} · 总计 ${fmt(orders)}`};
    });
    return renderRhythmChart({kind:'launch-hour',title:'分时首销节奏',rows:points,maxValue:chartMax(data.map(row=>row.orders)),series:[{key:'small',label:'小订转大',color:colors.green},{key:'direct',label:'直接大定',color:colors.blue}]});
  }
  function renderLaunchHourly(rows){
    const days=[...new Set((rows||[]).map(row=>String(row.period||"")).filter(Boolean))];
    const options=["总计",...days].map(day=>`<option value="${esc(day)}">${esc(String(day).replace(/[ T]00:00:00$/, ""))}</option>`).join("");
    return `<div class="hourly-wrap"><div class="hourly-toolbar"><span>分时口径</span><select data-launch-hourly-select aria-label="分时口径" data-launch-hourly-rows="${esc(JSON.stringify(rows||[]))}">${options}</select></div><div data-launch-hourly-body>${renderLaunchHourlyChart(rows,"总计")}</div></div>`;
  }
  function renderColumns(rows,color){const known=row=>row.value!=null&&Number.isFinite(Number(row.value)),max=chartMax(rows.filter(known).map(row=>row.value));return `<div class="trend">${rows.map(row=>`<div class="trend-col"><i style="height:${known(row)?Number(row.value)/max*100:0}%;background:${color}"><b class="column-data-label"${known(row)?'':' title="该周期数据未提供"'}>${known(row)?fmt(row.value):"—"}</b></i><span>${esc(row.label)}</span></div>`).join("")}</div>`}
  function renderCancelCards(groups){return `<div class="cancel-grid">${groups.map((group,index)=>`<section class="structure-card"><h3>${esc(group.name)}</h3>${renderBars({color:["orange","coral","purple","blue","coral","green","orange"][index%7],rows:group.rows})}</section>`).join("")}</div>`}
