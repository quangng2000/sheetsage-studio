/* Native-webview arrangement view. Musical interpretation lives in
 * music-analysis.js; this module only displays its time-aligned predictions. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ProducerWorkspace = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const noteNames = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const number = (value, places = 1) => Number.isFinite(value) ? Number(value.toFixed(places)).toString() : "—";
  const pitchName = (pitch) => Number.isInteger(pitch) ? `${noteNames[pitch % 12]}${Math.floor(pitch / 12) - 1}` : "—";
  const cleanLabel = (label) => String(label ?? "—")
    .replace(/:minor/g, " minor").replace(/:major/g, " major")
    .replace(/:min/g, "m").replace(/:maj(?=\d)/g, "maj").replace(/:maj\b/g, "")
    .replace(/:/g, "").replace(/#/g, "♯").replace(/(^|\/)([A-G])b/g, "$1$2♭");
  function timeLabel(time, precise = false) {
    if (!Number.isFinite(time)) return "—";
    const safe = Math.max(0, time), minutes = Math.floor(safe / 60);
    const seconds = precise ? (safe % 60).toFixed(2).padStart(5, "0") : Math.floor(safe % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function create({root, onSeek}) {
    if (!root) throw new Error("ProducerWorkspace requires a root element.");
    const analysis = globalThis.MusicAnalysis;
    if (!analysis) throw new Error("Load music-analysis.js before workspace-view.js.");
    let report = null, result = null, peaks = null, audioDuration = 0;
    let currentTime = 0, playing = false, zoom = 1, plotWidth = 0, labelWidth = 122;
    let selection = null, previousInspector = "", previousActive = "";
    let marks = [], noteMarks = [], beatMarks = [], tracks = [], waveform = null, renderFrame = null;

    root.classList.add("producer-workspace");
    const toolbar = node("div", "ws-toolbar"), range = node("div", "ws-range");
    const zoomGroup = node("div", "ws-zoom"), zoomButtons = [];
    zoomGroup.setAttribute("role", "group"); zoomGroup.setAttribute("aria-label", "Timeline zoom");
    zoomGroup.append(node("span", "", "ZOOM"));
    [1, 2, 4, 8].forEach((amount) => {
      const button = node("button", "", amount === 1 ? "Fit" : `${amount}×`);
      button.type = "button"; button.setAttribute("aria-label", amount === 1 ? "Fit analyzed excerpt" : `Zoom timeline ${amount} times`);
      button.setAttribute("aria-pressed", String(amount === 1));
      button.addEventListener("click", () => {
        const fraction = scroll.scrollWidth > scroll.clientWidth ? scroll.scrollLeft / (scroll.scrollWidth - scroll.clientWidth) : 0;
        zoom = amount; zoomButtons.forEach(([value, control]) => control.setAttribute("aria-pressed", String(value === amount)));
        renderTimeline(); scroll.scrollLeft = fraction * Math.max(0, scroll.scrollWidth - scroll.clientWidth);
      });
      zoomButtons.push([amount, button]); zoomGroup.append(button);
    });
    toolbar.append(range, zoomGroup);
    const main = node("div", "ws-main"), arranger = node("div", "ws-arranger");
    const position = node("div", "ws-position"), positionValues = {};
    [["time", "PLAYHEAD", ""], ["bbt", "BAR · BEAT", "bbt-block"], ["tempo", "♩ BPM · DERIVED", ""], ["meter", "METER", ""], ["section", "SECTION", "current-section"]].forEach(([id, title, className]) => {
      const block = node("div", `ws-position-block ${className}`);
      const value = node("span", "ws-position-value", "—"); block.append(node("span", "ws-position-label", title), value);
      positionValues[id] = value; position.append(block);
    });
    const outside = node("span", "ws-outside", "Outside analyzed range"); outside.hidden = true; position.append(outside);
    const scroll = node("div", "ws-scroll"), timeline = node("div", "ws-timeline");
    scroll.setAttribute("aria-label", "Musical arrangement timeline. Scroll horizontally when zoomed.");
    scroll.append(timeline); arranger.append(position, scroll);
    const inspector = node("aside", "ws-inspector"); inspector.setAttribute("aria-label", "Musical selection inspector");
    const inspectorHeading = node("h3", "ws-inspector-heading", "INSPECTOR");
    const selectionKind = node("div", "ws-selection-kind", "At playhead"), selectionTitle = node("div", "ws-selection-title", "—");
    const selectionRange = node("div", "ws-selection-range", "");
    const inspectorCaption = node("p", "ws-inspector-caption", "Click a region, beat, or note to inspect its exact prediction and seek the original recording.");
    const fields = node("dl"), fieldValues = {};
    ["Section", "Chord", "Key", "Meter", "Bar · beat", "Tempo ♩", "Vocal note", "Instrument note"].forEach((label) => {
      const row = node("div"), value = node("dd", "", "—"); row.append(node("dt", "", label), value); fields.append(row); fieldValues[label] = value;
    });
    const selectedDetail = node("div", "ws-selected-detail");
    const inspectorNote = node("p", "ws-inspector-note", "Melody lanes are symbolic predictions, not separated audio stems. Tempo is derived from adjacent predicted beats, in quarter-note BPM.");
    inspector.append(inspectorHeading, selectionKind, selectionTitle, selectionRange, inspectorCaption, fields, selectedDetail, inspectorNote);
    main.append(arranger, inspector);
    const footer = node("div", "ws-footer"), footerLeft = node("span"), footerRight = node("span", "", "PREDICTIONS · NOT AN EDITOR"); footer.append(footerLeft, footerRight);
    const diagnostics = node("details", "ws-diagnostics"); diagnostics.hidden = true;
    root.replaceChildren(toolbar, main, footer, diagnostics);
    let playhead = null;

    function seek(time) {
      if (!report || !Number.isFinite(time)) return;
      const target = Math.max(0, Math.min(report.duration, time));
      if (typeof onSeek === "function") onSeek(target);
      setPlayback(target, playing);
    }
    function select(item, type, element) {
      if (selection?.element) selection.element.classList.remove("selected");
      selection = {item, type, element}; if (element) element.classList.add("selected");
      previousInspector = ""; seek(item.start ?? item.time ?? 0);
      updateInspector(analysis.atTime(report, currentTime));
    }
    function missingMessage(feature) {
      const info = report.availability?.[feature];
      return info?.status === "not_requested" ? "Not requested in this run" : "No prediction returned";
    }
    function grid(track) {
      const layer = node("div", "ws-beat-grid"); layer.setAttribute("aria-hidden", "true");
      for (const beat of report.beats) {
        const line = node("i", `ws-gridline${beat.downbeat ? " downbeat" : ""}`);
        line.style.left = `${beat.time / report.duration * 100}%`; layer.append(line);
      }
      track.append(layer);
    }
    function addRow(name, subtitle, className, color, {gridLines = true} = {}) {
      const row = node("div", `ws-row ${className}`); row.style.setProperty("--lane-color", color || "#8298ab");
      const label = node("div", "ws-label"); label.append(node("strong", "", name)); if (subtitle) label.append(node("small", "", subtitle));
      const track = node("div", "ws-track"); track.style.width = `${plotWidth}px`; track.setAttribute("aria-label", `${name} timeline`);
      track.addEventListener("click", (event) => { if (event.target.closest("button")) return; const rect = track.getBoundingClientRect(); seek((event.clientX - rect.left) / rect.width * report.duration); });
      track.addEventListener("keydown", (event) => {
        if (event.target !== track) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); seek(currentTime + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 5 : .25)); }
        if (event.key === "Home" || event.key === "End") { event.preventDefault(); seek(event.key === "Home" ? 0 : report.duration); }
      });
      track.tabIndex = 0; track.setAttribute("aria-description", "Click to seek; use Left and Right arrows to seek a quarter second, Shift for five seconds.");
      if (gridLines) grid(track); row.append(label, track); timeline.append(row); tracks.push(track); return track;
    }
    function drawRegions(track, regions, type, feature) {
      if (!regions.length) { track.append(node("span", "ws-missing", missingMessage(feature))); return; }
      regions.forEach((item) => {
        const width = (item.end - item.start) / report.duration * plotWidth;
        const title = type === "tempo" ? `${number(item.bpm)} BPM` : cleanLabel(item.label);
        const button = node("button", `ws-region${width < 35 ? " short-region" : ""}`, width >= 18 ? title : "");
        button.type = "button"; button.style.left = `${item.start / report.duration * 100}%`; button.style.width = `${Math.max(0.05, (item.end - item.start) / report.duration * 100)}%`;
        if (type === "tempo") {
          // A step plot communicates local timing variation without smoothing,
          // quantizing, or replacing the model's beat intervals with one BPM.
          const span = Math.max(1, report.summary.tempoMax - report.summary.tempoMin);
          button.classList.add("ws-tempo-step");
          button.style.top = `${5 + (report.summary.tempoMax - item.bpm) / span * 24}px`;
          button.textContent = width > 39 ? number(item.bpm) : "";
        }
        const description = `${type}: ${title}; ${timeLabel(item.start, true)} to ${timeLabel(item.end, true)}; ${item.source === "derived" ? "derived from predicted beats" : "model prediction"}`;
        button.title = description; button.setAttribute("aria-label", description); button.addEventListener("click", () => select(item, type, button));
        track.append(button); marks.push({item, type, element:button});
      });
    }
    function drawNotes(track, notes, name) {
      if (!notes.length) { track.append(node("span", "ws-missing", missingMessage(name))); return; }
      let low = Math.min(...notes.map((note) => note.pitch)) - 2, high = Math.max(...notes.map((note) => note.pitch)) + 2;
      if (high - low < 12) { const center = (high + low) / 2; low = Math.floor(center - 6); high = low + 12; }
      low = Math.max(0, low); high = Math.min(127, high);
      const pitchSpan = high - low + 1, pitchGrid = node("div", "ws-note-grid"); pitchGrid.setAttribute("aria-hidden", "true");
      for (let pitch = low; pitch <= high; pitch++) {
        const line = node("i", "ws-note-grid-line"); line.style.top = `${(high - pitch + .5) / pitchSpan * 100}%`; pitchGrid.append(line);
        if (pitch % 12 === 0) { const label = node("span", "ws-pitch-label", pitchName(pitch)); label.style.top = `${(high - pitch) / pitchSpan * 100}%`; pitchGrid.append(label); }
      }
      track.append(pitchGrid);
      notes.forEach((item) => {
        const button = node("button", "ws-note"); button.type = "button";
        button.style.left = `${item.start / report.duration * 100}%`; button.style.width = `${(item.end - item.start) / report.duration * 100}%`;
        button.style.top = `calc(${(high - item.pitch + .5) / pitchSpan * 100}% - 2px)`;
        const description = `${name} melody ${pitchName(item.pitch)}, MIDI ${item.pitch}; ${timeLabel(item.start, true)} to ${timeLabel(item.end, true)}; model prediction, not an audio stem`;
        button.title = description; button.setAttribute("aria-label", description); button.addEventListener("click", () => select(item, `${name} melody`, button)); track.append(button); noteMarks.push({item, element:button});
      });
    }
    function renderTimeline() {
      const oldScroll = scroll.scrollLeft;
      tracks = []; marks = []; noteMarks = []; beatMarks = []; waveform = null; timeline.replaceChildren();
      if (!report || !report.duration) { timeline.append(node("div", "ws-empty", "This run has no valid analyzed duration.")); return; }
      labelWidth = parseFloat(getComputedStyle(root).getPropertyValue("--label-width")) || 122;
      plotWidth = Math.max(190, scroll.clientWidth - labelWidth) * zoom;
      timeline.style.width = `${labelWidth + plotWidth}px`;
      const ruler = addRow("TIME / SEC", "", "ws-ruler", "#899bad", {gridLines:false});
      const minStep = report.duration / Math.max(1, plotWidth / 72);
      const step = [.1,.25,.5,1,2,5,10,15,30,60,120].find((candidate) => candidate >= minStep) || 300;
      for (let time = 0; time <= report.duration + .0001; time += step) {
        if (time > report.duration - step * .25 && time !== 0) continue;
        const tick = node("span", "ws-ruler-tick"); tick.style.left = `${time / report.duration * 100}%`; tick.append(node("span", "", timeLabel(time, step < 1))); ruler.append(tick);
      }
      const waveTrack = addRow("Original audio", "Analyzed excerpt", "ws-wave-row", "#99acb4");
      waveform = node("canvas", "ws-wave"); waveform.setAttribute("role", "img"); waveform.setAttribute("aria-label", "Original recording waveform inside analyzed range"); waveTrack.append(waveform);
      drawRegions(addRow("Structure", "Model segments", "ws-structure-row", "var(--section-color)"), report.sections, "structure", "structure");
      drawRegions(addRow("Chords", "Model harmony", "ws-region-row", "var(--chord-color)"), report.chords, "chord", "chords");
      drawRegions(addRow("Key", "Changes preserved", "ws-region-row", "var(--key-color)"), report.keys, "key", "key");
      drawRegions(addRow("Meter", "Denominator beats", "ws-region-row", "var(--meter-color)"), report.meters, "meter", "meter");
      const tempoRange = report.summary.tempoMin !== null ? `${number(report.summary.tempoMin,0)}–${number(report.summary.tempoMax,0)} BPM · derived` : "Derived · BPM";
      drawRegions(addRow("Tempo ♩", tempoRange, "ws-tempo-row", "var(--tempo-color)"), report.tempo, "tempo", "tempo");
      const beatTrack = addRow("Beat grid", "Amber = downbeat", "ws-beat-row", "var(--tempo-color)");
      if (!report.beats.length) beatTrack.append(node("span", "ws-missing", missingMessage("beats")));
      report.beats.forEach((item) => {
        const button = node("button", `ws-beat-mark${item.downbeat ? " downbeat" : ""}`); button.type = "button"; button.style.left = `${item.time / report.duration * 100}%`;
        if (item.downbeat && plotWidth / report.duration > 20) button.append(node("span", "", item.bar === null ? "↓" : String(item.bar)));
        const title = `${item.downbeat ? "Downbeat" : "Beat"} ${item.position} of ${item.numerator}, ${item.numerator}/${item.denominator}${item.bar !== null ? `, observed bar ${item.bar}` : ""} at ${timeLabel(item.time, true)}`;
        button.title = title; button.setAttribute("aria-label", title); button.addEventListener("click", () => select(item, item.downbeat ? "downbeat" : "beat", button)); beatTrack.append(button); beatMarks.push({item,element:button});
      });
      drawNotes(addRow("Vocal melody", "Predicted notes", "ws-note-row", "var(--vocal-color)"), report.melody.vocal, "vocal");
      drawNotes(addRow("Instrumental", "Predicted melody", "ws-note-row", "var(--instrumental-color)"), report.melody.instrumental, "instrumental");
      playhead = node("div", "ws-playhead"); playhead.setAttribute("aria-hidden", "true"); timeline.append(playhead);
      scroll.scrollLeft = oldScroll;
      if (selection) {
        const match = [...marks, ...noteMarks, ...beatMarks].find((mark) => mark.item === selection.item);
        selection.element = match?.element || null; selection.element?.classList.add("selected");
      }
      drawWaveform(); previousActive = ""; setPlayback(currentTime, playing);
    }
    function drawWaveform() {
      if (!waveform || !report) return;
      const rect = waveform.getBoundingClientRect(); if (!rect.width || !rect.height) return;
      const dpr = window.devicePixelRatio || 1;
      waveform.width = Math.round(rect.width * dpr); waveform.height = Math.round(rect.height * dpr);
      const context = waveform.getContext("2d"); if (!context) return;
      context.setTransform(dpr,0,0,dpr,0,0); context.clearRect(0,0,rect.width,rect.height);
      context.fillStyle = "#4b6570"; context.fillRect(0, rect.height / 2, rect.width, 1);
      if (!peaks?.length || !audioDuration) { context.fillStyle="#8499ab";context.font="10px -apple-system, sans-serif";context.fillText("Waveform preview unavailable · Original audio playback remains available",11,rect.height/2+3);return; }
      const barCount = Math.max(1, Math.floor(rect.width / 3)), sampleFraction = Math.min(1, report.duration / audioDuration);
      context.fillStyle = "#80a3ab";
      for (let index = 0; index < barCount; index++) {
        const from = Math.floor(index / barCount * sampleFraction * peaks.length), to = Math.max(from+1, Math.floor((index+1)/barCount*sampleFraction*peaks.length));
        let peak = 0; for (let point=from;point<to;point++) peak=Math.max(peak,peaks[point]||0);
        const height = Math.max(1, Math.pow(peak,.75)*(rect.height-10)); context.fillRect(index*3,(rect.height-height)/2,1.5,height);
      }
    }
    function updateInspector(current) {
      const selected = selection?.item;
      const values = {"Section":cleanLabel(current.section?.label),"Chord":cleanLabel(current.chord?.label),"Key":cleanLabel(current.key?.label),"Meter":current.meter?.label || "—","Bar · beat":current.beat ? `${current.beat.bar ?? "?"} · ${current.beat.position}` : "—","Tempo ♩":current.tempo ? `${number(current.tempo.bpm)} BPM` : "—","Vocal note":current.notes.vocal.map((note)=>pitchName(note.pitch)).join(" · ") || "—","Instrument note":current.notes.instrumental.map((note)=>pitchName(note.pitch)).join(" · ") || "—"};
      const signature = JSON.stringify([values, selection?.type, selected?.start, selected?.time, selected?.pitch, report?.duration]);
      if (signature === previousInspector) return; previousInspector = signature;
      Object.entries(values).forEach(([key,value])=>{ fieldValues[key].textContent=value;fieldValues[key].classList.toggle("ws-unavailable",value==="—"); });
      if (selected) {
        selectionKind.textContent = `Selected ${selection.type}`;
        const title = selected.pitch !== undefined ? pitchName(selected.pitch) : selected.bpm !== undefined ? `${number(selected.bpm)} BPM` : selected.label ? cleanLabel(selected.label) : selected.downbeat ? `Bar ${selected.bar ?? "?"} · downbeat` : `Beat ${selected.position}`;
        selectionTitle.textContent=title;
        selectionRange.textContent = selected.end !== undefined ? `${timeLabel(selected.start,true)} — ${timeLabel(selected.end,true)} · ${number(selected.end-selected.start,2)} s` : `At ${timeLabel(selected.time,true)}`;
        selectedDetail.replaceChildren(node("h4","","PREDICTION DETAIL"));
        if(selected.pitch !== undefined)selectedDetail.append(node("p","",`MIDI pitch ${selected.pitch} · ${selection.type}. This is a predicted note, not an isolated recording.`));
        else if(selected.bpm !== undefined)selectedDetail.append(node("p","","Quarter-note BPM derived from the elapsed time between consecutive predicted denominator beats. Not a global tempo estimate."));
        else if(selected.position !== undefined)selectedDetail.append(node("p","",`${selected.numerator}/${selected.denominator} · denominator beat ${selected.position}/${selected.numerator} · eighth-note position ${selected.eighthPosition}. Bar numbers count observed downbeats from this excerpt.`));
        else selectedDetail.append(node("p","",`Raw model label: ${selected.label}. The region extends until the next change or the end of this analyzed excerpt.`));
        selectedDetail.append(node("span","ws-source-tag",selected.source === "derived" ? "Derived from predicted beats" : "SheetSage2 model prediction"));
      } else {
        selectionKind.textContent="At playhead";
        selectionTitle.textContent=current.section ? cleanLabel(current.section.label) : "Explore a layer";
        selectionRange.textContent = currentTime >= (report?.duration||0) ? "Playback is outside this analyzed excerpt" : "Original recording · synchronized layers";
        selectedDetail.replaceChildren(node("h4","","ANALYSIS COVERAGE"));
        const summary=report?.summary;
        if(summary)selectedDetail.append(node("p","",`${summary.beatCount} beat predictions · ${summary.downbeatCount} downbeats · ${summary.melodyNotes} raw melody notes.`));
        selectedDetail.append(node("span","ws-source-tag","Model predictions · No confidence scores supplied"));
      }
    }
    function setPlayback(time, isPlaying) {
      currentTime = Number.isFinite(time) ? Math.max(0,time) : 0; playing=Boolean(isPlaying);
      positionValues.time.textContent=timeLabel(currentTime,true);
      if (!report) return;
      const current=analysis.atTime(report,currentTime), inRange=currentTime < report.duration;
      if(playhead){playhead.hidden=!inRange;playhead.style.left=`${labelWidth+Math.min(report.duration,currentTime)/report.duration*plotWidth}px`;}
      positionValues.bbt.textContent=current.beat ? `${current.beat.bar ?? "?"} · ${current.beat.position}` : "—";
      positionValues.tempo.textContent=current.tempo ? number(current.tempo.bpm) : "—";
      positionValues.meter.textContent=current.meter?.label || "—";
      positionValues.section.textContent=cleanLabel(current.section?.label);
      outside.hidden=inRange; footerRight.textContent=inRange ? "PREDICTIONS · NOT AN EDITOR" : "PLAYBACK OUTSIDE ANALYZED EXCERPT";
      const activeSignature=JSON.stringify([current.section?.start,current.chord?.start,current.key?.start,current.meter?.start,current.tempo?.start,current.notes.vocal.map((note)=>note.start),current.notes.instrumental.map((note)=>note.start),playing]);
      if(activeSignature!==previousActive){previousActive=activeSignature;marks.forEach(({item,element})=>element.classList.toggle("active",inRange&&currentTime>=item.start&&currentTime<item.end));noteMarks.forEach(({item,element})=>element.classList.toggle("sounding",playing&&inRange&&currentTime>=item.start&&currentTime<item.end));}
      updateInspector(current);
    }
    function updateRange(){range.replaceChildren(document.createTextNode(`0:00 — ${timeLabel(report?.duration||0,true)} analyzed`)); if(audioDuration)range.append(node("span","",`${timeLabel(audioDuration)} full recording`));}
    function setResult(value) {
      result=value;report=value ? analysis.analyze(value) : null;selection=null;previousInspector="";previousActive="";zoom=1;
      zoomButtons.forEach(([amount,button])=>button.setAttribute("aria-pressed",String(amount===1)));
      updateRange(); diagnostics.replaceChildren(); diagnostics.hidden=!report?.diagnostics?.length;
      if(report?.diagnostics?.length){diagnostics.append(node("summary","",`${report.diagnostics.length} model / analysis notes`));report.diagnostics.forEach((message)=>diagnostics.append(node("p","",String(message))));}
      const summary=report?.summary;
      footerLeft.textContent=summary ? `${summary.sectionCount} sections · ${summary.chordCount} chord regions · ${summary.beatCount} beats · ${summary.melodyNotes} melody notes` : "No analysis loaded";
      renderTimeline();
    }
    function setWaveform(value, duration){peaks=value;audioDuration=Number.isFinite(duration)&&duration>0?duration:0;updateRange();drawWaveform();}
    function resize(){if(renderFrame!==null)cancelAnimationFrame(renderFrame);renderFrame=requestAnimationFrame(()=>{renderFrame=null;renderTimeline();});}
    return Object.freeze({setResult,setPlayback,setWaveform,resize});
  }
  return Object.freeze({create});
});
