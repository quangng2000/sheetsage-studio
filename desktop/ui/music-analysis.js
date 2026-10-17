/* Offline views of the official model's decoded events. No musical predictions
 * are added here. Tempo is the sole derived feature and is labelled as such. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MusicAnalysis = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

  function eventList(result) {
    if (Array.isArray(result?.events)) return result.events;
    return Array.isArray(result?.events?.events) ? result.events.events : [];
  }

  function analyzedDuration(result) {
    // Prefer the actual analyzed excerpt over the original recording's length.
    for (const value of [result?.summary?.duration_seconds, result?.duration_seconds,
      result?.playback?.duration, result?.duration]) {
      if (finite(value) && value > 0) return value;
    }
    return 0;
  }

  function median(values) {
    if (!values.length) return null;
    const ordered = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  function regions(points, duration) {
    const ordered = Array.from(points.entries()).sort((a, b) => a[0] - b[0]);
    const result = [];
    ordered.forEach(([start, value], index) => {
      const end = ordered[index + 1]?.[0] ?? duration;
      if (!value || end <= start) return;
      const previous = result[result.length - 1];
      if (previous && previous.end === start && previous.label === value.label) previous.end = end;
      else result.push({start, end, ...value, source: "model"});
    });
    return result;
  }

  function predominant(regions) {
    const spans = new Map();
    for (const region of regions) spans.set(region.label, (spans.get(region.label) || 0) + region.end - region.start);
    let label = null, longest = 0;
    for (const [candidate, length] of spans) {
      if (length > longest) { label = candidate; longest = length; }
    }
    return label;
  }

  function requestedPrompts(result) {
    for (const candidate of [result?.summary?.prompts, result?.events?.prompts, result?.prompts]) {
      if (Array.isArray(candidate)) return new Set(candidate.filter((value) => typeof value === "string"));
    }
    return null;
  }

  function availability(result, report) {
    const prompts = requestedPrompts(result);
    const rhythm = ["downbeat_meter"];
    const melody = ["melody_full", "melody_vocal"];
    const definitions = {
      beats: [report.beats.length, rhythm, "model", "Model-predicted beats"],
      downbeats: [report.downbeats.length, rhythm, "model", "Model-predicted downbeats"],
      tempo: [report.tempo.length, rhythm, "derived", "Derived from predicted beats"],
      meter: [report.meters.length, rhythm, "model", "Model-predicted meter"],
      melody: [report.melody.vocal.length + report.melody.instrumental.length, melody, "model", "Raw model-predicted melody"],
      vocal: [report.melody.vocal.length, melody, "model", "Model-predicted vocal melody"],
      instrumental: [report.melody.instrumental.length, ["melody_full"], "model", "Model-predicted instrumental melody"],
      chords: [report.chords.length, ["chord_full", "chord_majmin"], "model", "Model-predicted chords"],
      key: [report.keys.length, ["key"], "model", "Model-predicted key"],
      structure: [report.sections.length, ["structure"], "model", "Model-predicted structure"],
    };
    return Object.fromEntries(Object.entries(definitions).map(([feature, [count, tasks, source, label]]) => {
      const observed = count > 0;
      const requested = prompts ? tasks.some((task) => prompts.has(task)) : null;
      return [feature, {observed, requested, status: observed ? "available" : requested === false ? "not_requested" : "not_returned", source, label}];
    }));
  }

  function analyze(result) {
    const duration = analyzedDuration(result);
    const diagnostics = [];
    const diagnosticSet = new Set();
    function diagnostic(message) {
      if (typeof message !== "string" || !message || diagnosticSet.has(message)) return;
      diagnosticSet.add(message);
      diagnostics.push(message);
    }
    for (const messages of [result?.summary?.warnings, result?.summary?.diagnostics, result?.warnings, result?.diagnostics]) {
      if (Array.isArray(messages)) messages.forEach(diagnostic);
    }
    if (typeof result?.summary?.abc_error === "string" && result.summary.abc_error) diagnostic(`Notation export: ${result.summary.abc_error}`);
    if (!duration) diagnostic("Analyzed duration is unavailable; no timeline has been inferred from isolated events.");

    const report = {duration, sections: [], chords: [], keys: [], meters: [], beats: [], downbeats: [],
      tempo: [], melody: {vocal: [], instrumental: []}, summary: {}, availability: {}, diagnostics};
    const fields = {structure: new Map(), chord: new Map(), key: new Map()};
    const rhythms = new Map(), melodies = new Map();
    // Stable order preserves the latest scalar value at a duplicated timestamp.
    // Melody is a note collection: upstream exports every event's notes, even
    // when several events share an onset or contain identical notes.
    const ordered = [];
    eventList(result).forEach((event, index) => {
      if (!object(event) || !object(event.values)) {
        diagnostic("Ignored an event without a valid values object.");
        return;
      }
      const time = own(event, "time") ? event.time : event.values.timestamp;
      if (!finite(time)) { diagnostic("Ignored an invalid event timestamp."); return; }
      if (!duration || time >= duration) return;
      ordered.push({time, index, values: event.values});
    });
    ordered.sort((a, b) => a.time - b.time || a.index - b.index);

    for (const {time, values} of ordered) {
      // A note crossing the excerpt start can be clipped; a negative onset is
      // not evidence for a key, beat, or section at the start of the excerpt.
      if (own(values, "melody")) {
        if (Array.isArray(values.melody)) {
          const notes = melodies.get(time) || [];
          notes.push(...values.melody);
          melodies.set(time, notes);
        } else diagnostic("Ignored an invalid melody prediction.");
      }
      if (time < 0) { diagnostic("Ignored annotations before the analyzed range; crossing melody notes are clipped."); continue; }
      for (const field of Object.keys(fields)) {
        if (!own(values, field)) continue;
        const label = typeof values[field] === "string" ? values[field].trim() : "";
        fields[field].set(time, label ? {label} : null);
        if (!label) diagnostic(`An empty or invalid ${field} prediction leaves a gap until the next valid prediction.`);
      }
      if (own(values, "rhythm")) {
        if (!object(values.rhythm)) { diagnostic("Ignored an invalid rhythm prediction."); continue; }
        const merged = rhythms.get(time) || {};
        for (const property of ["meter", "eighth_position"]) {
          if (own(values.rhythm, property)) merged[property] = values.rhythm[property];
        }
        rhythms.set(time, merged);
      }
    }
    report.sections = regions(fields.structure, duration);
    report.chords = regions(fields.chord, duration);
    report.keys = regions(fields.key, duration);

    const meterPoints = new Map();
    let meter = null, bar = null;
    for (const [time, rhythm] of Array.from(rhythms.entries()).sort((a, b) => a[0] - b[0])) {
      if (own(rhythm, "meter")) {
        const candidate = rhythm.meter;
        if (Array.isArray(candidate) && candidate.length === 2 && candidate.every(positiveInteger)) {
          meter = {numerator: candidate[0], denominator: candidate[1], label: `${candidate[0]}/${candidate[1]}`};
          meterPoints.set(time, meter);
        } else {
          meter = null;
          meterPoints.set(time, null);
          diagnostic("An invalid meter prediction leaves a gap until the next valid meter.");
        }
      }
      if (!own(rhythm, "eighth_position")) continue;
      if (!meter) { diagnostic("A beat without a preceding valid meter cannot be placed on a beat grid."); continue; }
      const eighthPosition = rhythm.eighth_position;
      // Match upstream exports_sheetsage2.rhythm_rows exactly: the token is an
      // eighth-note position, not a 4/4 beat index. Position is one-based.
      const zeroPosition = eighthPosition * meter.denominator / 8;
      if (!Number.isSafeInteger(eighthPosition) || !Number.isSafeInteger(zeroPosition) || zeroPosition < 0 || zeroPosition >= meter.numerator) {
        diagnostic("Ignored an eighth-note position that is outside the predicted meter's denominator-beat grid.");
        continue;
      }
      const position = zeroPosition + 1, downbeat = position === 1;
      if (downbeat) bar = bar === null ? 1 : bar + 1;
      report.beats.push({time, position, numerator: meter.numerator, denominator: meter.denominator,
        eighthPosition, downbeat, bar, source: "model"});
    }
    report.meters = regions(meterPoints, duration);
    report.downbeats = report.beats.filter((beat) => beat.downbeat);

    for (let index = 1; index < report.beats.length; index++) {
      const previous = report.beats[index - 1], current = report.beats[index];
      const elapsed = current.time - previous.time;
      const changedMeter = report.meters.some((region) => region.start > previous.time && region.start <= current.time);
      if (!finite(elapsed) || elapsed <= 0 || changedMeter || previous.numerator !== current.numerator || previous.denominator !== current.denominator) continue;
      if (current.position !== previous.position % previous.numerator + 1) {
        diagnostic("Tempo is unavailable across nonconsecutive predicted beat positions; missing beats were not invented.");
        continue;
      }
      // Each interval spans one denominator beat: 6/8 eighth-note pulses at
      // 0.25 s correspond to quarter-note BPM 120, not 240 or dotted-quarter 80.
      const bpm = 60 / elapsed * 4 / previous.denominator;
      if (finite(bpm) && bpm > 0) report.tempo.push({start: previous.time, end: current.time, bpm, source: "derived"});
    }

    for (const [time, notes] of Array.from(melodies.entries()).sort((a, b) => a[0] - b[0])) {
      if (!Array.isArray(notes)) { diagnostic("Ignored an invalid melody prediction."); continue; }
      for (const note of notes) {
        if (!object(note) || !finite(note.end_time) || !Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 || ![0, 1].includes(note.track)) {
          diagnostic("Ignored an invalid raw melody note."); continue;
        }
        const start = Math.max(0, time), end = Math.min(duration, note.end_time);
        if (end <= start) { diagnostic("Ignored a melody note with no positive duration in the analyzed range."); continue; }
        const track = note.track === 0 ? "vocal" : "instrumental";
        report.melody[track].push({start, end, pitch: note.pitch, track: note.track, source: "model"});
      }
    }

    const tempos = report.tempo.map((point) => point.bpm);
    report.summary = {
      durationSeconds: duration, tempoBpm: median(tempos),
      tempoMin: tempos.length ? Math.min(...tempos) : null,
      tempoMax: tempos.length ? Math.max(...tempos) : null,
      beatCount: report.beats.length, downbeatCount: report.downbeats.length, barCount: report.downbeats.length,
      sectionCount: report.sections.length, chordCount: report.chords.length, keyCount: report.keys.length, meterCount: report.meters.length,
      vocalNotes: report.melody.vocal.length, instrumentalNotes: report.melody.instrumental.length,
      melodyNotes: report.melody.vocal.length + report.melody.instrumental.length,
      primaryKey: predominant(report.keys), primaryMeter: predominant(report.meters),
    };
    report.availability = availability(result, report);
    return report;
  }

  function atTime(report, time) {
    const current = {section: null, chord: null, key: null, meter: null, beat: null, tempo: null, notes: {vocal: [], instrumental: []}};
    if (!report || !finite(time) || time < 0 || time >= report.duration) return current;
    const regionAt = (values) => (Array.isArray(values) ? values.find((region) => time >= region.start && time < region.end) : null) || null;
    current.section = regionAt(report.sections);
    current.chord = regionAt(report.chords);
    current.key = regionAt(report.keys);
    current.meter = regionAt(report.meters);
    current.tempo = regionAt(report.tempo);
    for (const beat of report.beats || []) {
      if (beat.time > time) break;
      current.beat = beat;
    }
    // A new meter without its next beat must not inherit a stale position from
    // the old meter. The same applies to a deliberate invalid-meter gap.
    if (!current.meter || (current.beat && current.beat.time < current.meter.start)) current.beat = null;
    for (const track of ["vocal", "instrumental"]) current.notes[track] = (report.melody?.[track] || []).filter((note) => time >= note.start && time < note.end);
    return current;
  }

  return Object.freeze({analyze, atTime});
});
