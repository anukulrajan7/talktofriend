// Socket.IO wrapper. Events designed for mesh signaling with targeted relay.

(function () {
  class Signaling {
    constructor() {
      this.socket = io({ autoConnect: false });
      this.myId = null;
      this.listeners = new Map();

      const events = [
        "connect", "disconnect", "error-msg",
        "room-created", "room-joined",
        "peer-joined", "peer-left",
        "offer", "answer", "ice-candidate",
        "chat",
        "upgrade-to-sfu",
      ];
      events.forEach((ev) => {
        this.socket.on(ev, (...args) => this._emit(ev, ...args));
      });

      this.on("room-created", (d) => (this.myId = d.myId));
      this.on("room-joined", (d) => (this.myId = d.myId));
    }

    connect() { this.socket.connect(); }
    disconnect() { this.socket.disconnect(); }

    on(event, handler) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(handler);
    }

    off(event, handler) {
      const handlers = this.listeners.get(event);
      if (!handlers) return;
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    }

    _emit(event, ...args) {
      (this.listeners.get(event) || []).forEach((h) => {
        try { h(...args); } catch (e) { console.error(`[signaling] ${event}:`, e); }
      });
    }

    createRoom()              { this.socket.emit("create-room"); }
    joinRoom(code, name)      { this.socket.emit("join-room", { code, name }); }
    sendOffer(to, sdp)        { this.socket.emit("offer", { to, sdp }); }
    sendAnswer(to, sdp)       { this.socket.emit("answer", { to, sdp }); }
    sendIce(to, candidate)    { this.socket.emit("ice-candidate", { to, candidate }); }
    sendChat(body)            { this.socket.emit("chat", { body }); }
    leave()                   { this.socket.emit("leave"); }
  }

  window.Signaling = Signaling;
})();
