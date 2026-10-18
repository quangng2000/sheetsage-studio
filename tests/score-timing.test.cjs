"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {create} = require("../desktop/ui/score-timing.js");
const near = (actual, expected) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);
const measure = (start, end, score_start, score_end, leading_rest = 0, trailing_rest = 0, index = 0) => ({start, end, score_start, score_end, leading_rest, trailing_rest, index});
const grid = (times, numerator = 4, denominator = 4) => times.map((time, index) => `${time}\t${index % numerator + 1}\t${numerator}\t${denominator}`).join("\n");
const result = (measures, text, duration = measures.at(-1)?.end) => ({summary: {duration_seconds: duration}, playback: {duration, measures}, ...(text === undefined ? {} : {score_timing: {version: 1, notation_beats: text}})});

test("UMD exposes ScoreTiming in the browser without dependencies", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("../desktop/ui/score-timing.js"), "utf8"), context);
  assert.equal(typeof context.ScoreTiming.create, "function");
});

test("4/4 maps seconds to whole-note positions and back", () => {
  const timing = create(result([measure(0, 2, 0, 1)], grid([0, 0.5, 1, 1.5, 2])));
  assert.equal(timing.available, true);
  assert.equal(timing.precision, "beat");
  near(timing.audioToScore(0.75), 0.375);
  near(timing.scoreToAudio(0.375), 0.75);
  near(timing.audioToScore(2), 1);
  assert.equal(timing.segments.length, 4);
});

test("piecewise beat interpolation follows tempo changes rather than average tempo", () => {
  const timing = create(result([measure(0, 3, 0, 1)], grid([0, 0.25, 0.75, 1.75, 3])));
  near(timing.audioToScore(0.25), 0.25);
  near(timing.audioToScore(1.25), 0.625);
  near(timing.scoreToAudio(0.625), 1.25);
  near(timing.audioToScore(2.375), 0.875);
});

test("leading rest is a score offset, not extra recorded audio", () => {
  const timing = create(result([measure(0.01, 1.51, 0, 1, 0.625)], grid([0.01, 0.51, 1.01, 1.51], 3, 8)));
  near(timing.audioToScore(0.01), 0.625);
  near(timing.audioToScore(0.51), 0.75);
  near(timing.audioToScore(1.51), 1);
  near(timing.scoreToAudio(0.25), 0.01);
  assert.equal(timing.audioToScore(0), null);
  assert.equal(timing.padding[0].kind, "leading");
});

test("6/8 maps eighth-note beat intervals, not quarter-note intervals", () => {
  const timing = create(result([measure(0, 1.5, 0, 0.75)], grid([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5], 6, 8)));
  near(timing.audioToScore(0.25), 0.125);
  near(timing.scoreToAudio(0.5), 1);
});

test("7/8 pickup padded to 4/4 uses the actual notated length", () => {
  const timing = create(result([measure(0, 1.4, 0, 1, 0.125)], grid([0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4], 7, 8)));
  near(timing.audioToScore(0), 0.125);
  near(timing.audioToScore(0.8), 0.625);
});

test("inferred measure length wins over conflicting raw meter declarations", () => {
  const input = result([measure(0, 0.5, 0, 0.25), measure(0.5, 2.5, 0.25, 1.25, 0, 0, 1)], grid([0, 0.5, 1, 1.5, 2, 2.5]));
  const timing = create(input);
  assert.equal(timing.precision, "beat");
  near(timing.audioToScore(0.5), 0.25);
  near(timing.audioToScore(1), 0.5);
});

test("meter changes preserve each measure's denominator and shared score boundary", () => {
  const beats = [
    ...[0, 0.25, 0.5, 0.75, 1, 1.25].map((time, index) => `${time}\t${index + 1}\t6\t8`),
    ...[1.5, 2, 2.5, 3, 3.5].map((time, index) => `${time}\t${index % 4 + 1}\t4\t4`),
  ].join("\n");
  const timing = create(result([measure(0, 1.5, 0, 0.75), measure(1.5, 3.5, 0.75, 1.75, 0, 0, 1)], beats));
  assert.equal(timing.precision, "beat");
  near(timing.audioToScore(1.25), 0.625);
  near(timing.audioToScore(1.5), 0.75);
  near(timing.audioToScore(2), 1);
});

test("final extrapolated beat retains its slope when audio ends inside the beat", () => {
  const input = result([measure(0, 0.75, 0, 1, 0, 0.75)], grid([0, 1]), 0.75);
  const timing = create(input);
  assert.equal(timing.precision, "beat");
  near(timing.audioToScore(0.5), 0.125);
  near(timing.audioToScore(0.75), 0.1875);
  near(timing.scoreToAudio(0.125), 0.5);
  assert.equal(timing.audioToScore(1), null);
  assert.equal(timing.scoreToAudio(0.2), null); // Unrecorded part of the real beat, not artificial rest.
  near(timing.scoreToAudio(0.5), 0.75); // Artificial trailing rest snaps to recorded end.
});

