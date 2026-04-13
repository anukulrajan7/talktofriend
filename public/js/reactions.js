// Reactions: floating emoji overlay + canvas-confetti for special triggers.
// Broadcasts via DataChannel so all peers see it in real-time (no server round-trip).

(function () {
  const ALLOWED_EMOJIS = new Set(['🎉','👏','❤️','😂','🔥','👍','💡','👀']);
  const FLOAT_DURATION_MS = 2500;

  class Reactions {
    constructor({ mesh, overlayEl }) {
      this.mesh = mesh;
      this.overlayEl = overlayEl;
    }

    // Called when local user clicks an emoji
    trigger(emoji) {
      this._render(emoji);
      if (emoji === "🎉") this._confettiBurst();
      this._broadcast(emoji);
    }

    // Wire DataChannel incoming messages for remote reactions
    handleIncoming(channel) {
      channel.addEventListener("message", (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "reaction" && ALLOWED_EMOJIS.has(msg.emoji)) {
            this._render(msg.emoji);
            if (msg.emoji === "🎉") this._confettiBurst();
          } else {
            console.warn("Reactions: rejected invalid emoji", msg);
          }
        } catch {}
      });
    }

    _broadcast(emoji) {
      if (!this.mesh) return; // SFU mode: no broadcast yet
      if (!ALLOWED_EMOJIS.has(emoji)) return;
      this.mesh.broadcastDataChannel(JSON.stringify({ type: "reaction", emoji }));
    }

    _render(emoji) {
      const el = document.createElement("div");
      el.className = "reaction";
      el.textContent = emoji;
      // Random horizontal start within stage
      const x = Math.random() * (this.overlayEl.clientWidth - 60) + 10;
      const horizontalDrift = (Math.random() - 0.5) * 100;
      el.style.left = `${x}px`;
      el.style.bottom = "60px";
      el.style.setProperty("--x", `${horizontalDrift}px`);

      this.overlayEl.appendChild(el);
      setTimeout(() => el.remove(), FLOAT_DURATION_MS);
    }

    _confettiBurst() {
      if (!window.confetti) return;
      window.confetti({
        particleCount: 80,
        spread: 75,
        origin: { y: 0.8 },
        colors: ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#818cf8"],
      });
    }

    // Easter egg: rainstorm
    confettiRain(durationMs = 3000) {
      if (!window.confetti) return;
      const end = Date.now() + durationMs;
      (function frame() {
        window.confetti({
          particleCount: 4,
          startVelocity: 0,
          ticks: 200,
          origin: { x: Math.random(), y: 0 },
          colors: ["#6366f1", "#f59e0b", "#10b981"],
          gravity: 0.5,
          scalar: 0.8,
        });
        if (Date.now() < end) requestAnimationFrame(frame);
      })();
    }
  }

  window.Reactions = Reactions;
})();
