"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {analyze, atTime} = require("../desktop/ui/music-analysis.js");

const event = (time, values) => ({time, values});
const result = (events, duration = 10, prompts) => ({summary: {duration_seconds: duration, ...(prompts ? {prompts} : {})}, events: {events}});
function beatEvents(numerator, denominator, period, count, start = 0) {
  return Array.from({length: count}, (_, index) => event(start + index * period, {rhythm: {
    ...(index === 0 ? {meter: [numerator, denominator]} : {}), eighth_position: (index % numerator) * 8 / denominator,
  }}));
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);

test("UMD exports a browser global without Node or dependencies", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("../desktop/ui/music-analysis.js"), "utf8"), context);
  assert.equal(typeof context.MusicAnalysis.analyze, "function");
  assert.equal(typeof context.MusicAnalysis.atTime, "function");
});

test("4/4 positions carry meter and derive quarter-note BPM", () => {
  const report = analyze(result(beatEvents(4, 4, 0.5, 9), 5));
  assert.deepEqual(report.beats.slice(0, 5).map((beat) => beat.position), [1, 2, 3, 4, 1]);
  assert.deepEqual(report.beats.map((beat) => beat.eighthPosition), [0, 2, 4, 6, 0, 2, 4, 6, 0]);
  assert.deepEqual(report.downbeats.map((beat) => beat.time), [0, 2, 4]);
  assert.deepEqual(report.beats.map((beat) => beat.bar), [1, 1, 1, 1, 2, 2, 2, 2, 3]);
  assert.equal(report.summary.tempoBpm, 120);
  assert.equal(report.summary.tempoMin, 120);
  assert.equal(report.summary.tempoMax, 120);
  assert.equal(report.meters.length, 1);
  assert.equal(report.meters[0].end, 5);
});

test("6/8 beats are eighth pulses; tempo is explicitly quarter-note BPM", () => {
  const report = analyze(result(beatEvents(6, 8, 0.25, 13), 4));
  assert.deepEqual(report.beats.slice(0, 7).map((beat) => beat.position), [1, 2, 3, 4, 5, 6, 1]);
  assert.deepEqual(report.downbeats.map((beat) => beat.time), [0, 1.5, 3]);
  assert.equal(report.summary.tempoBpm, 120);
  assert.equal(report.availability.tempo.source, "derived");
  assert.equal(report.availability.tempo.label, "Derived from predicted beats");
  assert.ok(report.tempo.every((point) => point.source === "derived"));
});

test("7/8 is not silently converted to 4/4", () => {
  const report = analyze(result(beatEvents(7, 8, 0.2, 15), 4));
  assert.equal(report.meters[0].label, "7/8");
  assert.deepEqual(report.downbeats.map((beat) => beat.time), [0, 1.4000000000000001, 2.8000000000000003]);
  assert.equal(report.summary.beatCount, 15);
  near(report.summary.tempoBpm, 150);
  assert.equal(atTime(report, 1.5).beat.position, 1);
});

test("meter changes invalidate tempo intervals across the boundary", () => {
  const events = [...beatEvents(4, 4, 0.5, 4), ...beatEvents(6, 8, 0.25, 4, 2)];
  const report = analyze(result(events, 4));
  assert.deepEqual(report.meters.map((meter) => meter.label), ["4/4", "6/8"]);
  assert.equal(report.tempo.some((point) => point.start === 1.5 && point.end === 2), false);
  assert.equal(atTime(report, 2).meter.label, "6/8");
  assert.equal(atTime(report, 2).beat.bar, 2);
});

test("intervening meter changes cannot be hidden by changing back before the next beat", () => {
  const report = analyze(result([
    event(0, {rhythm: {meter: [4, 4], eighth_position: 0}}),
    event(0.1, {rhythm: {meter: [6, 8]}}), event(0.2, {rhythm: {meter: [4, 4]}}),
    event(0.5, {rhythm: {eighth_position: 2}}),
  ]));
  assert.equal(report.tempo.length, 0);
  assert.equal(atTime(report, 0.3).beat, null);
});

test("beats and regions do not appear before the first model prediction", () => {
  const report = analyze(result([
    event(2, {key: "D:minor", structure: "verse", chord: "D:min", rhythm: {meter: [4, 4], eighth_position: 4}}),
    event(2.5, {rhythm: {eighth_position: 6}}), event(3, {rhythm: {eighth_position: 0}}),
  ]));
  const early = atTime(report, 1);
  assert.equal(early.key, null);
  assert.equal(early.meter, null);
  assert.equal(early.beat, null);
  assert.equal(early.section, null);
  assert.equal(report.beats[0].bar, null);
  assert.equal(report.beats[1].bar, null);
  assert.equal(report.beats[2].bar, 1);
  assert.equal(report.keys[0].start, 2);
});

