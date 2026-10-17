"use strict";

// These tests exercise DOM construction and interaction contracts without a
// browser, model download, or saved private recording. Native visual QA remains
// a separate check: this deliberately small DOM is not a layout engine.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.listeners = new Map();
    this.className = "";
    this.ownText = "";
    this.hidden = false;
    this.clientWidth = 820;
    this.scrollLeft = 0;
    this.style = {setProperty(name, value) { this[name] = value; }};
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => {
        const present = this.classList.contains(name), wanted = force === undefined ? !present : Boolean(force);
        if (wanted) this.classList.add(name); else this.classList.remove(name);
        return wanted;
      },
    };
  }
  append(...children) {
    children.forEach((child) => { child.parentElement = this; this.children.push(child); });
  }
  replaceChildren(...children) {
    this.children.forEach((child) => { child.parentElement = null; });
    this.children = []; this.ownText = ""; this.append(...children);
  }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent || "").join(""); }
  set textContent(value) { this.children = []; this.ownText = String(value); }
  get scrollWidth() { return Math.max(this.clientWidth, ...this.children.map((child) => parseFloat(child.style?.width) || 0)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  dispatch(name, event = {}) {
    const value = {target: this, currentTarget: this, preventDefault() {}, ...event};
    for (const listener of this.listeners.get(name) || []) listener(value);
  }
  closest(selector) {
    if (selector === "button" && this.tagName === "button") return this;
    return this.parentElement?.closest(selector) || null;
  }
  getBoundingClientRect() { return {width: parseFloat(this.style.width) || 698, height: 47, left: 0}; }
  getContext() { return {setTransform() {}, clearRect() {}, fillRect() {}, fillText() {}}; }
}

const source = (file) => fs.readFileSync(path.join(__dirname, "..", "desktop", "ui", file), "utf8");
function harness() {
  const frames = new Map(); let nextFrame = 0;
  const context = vm.createContext({
    document: {createElement: (tag) => new FakeElement(tag), createTextNode: (text) => ({textContent: text})},
    window: {devicePixelRatio: 1},
    getComputedStyle: () => ({getPropertyValue: () => "122px"}),
    requestAnimationFrame: (callback) => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  vm.runInContext(source("music-analysis.js"), context);
  vm.runInContext(source("workspace-view.js"), context);
  const root = new FakeElement("div"), seeks = [];
  const workspace = context.ProducerWorkspace.create({root, onSeek: (time) => seeks.push(time)});
  const all = (predicate, element = root) => [element, ...element.children.flatMap((child) => child instanceof FakeElement ? all(predicate, child) : [])].filter(predicate);
  const byClass = (name) => all((element) => element.classList.contains(name));
  const labelValue = (label) => {
    const rows = all((element) => element.tagName === "dt" && element.textContent === label);
    return rows[0]?.parentElement.children.find((child) => child.tagName === "dd");
  };
  return {context, root, workspace, seeks, all, byClass, labelValue, flushFrames() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback()); }, pendingFrames: () => frames.size};
}

function fixture() {
  const event = (time, values) => ({time, values});
  return {summary: {duration_seconds: 4, prompts: ["downbeat_meter", "structure", "key", "chord_full", "melody_full"], warnings: ["Inspect predictions against the recording."]}, events: {events: [
    event(0, {key: "C:minor", structure: "intro", chord: "C:min", rhythm: {meter: [7,8], eighth_position: 0}, melody: [{pitch:60,track:0,end_time:1}]}),
    event(.25, {rhythm: {eighth_position:1}}),
    event(.5, {chord: "F:min", rhythm: {meter:[4,4], eighth_position:0}, melody:[{pitch:64,track:1,end_time:1.4}]}),
    event(1, {key:"D:minor", structure:"verse", rhythm:{eighth_position:2}}),
    event(1.5, {rhythm:{eighth_position:4}}),
    event(2, {rhythm:{eighth_position:6}}),
    event(2.5, {rhythm:{eighth_position:0}}),
    event(2.9, {rhythm:{eighth_position:2}}),
    event(3.5, {rhythm:{eighth_position:4}}),
  ]}};
}

test("UMD exports the native browser API without dependencies", () => {
  const {context} = harness();
  assert.equal(typeof context.ProducerWorkspace.create, "function");
  assert.equal(typeof require("../desktop/ui/workspace-view.js").create, "function");
});

test("creates aligned musical lanes, raw melody buttons, and model notes", () => {
  const h = harness(); h.workspace.setResult(fixture());
  assert.equal(h.byClass("ws-row").length, 10);
  for (const name of ["Original audio", "Structure", "Chords", "Key", "Meter", "Tempo ♩", "Beat grid", "Vocal melody", "Instrumental"]) {
    assert.ok(h.byClass("ws-label").some((label) => label.textContent.includes(name)), name);
  }
  assert.equal(h.byClass("ws-note").length, 2);
  assert.ok(h.byClass("ws-note").every((button) => button.getAttribute("aria-label").includes("not an audio stem")));
  assert.ok(h.byClass("ws-diagnostics")[0].textContent.includes("Inspect predictions against the recording."));
});

test("playback uses the current key and changing meter, not a first-event global label", () => {
  const h = harness(); h.workspace.setResult(fixture());
  h.workspace.setPlayback(.1, false);
  assert.equal(h.labelValue("Key").textContent, "C minor");
  assert.equal(h.labelValue("Meter").textContent, "7/8");
  h.workspace.setPlayback(1, true);
  assert.equal(h.labelValue("Key").textContent, "D minor");
  assert.equal(h.labelValue("Meter").textContent, "4/4");
  assert.equal(h.labelValue("Section").textContent, "verse");
  assert.equal(h.labelValue("Bar · beat").textContent, "2 · 2");
  assert.equal(h.labelValue("Tempo ♩").textContent, "120 BPM");
  assert.equal(h.labelValue("Vocal note").textContent, "—");
  assert.equal(h.labelValue("Instrument note").textContent, "E4");
  assert.equal(h.byClass("ws-note").filter((button) => button.classList.contains("sounding")).length, 1);
});

test("tempo is an unsmoothed step plot of derived quarter-note BPM intervals", () => {
  const h = harness(); h.workspace.setResult(fixture());
  const steps = h.byClass("ws-tempo-step");
  assert.equal(steps.length, 7); // The 7/8 → 4/4 boundary is not bridged.
  assert.ok(new Set(steps.map((button) => button.style.top)).size > 1);
  assert.ok(steps.every((button) => Number.isFinite(parseFloat(button.style.top))));
  assert.ok(steps.every((button) => button.getAttribute("aria-label").includes("derived from predicted beats")));
  assert.ok(h.byClass("ws-tempo-row")[0].textContent.includes("100–150 BPM · derived"));
  steps[0].dispatch("click");
  assert.equal(h.seeks[0], 0);
  assert.ok(h.byClass("ws-selected-detail")[0].textContent.includes("Not a global tempo estimate"));
});

test("region and note clicks seek their precise onset and expose inspectable provenance", () => {
  const h = harness(); h.workspace.setResult(fixture());
  const verse = h.byClass("ws-region").find((button) => button.getAttribute("aria-label").startsWith("structure: verse"));
  verse.dispatch("click");
  assert.equal(h.seeks.at(-1), 1);
  assert.equal(h.byClass("ws-selection-title")[0].textContent, "verse");
  assert.ok(h.byClass("ws-selected-detail")[0].textContent.includes("Raw model label: verse"));
  const instrumental = h.byClass("ws-note").find((button) => button.getAttribute("aria-label").startsWith("instrumental"));
  instrumental.dispatch("click");
  assert.equal(h.seeks.at(-1), .5);
  assert.equal(h.byClass("ws-selection-title")[0].textContent, "E4");
  assert.ok(h.byClass("ws-selected-detail")[0].textContent.includes("MIDI pitch 64"));
  assert.ok(h.byClass("ws-source-tag")[0].textContent.includes("model prediction"));
});

test("beat selection exposes denominator position and remains selected when zoom changes", () => {
  const h = harness(); h.workspace.setResult(fixture());
  const beat = h.byClass("ws-beat-mark").find((button) => button.title.includes("at 0:00.25"));
  beat.dispatch("click");
  assert.equal(h.seeks.at(-1), .25);
  assert.ok(h.byClass("ws-selected-detail")[0].textContent.includes("denominator beat 2/7"));
  const double = h.byClass("ws-zoom")[0].children.find((button) => button.textContent === "2×");
  double.dispatch("click");
  assert.equal(double.getAttribute("aria-pressed"), "true");
  assert.equal(h.byClass("ws-beat-mark").filter((button) => button.classList.contains("selected")).length, 1);
  assert.equal(parseFloat(h.byClass("ws-track")[0].style.width), (820-122)*2);
});

test("timeline keyboard seek is bounded and respects shift's larger increment", () => {
  const h = harness(); h.workspace.setResult(fixture());
  const track = h.byClass("ws-track")[0];
  track.dispatch("keydown", {key:"ArrowRight"});
  assert.equal(h.seeks.at(-1), .25);
  track.dispatch("keydown", {key:"ArrowRight", shiftKey:true});
  assert.equal(h.seeks.at(-1), 4);
  track.dispatch("keydown", {key:"Home"});
  assert.equal(h.seeks.at(-1), 0);
  track.dispatch("keydown", {key:"ArrowLeft"});
  assert.equal(h.seeks.at(-1), 0);
  track.dispatch("keydown", {key:"End"});
  assert.equal(h.seeks.at(-1), 4);
});

test("full recording playback outside the excerpt clears predictions and hides the shared playhead", () => {
  const h = harness(); h.workspace.setResult(fixture());
  h.workspace.setWaveform(new Float32Array([.1,.8,.5,.6,.7]), 50.35);
  assert.ok(h.byClass("ws-range")[0].textContent.includes("0:04.00 analyzed"));
  assert.ok(h.byClass("ws-range")[0].textContent.includes("0:50 full recording"));
  h.workspace.setPlayback(4, true);
  assert.equal(h.byClass("ws-playhead")[0].hidden, true);
  assert.equal(h.byClass("ws-outside")[0].hidden, false);
  assert.equal(h.labelValue("Key").textContent, "—");
  assert.equal(h.labelValue("Meter").textContent, "—");
  assert.equal(h.labelValue("Tempo ♩").textContent, "—");
  assert.equal(h.byClass("ws-note").filter((button) => button.classList.contains("sounding")).length, 0);
});

test("missing predictions are visibly unknown, without fabricated notes, meter, or tempo", () => {
  const h = harness(); h.workspace.setResult({summary:{duration_seconds:4,prompts:[]},events:[]});
  assert.equal(h.byClass("ws-note").length, 0);
  assert.equal(h.byClass("ws-tempo-step").length, 0);
  assert.equal(h.byClass("ws-beat-mark").length, 0);
  assert.ok(h.byClass("ws-missing").every((label) => label.textContent === "Not requested in this run"));
  assert.equal(h.labelValue("Meter").textContent, "—");
  assert.equal(h.labelValue("Tempo ♩").textContent, "—");
});

test("repeated playback within one musical state retains inspector DOM and resize is coalesced", () => {
  const h = harness(); h.workspace.setResult(fixture());
  h.workspace.setPlayback(.6, false);
  const details = h.byClass("ws-selected-detail")[0], original = details.children[0];
  h.workspace.setPlayback(.61, false); h.workspace.setPlayback(.62, false);
  assert.equal(details.children[0], original);
  h.workspace.resize(); h.workspace.resize(); h.workspace.resize();
  assert.equal(h.pendingFrames(), 1);
  h.flushFrames(); assert.equal(h.pendingFrames(), 0);
  assert.equal(h.byClass("ws-row").length, 10);
});

test("null and zero-duration results are safe and do not synthesize a timeline", () => {
  const h = harness(); h.workspace.setResult(fixture());
  h.workspace.setResult(null); h.workspace.setPlayback(Number.NaN, false);
  assert.equal(h.byClass("ws-row").length, 0);
  assert.ok(h.byClass("ws-empty")[0].textContent.includes("no valid analyzed duration"));
  h.workspace.setResult({summary:{duration_seconds:0},events:[]});
  h.workspace.setWaveform(null,0); h.workspace.resize(); h.flushFrames();
  assert.equal(h.byClass("ws-row").length, 0);
});
