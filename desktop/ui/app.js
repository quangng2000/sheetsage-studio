"use strict";

// The webview only talks to the local Rust host. No remote API or upload exists.
const $ = (id) => document.getElementById(id);
const COLORS = ["#81b7b0", "#bea96b", "#a8a0ca", "#b1c785", "#d49783"];
const state = {
  selectedAudio: null, result: null, runs: [], sample: null, busy: false,
  modelLoaded: false, modelInstalled: false, pythonAvailable: false,
  activeTab: "arrangement", analysis: null, waveform: null, audioGeneration: 0, jobId: null,
  scoreRendered: false, animationFrame: null, toastTimer: null, jobKind: null,
  completedJobIds: new Set(),
  playbackUrl: null, playbackMode: "empty", expectedDuration: null, mediaSrc: "",
};
const tauri = window.__TAURI__;
const invoke = (command, args) => {
  if (!tauri?.core?.invoke) return Promise.reject(new Error("Open SheetSage Studio as the desktop app to use the local model."));
  return tauri.core.invoke(command, args);
};
const audio = $("audio");
audio.volume = 0.8;
const workspace = window.ProducerWorkspace?.create({root: $("arrangement-root"), onSeek: seekTo});
const scoreFollow = window.ScoreFollow?.create({root: $("score-output"), button: $("follow-audio"), status: $("score-follow-status"), onSeek: seekTo});