test("missing beat positions never create synthetic pulses or tempo", () => {
  const report = analyze(result([
    event(0, {rhythm: {meter: [4, 4], eighth_position: 0}}),
    event(1, {rhythm: {eighth_position: 4}}), event(1.5, {rhythm: {eighth_position: 6}}),
  ]));
  assert.equal(report.beats.length, 3);
  assert.deepEqual(report.tempo.map((point) => [point.start, point.end]), [[1, 1.5]]);
  assert.equal(atTime(report, 0.5).tempo, null);
  assert.ok(report.diagnostics.some((message) => message.includes("missing beats")));
});

test("regions sort, merge repeated labels, retain changes, and end at analyzed duration", () => {
  const report = analyze(result([
    event(6, {structure: "chorus", key: "D:minor", chord: "G:maj"}),
    event(2, {structure: "verse", key: "C:major", chord: "C:maj"}),
    event(4, {structure: "verse", key: "C:major", chord: "C:maj"}),
    event(8, {structure: "verse", chord: "C:maj"}),
  ], 10));
  assert.deepEqual(report.sections.map(({start, end, label}) => [start, end, label]), [[2, 6, "verse"], [6, 8, "chorus"], [8, 10, "verse"]]);
  assert.deepEqual(report.keys.map(({start, end, label}) => [start, end, label]), [[2, 6, "C:major"], [6, 10, "D:minor"]]);
  assert.equal(report.summary.primaryKey, "C:major"); // Earliest wins the equal-duration tie.
  assert.equal(report.summary.primaryMeter, null);
  assert.equal(atTime(report, 6).key.label, "D:minor");
  assert.equal(atTime(report, 10).key, null);
});

test("latest scalar duplicate wins without losing other fields or simultaneous melody events", () => {
  const report = analyze(result([
    event(1, {key: "C:major", chord: "C:maj", rhythm: {eighth_position: 0}}),
    event(1, {key: "D:minor", rhythm: {meter: [7, 8]}}),
    event(1, {chord: "D:min"}),
    event(1, {melody: [{pitch: 60, track: 0, end_time: 2}]}),
    event(1, {melody: [{pitch: 62, track: 1, end_time: 2}]}),
  ]));
  assert.equal(report.keys[0].label, "D:minor");
  assert.equal(report.chords[0].label, "D:min");
  assert.equal(report.beats.length, 1);
  assert.equal(report.beats[0].numerator, 7);
  assert.equal(report.melody.vocal.length, 1);
  assert.equal(report.melody.vocal[0].pitch, 60);
  assert.equal(report.melody.instrumental[0].pitch, 62);
  assert.equal(report.summary.melodyNotes, 2);
});

test("every source melody note at a shared onset survives, including harmony and identical notes", () => {
  const events = [
    event(1, {melody: [{pitch: 60, track: 0, end_time: 2}]}),
    event(1, {melody: [{pitch: 64, track: 1, end_time: 3}, {pitch: 67, track: 1, end_time: 3}]}),
    event(1, {melody: [{pitch: 60, track: 0, end_time: 2}]}),
    event(1, {melody: []}),
    event(1, {melody: null}),
  ];
  const before = JSON.stringify(events);
  const report = analyze(result(events));
  assert.deepEqual(report.melody.vocal.map((note) => note.pitch), [60, 60]);
  assert.deepEqual(report.melody.instrumental.map((note) => note.pitch), [64, 67]);
  assert.equal(report.summary.vocalNotes, 2);
  assert.equal(report.summary.instrumentalNotes, 2);
  assert.equal(report.summary.melodyNotes, 4);
  assert.equal(atTime(report, 1.5).notes.vocal.length, 2);
  assert.equal(atTime(report, 1.5).notes.instrumental.length, 2);
  assert.equal(JSON.stringify(events), before);
});

test("explicit empty or invalid labels leave gaps rather than inventing continuity", () => {
  const report = analyze(result([
    event(1, {key: "C:major", chord: "N", structure: "intro"}),
    event(3, {key: null, chord: "", structure: 42}),
    event(5, {key: "C:major", chord: "C:maj", structure: "verse"}),
  ]));
  assert.equal(report.keys.length, 2);
  assert.equal(report.keys[0].end, 3);
  assert.equal(report.chords[0].label, "N");
  assert.equal(atTime(report, 4).key, null);
  assert.equal(atTime(report, 4).section, null);
  assert.equal(atTime(report, 4).chord, null);
});

