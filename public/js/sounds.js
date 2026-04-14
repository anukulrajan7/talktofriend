class Sounds {
  constructor() {
    this.ctx = null; // lazy init AudioContext (needs user gesture)
    this.enabled = true;
  }

  _ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.ctx;
  }

  // Helper: play a chord (multiple notes simultaneously) — richer Discord-like sound
  _playChord(freqs, duration = 0.3, volume = 0.04, type = "sine") {
    try {
      const ctx = this._ensureContext();
      freqs.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 2000;
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.04);
        gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.04);
        gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + i * 0.04 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.04 + duration);
        osc.start(ctx.currentTime + i * 0.04);
        osc.stop(ctx.currentTime + i * 0.04 + duration);
      });
    } catch (e) { /* ignore */ }
  }

  // Discord-style ascending chord for peer join
  join() {
    if (!this.enabled) return;
    this._playChord([392, 523, 659], 0.35, 0.05); // G4 C5 E5 — major chord ascending
  }

  // Discord-style descending chord for peer leave
  leave() {
    if (!this.enabled) return;
    this._playChord([659, 523, 392], 0.3, 0.04); // E5 C5 G4 — descending
  }

  // Soft pop for new chat message
  chat() {
    if (!this.enabled) return;
    this._playChord([880, 1047], 0.12, 0.05, "triangle"); // A5 C6 — quick pop
  }

  // Celebratory chime for emoji reactions
  reaction() {
    if (!this.enabled) return;
    try {
      const ctx = this._ensureContext();
      const freqs = [523, 659, 784]; // C5 E5 G5
      freqs.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.07);
        gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.07);
        gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + i * 0.07 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.07 + 0.2);
        osc.start(ctx.currentTime + i * 0.07);
        osc.stop(ctx.currentTime + i * 0.07 + 0.2);
      });
    } catch (e) { /* ignore audio errors */ }
  }

  // Mute — quick descending two-note (Discord style)
  mute() {
    if (!this.enabled) return;
    this._playChord([523, 392], 0.15, 0.06, "triangle"); // C5→G4 down
  }

  // Unmute — quick ascending two-note
  unmute() {
    if (!this.enabled) return;
    this._playChord([392, 523], 0.15, 0.06, "triangle"); // G4→C5 up
  }

  // Ultra-quiet hover tick (G6 sine) — subtle haptic feedback
  hover() {
    if (!this.enabled) return;
    this._playChord([1568], 0.04, 0.015, "sine");
  }

  // Snappy click (C6 + E6 triangle) — button press feedback
  click() {
    if (!this.enabled) return;
    this._playChord([1047, 1319], 0.06, 0.03, "triangle");
  }

  // Playful nudge boing — descending sine wobble
  nudge() {
    if (!this.enabled) return;
    try {
      const ctx = this._ensureContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(400, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.15);
      osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.25);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) {}
  }

  // Richer chord for first-connection celebration (C5 E5 G5 C6)
  celebrate() {
    if (!this.enabled) return;
    this._playChord([523, 659, 784, 1047], 0.5, 0.06, "sine");
  }

  // Soft low tone for errors
  error() {
    if (!this.enabled) return;
    try {
      const ctx = this._ensureContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(180, ctx.currentTime + 0.25);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) { /* ignore audio errors */ }
  }
}