function formatTime(seconds, fraction = false) {
  const value = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}${fraction ? `.${Math.floor((value % 1) * 10)}` : ""}`;
}
function number(value, fallback = "—") { return Number.isFinite(Number(value)) && value !== null ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 }) : fallback; }
function eventsFor(result) { return Array.isArray(result?.events) ? result.events : result?.events?.events || []; }
function pitchName(pitch) { const p = Number(pitch); return Number.isFinite(p) ? `${["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"][((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}` : "—"; }
function resultDuration() {
  if(state.analysis)return state.analysis.duration;
  return Number(state.result?.summary?.duration_seconds ?? state.result?.playback?.duration) || 0;
}
function melodyTracks() {
  return state.analysis ? [{name:"Vocal melody",notes:state.analysis.melody.vocal},{name:"Instrumental melody",notes:state.analysis.melody.instrumental}] : [];
}
function sameAudio(left, right) { return Boolean(left && right && left.path === right.path); }
function assetUrl(asset) { return asset?.url || (asset?.path && tauri?.core?.convertFileSrc ? tauri.core.convertFileSrc(asset.path) : ""); }
function setText(id, value) { $(id).textContent = value; }
function showError(error) {
  setText("error-message", typeof error === "string" ? error : error?.message || String(error));
  $("error-banner").hidden = false;
}
function toast(message) {
  clearTimeout(state.toastTimer); setText("toast", message); $("toast").hidden = false;
  state.toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
}
function updateControls() {
  $("choose-button").disabled = state.busy;
  $("sample-button").disabled = state.busy;
  $("empty-demo").disabled = state.busy;
  $("clip-duration").disabled = state.busy;
  $("transcribe-button").disabled = state.busy || !state.selectedAudio || !state.modelInstalled || !state.pythonAvailable;
  $("transcribe-button").hidden = state.busy;
  $("cancel-button").hidden = !state.busy;
  $("warm-button").disabled = state.busy || state.modelLoaded || !state.modelInstalled || !state.pythonAvailable;
  $("warm-button").textContent = state.modelLoaded ? "✓ Model is warm" : "◈ Warm model";
  $("model-light").className = `status-light${state.busy ? " working" : state.modelLoaded ? " ready" : ""}`;
  setText("model-status", state.busy ? "Model working" : state.modelLoaded ? "Model ready" : !state.pythonAvailable ? "Python unavailable" : !state.modelInstalled ? "Model not installed" : "Model on disk");
  for (const id of ["export-midi", "export-abc", "export-events", "open-output"]) $(id).disabled = !state.result;
  if ($("export-artifact")) $("export-artifact").disabled = !state.result || !$("artifact-select")?.options.length;
  if ($("artifact-select")) $("artifact-select").disabled = !state.result;
  for (const button of $("run-history").querySelectorAll("button")) button.disabled = state.busy;
}
function beginJob(title, detail, kind = "transcribe") {
  state.busy = true; state.jobId = null; state.jobKind = kind;
  $("error-banner").hidden = true;
  setText("job-title", title); setText("job-detail", detail); setText("job-stage", "PREPARING");
  $("job-panel").hidden = false; updateControls();
}
function finishJob() {
  state.busy = false; state.jobId = null; state.jobKind = null; $("job-panel").hidden = true; updateControls();
}

async function setAudio(asset) {
  const generation = ++state.audioGeneration;
  state.selectedAudio = asset; state.waveform = null;
  workspace?.setWaveform(null, 0);
  audio.pause(); audio.removeAttribute("src"); audio.load();
  releasePlaybackPreview();state.playbackMode=asset?"checking":"empty";state.expectedDuration=null;state.mediaSrc="";
  $("seek").value = 0; $("seek").disabled = true; $("play-button").disabled = true;
  setText("play-time", "0:00"); setText("total-time", "0:00");
  setText("audio-name", asset?.name || "Choose a recording");
  setText("audio-detail", asset ? "Local recording · Ready for playback" : "MP3, WAV, FLAC, M4A, and other supported audio");
  $("waveform-empty").hidden = false;
  $("waveform-empty").lastChild.textContent = asset ? "Reading audio waveform…" : "Choose audio or explore the demo";
  drawWaveform(); updateControls();
  if (!asset) return;
  const url = assetUrl(asset);
  if (!url) { showError("The desktop host did not provide a playable audio URL."); return; }
  audio.src = url; state.mediaSrc=audio.src; audio.load();
  let context;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Audio waveform could not be read (${response.status}).`);
    const declaredSize = Number(response.headers.get("Content-Length"));
    if (declaredSize > 100 * 1024 * 1024) throw new Error("Waveform preview is limited to recordings under 100 MB. Playback is still available.");
    const bytes = await response.arrayBuffer();
    if (generation !== state.audioGeneration) return;
    if (bytes.byteLength > 100 * 1024 * 1024) throw new Error("Waveform preview is limited to recordings under 100 MB. Playback is still available.");
    context = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await context.decodeAudioData(bytes);
    if (generation !== state.audioGeneration) return;
    state.expectedDuration=decoded.duration;
    if(window.AudioPreview.needsCompatibilityPreview(audio.duration,decoded.duration)) {
      // Some DASH/AAC containers expose the wrong media clock in WKWebView.
      // A bounded PCM preview fixes playback without changing inference input.
      try {
        const wav=window.AudioPreview.encodePCM16(decoded);
        const preview=URL.createObjectURL(new Blob([wav],{type:"audio/wav"}));
        state.playbackUrl=preview;state.playbackMode="preview";
        audio.pause();audio.src=preview;state.mediaSrc=audio.src;audio.load();
      } catch(error) {
        state.playbackMode="unsupported";
        showError(`Playback timing is unsupported for this recording. Analysis remains available. ${error.message||error}`);
      }
    } else state.playbackMode="original";
    const data = decoded.getChannelData(0);
    const buckets = 1600;
    const peaks = new Float32Array(buckets);
    const samplesPerBucket = Math.max(1, Math.floor(data.length / buckets));
    for (let i = 0; i < buckets; i++) {
      let peak = 0;
      const end = Math.min(data.length, (i + 1) * samplesPerBucket);
      // At most ~250 amplitude samples per bucket keeps long recordings responsive.
      const stride = Math.max(1, Math.floor(samplesPerBucket / 250));
      for (let j = i * samplesPerBucket; j < end; j += stride) peak = Math.max(peak, Math.abs(data[j]));
      peaks[i] = peak;
    }
    state.waveform = peaks; $("waveform-empty").hidden = true; drawWaveform();
    workspace?.setWaveform(peaks, decoded.duration);
    refreshMediaControls();
  } catch (error) {
    if (generation === state.audioGeneration) {
      $("waveform-empty").lastChild.textContent = "Waveform unavailable · Use the playback controls below";
      console.info("Waveform preview:", error);
      if(state.playbackMode==="checking"){
        state.playbackMode=audio.error?"unsupported":"original";
        if(audio.error)showError("This recording cannot be played in the desktop player. Analysis and inspection remain available.");
      }
      refreshMediaControls();
    }
  } finally { if (context) await context.close().catch(() => {}); }
}