test("invalid meter creates a gap, and beat positions require a valid carried meter", () => {
  const report = analyze(result([
    event(0, {rhythm: {eighth_position: 0}}),
    event(1, {rhythm: {meter: [4, 4], eighth_position: 0}}),
    event(2, {rhythm: {meter: [0, 8], eighth_position: 2}}),
    event(3, {rhythm: {eighth_position: 4}}),
    event(4, {rhythm: {meter: [6, 8], eighth_position: 0}}),
  ]));
  assert.deepEqual(report.meters.map(({start, end}) => [start, end]), [[1, 2], [4, 10]]);
  assert.deepEqual(report.beats.map((beat) => beat.time), [1, 4]);
  assert.equal(atTime(report, 2.5).meter, null);
  assert.equal(atTime(report, 2.5).beat, null);
  assert.equal(report.tempo.length, 0);
});

test("off-grid, fractional, negative, or out-of-meter rhythm positions are rejected", () => {
  const report = analyze(result([
    event(0, {rhythm: {meter: [4, 4], eighth_position: 0}}),
    event(1, {rhythm: {eighth_position: 1}}), event(2, {rhythm: {eighth_position: -2}}),
    event(3, {rhythm: {eighth_position: 8}}), event(4, {rhythm: {eighth_position: 2.5}}),
    event(5, {rhythm: {eighth_position: "2"}}),
  ]));
  assert.equal(report.beats.length, 1);
  assert.equal(report.summary.tempoBpm, null);
});

test("invalid timestamps are ignored, not coerced to zero", () => {
  const invalid = [NaN, Infinity, -Infinity, null, "", "1", undefined];
  const events = invalid.map((time) => event(time, {key: "C:major"}));
  events.push({values: {timestamp: 2, key: "D:minor"}});
  events.push(event(3, {key: "E:minor"}));
  const report = analyze(result(events));
  assert.deepEqual(report.keys.map(({start, label}) => [start, label]), [[2, "D:minor"], [3, "E:minor"]]);
  assert.equal(atTime(report, 0).key, null);
  assert.equal(report.diagnostics.filter((message) => message.includes("invalid event timestamp")).length, 1);
});

test("raw melody is clipped to the excerpt and remains separate from playback/chord voicing", () => {
  const input = result([
    event(-1, {key: "X", melody: [{pitch: 60, track: 0, end_time: 0.5}]}),
    event(1, {melody: [{pitch: 64, track: 0, end_time: 2}, {pitch: 67, track: 1, end_time: 20}]}),
    event(3, {melody: [{pitch: 70, track: 0, end_time: 2}, {pitch: 72, track: 1, end_time: 3}]}),
    event(10, {melody: [{pitch: 75, track: 0, end_time: 11}]}),
  ], 10);
  input.playback = {duration: 60, tracks: [{name: "Chord", notes: [{start: 0, end: 10, pitch: 100}]}]};
  const report = analyze(input);
  assert.equal(report.duration, 10);
  assert.deepEqual(report.melody.vocal.map(({start, end, pitch}) => [start, end, pitch]), [[0, 0.5, 60], [1, 2, 64]]);
  assert.deepEqual(report.melody.instrumental.map(({start, end, pitch}) => [start, end, pitch]), [[1, 10, 67]]);
  assert.equal(report.keys.length, 0);
  assert.equal(report.summary.melodyNotes, 3);
  assert.equal(atTime(report, 1.5).notes.vocal[0].pitch, 64);
  assert.equal(atTime(report, 1.5).notes.instrumental[0].pitch, 67);
  assert.equal(atTime(report, 2).notes.vocal.length, 0);
});

test("invalid pitches, tracks, and note ends cannot leak into a melody lane", () => {
  const notes = [
    {pitch: -1, track: 0, end_time: 2}, {pitch: 128, track: 0, end_time: 2},
    {pitch: 60.5, track: 0, end_time: 2}, {pitch: 60, track: 2, end_time: 2},
    {pitch: 60, track: "0", end_time: 2}, {pitch: 60, track: 0, end_time: NaN},
    {pitch: 60, track: 0, end_time: "2"}, null,
  ];
  const report = analyze(result([event(1, {melody: notes}), event(3, {melody: {}})]));
  assert.equal(report.summary.melodyNotes, 0);
  assert.equal(report.availability.melody.observed, false);
});

