// BackgroundProcessor: real-time background blur using MediaPipe Selfie Segmentation.
//
// How it works:
//   1. Captures frames from source video track
//   2. Runs MediaPipe segmentation to get person mask
//   3. Draws blurred background + sharp foreground to canvas
//   4. Outputs processed stream via canvas.captureStream()
//
// Usage:
//   const processor = new BackgroundProcessor();
//   await processor.init();
//   const processedTrack = await processor.enable(originalVideoTrack);
//   // Later: const originalTrack = processor.disable();

class BackgroundProcessor {
  constructor() {
    this._segmenter = null;
    this._canvas = null;
    this._ctx = null;
    this._sourceTrack = null;
    this._processedStream = null;
    this._animFrame = null;
    this._enabled = false;
    this._ready = false;
    this._blurRadius = 12; // px — adjustable
    this._video = null;
  }

  // Load MediaPipe segmentation model
  async init() {
    if (this._ready) return;

    // Create offscreen elements
    this._canvas = document.createElement("canvas");
    this._ctx = this._canvas.getContext("2d", { willReadFrequently: true });
    this._maskCanvas = document.createElement("canvas");
    this._maskCtx = this._maskCanvas.getContext("2d");

    this._video = document.createElement("video");
    this._video.autoplay = true;
    this._video.playsInline = true;
    this._video.muted = true;
    this._video.style.display = "none";
    document.body.appendChild(this._video);

    // Load MediaPipe SelfieSegmentation from CDN
    try {
      if (!window.SelfieSegmentation) {
        await this._loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js");
      }

      this._segmenter = new window.SelfieSegmentation({
        locateFile: (file) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
      });

      this._segmenter.setOptions({
        modelSelection: 1, // 1 = landscape (faster), 0 = general
        selfieMode: true,
      });

      this._segmenter.onResults((results) => {
        this._lastMask = results.segmentationMask;
      });

      // Warm up the model with a blank frame
      const warmup = document.createElement("canvas");
      warmup.width = 320;
      warmup.height = 240;
      await this._segmenter.send({ image: warmup });

      this._ready = true;
      console.log("[bg-blur] MediaPipe segmentation ready");
    } catch (e) {
      console.error("[bg-blur] Failed to load MediaPipe:", e);
      this._ready = false;
      throw new Error("Background blur not available");
    }
  }

  // Enable blur — returns a new processed video track
  async enable(sourceTrack) {
    if (!this._ready) await this.init();
    if (this._enabled) return this.getProcessedTrack();

    this._sourceTrack = sourceTrack;
    const settings = sourceTrack.getSettings();
    const w = settings.width || 640;
    const h = settings.height || 480;

    this._canvas.width = w;
    this._canvas.height = h;
    this._maskCanvas.width = w;
    this._maskCanvas.height = h;

    // Feed source track into hidden video element
    this._video.srcObject = new MediaStream([sourceTrack]);
    await this._video.play();

    // Start processing loop
    this._enabled = true;
    this._processLoop();

    // Capture processed output at source framerate
    this._processedStream = this._canvas.captureStream(settings.frameRate || 30);
    console.log(`[bg-blur] enabled (${w}x${h})`);

    return this._processedStream.getVideoTracks()[0];
  }

  // Disable blur — returns original track
  disable() {
    this._enabled = false;
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
    if (this._processedStream) {
      this._processedStream.getTracks().forEach((t) => t.stop());
      this._processedStream = null;
    }
    console.log("[bg-blur] disabled");
    return this._sourceTrack;
  }

  getProcessedTrack() {
    return this._processedStream?.getVideoTracks()[0] || null;
  }

  isEnabled() {
    return this._enabled;
  }

  setBlurRadius(px) {
    this._blurRadius = Math.max(4, Math.min(30, px));
  }

  destroy() {
    this.disable();
    this._segmenter?.close();
    this._video?.remove();
    this._ready = false;
  }

  // Internal: frame processing loop
  _processLoop() {
    if (!this._enabled) return;

    const video = this._video;
    const ctx = this._ctx;
    const w = this._canvas.width;
    const h = this._canvas.height;

    // Send frame to segmenter (async, result comes via onResults callback)
    if (video.readyState >= 2) {
      this._segmenter.send({ image: video }).catch(() => {});

      // Draw the composited frame
      if (this._lastMask) {
        // Step 1: Draw blurred full frame (background)
        ctx.filter = `blur(${this._blurRadius}px)`;
        ctx.drawImage(video, 0, 0, w, h);
        ctx.filter = "none";

        // Step 2: Draw mask to mask canvas
        this._maskCtx.drawImage(this._lastMask, 0, 0, w, h);

        // Step 3: Draw sharp person on top using mask as clip
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.drawImage(this._maskCanvas, 0, 0, w, h);
        ctx.globalCompositeOperation = "destination-over";
        // Re-draw person sharply where mask was cut out
        ctx.drawImage(video, 0, 0, w, h);
        ctx.restore();
      } else {
        // No mask yet — draw unprocessed frame
        ctx.drawImage(video, 0, 0, w, h);
      }
    }

    this._animFrame = requestAnimationFrame(() => this._processLoop());
  }

  // Load external script dynamically
  _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }
}
