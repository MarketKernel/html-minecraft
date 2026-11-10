/**
 * Every sound is synthesised: filtered noise for digging, steps and
 * explosions, soft triangle notes for the music. Nothing to download, and the
 * AudioContext starts on the first click, as browsers require.
 */
import type { Material } from '../core/blocks';

/** Filter centre and loudness of the noise for each material. */
const MATERIAL: Record<Material, { freq: number; q: number; gain: number }> = {
  grass: { freq: 900, q: 0.8, gain: 0.5 },
  stone: { freq: 2200, q: 1.2, gain: 0.45 },
  wood: { freq: 600, q: 2.5, gain: 0.6 },
  sand: { freq: 3200, q: 0.6, gain: 0.35 },
  glass: { freq: 5200, q: 3, gain: 0.35 },
  cloth: { freq: 500, q: 0.5, gain: 0.45 },
  snow: { freq: 2600, q: 0.5, gain: 0.3 },
  plant: { freq: 1500, q: 0.7, gain: 0.35 },
  liquid: { freq: 700, q: 1, gain: 0.4 },
};

/** C major pentatonic over two octaves. */
const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0];

export class Sound {
  private ctx: AudioContext | null = null;
  private sfx!: GainNode;
  private music!: GainNode;
  private noise!: AudioBuffer;
  private nextNote = 0;
  private melody = 4;
  private phraseLeft = 0;
  sfxOn = true;
  musicOn = true;

  /** Call from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.5;
    this.sfx.connect(ctx.destination);
    // Music through a soft echo.
    this.music = ctx.createGain();
    this.music.gain.value = 0.11;
    const delay = ctx.createDelay();
    delay.delayTime.value = 0.38;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2400;
    this.music.connect(ctx.destination);
    this.music.connect(delay);
    delay.connect(tone);
    tone.connect(feedback);
    feedback.connect(delay);
    tone.connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.nextNote = ctx.currentTime + 2;
  }

  private burst(duration: number, type: BiquadFilterType, freq: number, q: number, gain: number, sweepTo?: number, when = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn) return;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, t + duration);
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(g).connect(this.sfx);
    src.start(t, Math.random() * 1.5);
    src.stop(t + duration + 0.05);
  }

  private tone(freq: number, duration: number, gain: number, type: OscillatorType = 'sine', bendTo?: number, out?: AudioNode, when = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (bendTo) osc.frequency.exponentialRampToValueAtTime(bendTo, t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(out ?? this.sfx);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  dig(material: Material): void {
    const m = MATERIAL[material];
    this.burst(0.22, 'bandpass', m.freq, m.q, m.gain);
    if (material === 'glass') for (let i = 0; i < 4; i++) this.tone(2400 + Math.random() * 2400, 0.25, 0.05, 'sine', undefined, undefined, i * 0.03);
  }

  place(material: Material): void {
    const m = MATERIAL[material];
    this.burst(0.12, 'lowpass', m.freq * 0.8, 1, m.gain * 0.9);
    if (this.sfxOn) this.tone(160, 0.08, 0.2, 'sine', 80);
  }

  step(material: Material): void {
    const m = MATERIAL[material];
    this.burst(0.09, 'bandpass', m.freq * 0.9, m.q, m.gain * 0.35);
  }

  splash(): void {
    this.burst(0.5, 'bandpass', 1400, 0.6, 0.4, 400);
  }

  fuse(): void {
    this.burst(1.6, 'highpass', 4000, 0.7, 0.18, 6000);
  }

  boom(distance: number): void {
    const loud = Math.max(0.15, 1 - distance / 60);
    this.burst(1.6, 'lowpass', 900, 0.7, 1.2 * loud, 60);
    this.burst(0.5, 'bandpass', 2400, 0.5, 0.5 * loud, 300);
    if (this.sfxOn) this.tone(90, 0.9, 0.6 * loud, 'sine', 30);
  }

  click(): void {
    if (this.sfxOn) this.tone(880, 0.05, 0.08, 'square', 660);
  }

  /** Called every frame: schedules the next few notes of a slow, wandering tune. */
  tick(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicOn) return;
    while (this.nextNote < ctx.currentTime + 0.5) {
      if (this.phraseLeft <= 0) {
        // A rest between phrases, then a new phrase of a few notes.
        this.phraseLeft = 4 + Math.floor(Math.random() * 6);
        this.nextNote += 3 + Math.random() * 7;
        continue;
      }
      this.melody = Math.max(0, Math.min(SCALE.length - 1, this.melody + Math.round((Math.random() - 0.5) * 4)));
      const when = Math.max(0, this.nextNote - ctx.currentTime);
      this.tone(SCALE[this.melody]!, 2.6, 0.5, 'triangle', undefined, this.music, when);
      if (Math.random() < 0.3) this.tone(SCALE[this.melody]! / 2, 3.5, 0.35, 'sine', undefined, this.music, when);
      this.nextNote += [0.45, 0.6, 0.9, 1.2][Math.floor(Math.random() * 4)]!;
      this.phraseLeft--;
    }
  }
}