function releasePlaybackPreview(){
  if(state.playbackUrl)URL.revokeObjectURL(state.playbackUrl);
  state.playbackUrl=null;
}
function refreshMediaControls(){
  if(audio.currentSrc&&state.mediaSrc&&audio.currentSrc!==state.mediaSrc)return;
  const hasMetadata=audio.readyState>=1&&Number.isFinite(audio.duration)&&audio.duration>0;
  if(hasMetadata&&["original","preview"].includes(state.playbackMode)&&state.expectedDuration!==null&&window.AudioPreview.needsCompatibilityPreview(audio.duration,state.expectedDuration)){
    state.playbackMode="unsupported";audio.pause();
    showError("The compatible preview still has an invalid playback clock. Analysis remains available; playback is disabled.");
  }
  const ready=hasMetadata&&["original","preview"].includes(state.playbackMode);
  $("play-button").disabled=!ready;$("seek").disabled=!ready;
  if(ready){
    setText("total-time",formatTime(audio.duration));
    setText("audio-detail",`${formatTime(audio.duration)} recording · ${state.playbackMode==="preview"?"Compatible PCM playback · Original used for analysis":"Local audio"}`);
    updatePlayback();
  }else if(state.playbackMode==="unsupported")setText("audio-detail","Playback timing unsupported · Analysis and inspection remain available");
}
window.addEventListener("beforeunload",releasePlaybackPreview);

