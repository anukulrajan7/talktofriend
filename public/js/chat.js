// Chat: hybrid — real-time via server echo (simplest, reliable) + SQLite history.
// We prefer server-echo over DataChannel for chat because:
//   - server persists messages automatically
//   - all peers always receive (no mesh-fanout bugs)
//   - latency is already <50ms on same-region server
// DataChannel exists but is used for reactions/low-latency UI signals.

(function () {
  class Chat {
    constructor({ signaling, listEl, onNew }) {
      this.signaling = signaling;
      this.listEl = listEl;
      this.onNew = onNew;
      this.seenIds = new Set();

      this.signaling.on("chat", (msg) => this._append(msg, true));
    }

    send(body) {
      if (!body || !body.trim()) return;
      this.signaling.sendChat(body.trim());
    }

    async loadHistory(code) {
      try {
        const r = await fetch(`/api/rooms/${encodeURIComponent(code)}/chat`);
        if (!r.ok) return;
        const { messages } = await r.json();
        (messages || []).forEach((m) => this._append(m, false));
      } catch (e) {
        console.warn("[chat] history load failed", e);
      }
    }

    _append(msg, animate = true) {
      if (this.seenIds.has(msg.id)) return;
      this.seenIds.add(msg.id);

      const wrap = document.createElement("div");
      wrap.className = animate ? "bubble-in" : "";

      const author = document.createElement("div");
      author.className = "text-xs text-mute mb-0.5 flex items-center gap-1";

      const authorSpan = document.createElement("span");
      authorSpan.className = "font-medium text-dim";
      authorSpan.textContent = msg.author;

      const sep = document.createElement("span");
      sep.className = "text-mute";
      sep.textContent = "·";

      const timeSpan = document.createElement("span");
      timeSpan.textContent = formatTime(msg.createdAt);

      author.append(authorSpan, sep, timeSpan);

      const body = document.createElement("div");
      body.className = "text-sm leading-relaxed break-words";
      body.textContent = msg.body;

      wrap.appendChild(author);
      wrap.appendChild(body);
      this.listEl.appendChild(wrap);
      this.listEl.scrollTop = this.listEl.scrollHeight;

      this.onNew?.(msg);
    }
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  window.Chat = Chat;
})();
