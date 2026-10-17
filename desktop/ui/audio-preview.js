/* Local playback compatibility only. Original recordings remain inference input;
 * this module does not rescale clocks, alter model events, or claim losslessness. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AudioPreview = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_MAX_BYTES = 100 * 1024 ** 2;
  const UINT32_MAX = 0xffffffff;
  const positiveDuration = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

  function needsCompatibilityPreview(mediaDuration, decodedDuration) {
    // Without a valid independent decode there is no trustworthy clock to
    // compare against; do not invent a duration or a rescaling factor.
    if (!positiveDuration(decodedDuration)) return false;
    if (!positiveDuration(mediaDuration)) return true;
    return Math.abs(mediaDuration - decodedDuration) > Math.max(0.25, decodedDuration * 0.005);
  }

  function encodePCM16(audioBuffer, {maxBytes = DEFAULT_MAX_BYTES} = {}) {
    if (!audioBuffer || typeof audioBuffer.getChannelData !== "function") {
      throw new TypeError("A decoded audio buffer is required for playback preview.");
    }
    const channels = audioBuffer.numberOfChannels, frames = audioBuffer.length, sampleRate = audioBuffer.sampleRate;
    if (!Number.isSafeInteger(channels) || channels < 1 || channels > 8) {
      throw new RangeError("Playback preview requires between 1 and 8 channels.");
    }
    if (!Number.isSafeInteger(frames) || frames < 1) {
      throw new RangeError("Playback preview requires a positive integer frame count.");
    }
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 1 || sampleRate > UINT32_MAX) {
      throw new RangeError("Playback preview requires a valid integer sample rate.");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 44) {
      throw new RangeError("Playback preview size limit must be an integer of at least 44 bytes.");
    }

    const blockAlign = channels * 2, byteRate = sampleRate * blockAlign;
    const dataBytes = frames * blockAlign, totalBytes = dataBytes + 44;
    // Check bounds before allocating PCM, including the WAV format's own size
    // limits. A small compressed recording can decode to gigabytes of samples.
    if (!Number.isSafeInteger(dataBytes) || dataBytes > UINT32_MAX || totalBytes - 8 > UINT32_MAX ||
        totalBytes > maxBytes || byteRate > UINT32_MAX) {
      throw new RangeError("Decoded playback preview exceeds its size or WAV-format limit.");
    }
    const source = [];
    for (let channel = 0; channel < channels; channel++) {
      const samples = audioBuffer.getChannelData(channel);
      if (!ArrayBuffer.isView(samples) || Object.prototype.toString.call(samples) !== "[object Float32Array]" || samples.length !== frames) {
        throw new TypeError("Decoded channels must be Float32 arrays matching the frame count.");
      }
      source.push(samples);
    }

    const buffer = new ArrayBuffer(totalBytes), view = new DataView(buffer);
    const text = (offset, value) => {
      for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
    };
    text(0, "RIFF"); view.setUint32(4, totalBytes - 8, true); text(8, "WAVE");
    text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, dataBytes, true);

    let offset = 44;
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        const raw = source[channel][frame];
        if (!Number.isFinite(raw)) throw new TypeError("Decoded playback audio contains a non-finite sample.");
        const sample = Math.max(-1, Math.min(1, raw));
        view.setInt16(offset, Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff)), true);
        offset += 2;
      }
    }
    return buffer;
  }

  return Object.freeze({needsCompatibilityPreview, encodePCM16});
});