function canvasContext(id) {
  const canvas = $(id), rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (!rect.width || !rect.height) return null;
  const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return {ctx, width:rect.width, height:rect.height};
}
function drawWaveform() {
  const surface = canvasContext("waveform"); if (!surface) return;
  const {ctx,width,height} = surface;
  ctx.strokeStyle = "#343d47"; ctx.lineWidth = .5;
  ctx.beginPath(); ctx.moveTo(0,height/2); ctx.lineTo(width,height/2); ctx.stroke();
  if (!state.waveform) return;
  const fraction = audio.duration ? audio.currentTime / audio.duration : 0;
  const bars = Math.floor(width / 3.5), barWidth = 1.6;
  for (let i = 0; i < bars; i++) {
    const start = Math.floor(i / bars * state.waveform.length), end = Math.max(start+1,Math.floor((i+1)/bars*state.waveform.length));
    let peak = 0; for (let j=start;j<end;j++) peak=Math.max(peak,state.waveform[j]||0);
    const h = Math.max(2, Math.pow(peak,.7) * (height - 16));
    ctx.fillStyle = i / bars <= fraction ? "#dfc48d" : "#739b98";
    ctx.fillRect(i*3.5, (height-h)/2, barWidth,h);
  }
  if (fraction>0) {ctx.strokeStyle="#e0cc9a";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(fraction*width,5);ctx.lineTo(fraction*width,height-5);ctx.stroke();}
}
function drawPianoRoll() {
  const surface=canvasContext("piano-roll"); if(!surface || !state.result)return;
  const {ctx,width,height}=surface;
  // Draw raw decoder melody, never synthesized chord voicings from playback MIDI.
  const tracks=melodyTracks(), notes=tracks.flatMap(t=>t.notes || []), duration=resultDuration();
  const left=52,right=16,top=13,bottom=24,plotWidth=width-left-right,plotHeight=height-top-bottom;
  if(!notes.length || !duration) {ctx.fillStyle="#8fa793";ctx.font="11px -apple-system, sans-serif";ctx.fillText("No melody notes were found in this recording.",left,50);return;}
  const pitches=notes.map(n=>Number(n.pitch)).filter(Number.isFinite);
  let low=Math.max(0,Math.min(...pitches)-2), high=Math.min(127,Math.max(...pitches)+2);
  if(high-low<12){const center=(low+high)/2;low=Math.max(0,Math.floor(center-7));high=Math.min(127,low+14);}
  const rows=high-low+1,rowHeight=plotHeight/rows;
  for(let pitch=low;pitch<=high;pitch++) {
    const y=top+(high-pitch)*rowHeight;
    ctx.fillStyle=[1,3,6,8,10].includes(pitch%12)?"#151a21":"#1b222b";ctx.fillRect(left,y,plotWidth,rowHeight);
    ctx.strokeStyle="#2c3540";ctx.lineWidth=.5;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(width-right,y);ctx.stroke();
    ctx.fillStyle=[1,3,6,8,10].includes(pitch%12)?"#17202a":"#283442";ctx.fillRect(0,y,left-1,rowHeight-1);
    if(pitch%12===0 || (rows<18&&rowHeight>=13)){ctx.fillStyle=pitch%12===0?"#b3becd":"#81909f";ctx.font="11px -apple-system, sans-serif";ctx.textAlign="right";ctx.fillText(pitchName(pitch),left-10,y+rowHeight/2+3);}
  }
  const step=duration<=25?2:duration<=60?5:duration<=180?15:60;
  for(let t=0;t<=duration;t+=step){const x=left+t/duration*plotWidth;ctx.strokeStyle="#35404d";ctx.lineWidth=.5;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,height-bottom);ctx.stroke();ctx.fillStyle="#8b9bab";ctx.font="11px -apple-system, sans-serif";ctx.textAlign="center";ctx.fillText(formatTime(t),x,height-8);}
  tracks.forEach((track,index)=>(track.notes||[]).forEach(note=>{
    const start=Math.max(0,Number(note.start)||0),end=Math.min(duration,Number(note.end)||0),pitch=Number(note.pitch);
    if(end<=start || !Number.isFinite(pitch))return;
    const x=left+start/duration*plotWidth,y=top+(high-pitch)*rowHeight+1,w=Math.max(2,(end-start)/duration*plotWidth-1),h=Math.max(2,rowHeight-2);
    ctx.fillStyle=COLORS[index%COLORS.length];ctx.globalAlpha=audio.currentTime>=start&&audio.currentTime<end&&!audio.paused?1:.78;
    ctx.beginPath();if(ctx.roundRect)ctx.roundRect(x,y,w,h,Math.min(2,h/3));else ctx.rect(x,y,w,h);ctx.fill();ctx.globalAlpha=1;
    if(w>35&&h>=13){ctx.fillStyle="#1a282b";ctx.font="11px -apple-system, sans-serif";ctx.textAlign="left";ctx.fillText(pitchName(pitch),x+4,y+h/2+3.5);}
  }));
  if(audio.currentTime<=duration){const x=left+audio.currentTime/duration*plotWidth;ctx.fillStyle="#e9e1c4";ctx.fillRect(x,top,1,plotHeight);ctx.beginPath();ctx.moveTo(x-3,0);ctx.lineTo(x+3,0);ctx.lineTo(x,5);ctx.fill();}
}
function renderChords() {
  const lane=$("chord-blocks");lane.replaceChildren();
  const duration=resultDuration();if(!duration)return;
  const chords=[];
  for(const event of eventsFor(state.result)) {
    const chord=event.values?.chord??event.chord,time=Number(event.time??event.values?.timestamp);
    if(chord && Number.isFinite(time) && time<duration && chords.at(-1)?.name!==chord)chords.push({name:String(chord),time:Math.max(0,time)});
  }
  chords.forEach((chord,index)=>{
    const block=document.createElement("div");block.className="chord-block";block.textContent=chord.name.replace(":min","m").replace(":maj","");
    block.style.left=`${chord.time/duration*100}%`;block.style.width=`${((chords[index+1]?.time??duration)-chord.time)/duration*100}%`;
    block.title=`${chord.name} · ${formatTime(chord.time,true)}`;lane.append(block);
  });
}
function renderEvents() {
  const body=$("events-body");body.replaceChildren();const events=eventsFor(state.result);
  setText("event-count",`${events.length} musical events`);
  const fragment=document.createDocumentFragment();
  for(const event of events) {
    const values=event.values||event,time=Number(event.time??values.timestamp),row=document.createElement("tr");
    if(!Number.isFinite(time)||time<0)continue;
    const context=state.analysis&&window.MusicAnalysis.atTime(state.analysis,time);
    const beat=state.analysis?.beats.find(b=>Math.abs(b.time-time)<0.000001);
    const melody=Array.isArray(values.melody)?values.melody.map(n=>`${pitchName(n.pitch)} (${n.track===0?"vocal":n.track===1?"instrumental":"unknown track"})`).join(" · "):"—";
    for(const value of [formatTime(time,true),beat?.position??"—",context?.meter?.label??"—",beat?.downbeat?"Downbeat":"—",context?.tempo?`${number(context.tempo.bpm)} BPM`:"—",values.chord||"—",values.key||"—",values.structure||"—",melody||"—"]){const td=document.createElement("td");td.textContent=String(value);row.append(td);}
    const details=document.createElement("details"),label=document.createElement("summary"),source=document.createElement("pre");
    details.className="raw-event";label.textContent="Raw event";source.textContent=JSON.stringify(event,null,2);details.append(label,source);row.lastChild.append(details);
    row.tabIndex=0;row.setAttribute("aria-label",`Seek to ${formatTime(time,true)}`);row.addEventListener("click",e=>{if(!e.target.closest("details"))seekTo(time);});row.addEventListener("keydown",e=>{if(e.target===row&&(e.key==="Enter"||e.key===" ")){e.preventDefault();seekTo(time);}});fragment.append(row);
  }
  body.append(fragment);
}
function renderStats() {
  const summary=state.result?.summary||{}, playback=state.result?.playback||{}, statContainer=$("stats");statContainer.replaceChildren();
  const notes=(playback.tracks||[]).reduce((n,t)=>n+(t.notes?.length||0),0);
  const stats=[
    ["Analyzed audio",resultDuration()?number(resultDuration()):"—","sec"],
    ["Melody notes",summary.melody_notes!==undefined?number(summary.melody_notes):number(notes),"notes"],
    ["Musical events",summary.events!==undefined?number(summary.events):number(eventsFor(state.result).length),"events"],
    ["Score length",summary.abc_measures!==undefined?number(summary.abc_measures):"—","measures"],
    ["Inference time",summary.elapsed_seconds!==undefined?number(summary.elapsed_seconds):"—","sec"],
  ];
  for(const [label,value,unit] of stats){const el=document.createElement("div");el.className="stat";const name=document.createElement("span");name.className="stat-label";name.textContent=label;const val=document.createElement("span");val.className="stat-value";val.textContent=value;const u=document.createElement("span");u.className="stat-unit";u.textContent=unit;el.append(name,val,u);statContainer.append(el);}
  statContainer.hidden=!state.result;
}
function renderScore() {
  if(state.scoreRendered || !state.result)return;
  const output=$("score-output");output.replaceChildren();setText("abc-source",state.result.abc||"No ABC notation was produced.");
  if(!state.result.abc || !window.ABCJS?.renderAbc){const p=document.createElement("p");p.className="score-message";p.textContent=!state.result.abc?"This run did not produce sheet music. Explore the piano roll or events instead.":"The local notation renderer is unavailable. You can view or export the ABC source.";output.append(p);return;}
  try {
    // abcjs gives its responsive parent a percentage padding-bottom. Keep that
    // sizing surface inside, not on, the bounded scrolling viewport.
    const engraving=document.createElement("div");engraving.className="score-engraving";output.append(engraving);
    const tunes=window.ABCJS.renderAbc(engraving,state.result.abc,{responsive:"resize",oneSvgPerLine:false,paddingtop:12,paddingbottom:16,paddingleft:5,paddingright:5,foregroundColor:"#263228",selectionColor:"#a47737",add_classes:true});
    state.scoreRendered=true;scoreFollow?.attach(state.result,tunes[0]);
  }
  catch(error){const p=document.createElement("p");p.className="score-message";p.textContent="This notation could not be engraved. Its ABC source is still available below.";output.replaceChildren(p);console.warn(error);}
}
function selectTab(tab) {
  state.activeTab=tab;
  for(const button of document.querySelectorAll("[data-tab]")){const active=button.dataset.tab===tab;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1;}
  for(const name of ["arrangement","roll","score","events"]){const panel=$(`panel-${name}`);if(panel)panel.hidden=name!==tab;}
  if(tab==="score")renderScore();if(tab==="roll")drawPianoRoll();
  if(tab==="arrangement")workspace?.resize();
  updatePlayback();
}
function renderResult(result) {
  state.result=result;state.scoreRendered=false;state.analysis=result&&window.MusicAnalysis?window.MusicAnalysis.analyze(result):null;
  scoreFollow?.reset();
  workspace?.setResult(result);
  $("empty-result").hidden=Boolean(result);$("result-panels").hidden=!result;$("stats").hidden=!result;
  setText("result-state",result?"Transcribed locally":"Ready to explore");
  $("track-legend").replaceChildren();
  if(result){
    melodyTracks().forEach((track,index)=>{const item=document.createElement("span");item.className="legend-item";const swatch=document.createElement("span");swatch.className="legend-swatch";swatch.style.backgroundColor=COLORS[index%COLORS.length];item.append(swatch,document.createTextNode(track.name));$("track-legend").append(item);});
    const keys=state.analysis?.keys.map(region=>region.label)??[],meters=state.analysis?.meters.map(region=>region.label)??[];
    const sequence=(labels)=>labels.length>4?`${labels[0]} · ${labels.length} regions (see Arrangement)`:labels.join(" → ")||"Not predicted";
    setText("key-label",`KEY ${sequence(keys.map(key=>key.replace(":minor"," minor").replace(":major"," major")))}`);
    setText("meter-label",`METER ${sequence(meters)}`);
    setText("roll-duration",`${formatTime(resultDuration())} ANALYZED`);
    const elapsed=result.summary?.elapsed_seconds;
    setText("footer-status",elapsed!==undefined?`SheetSage2 · ${number(elapsed)} sec inference · ${result.summary?.dtype||"local"}`:"SheetSage2 · Local transcription");
    renderChords();renderEvents();renderStats();renderArtifactOptions();selectTab(state.activeTab);
    const warnings=[...(result.summary?.warnings||[]),...(result.summary?.abc_error?[result.summary.abc_error]:[])];
    if(warnings.length)showError(`Model note: ${warnings.join(" · ")}`);
  }else{setText("footer-status","SheetSage2 · Music understanding, on your machine");renderArtifactOptions();}
  renderHistory();updateControls();
}
function renderHistory() {
  const history=$("run-history");history.replaceChildren();setText("run-count",String(state.runs.length));
  if(!state.runs.length){const p=document.createElement("p");p.className="sidebar-empty";p.textContent="Your transcriptions will appear here.";history.append(p);return;}
  for(const run of state.runs){const button=document.createElement("button");button.className=`history-item${state.result?.run_id===run.id?" active":""}`;button.disabled=state.busy;const icon=document.createElement("span");icon.className="history-note";icon.textContent="♫";const text=document.createElement("span");text.className="history-text";const name=document.createElement("span");name.className="history-name";name.textContent=run.name||run.id;const meta=document.createElement("span");meta.className="history-meta";const date=new Date(run.created_at);meta.textContent=`${formatTime(run.duration_seconds)} · ${Number.isNaN(date.getTime())?"Saved session":date.toLocaleDateString(undefined,{month:"short",day:"numeric"})}`;text.append(name,meta);button.append(icon,text);if(state.result?.run_id===run.id){const dot=document.createElement("span");dot.className="history-dot";button.append(dot);}button.addEventListener("click",()=>loadRun(run.id));history.append(button);}
}
async function loadRun(runId){if(state.busy)return;try{const result=await invoke("get_run",{runId});$("error-banner").hidden=true;renderResult(result);await setAudio({path:result.audio_path,name:result.audio_name||result.summary?.audio||runId,...(state.sample?.path===result.audio_path?{url:state.sample.url}:{})});}catch(error){showError(error);}}
async function chooseAudio(){try{const asset=await invoke("pick_audio");if(asset){$("error-banner").hidden=true;renderResult(null);await setAudio(asset);}}catch(error){showError(error);}}
async function selectSample(){if(state.busy)return;try{const sample=await invoke("select_sample");state.sample=sample;const saved=state.runs.find(run=>run.name===sample.name);if(saved){const result=await invoke("get_run",{runId:saved.id});if(result.audio_path===sample.path){$("error-banner").hidden=true;renderResult(result);await setAudio(sample);return;}}$("error-banner").hidden=true;renderResult(null);await setAudio(sample);}catch(error){showError(error);}}
function seekTo(time){if(!Number.isFinite(audio.duration))return;audio.currentTime=Math.max(0,Math.min(audio.duration,time));updatePlayback();}
function updatePlayback(){setText("play-time",formatTime(audio.currentTime));$("seek").value=audio.duration?Math.round(audio.currentTime/audio.duration*1000):0;$("play-button").textContent=audio.paused?"▶":"Ⅱ";$("play-button").setAttribute("aria-label",audio.paused?"Play audio":"Pause audio");workspace?.setPlayback(audio.currentTime,!audio.paused);scoreFollow?.setPlayback(audio.currentTime,!audio.paused,state.activeTab==="score");drawWaveform();if(state.activeTab==="roll")drawPianoRoll();}
function animate(){updatePlayback();if(!audio.paused)state.animationFrame=requestAnimationFrame(animate);}
function timelineSeek(event,kind){const rect=event.currentTarget.getBoundingClientRect();let x=event.clientX-rect.left,width=rect.width,duration=audio.duration;if(kind==="roll"){x-=52;width-=68;duration=resultDuration();}if(x>=0&&x<=width&&Number.isFinite(duration))seekTo(x/width*duration);}

