/* Original-audio seconds <-> ABC whole-note positions. This is an alignment
 * utility, not a player: the original recording remains the transport clock. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ScoreTiming = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const close = (left, right) => Math.abs(left - right) <= 0.000001;
  const wholeClose = (left, right) => Math.abs(left - right) <= 1e-9;

  function failure(reason) {
    return {available: false, precision: "unavailable", reason, segments: [], padding: [],
      audioToScore: () => null, scoreToAudio: () => null};
  }

  function readMeasures(result) {
    const raw = result?.playback?.measures;
    if (!Array.isArray(raw) || !raw.length) throw new Error("No score-to-audio measure map is available.");
    return raw.map((row, order) => {
      if (!row || typeof row !== "object") throw new Error("The score measure map contains an invalid row.");
      const values = [row.start, row.end, row.score_start, row.score_end];
      const leading = row.leading_rest ?? 0, trailing = row.trailing_rest ?? 0;
      if (!values.every(finite) || row.start < 0 || row.end <= row.start || row.score_start < 0 || row.score_end <= row.score_start ||
          !finite(leading) || !finite(trailing) || leading < 0 || trailing < 0 || leading + trailing >= row.score_end - row.score_start) {
        throw new Error("The score measure map contains invalid times, positions, or padding.");
      }
      return {index: Number.isSafeInteger(row.index) ? row.index : order,
        start: row.start, end: row.end, scoreStart: row.score_start, scoreEnd: row.score_end,
        actualStart: row.score_start + leading, actualEnd: row.score_end - trailing, leading, trailing};
    }).map((row, index, rows) => {
      const previous = rows[index - 1];
      if (previous && (row.start < previous.end - 0.000001 || row.scoreStart < previous.scoreEnd - 1e-9)) {
        throw new Error("Score measures overlap or are not in chronological order.");
      }
      return row;
    });
  }

  function readBeats(source) {
    if (source.version !== 1 || typeof source.notation_beats !== "string") throw new Error("The exported notation timing grid has an unsupported format.");
    if (!source.notation_beats.trim()) throw new Error("The exported notation timing grid is empty.");
    const beats = source.notation_beats.trim().split(/\r?\n/).map((line) => {
      const columns = line.trim().split(/\s+/);
      if (columns.length !== 4) throw new Error("The exported notation timing grid has an invalid row.");
      const [time, position, numerator, denominator] = columns.map(Number);
      if (!finite(time) || time < 0 || ![position, numerator, denominator].every((value) => Number.isSafeInteger(value) && value > 0) ||
          !Number.isInteger(Math.log2(denominator))) throw new Error("The exported notation timing grid has an invalid row.");
      return time;
    });
    if (beats.length < 2 || beats.some((time, index) => index > 0 && time <= beats[index - 1])) {
      throw new Error("The exported notation beat times must be strictly increasing.");
    }
    return beats;
  }

  // Returns {available, precision, reason, segments, padding,
  // audioToScore(seconds), scoreToAudio(wholeNotes)}. Lookups return number|null.
  // "beat" follows the exact saved notation grid, not raw decoder note onsets;
  // "measure" is an explicitly approximate fallback for legacy/missing grids.
  function create(result) {
    let measures;
    try { measures = readMeasures(result); } catch (error) { return failure(error.message); }
    const duration = [result?.summary?.duration_seconds, result?.playback?.duration].find((value) => finite(value) && value > 0) ?? measures[measures.length - 1].end;
    const exact = result?.score_timing !== null && result?.score_timing !== undefined;
    let beats = null;
    if (exact) {
      try { beats = readBeats(result.score_timing); } catch (error) { return failure(error.message); }
    }
    const segments = [], padding = [];
    function segment(audioStart, audioEnd, scoreStart, scoreEnd, measure) {
      const clippedStart = Math.max(audioStart, measure.start), clippedEnd = Math.min(audioEnd, measure.end, duration);
      if (clippedEnd <= clippedStart) return;
      // Interpolate BEFORE clipping: an extrapolated final beat can lie beyond
      // the recording. Shortening its slope would stretch the entire last bar.
      const slope = (scoreEnd - scoreStart) / (audioEnd - audioStart);
      if (!finite(slope) || slope <= 0) throw new Error("The score timing interval has an invalid slope.");
      segments.push({audioStart: clippedStart, audioEnd: clippedEnd,
        scoreStart: scoreStart + (clippedStart - audioStart) * slope,
        scoreEnd: scoreStart + (clippedEnd - audioStart) * slope, measureIndex: measure.index});
    }
    try {
      measures.forEach((measure, index) => {
        if (exact) {
          const first = beats.findIndex((time) => close(time, measure.start));
          let last = beats.findIndex((time) => close(time, measure.end));
          // Only the final measure may end between its last two notation knots:
          // upstream clips playback.end to duration, but retains the full knot.
          if (last === -1 && index === measures.length - 1 && measure.end <= beats[beats.length - 1] && measure.end > beats[beats.length - 2]) last = beats.length - 1;
          if (first === -1 || last <= first) throw new Error("The notation beat grid does not match the score measure boundaries.");
          if (index < measures.length - 1 && beats[last] > measures[index + 1].start + 0.000001) throw new Error("The notation grid crosses a score measure boundary.");
          const count = last - first, step = (measure.actualEnd - measure.actualStart) / count;
          // The canonical grid uses a constant denominator within each measure,
          // including inferred meters. Do not trust conflicting raw declarations.
          const denominator = Math.round(1 / step);
          if (!Number.isSafeInteger(denominator) || denominator < 1 || !Number.isInteger(Math.log2(denominator)) || !wholeClose(step, 1 / denominator)) {
            throw new Error("The notation beat grid and nonpadding score length are inconsistent.");
          }
          for (let beat = first; beat < last; beat++) {
            const scoreStart = measure.actualStart + (beat - first) * step;
            segment(beats[beat], beats[beat + 1], scoreStart, scoreStart + step, measure);
          }
        } else {
          segment(measure.start, measure.end, measure.actualStart, measure.actualEnd, measure);
        }
        if (measure.start < duration) {
          if (measure.leading) padding.push({scoreStart: measure.scoreStart, scoreEnd: measure.actualStart,
            audioTime: measure.start, kind: "leading", measureIndex: measure.index});
          if (measure.trailing) padding.push({scoreStart: measure.actualEnd, scoreEnd: measure.scoreEnd,
            audioTime: Math.min(measure.end, duration), kind: "trailing", measureIndex: measure.index});
        }
      });
    } catch (error) { return failure(error.message); }
    if (!segments.length) return failure("The score has no mapped audio inside this recording.");

    function lookup(values, position, start, end) {
      let low = 0, high = values.length - 1, candidate = -1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (values[middle][start] <= position) { candidate = middle; low = middle + 1; }
        else high = middle - 1;
      }
      if (candidate === -1 || position > values[candidate][end]) return null;
      return values[candidate];
    }
    function audioToScore(time) {
      if (!finite(time)) return null;
      const item = lookup(segments, time, "audioStart", "audioEnd");
      if (!item) return null;
      return item.scoreStart + (time - item.audioStart) / (item.audioEnd - item.audioStart) * (item.scoreEnd - item.scoreStart);
    }
    function scoreToAudio(position) {
      if (!finite(position)) return null;
      const item = lookup(segments, position, "scoreStart", "scoreEnd");
      if (item) return item.audioStart + (position - item.scoreStart) / (item.scoreEnd - item.scoreStart) * (item.audioEnd - item.audioStart);
      // Written padding has no recorded duration. Seeking there snaps to the
      // adjoining real boundary; genuine unmapped score gaps remain unavailable.
      const rest = padding.find((part) => position >= part.scoreStart && position <= part.scoreEnd);
      return rest ? rest.audioTime : null;
    }
    return {available: true, precision: exact ? "beat" : "measure",
      reason: exact ? "Aligned to the exported notation beat grid, including notation padding and local tempo changes."
        : "Approximate measure-only alignment: the exact notation beat grid is unavailable; within-bar and final clipped timing may differ.",
      segments, padding, audioToScore, scoreToAudio};
  }

  return Object.freeze({create});
});
