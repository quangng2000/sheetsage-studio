/* Adapter for the pinned abcjs 6.6.3 rendered glyph structure.
 *
 * Durations here are whole-note fractions, NOT milliseconds or measures.
 * Reading each voice independently keeps sustained notes, ties, and rests
 * separate; abcjs noteTimings intentionally combines simultaneous onsets and
 * tied SVG fragments and therefore cannot provide per-glyph lifetimes.
 *
 * This is a visual score traversal, not repeat-expanded MIDI performance.
 * Retest this adapter whenever the bundled abcjs version changes. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ScoreElements = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const integer = (value) => Number.isInteger(value) && value >= 0;

  function collect(tune) {
    const groups = tune?.engraver?.staffgroups;
    if (!Array.isArray(groups)) return [];
    const state = new Map(), result = [];
    groups.forEach((group, systemIndex) => {
      if (!group || !Array.isArray(group.voices)) return;
      group.voices.forEach((voice, flatVoiceIndex) => {
        if (!voice || voice.staff?.isTabStaff || !Array.isArray(voice.children)) return;
        // abcjs adds voices in staff order, then local voice order, on every
        // system. The staff reference distinguishes v0 on different staves.
        const foundStaff = Array.isArray(group.staffs) ? group.staffs.indexOf(voice.staff) : -1;
        const staffIndex = foundStaff >= 0 ? foundStaff : flatVoiceIndex;
        const voiceNumber = integer(voice.voicenumber) ? voice.voicenumber : 0;
        const voiceKey = `${staffIndex}:${voiceNumber}`;
        if (!state.has(voiceKey)) state.set(voiceKey, {time:0, measure:0, hasMeasureContent:false});
        const clock = state.get(voiceKey);
        for (const absoluteElement of voice.children) {
          const abcelem = absoluteElement?.abcelem;
          if (!abcelem || absoluteElement.hint) continue;
          if (abcelem.el_type === "bar" || absoluteElement.type === "bar") {
            if (clock.hasMeasureContent) { clock.measure++; clock.hasMeasureContent=false; }
            continue;
          }
          if (abcelem.el_type !== "note" || abcelem.rest?.type === "spacer") continue;
          // A zero-duration grace/spacing note is given a positive engraving
          // width by abcjs. It must still consume no score time.
          if (finite(abcelem.duration) && abcelem.duration <= 0) continue;
          // durationClass preserves actual musical duration for multi-measure
          // rests and contains the applied tuplet multiplier. .duration can be
          // changed to 1 for layout of a multimeasure-rest symbol.
          const duration = finite(absoluteElement.durationClass) ? absoluteElement.durationClass : absoluteElement.duration;
          if (!finite(duration) || duration <= 0) continue;
          const elements = Array.isArray(absoluteElement.elemset)
            ? [...new Set(absoluteElement.elemset.filter((element) => element !== null && element !== undefined))]
            : [];
          const pitches = Array.isArray(abcelem.pitches) ? abcelem.pitches : [];
          result.push({
            start:clock.time, end:clock.time+duration, duration,
            elements, rest:Boolean(abcelem.rest), voice:flatVoiceIndex,
            voiceKey, voiceNumber, staffIndex, measureIndex:clock.measure,
            lineIndex:integer(group.line) ? group.line : systemIndex,
            startChar:integer(abcelem.startChar) ? abcelem.startChar : null,
            endChar:integer(abcelem.endChar) ? abcelem.endChar : null,
            x:finite(absoluteElement.x) ? absoluteElement.x : null,
            width:finite(absoluteElement.w) ? absoluteElement.w : null,
            tieStart:pitches.some((pitch) => Boolean(pitch.startTie)),
            tieEnd:pitches.some((pitch) => Boolean(pitch.endTie)),
            abcelem, absoluteElement,
          });
          clock.time += duration;
          clock.hasMeasureContent=true;
        }
      });
    });
    return result.sort((left,right) => left.start-right.start || left.voice-right.voice || left.lineIndex-right.lineIndex);
  }
  return Object.freeze({collect});
});
