"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {needsCompatibilityPreview, encodePCM16} = require("../desktop/ui/audio-preview.js");

function decoded(channels, sampleRate = 44100) {
  const source = channels.map((channel) => new Float32Array(channel));
  return {numberOfChannels: source.length, length: source[0]?.length ?? 0, sampleRate,
    getChannelData: (channel) => source[channel]};
}
const ascii = (view, start, count) => String.fromCharCode(...new Uint8Array(view.buffer, start, count));

test("browser UMD exports without DOM, Node, or audio APIs", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("../desktop/ui/audio-preview.js"), "utf8"), context);
  assert.equal(typeof context.AudioPreview.needsCompatibilityPreview, "function");
  assert.equal(typeof context.AudioPreview.encodePCM16, "function");
});

test("duration mismatch detection tolerates normal metadata rounding, not doubled clocks", () => {
  assert.equal(needsCompatibilityPreview(443.5, 221.75), true);
  assert.equal(needsCompatibilityPreview(221.75, 221.75), false);
  assert.equal(needsCompatibilityPreview(221.9, 221.75), false);
  assert.equal(needsCompatibilityPreview(100.5, 100), false);
  assert.equal(needsCompatibilityPreview(100.501, 100), true);
  assert.equal(needsCompatibilityPreview(1.25, 1), false);
  assert.equal(needsCompatibilityPreview(1.251, 1), true);
});

test("invalid native clocks request a preview only with a valid decoded duration", () => {
  for (const value of [NaN, Infinity, -Infinity, 0, -1, null, undefined, "221.75"]) {
    assert.equal(needsCompatibilityPreview(value, 221.75), true);
    assert.equal(needsCompatibilityPreview(221.75, value), false);
  }
});

test("PCM16 RIFF header declares the exact dimensions, rate, and payload", () => {
  const buffer = encodePCM16(decoded([[0, 0.5, -1]], 24000));
  assert.ok(buffer instanceof ArrayBuffer);
  const view = new DataView(buffer);
  assert.equal(buffer.byteLength, 50);
  assert.equal(ascii(view, 0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), 42);
  assert.equal(ascii(view, 8, 4), "WAVE");
  assert.equal(ascii(view, 12, 4), "fmt ");
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getUint32(28, true), 48000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(view, 36, 4), "data");
  assert.equal(view.getUint32(40, true), 6);
});

test("stereo samples are interleaved, signed, little-endian, and clamped", () => {
  const buffer = encodePCM16(decoded([[0, 0.5, -1, 2], [1, -0.5, 0.25, -2]]));
  const view = new DataView(buffer);
  const samples = Array.from({length: 8}, (_, index) => view.getInt16(44 + index * 2, true));
  assert.deepEqual(samples, [0, 32767, 16384, -16384, -32768, 8192, 32767, -32768]);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint16(32, true), 4);
  assert.equal(view.getUint32(28, true), 176400);
});

test("one through eight channels are accepted without modifying decoded samples", () => {
  const fixture = decoded(Array.from({length: 8}, () => [-1, 0, 1]));
  const before = Array.from({length: 8}, (_, channel) => Array.from(fixture.getChannelData(channel)));
  const buffer = encodePCM16(fixture);
  assert.equal(buffer.byteLength, 44 + 8 * 3 * 2);
  assert.deepEqual(Array.from({length: 8}, (_, channel) => Array.from(fixture.getChannelData(channel))), before);
});

test("size cap and WAV overflow are rejected before reading channels or allocating PCM", () => {
  let channelReads = 0;
  const fixture = {numberOfChannels: 2, length: 100_000_000, sampleRate: 44100,
    getChannelData() { channelReads++; throw new Error("must not read"); }};
  assert.throws(() => encodePCM16(fixture), /size or WAV-format limit/);
  assert.equal(channelReads, 0);
  assert.throws(() => encodePCM16({...fixture, length: Number.MAX_SAFE_INTEGER}, {maxBytes: Number.MAX_SAFE_INTEGER}), /limit/);
  assert.equal(channelReads, 0);
  assert.throws(() => encodePCM16(decoded([[0]]), {maxBytes: 45}), /limit/);
  assert.equal(encodePCM16(decoded([[0]]), {maxBytes: 46}).byteLength, 46);
});

test("invalid buffer shapes, channel counts, and sample rates are rejected", () => {
  for (const value of [null, undefined, {}, {getChannelData: true}]) assert.throws(() => encodePCM16(value), /buffer/);
  const valid = decoded([[0]]);
  for (const count of [0, -1, 9, 1.5, NaN, "1"]) assert.throws(() => encodePCM16({...valid, numberOfChannels: count}), /channels/);
  for (const frames of [0, -1, 1.5, NaN, Infinity, "1"]) assert.throws(() => encodePCM16({...valid, length: frames}), /frame/);
  for (const rate of [0, -1, 44100.5, NaN, Infinity, "44100", 2 ** 32]) assert.throws(() => encodePCM16({...valid, sampleRate: rate}), /sample rate/);
  assert.throws(() => encodePCM16({...valid, sampleRate: 0xffffffff}), /limit/);
  for (const limit of [-1, 0, 43, NaN, Infinity, 50.5, "100"]) assert.throws(() => encodePCM16(valid, {maxBytes: limit}), /size limit/);
});

test("channels must be complete Float32 arrays", () => {
  const valid = decoded([[0, 1]]);
  for (const samples of [null, [0, 1], new Float64Array([0, 1]), new Int32Array([0, 1]), new Float32Array([0])]) {
    assert.throws(() => encodePCM16({...valid, getChannelData: () => samples}), /Float32 arrays/);
  }
});

test("non-finite decoded samples are rejected rather than silently changing audio", () => {
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => encodePCM16(decoded([[0, value]])), /non-finite sample/);
});
