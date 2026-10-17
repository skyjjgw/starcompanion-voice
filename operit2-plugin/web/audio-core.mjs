/* Original StarCompanion implementation. SPDX-License-Identifier: MIT */
export const SAMPLE_RATE = 16000;

export class MonoResampler {
  constructor(sourceRate, targetRate = SAMPLE_RATE) {
    if (!Number.isFinite(sourceRate) || sourceRate < targetRate || targetRate <= 0) throw new Error('Unsupported sample rate');
    this.ratio = sourceRate / targetRate;
    this.weight = 0;
    this.sum = 0;
  }
  push(input) {
    const output = [];
    for (const raw of input) {
      let remaining = 1;
      const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      while (remaining > 1e-9) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= this.ratio - 1e-9) {
          output.push(this.sum / this.ratio);
          this.sum = 0;
          this.weight = 0;
        }
      }
    }
    return Float32Array.from(output);
  }
}

export function encodeWav(samples) {
  if (!samples.length || samples.length > SAMPLE_RATE * 15) throw new Error('Audio must be between 1 sample and 15 seconds');
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Uint8Array(buffer);
}

// Energy segmentation for the foreground MVP. This is not a neural VAD.
export class SpeechSegmenter {
  constructor({ onStart, onSegment, onLevel } = {}) {
    this.onStart = onStart || (() => {});
    this.onSegment = onSegment || (() => {});
    this.onLevel = onLevel || (() => {});
    this.frame = []; this.pre = []; this.recording = null;
    this.noise = 0.003; this.loudFrames = 0; this.silentFrames = 0; this.voicedFrames = 0;
  }
  push(samples) {
    for (const value of samples) {
      this.frame.push(value);
      if (this.frame.length === 320) { this.processFrame(this.frame); this.frame = []; }
    }
  }
  processFrame(frame) {
    const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length);
    const voiced = rms > Math.max(0.012, this.noise * 3.2);
    this.onLevel(Math.min(1, rms * 12));
    if (!this.recording) {
      this.pre.push(...frame);
      if (this.pre.length > 4800) this.pre.splice(0, this.pre.length - 4800);
      if (!voiced) this.noise = this.noise * 0.98 + Math.min(rms, 0.015) * 0.02;
      this.loudFrames = voiced ? this.loudFrames + 1 : 0;
      if (this.loudFrames >= 3) {
        this.recording = this.pre.splice(0); this.voicedFrames = 3; this.silentFrames = 0;
        this.onStart();
      }
      return;
    }
    this.recording.push(...frame);
    if (voiced) { this.voicedFrames++; this.silentFrames = 0; } else this.silentFrames++;
    if (this.silentFrames >= 32 || this.recording.length >= SAMPLE_RATE * 15) {
      const segment = this.recording.slice(0, SAMPLE_RATE * 15);
      const usable = this.voicedFrames >= 10;
      this.reset();
      if (usable) this.onSegment(Float32Array.from(segment));
    }
  }
  reset() {
    this.frame = []; this.pre = []; this.recording = null;
    this.loudFrames = 0; this.silentFrames = 0; this.voicedFrames = 0;
  }
}

globalThis.StarVoiceAudio = { SAMPLE_RATE, MonoResampler, encodeWav, SpeechSegmenter };