$("choose-button").addEventListener("click",chooseAudio);
$("sample-button").addEventListener("click",selectSample);
$("empty-demo").addEventListener("click",selectSample);
$("dismiss-error").addEventListener("click",()=>{$("error-banner").hidden=true;});
$("workspace-button").addEventListener("click",()=>{$("audio-name").scrollIntoView({behavior:"smooth",block:"center"});});
$("play-button").addEventListener("click",async()=>{try{if(audio.paused)await audio.play();else audio.pause();}catch(error){showError(error);}});
$("seek").addEventListener("input",()=>seekTo(Number($("seek").value)/1000*audio.duration));
$("volume").addEventListener("input",()=>{audio.volume=Number($("volume").value);});
$("waveform").addEventListener("click",e=>timelineSeek(e,"waveform"));
$("piano-roll").addEventListener("click",e=>timelineSeek(e,"roll"));
audio.addEventListener("loadedmetadata",refreshMediaControls);
audio.addEventListener("durationchange",refreshMediaControls);
audio.addEventListener("play",()=>{cancelAnimationFrame(state.animationFrame);animate();});
audio.addEventListener("pause",()=>{cancelAnimationFrame(state.animationFrame);updatePlayback();});
audio.addEventListener("timeupdate",()=>{if(audio.paused)updatePlayback();});
audio.addEventListener("ended",updatePlayback);
audio.addEventListener("error",()=>{
  if(!state.selectedAudio||!state.mediaSrc||!audio.error||state.playbackMode==="checking")return;
  if(audio.currentSrc&&audio.currentSrc!==state.mediaSrc)return;
  state.playbackMode="unsupported";refreshMediaControls();showError("This recording cannot be played in the desktop audio player. Analysis and inspection are still available.");
});
for(const tab of document.querySelectorAll("[data-tab]")){tab.addEventListener("click",()=>selectTab(tab.dataset.tab));tab.addEventListener("keydown",event=>{if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key)){event.preventDefault();const tabs=[...document.querySelectorAll("[data-tab]")].map(button=>button.dataset.tab),index=tabs.indexOf(state.activeTab);const next=event.key==="Home"?0:event.key==="End"?tabs.length-1:(index+(event.key==="ArrowRight"?1:tabs.length-1))%tabs.length;selectTab(tabs[next]);$(`tab-${tabs[next]}`).focus();}});}
$("toggle-abc").addEventListener("click",()=>{$("abc-source").hidden=!$("abc-source").hidden;setText("toggle-abc",$("abc-source").hidden?"Show ABC source":"Hide ABC source");});
$("transcribe-button").addEventListener("click",async()=>{if(state.busy||!state.selectedAudio)return;beginJob("Starting transcription","Preparing your recording. The first run also loads model weights.");try{const job=await invoke("start_transcription",{audioPath:state.selectedAudio.path,audioName:state.selectedAudio.name,maxSeconds:Number($("clip-duration").value)});if(state.busy)state.jobId=job.id;}catch(error){finishJob();showError(error);}});
$("warm-button").addEventListener("click",async()=>{beginJob("Warming the local model","Loading model weights into memory for faster subsequent runs.","warm");try{const job=await invoke("warm_model");if(state.busy)state.jobId=job.id;}catch(error){finishJob();showError(error);}});
$("cancel-button").addEventListener("click",async()=>{try{$("cancel-button").disabled=true;await invoke("cancel_job");setText("job-detail","Cancellation requested. Waiting for the local worker to stop…");}catch(error){showError(error);}finally{$("cancel-button").disabled=false;}});
for(const [id,artifact] of [["export-midi","midi"],["export-abc","abc"],["export-events","events"]])$(id).addEventListener("click",async()=>{if(!state.result)return;try{const path=await invoke("export_artifact",{runId:state.result.run_id,artifact});if(path)toast(`Saved ${artifact.toUpperCase()} to ${path}`);}catch(error){showError(error);}});
function renderArtifactOptions(){
  const select=$("artifact-select");if(!select)return;const previous=select.value;select.replaceChildren();
  const artifacts=state.result?.available_artifacts??(state.result?[{id:"events",label:"Musical events",filename:"events.json"},{id:"midi",label:"Combined MIDI",filename:"transcription.mid"},...(state.result.abc?[{id:"abc",label:"Sheet music",filename:"score.abc"}]:[])]:[]);
  for(const artifact of artifacts){const option=document.createElement("option");option.value=artifact.id;option.textContent=`${artifact.label} · ${artifact.filename}`;select.append(option);}
  if([...select.options].some(option=>option.value===previous))select.value=previous;
}
$("export-artifact")?.addEventListener("click",async()=>{if(!state.result||!$("artifact-select")?.value)return;try{const path=await invoke("export_artifact",{runId:state.result.run_id,artifact:$("artifact-select").value});if(path)toast(`Saved analysis export to ${path}`);}catch(error){showError(error);}});
$("open-output").addEventListener("click",async()=>{if(state.result)try{await invoke("open_output",{runId:state.result.run_id});}catch(error){showError(error);}});

