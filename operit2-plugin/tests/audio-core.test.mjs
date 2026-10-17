import test from 'node:test';
import assert from 'node:assert/strict';
import { MonoResampler, encodeWav, SpeechSegmenter } from '../web/audio-core.mjs';

test('resampling preserves DC amplitude, duration, and chunk boundaries at 44.1 kHz', () => {
  const input = new Float32Array(44100).fill(0.25);
  const whole = new MonoResampler(44100).push(input);
  const resampler = new MonoResampler(44100);
  const chunks = [];
  for (let offset = 0; offset < input.length; offset += 713) chunks.push(...resampler.push(input.subarray(offset, offset + 713)));
  assert.equal(whole.length, 16000);
  assert.deepEqual(Array.from(whole), chunks);
  assert.ok(chunks.every(value => Math.abs(value - 0.25) < 1e-6));
});
test('WAV is real mono PCM16 with correct clipping and byte lengths', () => {
  const wav = encodeWav(Float32Array.from([-2, -1, 0, 0.5, 1, 2]));
  const view = new DataView(wav.buffer);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), wav.length - 8);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(54, true), 32767);
  assert.throws(() => encodeWav(new Float32Array(240001)), /15 seconds/);
});
test('VAD ignores silence and clicks, emits speech with pre-roll and trailing silence', () => {
  let starts = 0;
  const segments = [];
  const vad = new SpeechSegmenter({ onStart: () => starts++, onSegment: samples => segments.push(samples) });
  vad.push(new Float32Array(16000));
  assert.equal(starts, 0);
  vad.push(new Float32Array(320).fill(0.3));
  vad.push(new Float32Array(16000));
  assert.equal(segments.length, 0);
  vad.push(new Float32Array(8000).fill(0.15));
  vad.push(new Float32Array(11000));
  assert.equal(starts, 1);
  assert.equal(segments.length, 1);
  assert.ok(segments[0].length > 8000);
  assert.ok(segments[0].slice(0, 3200).every(value => value === 0));
});
test('VAD caps sustained speech at fifteen seconds and reset drops partial audio', () => {
  const segments = [];
  const vad = new SpeechSegmenter({ onSegment: samples => segments.push(samples) });
  vad.push(new Float32Array(16 * 16000).fill(0.15));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].length, 240000);
  vad.reset(); vad.push(new Float32Array(16000));
  assert.equal(segments.length, 1);
});
