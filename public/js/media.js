// MediaManager: shared media handling for mesh and SFU modes.
//
// Responsibilities:
// - getUserMedia (camera + mic) with HD→SD fallback
// - Screen share via getDisplayMedia with auto-stop detection
// - Mute/unmute audio and video tracks
// - Picture-in-Picture self-preview during screen share
// - Track replacement for SFU producer updates
//
// Usage:
//   const media = new MediaManager();
//   await media.getLocalMedia();
//   media.setMicEnabled(false);

class MediaManager {
  constructor() {
    this.localStream = null;    // camera + mic stream
    this.screenStream = null;   // screen share stream
    this.screenPiP = null;      // PiP window reference
    this._audioTrack = null;
    this._videoTrack = null;
    this._screenTrack = null;
  }

  // Get camera + mic. Returns MediaStream.
  // Tries HD constraints first, falls back to SD on failure.
  async getLocalMedia(opts = {}) {
    const constraints = {
      audio: opts.audio !== false ? {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      } : false,
      video: opts.video !== false ? {
        width: { ideal: 1920, min: 640 },
        height: { ideal: 1080, min: 480 },
        frameRate: { ideal: 30, max: 30 },
        facingMode: 'user',
      } : false,
    };

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // Fallback: try lower resolution
      console.warn('Media: HD failed, trying SD', e.message);
      constraints.video = opts.video !== false ? { width: 640, height: 480 } : false;
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    }

    this._audioTrack = this.localStream.getAudioTracks()[0] || null;
    this._videoTrack = this.localStream.getVideoTracks()[0] || null;

    // Log actual video resolution for quality debugging
    if (this._videoTrack) {
      const settings = this._videoTrack.getSettings();
      console.log('Media: local stream ready', {
        audio: !!this._audioTrack,
        video: `${settings.width}x${settings.height}@${settings.frameRate}fps`,
      });
    } else {
      console.log('Media: local stream ready', { audio: !!this._audioTrack, video: false });
    }

    return this.localStream;
  }

  // Getters
  get audioTrack() { return this._audioTrack; }
  get videoTrack() { return this._videoTrack; }
  get screenTrack() { return this._screenTrack; }

  // Mute/unmute mic
  setMicEnabled(enabled) {
    if (this._audioTrack) this._audioTrack.enabled = enabled;
  }

  // Enable/disable camera
  setCamEnabled(enabled) {
    if (this._videoTrack) this._videoTrack.enabled = enabled;
  }

  isMicEnabled() {
    return this._audioTrack ? this._audioTrack.enabled : false;
  }

  isCamEnabled() {
    return this._videoTrack ? this._videoTrack.enabled : false;
  }

  // Start screen share. Returns the screen video track, or null if cancelled.
  async startScreenShare() {
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: false,
      });
      this._screenTrack = this.screenStream.getVideoTracks()[0];

      // Auto-stop when user clicks "Stop sharing" in browser UI
      this._screenTrack.onended = () => {
        this.stopScreenShare();
        // Notify app-room.js so it can update UI
        document.dispatchEvent(new CustomEvent('screen-share-ended'));
      };

      console.log('Media: screen share started');

      // Show camera feed in PiP while screen sharing
      if (this._videoTrack && this._videoTrack.enabled) {
        await this._showSelfPiP();
      }

      return this._screenTrack;
    } catch (e) {
      console.log('Media: screen share cancelled or failed', e.message);
      return null;
    }
  }

  async stopScreenShare() {
    if (this._screenTrack) {
      this._screenTrack.stop();
      this._screenTrack = null;
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }
    await this._closePiP();
    console.log('Media: screen share stopped');
  }

  // Picture-in-Picture: show camera feed in small PiP while screen sharing
  async _showSelfPiP() {
    try {
      if (!document.pictureInPictureEnabled) return;
      let pipVideo = document.getElementById('__media_pip');
      if (!pipVideo) {
        pipVideo = document.createElement('video');
        pipVideo.id = '__media_pip';
        pipVideo.muted = true;
        pipVideo.autoplay = true;
        pipVideo.playsInline = true;
        pipVideo.style.position = 'fixed';
        pipVideo.style.opacity = '0';
        pipVideo.style.pointerEvents = 'none';
        pipVideo.style.width = '1px';
        pipVideo.style.height = '1px';
        document.body.appendChild(pipVideo);
      }
      pipVideo.srcObject = new MediaStream([this._videoTrack]);
      await pipVideo.play();
      this.screenPiP = await pipVideo.requestPictureInPicture();
    } catch (e) {
      console.log('Media: PiP not available', e.message);
    }
  }

  async _closePiP() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      }
      this.screenPiP = null;
    } catch (e) {
      // ignore
    }
  }

  // Replace the video track (for SFU producer track replacement).
  // Returns the old track so the caller can stop it if needed.
  replaceVideoTrack(newTrack) {
    const old = this._videoTrack;
    this._videoTrack = newTrack;
    if (this.localStream && old) {
      this.localStream.removeTrack(old);
      this.localStream.addTrack(newTrack);
    }
    return old;
  }

  // Returns all live tracks suitable for SFU producing.
  getProducibleTracks() {
    const tracks = [];
    if (this._audioTrack && this._audioTrack.readyState === 'live') {
      tracks.push(this._audioTrack);
    }
    if (this._videoTrack && this._videoTrack.readyState === 'live') {
      tracks.push(this._videoTrack);
    }
    return tracks;
  }

  // Stop and release all media resources.
  close() {
    this.stopScreenShare();
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    this._audioTrack = null;
    this._videoTrack = null;
    console.log('Media: closed');
  }
}
