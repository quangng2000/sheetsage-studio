/* The recording owns the clock; engraving supplies only glyph positions. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./score-timing.js"), require("./score-elements.js"));
  else root.ScoreFollow = factory(root.ScoreTiming, root.ScoreElements);
})(typeof globalThis !== "undefined" ? globalThis : this, function (ScoreTiming, ScoreElements) {
  "use strict";

  function clockLabel(time) {
    const seconds = Math.max(0, time);
    return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
  }

  function create({root, button, status, onSeek}) {
    let timing = null, records = [], active = new Set(), actions = new WeakMap(), decorated = new Map();
    let follow = true, visible = false, lastTime = 0, playing = false, signature = "";
    const cursor = root.ownerDocument.createElement("div");
    cursor.className = "score-audio-cursor";
    cursor.setAttribute("aria-hidden", "true");
    cursor.hidden = true;

    function setStatus(text) { if (status.textContent !== text) status.textContent = text; }
    function clearHighlight() {
      for (const element of active) element.classList.remove("score-note-active", "score-rest-active");
      active.clear(); cursor.hidden = true; signature = "";
    }
    function reset() {
      clearHighlight(); cursor.remove(); timing = null; records = []; actions = new WeakMap();
      for (const [element, attributes] of decorated) {
        element.classList.remove("score-seekable");
        for (const [name, value] of Object.entries(attributes)) {
          if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
        }
      }
      decorated.clear();
      button.disabled = true;
      setStatus("Analyze a recording to follow its score.");
    }
    function updateButton() {
      button.setAttribute("aria-pressed", String(follow));
      button.textContent = follow ? "✓ Follow audio" : "Follow audio";
      button.title = "Automatically scroll to the current staff. Note highlighting stays on when scrolling is off.";
    }
    function seek(event) {
      if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
      let element = event.target;
      while (element && element !== root) {
        const record = actions.get(element);
        if (record) {
          const time = timing?.scoreToAudio(record.start);
          if (Number.isFinite(time)) { event.preventDefault(); onSeek(time); }
          return;
        }
        element = element.parentElement;
      }
    }
    root.addEventListener("click", seek);
    root.addEventListener("keydown", seek);
    button.addEventListener("click", () => { follow = !follow; updateButton(); setPlayback(lastTime, playing, visible, true); });

    function attach(result, tune) {
      reset(); timing = ScoreTiming.create(result);
      if (!timing.available) { setStatus(timing.reason || "Score timing unavailable; notation remains readable."); return; }
      records = ScoreElements.collect(tune).filter(record => Number.isFinite(record.start) && Number.isFinite(record.end) && record.end > record.start);
      if (!records.length) { setStatus("No timed notation elements were produced."); timing = null; return; }
      // abcjs marks its SVG as a single image; expose our interactive glyphs.
      for (const svg of root.querySelectorAll("svg")) {
        svg.setAttribute("role", "group"); svg.setAttribute("aria-label", "Interactive sheet music");
      }
      for (const record of records) {
        const time = timing.scoreToAudio(record.start);
        if (!Number.isFinite(time)) continue;
        const label = `Seek to ${clockLabel(time)} · ${record.rest ? "rest" : "note"}`;
        let focusTarget = true;
        for (const element of record.elements) {
          if (!element?.classList || !element.setAttribute) continue;
          if (!decorated.has(element)) decorated.set(element, Object.fromEntries(["role", "tabindex", "aria-label", "focusable"].map(name => [name, element.getAttribute(name)])));
          actions.set(element, record);
          element.classList.add("score-seekable");
          // One keyboard stop per notated note/rest, not per stem or beam path.
          if (focusTarget) {
            element.setAttribute("role", "button"); element.setAttribute("tabindex", "0");
            element.setAttribute("focusable", "true");
            element.setAttribute("aria-label", label); focusTarget = false;
          }
        }
      }
      root.append(cursor); button.disabled = false; updateButton();
      setPlayback(lastTime, playing, visible, true);
    }

    function bounds(elements) {
      const boxes = elements.filter(element => element?.getBoundingClientRect).map(element => element.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
      if (!boxes.length) return null;
      return {left: Math.min(...boxes.map(box => box.left)), right: Math.max(...boxes.map(box => box.right)), top: Math.min(...boxes.map(box => box.top)), bottom: Math.max(...boxes.map(box => box.bottom))};
    }

    function positionCursor(current, shouldScroll) {
      const first = current[0];
      if (!first) { cursor.hidden = true; return; }
      // Prefer the latest onset: another voice may still sustain an earlier note.
      const notes = current.filter(record => !record.rest && record.elements.length);
      const candidates = notes.length ? notes : current;
      const onset = Math.max(...candidates.map(record => record.start));
      const sounding = candidates.filter(record => Math.abs(record.start - onset) < 1e-7);
      const head = bounds(sounding.flatMap(record => record.elements));
      const line = sounding[0].lineIndex;
      const staff = bounds(records.filter(record => record.lineIndex === line).flatMap(record => record.elements));
      if (!head || !staff) { cursor.hidden = true; return; }
      const viewport = root.getBoundingClientRect();
      const top = staff.top - viewport.top + root.scrollTop - 6;
      const left = head.left - viewport.left + root.scrollLeft - 4;
      cursor.style.top = `${top}px`; cursor.style.left = `${left}px`;
      cursor.style.height = `${staff.bottom - staff.top + 12}px`; cursor.hidden = false;
      if (follow && shouldScroll && (staff.top < viewport.top + 20 || staff.bottom > viewport.bottom - 20)) {
        // Scroll only this score viewport; never move the transport off screen.
        const target = Math.max(0, top - 35);
        const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (root.scrollTo) root.scrollTo({top: target, behavior: reduced ? "instant" : "smooth"});
        else root.scrollTop = target;
      }
    }

    function setPlayback(time, isPlaying, isVisible = true, force = false) {
      force = force || (Boolean(isVisible) && !visible);
      lastTime = time; playing = Boolean(isPlaying); visible = Boolean(isVisible);
      if (!timing || !visible) return;
      const position = timing.audioToScore(time);
      if (!Number.isFinite(position)) {
        clearHighlight(); setStatus("Outside the timed score · Original audio continues."); return;
      }
      const current = records.filter(record => record.start <= position + 1e-8 && position < record.end - 1e-8);
      const precision = timing.precision === "beat" ? "Beat-aligned" : "Approximate measure timing";
      const measure = current.length ? ` · Measure ${current[current.length - 1].measureIndex + 1}` : "";
      // The transport clock still advances during a sustained glyph. Keep its
      // label current without reapplying highlights or scrolling every frame.
      setStatus(`${precision} · ${clockLabel(time)}${measure} · ${follow ? "Auto-scroll on" : "Auto-scroll off"} · Click notes to seek`);
      const nextSignature = current.map(record => records.indexOf(record)).join(",");
      if (!force && nextSignature === signature) return;
      const next = new Set(current.flatMap(record => record.elements));
      for (const element of active) if (!next.has(element)) element.classList.remove("score-note-active", "score-rest-active");
      for (const record of current) for (const element of record.elements) element.classList?.add(record.rest ? "score-rest-active" : "score-note-active");
      active = next; signature = nextSignature;
      positionCursor(current, true);
    }

    updateButton(); reset();
    return {attach, reset, setPlayback, resize: () => setPlayback(lastTime, playing, visible, true)};
  }
  return {create};
});