test("clipping does not rescale earlier beats in the final measure", () => {
  const input = result([measure(0, 1.75, 0, 1)], grid([0, 0.5, 1, 1.5, 2]), 1.75);
  const timing = create(input);
  near(timing.audioToScore(0.5), 0.25);
  near(timing.audioToScore(1.5), 0.75);
  near(timing.audioToScore(1.75), 0.875);
  assert.equal(timing.scoreToAudio(0.9), null);
});

test("trailing/leading artificial rests snap, but actual score/audio gaps do not", () => {
  const timing = create(result([
    measure(0, 0.5, 0, 0.5, 0, 0.25),
    measure(1, 1.5, 1, 1.5, 0.25, 0, 1),
  ], grid([0, 0.5, 1, 1.5])));
  assert.equal(timing.available, true);
  near(timing.scoreToAudio(0.4), 0.5);
  near(timing.scoreToAudio(1.1), 1);
  assert.equal(timing.scoreToAudio(0.75), null);
  assert.equal(timing.audioToScore(0.75), null);
});

test("at a shared audio boundary the new measure wins over previous padding", () => {
  const timing = create(result([
    measure(0, 0.5, 0, 0.5, 0, 0.25),
    measure(0.5, 1, 0.5, 1, 0.25, 0, 1),
  ], grid([0, 0.5, 1])));
  near(timing.audioToScore(0.5), 0.75);
  near(timing.scoreToAudio(0.4), 0.5);
  near(timing.scoreToAudio(0.6), 0.5);
});

test("without exact timing, legacy measure mapping is explicitly approximate", () => {
  const input = result([measure(0, 2, 0, 1)]);
  const timing = create(input);
  assert.equal(timing.available, true);
  assert.equal(timing.precision, "measure");
  assert.match(timing.reason, /Approximate/);
  near(timing.audioToScore(1), 0.5);
  input.score_timing = null;
  assert.equal(create(input).precision, "measure");
});

test("present-but-empty, malformed, or unsupported grids fail safe", () => {
  for (const text of ["", "0\t1\t4\t4", "0\t1\t4\t4\n0\t2\t4\t4", "0\t1\t4\t4\nNaN\t2\t4\t4", "0\t1\t4\t4\n2\t2\t4", "0\t1\t4\t4\n2\t2\t4\t3"]) {
    const timing = create(result([measure(0, 2, 0, 1)], text));
    assert.equal(timing.available, false);
    assert.equal(timing.precision, "unavailable");
    assert.equal(timing.audioToScore(1), null);
  }
  const input = result([measure(0, 2, 0, 1)], grid([0, 0.5, 1, 1.5, 2]));
  input.score_timing.version = 2;
  assert.equal(create(input).available, false);
});

test("mismatched boundary or impossible inferred denominator cannot claim exact timing", () => {
  assert.equal(create(result([measure(0.1, 2, 0, 1)], grid([0, 0.5, 1, 1.5, 2]))).available, false);
  assert.equal(create(result([measure(0, 2, 0, 0.7)], grid([0, 0.5, 1, 1.5, 2]))).available, false);
});

test("invalid, overlapping, reversed, and padding-only measure maps are unavailable", () => {
  for (const input of [null, {}, {playback: {measures: []}}, result([measure(1, 0, 0, 1)]), result([measure(0, 1, 0, 1, 1)]),
    result([measure(0, NaN, 0, 1)]), result([measure(0, 2, 0, 1), measure(1, 3, 1, 2)]),
    result([measure(0, 1, 0, 1), measure(1, 2, 0.5, 1.5)])]) {
    const timing = create(input);
    assert.equal(timing.available, false);
    assert.equal(timing.scoreToAudio(0), null);
  }
});

test("invalid/out-of-domain lookup values do not extrapolate", () => {
  const timing = create(result([measure(1, 3, 1, 2)], grid([1, 1.5, 2, 2.5, 3])));
  for (const value of [-1, 0, 4, NaN, Infinity, null, "1"]) assert.equal(timing.audioToScore(value), null);
  for (const value of [-1, 0, 3, NaN, Infinity, null, "1"]) assert.equal(timing.scoreToAudio(value), null);
  near(timing.audioToScore(1), 1);
  near(timing.scoreToAudio(2), 3);
});

test("read-only construction leaves source metadata unchanged", () => {
  const input = result([measure(0, 2, 0, 1)], grid([0, 0.5, 1, 1.5, 2]));
  const before = JSON.stringify(input);
  create(input);
  assert.equal(JSON.stringify(input), before);
});