function completeJob(id){
  const completedId=id??state.jobId;
  if(completedId!==null&&completedId!==undefined){
    state.completedJobIds.add(completedId);
    if(state.completedJobIds.size>1000)state.completedJobIds.delete(state.completedJobIds.values().next().value);
  }
  finishJob();
}
function handleModelEvent(event){
  const data=event.payload||event;
  if(data.type==="connected")return;
  if(data.id!==null&&data.id!==undefined&&state.completedJobIds.has(data.id))return;
  if(typeof data.model_loaded==="boolean")state.modelLoaded=data.model_loaded;
  // Events can arrive before the invoke promise returns its job ID. Bind the
  // first event immediately so later events cannot cross between two jobs.
  if(state.busy&&!state.jobId&&data.id!==null&&data.id!==undefined)state.jobId=data.id;
  if(state.jobId&&data.id&&data.id!==state.jobId)return;
  if(typeof data.model_loaded==="boolean")state.modelLoaded=data.model_loaded;
  if(data.type==="status"){
    if(data.message)setText("job-detail",data.message);
    if(data.state)setText("job-stage",String(data.state).replaceAll("_"," ").toUpperCase());
    if(["ready","idle","warmed","model_ready"].includes(data.state)){const wasWarming=state.busy&&state.jobKind==="warm";completeJob(data.id);if(state.modelLoaded&&wasWarming)toast("Model is warm and ready.");}
    updateControls();
  }else if(data.type==="progress"){
    const stage=String(data.stage||"processing");setText("job-stage",stage.replaceAll("_"," ").toUpperCase());
    const detail=[];if(data.window!==undefined)detail.push(`Window ${data.window}${data.windows?` of ${data.windows}`:""}`);if(data.tokens!==undefined)detail.push(`${number(data.tokens)} tokens generated`);
    setText("job-title",stage.includes("load")?"Loading model":stage.includes("export")?"Preparing your score":"Listening and transcribing");
    setText("job-detail",data.message|| (detail.length?detail.join(" · "):stage.replaceAll("_"," ")));
  }else if(data.type==="result"){
    completeJob(data.id);const result=data.result;renderResult(result);
    const record={id:result.run_id,name:result.audio_name||result.summary?.audio||"Recording",created_at:new Date().toISOString(),duration_seconds:resultDuration(),elapsed_seconds:result.summary?.elapsed_seconds};
    state.runs=[record,...state.runs.filter(r=>r.id!==record.id)];renderHistory();toast("Transcription complete. Your score is ready.");
  }else if(data.type==="error"){completeJob(data.id);showError(data.message||"The local model could not complete this run.");}
  else if(data.type==="cancelled"){completeJob(data.id);toast("Transcription cancelled.");}
}

