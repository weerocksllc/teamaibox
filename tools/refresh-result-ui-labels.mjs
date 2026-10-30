// Presentation-only updates; do not rerender or overwrite editable result text.
import {readFile,writeFile} from 'node:fs/promises';
for(const name of ['ocr','asr','translation']){
 const file=`apps/${name}-plugin/src/public/app.js`;
 let source=await readFile(file,'utf8');
 source=source.replaceAll('.style.width=new Intl.NumberFormat(state.locale,{style:"percent",maximumFractionDigits:0}).format(percent/100)','.style.width=`${percent}%`');
 source=source.replace('row.className=`block block-${blockLabel(block.block_type||"text")}`','row.className=`block block-${block.block_type||"text"}`');
 const end='if(state.jobId&&$("#status").dataset.status)$("#status").textContent=t($("#status").dataset.status)';
 if(!source.includes('function refreshResultLabels()')){
  if(!source.includes(end))throw new Error(`Missing preference hook: ${name}`);
  source=source.replace(end,`${end};refreshResultLabels()`);
  source+=name==='ocr'?`
function refreshResultLabels(){
 if(state.jobId)$("#job-detail").textContent=t("jobDetail",{id:state.jobId.slice(0,8)});
 if(state.file)$("#file-size").textContent=new Intl.NumberFormat(state.locale,{style:"unit",unit:"megabyte",maximumFractionDigits:2}).format(state.file.size/1048576);
 const value=state.result;if(!value)return;
 presentGeometryCapability(value);
 document.querySelectorAll("#layout .page-card").forEach((card,index)=>{
  const page=value.pages[index];if(!page)return;
  card.querySelector("h3").textContent=t("page",{page:new Intl.NumberFormat(state.locale).format(page.page_number)});
  card.querySelectorAll(".block").forEach((row,blockIndex)=>{
   const block=page.blocks[blockIndex];if(!block)return;
   row.querySelector("code").textContent=block.id+" · "+blockLabel(block.block_type||"text");
   row.querySelector(".confidence").textContent=block.confidence==null?"—":new Intl.NumberFormat(state.locale,{style:"percent",maximumFractionDigits:0}).format(block.confidence)+" "+t("confidence");
  });
 });
 const provenance=value.extensions?.provenance||{};
 const items=[["provenanceModel",provenance.model_key],["provenanceProfile",provenance.profile_key],["provenanceSource",provenance.source_reference_id]].filter(([,v])=>v);
 document.querySelectorAll("#provenance span").forEach((el,index)=>{const item=items[index];if(item)el.textContent=t(item[0],{value:item[1]})});
}
` : name==='asr'?`
function refreshResultLabels(){
 const status=$("#status").dataset.status;
 if(status){$("#detail").textContent=TERMINAL.has(status)?t(status):t(status)+" · "+t("job",{id:state.jobId?.slice(0,8)||"—"});$("#percent").textContent=new Intl.NumberFormat(state.locale,{style:"percent",maximumFractionDigits:0}).format(parseFloat($("#progress").style.width)/100||0)}
 const value=state.result;if(!value)return;
 let language=value.language?.code||"—";try{language=new Intl.DisplayNames([state.locale],{type:"language"}).of(language)}catch{}
 $("#detected-language").textContent=t("detected",{value:language});
 $("#duration").textContent=t("duration",{value:new Intl.NumberFormat(state.locale,{style:"unit",unit:"second",maximumFractionDigits:1}).format(value.duration_seconds)});
 $("#speaker-summary").textContent=value.speaker_information?.supported?t("speakerSupported",{value:value.speaker_information.speaker_count??"—"}):t("speakerUnavailable");
 document.querySelectorAll("#segments .segment").forEach(row=>{row.querySelector("textarea").ariaLabel=t("segmentEditor",{time:row.querySelector("time").textContent})});
 const items=[["model",value.provenance?.profile_key],["source",value.provenance?.source_reference_id]].filter(([,v])=>v);
 document.querySelectorAll("#provenance span").forEach((el,index)=>{const item=items[index];if(item)el.textContent=t(item[0],{value:item[1]})});
}
` : `
function refreshResultLabels(){
 const status=$("#status").dataset.status;
 if(status){$("#detail").textContent=TERMINAL.has(status)?t(status):t(status)+" · "+(state.jobId?.slice(0,8)||"—");$("#percent").textContent=new Intl.NumberFormat(state.locale,{style:"percent",maximumFractionDigits:0}).format(parseFloat($("#progress-bar").style.width)/100||0)}
 if(state.file)$("#kind-badge").textContent=kindLabel(kind(state.file.type));
 const value=state.result;if(!value)return;
 $("#language-summary").textContent=t("language",{source:languageName(value.source_language),target:languageName(value.target_language)});
 $("#kind-summary").textContent=t("kind",{value:kindLabel(value.input_kind)});
 document.querySelectorAll("#workflow-stages span").forEach((el,index)=>{const stage=value.workflow.stages[index];if(stage)el.textContent=kindLabel(stage.capability)+" · "+t(stage.status==="succeeded"?"stageSuccess":stage.status==="failed"?"stageFailed":"stageSkipped")});
 const intermediate=(value.workflow.intermediates||[]).filter(item=>UUID.test(item.reference_id||""));
 document.querySelectorAll("#intermediates button").forEach((el,index)=>{if(intermediate[index])el.textContent=t("intermediateDownload",{kind:kindLabel(intermediate[index].kind)})});
 const items=[["sourceRef",value.provenance?.source_reference_id],["completed",value.provenance?.completed_at]].filter(([,v])=>v);
 document.querySelectorAll("#provenance span").forEach((el,index)=>{const item=items[index];if(item)el.textContent=t(item[0],{value:item[1]})});
}
`;
  // Apply formatting on the first result too, without translating its content.
  if(name==='ocr')source=source.replace('presentGeometryCapability(job.result)}}','presentGeometryCapability(job.result)}refreshResultLabels()}');
  else source=source.replace('if(status==="succeeded")result(job.result)}','if(status==="succeeded")result(job.result);refreshResultLabels()}');
 }
 await writeFile(file,source);
}
