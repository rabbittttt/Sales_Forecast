// Historical order dashboard routines used by the raw workbook regression fixtures.
  let rawRowsCache=[],rawRowsKey=null,rawRenderRevision=0;
  async function loadRawRows(fileIndex,sheetIndex){
    if(FORECAST_APP)return [];
    const key=`${fileIndex}|${sheetIndex}`;
    if(rawRowsKey===key)return rawRowsCache;
    const b64=RAW_BLOCKS[key]||await getRawBlock(key);
    try{return b64?((await decompressJson(b64)).rows||[]):[]}
    catch(error){delete RAW_BLOCKS[key];rawBlockRequests.delete(key);throw error;}
  }
  function visibleRawRows(rows,query){const header=rows.length?[rows[0]]:[];return[...header,...filterRawRows(rows.slice(1),query)]}
  async function renderRaw(){
    if(FORECAST_APP){state.module="sales_forecast";if(await ensureState()===false)return;await renderAll();syncUrl("replace");return;}
    const revision=++rawRenderRevision,fileIndex=state.rawFile,sheetIndex=state.rawSheet,file=DATA.raw_files[fileIndex]||DATA.raw_files[0],sheet=file?.sheets[sheetIndex]||file?.sheets[0];
    let rows;
    try{rows=await loadRawRows(fileIndex,sheetIndex)}catch(error){
      if(revision!==rawRenderRevision||state.module!=='raw'||fileIndex!==state.rawFile||sheetIndex!==state.rawSheet)return;
      $('#page').innerHTML=`<div class="empty-page" role="alert"><p>${esc(error.message)}</p><button type="button" data-raw-retry>重新加载底表</button></div>`;
      $('[data-raw-retry]').onclick=()=>renderRaw();return;
    }
    if(revision!==rawRenderRevision||state.module!=="raw"||fileIndex!==state.rawFile||sheetIndex!==state.rawSheet)return;
    // Commit export data only with the matching visible sheet. A stale async
    // read must not replace the current page's cache after its revision check.
    rawRowsCache=rows;rawRowsKey=`${fileIndex}|${sheetIndex}`;
    const visibleRows=visibleRawRows(rows,state.rawQuery);
    $("#page").innerHTML=`<div class="raw-layout"><label class="raw-file-picker"><span>选择底表文件</span><select id="rawFile" aria-label="选择底表文件">${DATA.raw_files.map((item,index)=>`<option value="${index}"${index===state.rawFile?" selected":""}>${esc(item.name)}</option>`).join("")}</select></label><aside class="file-list">${DATA.raw_files.map((item,index)=>`<button data-file="${index}" class="${index===state.rawFile?"active":""}" title="${esc(item.name)}">${esc(item.name)}</button>`).join("")}</aside><section class="raw-main"><div class="raw-toolbar"><div class="raw-title"><strong>${esc(file?.name||"")}</strong><small>${sheet?.total_rows||0} 行 × ${sheet?.total_cols||0} 列 · <span id="rawMatchCount" role="status" aria-live="polite">${Math.max(visibleRows.length-1,0)} 条数据（不含表头）</span> · 横向滚动查看其余列</small></div><label><span>Sheet</span><select id="rawSheet">${(file?.sheets||[]).map((item,index)=>`<option value="${index}">${esc(item.name)}</option>`).join("")}</select></label><label><span>表内搜索</span><input id="rawSearch" type="search" value="${esc(state.rawQuery)}" placeholder="在当前 Sheet 中搜索" aria-controls="rawTable" aria-describedby="rawMatchCount"></label><button type="button" id="clearRawSearch" ${state.rawQuery?"":"disabled"}>清空搜索</button><div class="raw-freeze-controls" role="group" aria-label="锁窗格"><label class="raw-freeze-toggle"><input id="rawFreezeRow" type="checkbox" ${state.rawFreezeRow?"checked":""}><span>锁定首行</span></label><label class="raw-freeze-toggle" title="只锁定第一列；与锁定标题列互斥"><input id="rawFreezeFirstColumn" type="checkbox" ${state.rawFreezeFirstColumn?"checked":""}><span>锁定首列</span></label><label class="raw-freeze-toggle" title="自动锁定左侧连续的文字标题列；与锁定首列互斥"><input id="rawFreezeColumn" type="checkbox" ${state.rawFreezeColumn?"checked":""}><span>锁定标题列</span></label></div><button class="export-button" id="exportRaw">导出当前数据</button><button type="button" class="export-button" id="exportRawWorkbook" ${file?.workbook_key?'':'disabled'} title="${file?.workbook_key?'导出该文件的全部 Sheet，保留原文件格式，不受搜索影响':'原始 Excel 文件不可用，请重新生成看板'}">导出整个 Excel</button></div><div class="raw-table ${state.rawFreezeRow?"freeze-row":""} ${state.rawFreezeColumn||state.rawFreezeFirstColumn?"freeze-column":""}" id="rawTable">${renderRawTable(visibleRows)}</div><div class="raw-empty" id="rawEmpty" ${visibleRows.length>1?"hidden":""}><strong>没有匹配的数据</strong><p>请尝试其他关键词，或清空搜索查看当前 Sheet。</p></div></section></div>`;
    document.querySelectorAll("[data-file]").forEach(button=>button.onclick=async()=>{state.rawFile=Number(button.dataset.file);state.rawSheet=0;state.rawQuery="";await renderRaw();syncUrl('push')});
    $("#rawFile").onchange=async event=>{state.rawFile=Number(event.target.value);state.rawSheet=0;state.rawQuery="";await renderRaw();syncUrl('push')};
    $("#rawSheet").value=state.rawSheet;$("#rawSheet").onchange=async event=>{state.rawSheet=Number(event.target.value);state.rawQuery="";await renderRaw();syncUrl('push')};
    applyRawFrozenColumns(visibleRows);
    const updateRawSearch=()=>{const filtered=visibleRawRows(rows,state.rawQuery);$("#rawTable").innerHTML=renderRawTable(filtered);$("#rawMatchCount").textContent=`${Math.max(filtered.length-1,0)} 条数据（不含表头）`;$("#rawEmpty").hidden=filtered.length>1;$("#clearRawSearch").disabled=!state.rawQuery;applyRawFrozenColumns(filtered)};
    $("#rawSearch").oninput=event=>{state.rawQuery=event.target.value;updateRawSearch();syncUrl('replace')};
    $("#clearRawSearch").onclick=()=>{state.rawQuery="";$("#rawSearch").value="";updateRawSearch();syncUrl('replace');$("#rawSearch").focus()};
    $("#rawFreezeRow").onchange=event=>{state.rawFreezeRow=event.target.checked;$("#rawTable").classList.toggle("freeze-row",state.rawFreezeRow)};
    $("#rawFreezeColumn").onchange=event=>{state.rawFreezeColumn=event.target.checked;if(state.rawFreezeColumn)state.rawFreezeFirstColumn=false;$("#rawFreezeFirstColumn").checked=state.rawFreezeFirstColumn;applyRawFrozenColumns(visibleRawRows(rows,state.rawQuery))};
    $("#rawFreezeFirstColumn").onchange=event=>{state.rawFreezeFirstColumn=event.target.checked;if(state.rawFreezeFirstColumn)state.rawFreezeColumn=false;$("#rawFreezeColumn").checked=state.rawFreezeColumn;applyRawFrozenColumns(visibleRawRows(rows,state.rawQuery))};
    $("#exportRaw").onclick=()=>exportRaw(file,sheet);
    $("#exportRawWorkbook").onclick=event=>exportRawWorkbook(file,event.currentTarget);
  }
  function filterRawRows(rows,query){const keyword=(query||"").trim().toLowerCase();return keyword?rows.filter(row=>row.some(value=>String(value??"").toLowerCase().includes(keyword))):rows}
  function rawCellIsData(value){
    if(typeof value==="number")return Number.isFinite(value);
    const text=String(value??"").trim();
    if(!text)return false;
    return /^(?:[¥￥$€£]\s*)?[-+]?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?%?$/.test(text)||/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+.*)?$/.test(text)||/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text);
  }
  function rawTableWidth(rows){return rows.reduce((width,row)=>Math.max(width,row.length),0)}
  function rawTitleColumnCount(rows){
    const width=rawTableWidth(rows),body=rows.slice(1,101);let count=0;
    for(let col=0;col<width;col+=1){
      const values=body.map(row=>row[col]).filter(value=>String(value??"").trim()!=="");
      if(!values.length){if(col===0&&width)count=1;break}
      if(values.filter(rawCellIsData).length/values.length>=.5)break;
      count+=1;
    }
    return count;
  }
  function applyRawFrozenColumns(rows){
    const root=$("#rawTable");if(!root)return;
    const revision=root._rawFreezeRevision=(root._rawFreezeRevision||0)+1;
    root.classList.toggle("freeze-column",state.rawFreezeColumn||state.rawFreezeFirstColumn);
    root.querySelectorAll(".raw-frozen-column,.raw-frozen-edge").forEach(cell=>{cell.classList.remove("raw-frozen-column","raw-frozen-edge");cell.style.removeProperty("left")});
    if(!state.rawFreezeColumn&&!state.rawFreezeFirstColumn)return;
    const count=state.rawFreezeFirstColumn?Math.min(1,rawTableWidth(rows)):rawTitleColumnCount(rows);if(!count)return;
    requestAnimationFrame(()=>{
      if(!root.isConnected||root!==$("#rawTable")||root._rawFreezeRevision!==revision)return;
      let left=0;
      for(let col=0;col<count;col+=1){
        const cells=[...root.querySelectorAll(`[data-raw-col="${col}"]`)],measure=cells[0];if(!measure)break;
        cells.forEach(cell=>{cell.classList.add("raw-frozen-column");cell.style.left=`${left}px`;if(col===count-1)cell.classList.add("raw-frozen-edge")});
        left+=measure.getBoundingClientRect().width;
      }
    });
  }
  function renderRawTable(rows){const width=rawTableWidth(rows);return `<table class="data-table"><tbody>${rows.map((row,index)=>`<tr>${Array.from({length:width},(_,col)=>{const cell=row[col]??"";const title=String(cell)!==""?` title="${esc(cell)}"`:"";return `<${index===0?"th":"td"} data-raw-col="${col}"${title}>${fmt(cell)}</${index===0?"th":"td"}>`}).join("")}</tr>`).join("")}</tbody></table>`}
  function exportRaw(file,sheet){
    const rows=visibleRawRows(rawRowsCache,state.rawQuery),csv="\ufeff"+rows.map(row=>row.map(csvCell).join(",")).join("\r\n"),blob=new Blob([csv],{type:"text/csv;charset=utf-8"}),base=(file?.name||"底表").replace(/\.xlsx?$/i,"").replace(/[\\/:*?\"<>|]/g,"_");
    downloadBlob(blob,`${base}_${(sheet?.name||"Sheet").replace(/[\\/:*?\"<>|]/g,"_")}.csv`);showToast(`已导出 ${rows.length} 行 CSV`);
  }
  async function exportRawWorkbook(file,button){
    button.disabled=true;button.textContent='正在导出…';
    try{
      const b64=RAW_BLOCKS[file?.workbook_key]||await getRawBlock(file?.workbook_key);
      if(!b64)throw new Error('整表文件不可用');
      // Yield before decoding so the loading state is painted. Chunking avoids
      // allocating another full-size binary string for a large workbook.
      await new Promise(resolve=>setTimeout(resolve,0));
      const chunks=[];
      for(let offset=0;offset<b64.length;offset+=65536){
        const binary=atob(b64.slice(offset,offset+65536)),bytes=new Uint8Array(binary.length);
        for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
        chunks.push(bytes);
        if(offset&&offset%4194304===0)await new Promise(resolve=>setTimeout(resolve,0));
      }
      const blob=new Blob(chunks,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      downloadBlob(blob,(file.name||'底表.xlsx').replace(/[\\/:*?\"<>|]/g,'_'));
      showToast('已导出整个 Excel，包含全部 Sheet');
    }catch(error){showToast('整表导出失败，请重新生成看板后重试')}
    finally{button.disabled=false;button.textContent='导出整个 Excel'}
  }
  function downloadBlob(blob,name){
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    try{link.href=url;link.download=name;document.body.appendChild(link);link.click()}
    finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),500)}
  }
  function csvCell(value){const text=String(value??"");return /[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text}