const resizeObserver=new ResizeObserver(()=>{drawWaveform();if(state.activeTab==="roll")drawPianoRoll();if(state.activeTab==="arrangement")workspace?.resize();});
resizeObserver.observe($("waveform"));resizeObserver.observe($("piano-roll"));
const scoreResizeObserver=new ResizeObserver(()=>{if(state.activeTab==="score")scoreFollow?.resize();});
scoreResizeObserver.observe($("score-output"));
async function boot(){
  updateControls();
  try{
    if(tauri?.event?.listen)await tauri.event.listen("model-event",handleModelEvent);
    const initial=await invoke("get_initial_state");state.sample=initial.sample;state.runs=initial.runs||[];state.modelLoaded=Boolean(initial.model_loaded);state.modelInstalled=Boolean(initial.model_installed);state.pythonAvailable=Boolean(initial.python_available);state.busy=Boolean(initial.busy);
    if(initial.latest_result){renderResult(initial.latest_result);const result=initial.latest_result;await setAudio({path:result.audio_path,name:result.audio_name||result.summary?.audio||"Recording",...(initial.sample?.path===result.audio_path?{url:initial.sample.url}:{})});}
    else{renderResult(null);if(initial.sample)await setAudio(initial.sample);}
    if(state.busy){$("job-panel").hidden=false;setText("job-title","Local model is working");setText("job-detail","Waiting for the next progress update…");}
    updateControls();
  }catch(error){showError(error);setText("model-status","Desktop host unavailable");}
}
boot();
