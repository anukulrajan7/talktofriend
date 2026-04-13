class SpeakingDetector {
  constructor({ onSpeakingChange }) {
    this.onSpeakingChange = onSpeakingChange;
    this.ctx = null;
    this.analysers = new Map(); // peerId -> { analyser, data, rafId, speaking }
    this.THRESHOLD = 15; // volume threshold (0-128)
    this.DEBOUNCE_MS = 500; // time speaking must drop before "not speaking"
  }

  _ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.ctx;
  }

  track(peerId, stream) {
    if (this.analysers.has(peerId)) this.untrack(peerId);

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    try {
      const ctx = this._ensureContext();
      const source = ctx.createMediaStreamSource(new MediaStream([audioTracks[0]]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const entry = { analyser, data, rafId: null, speaking: false, lastActive: 0 };
      this.analysers.set(peerId, entry);

      const loop = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;

        const now = Date.now();
        const active = avg > this.THRESHOLD;

        if (active) entry.lastActive = now;

        const wasSpeaking = entry.speaking;
        const nowSpeaking = active || (now - entry.lastActive) < this.DEBOUNCE_MS;

        if (wasSpeaking !== nowSpeaking) {
          entry.speaking = nowSpeaking;
          this.onSpeakingChange?.(peerId, nowSpeaking);
        }

        entry.rafId = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) {
      console.warn("SpeakingDetector: failed to track", peerId, e);
    }
  }

  untrack(peerId) {
    const entry = this.analysers.get(peerId);
    if (entry) {
      if (entry.rafId) cancelAnimationFrame(entry.rafId);
      this.analysers.delete(peerId);
    }
  }

  close() {
    for (const peerId of this.analysers.keys()) this.untrack(peerId);
    if (this.ctx) {
      try { this.ctx.close(); } catch (_) {}
      this.ctx = null;
    }
  }
}
