// BackgroundProcessor: real-time background blur.
//
// Strategy: Canvas OffscreenCanvas with CSS filter blur.
// Uses a two-layer composite: blurred full frame + sharp center oval.
// No ML model needed — works on ALL browsers that support Canvas.
//
// The "center oval" approach approximates person segmentation by assuming
// the face/body is roughly centered in the frame. Not perfect, but:
// - Zero dependencies (no CDN, no WASM, no ML model)
// - Works instantly (no model download)
// - Low CPU overhead
// - Graceful — looks like a "bokeh" portrait mode effect
//
// Usage:
//   const processor = new BackgroundProcessor();
//   const processedTrack = await processor.enable(originalVideoTrack);
//   processor.disable(); // returns original track

class BackgroundProcessor {
  constructor() {
    this._canvas = null;
    this._ctx = null;
    this._sourceTrack = null;
    this._processedStream = null;
    this._animFrame = null;
    this._enabled = false;
    this._video = null;
    this._blurPx = 14;
  }

  async enable(sourceTrack) {
    if (this._enabled) return this.getProcessedTrack();

    this._sourceTrack = sourceTrack;
    const settings = sourceTrack.getSettings();
    const w = settings.width || 640;
    const h = settings.height || 480;

    // Create processing canvas
    this._canvas = document.createElement("canvas");
    this._canvas.width = w;
    this._canvas.height = h;
    this._ctx = this._canvas.getContext("2d");

    // Create gradient mask canvas (static — only needs to be drawn once)
    this._maskCanvas = document.createElement("canvas");
    this._maskCanvas.width = w;
    this._maskCanvas.height = h;
    const mctx = this._maskCanvas.getContext("2d");
    // Radial gradient: transparent center (person), black edges (blur zone)
    const gradient = mctx.createRadialGradient(w/2, h*0.42, Math.min(w, h) * 0.22, w/2, h*0.45, Math.max(w, h) * 0.55);
    gradient.addColorStop(0, "rgba(0,0,0,0)");     // center: fully transparent (sharp)
    gradient.addColorStop(0.6, "rgba(0,0,0,0)");   // still sharp
    gradient.addColorStop(0.85, "rgba(0,0,0,1)");  // transition to blur
    gradient.addColorStop(1, "rgba(0,0,0,1)");      // edge: fully opaque (blurred)
    mctx.fillStyle = gradient;
    mctx.fillRect(0, 0, w, h);

    // Hidden video element for source
    this._video = document.createElement("video");
    this._video.autoplay = true;
    this._video.playsInline = true;
    this._video.muted = true;
    this._video.style.cssText = "position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;";
    document.body.appendChild(this._video);
    this._video.srcObject = new MediaStream([sourceTrack]);
    await this._video.play();

    // Start processing
    this._enabled = true;
    this._processLoop();

    // Capture output
    this._processedStream = this._canvas.captureStream(settings.frameRate || 30);
    console.log(`[bg-blur] enabled (${w}x${h}, canvas-based)`);
    return this._processedStream.getVideoTracks()[0];
  }

  disable() {
    this._enabled = false;
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
    if (this._processedStream) {
      this._processedStream.getTracks().forEach(t => t.stop());
      this._processedStream = null;
    }
    if (this._video) {
      this._video.remove();
      this._video = null;
    }
    console.log("[bg-blur] disabled");
    return this._sourceTrack;
  }

  getProcessedTrack() {
    return this._processedStream?.getVideoTracks()[0] || null;
  }

  isEnabled() { return this._enabled; }

  setBlurRadius(px) { this._blurPx = Math.max(4, Math.min(30, px)); }

  destroy() { this.disable(); }

  _processLoop() {
    if (!this._enabled) return;

    const v = this._video;
    const ctx = this._ctx;
    const w = this._canvas.width;
    const h = this._canvas.height;

    if (v.readyState >= 2) {
      // Layer 1: Draw sharp frame
      ctx.filter = "none";
      ctx.drawImage(v, 0, 0, w, h);

      // Layer 2: Draw blurred frame on top, masked to edges only
      ctx.save();
      ctx.filter = `blur(${this._blurPx}px)`;
      ctx.globalCompositeOperation = "source-over";
      // Use mask: draw blurred frame, then mask controls where it shows
      // Technique: draw blur to temp, composite with mask
      ctx.drawImage(v, 0, 0, w, h);
      ctx.filter = "none";
      // Apply mask — center becomes transparent (shows sharp layer below)
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(this._maskCanvas, 0, 0, w, h);
      ctx.restore();

      // Re-draw sharp center on top
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      ctx.drawImage(v, 0, 0, w, h);
      ctx.restore();
    }

    this._animFrame = requestAnimationFrame(() => this._processLoop());
  }
}