test("availability distinguishes requested-but-absent from not requested", () => {
  const report = analyze(result([], 10, ["timestamp", "key", "melody_vocal"]));
  assert.deepEqual(report.availability.key, {observed: false, requested: true, status: "not_returned", source: "model", label: "Model-predicted key"});
  assert.equal(report.availability.chords.requested, false);
  assert.equal(report.availability.chords.status, "not_requested");
  assert.equal(report.availability.vocal.requested, true);
  assert.equal(report.availability.instrumental.requested, false);
  assert.equal(analyze(result([])).availability.key.requested, null);
});

test("decoded wrapper prompts and observed unrequested fields are retained honestly", () => {
  const input = result([event(1, {key: "C:major"})]);
  input.events.prompts = ["timestamp"];
  const report = analyze(input);
  assert.equal(report.availability.key.requested, false);
  assert.equal(report.availability.key.observed, true);
  assert.equal(report.availability.key.status, "available");
});

test("empty and absent fields never invent default key, meter, confidence, or tempo", () => {
  for (const input of [null, undefined, {}, result([]), result([event(1, {})])]) {
    const report = analyze(input);
    assert.equal(report.keys.length, 0);
    assert.equal(report.meters.length, 0);
    assert.equal(report.tempo.length, 0);
    assert.equal(report.summary.primaryKey, null);
    assert.equal(report.summary.primaryMeter, null);
    assert.equal(report.summary.tempoBpm, null);
    assert.equal(report.summary.tempoMin, null);
    assert.equal(report.summary.tempoMax, null);
    assert.equal(own(report, "confidence"), false);
  }
});

function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }

test("duration is explicit; annotations at the exact end and beyond are omitted", () => {
  const input = result([event(0, {key: "C:major"}), event(2, {key: "D:minor"}), event(3, {key: "E:minor"})], 2);
  const report = analyze(input);
  assert.equal(report.keys.length, 1);
  assert.equal(report.keys[0].end, 2);
  const unknown = analyze({events: input.events});
  assert.equal(unknown.duration, 0);
  assert.equal(unknown.keys.length, 0);
  assert.ok(unknown.diagnostics.some((message) => message.includes("duration")));
});

test("cursor lookup is half-open, refuses invalid/out-of-range positions, and does not extrapolate tempo", () => {
  const report = analyze(result(beatEvents(4, 4, 0.5, 3), 2));
  assert.equal(atTime(report, 0).tempo.bpm, 120);
  assert.equal(atTime(report, 0.5).tempo.start, 0.5);
  assert.equal(atTime(report, 1).tempo, null);
  for (const time of [-1, 2, 20, NaN, Infinity, null, "0"]) {
    assert.deepEqual(atTime(report, time), {section: null, chord: null, key: null, meter: null, beat: null, tempo: null, notes: {vocal: [], instrumental: []}});
  }
});

test("tempo summary is the median of interval estimates and reports the observed range", () => {
  const report = analyze(result([
    event(0, {rhythm: {meter: [4, 4], eighth_position: 0}}),
    event(0.5, {rhythm: {eighth_position: 2}}), event(1.1, {rhythm: {eighth_position: 4}}),
    event(1.5, {rhythm: {eighth_position: 6}}),
  ]));
  near(report.summary.tempoBpm, 120);
  near(report.summary.tempoMin, 100);
  near(report.summary.tempoMax, 150);
  assert.equal(report.tempo.length, 3);
});

test("analysis does not mutate source events and preserves raw model diagnostics once", () => {
  const input = result([event(1, {key: "C:major", melody: [{pitch: 60, track: 0, end_time: 20}]})], 10);
  input.summary.warnings = ["Review this prediction", "Review this prediction"];
  input.summary.diagnostics = ["Notation padded"];
  input.summary.abc_error = "No key was decoded";
  const before = JSON.stringify(input);
  const report = analyze(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(report.diagnostics.filter((value) => value === "Review this prediction").length, 1);
  assert.ok(report.diagnostics.includes("Notation padded"));
  assert.ok(report.diagnostics.includes("Notation export: No key was decoded"));
  assert.equal(report.melody.vocal[0].end, 10);
});

test("token-limit warnings remain visible instead of claiming complete transcription", () => {
  const input = result([event(0, {key: "C:major"})], 222);
  input.summary.warnings = ["Window 1 reached the token limit; inspect its token coverage"];
  const report = analyze(input);
  assert.ok(report.diagnostics.includes(input.summary.warnings[0]));
  assert.equal(own(report, "complete"), false);
  assert.equal(own(report, "confidence"), false);
});
