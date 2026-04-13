// SFUClient: mediasoup-client wrapper for SFU rooms (5-20 people).
//
// Requires mediasoup-client loaded via CDN (window.mediasoupClient).
// Talks to the server via Socket.IO through the Signaling instance.
//
// Callbacks:
//   onRemoteTrack(peerId, track, kind)   — new remote audio/video track
//   onProducerClosed(peerId, kind)       — remote peer stopped producing

(function () {
  class SFUClient {
    constructor({ signaling, callbacks = {} }) {
      this.signaling = signaling;
      this.callbacks = callbacks;
      this.device = null;
      this.sendTransport = null;
      this.recvTransport = null;
      this.producers = new Map();  // kind -> Producer
      this.consumers = new Map();  // consumerId -> { consumer, peerId, kind }

      this._onNewProducer = null;
      this._onProducerClosed = null;
    }

    // ------------------ Connect ------------------

    async connect() {
      if (this.device) {
        console.warn("SFU: connect() already called, skipping");
        return;
      }
      const socket = this.signaling.socket;

      // 1. Get RTP capabilities from server
      const { rtpCapabilities } = await this._request("get-rtp-capabilities", {});
      console.log("SFU: got rtp capabilities");

      // 2. Create mediasoup Device and load capabilities
      this.device = new mediasoupClient.Device();
      await this.device.load({ routerRtpCapabilities: rtpCapabilities });
      console.log("SFU: device loaded");

      // 3. Create send transport
      this.sendTransport = await this._createTransport("send");
      console.log("SFU: send transport ready");

      // 4. Create recv transport
      this.recvTransport = await this._createTransport("recv");
      console.log("SFU: recv transport ready");

      // 5. Wire server push events
      this._onNewProducer = async ({ producerId, peerId, kind }) => {
        console.log(`SFU: new-producer from ${peerId} [${kind}]`);
        await this.consume(producerId, peerId, kind);
      };

      this._onProducerClosed = ({ producerId, peerId }) => {
        const entry = this.consumers.get(producerId);
        if (!entry) return;
        console.log(`SFU: producer-closed for ${peerId} [${entry.kind}]`);
        try { entry.consumer.close(); } catch {}
        this.consumers.delete(producerId);
        this.callbacks.onProducerClosed?.(peerId, entry.kind);
      };

      socket.on("new-producer", this._onNewProducer);
      socket.on("producer-closed", this._onProducerClosed);
    }

    // ------------------ Produce ------------------

    async produce(track) {
      if (!this.sendTransport) {
        console.warn("SFU: produce called before connect()");
        return null;
      }

      const kind = track.kind; // "audio" or "video"

      // Replace track if already producing this kind
      if (this.producers.has(kind)) {
        const existing = this.producers.get(kind);
        try {
          await existing.replaceTrack({ track });
          console.log(`SFU: replaced ${kind} track`);
          return existing;
        } catch (e) {
          console.warn(`SFU: replaceTrack failed for ${kind}, closing and re-producing`, e);
          existing.close();
          this.producers.delete(kind);
        }
      }

      try {
        const producer = await this.sendTransport.produce({ track });
        this.producers.set(kind, producer);
        console.log(`SFU: producing ${kind} [id=${producer.id}]`);

        producer.on("trackended", () => {
          console.log(`SFU: ${kind} track ended`);
          this.closeProducer(kind);
        });

        return producer;
      } catch (e) {
        console.error(`SFU: produce(${kind}) failed:`, e);
        return null;
      }
    }

    // ------------------ Consume ------------------

    async consume(producerId, peerId, kind) {
      if (!this.recvTransport) {
        console.warn("SFU: consume called before connect()");
        return;
      }

      try {
        const params = await this._request("consume", {
          producerId,
          rtpCapabilities: this.device.rtpCapabilities,
        });

        const consumer = await this.recvTransport.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
        });

        // Store by producerId so we can look up on producer-closed
        this.consumers.set(producerId, { consumer, peerId, kind });

        // Resume (server pauses consumers by default)
        await this._request("resume-consumer", { consumerId: consumer.id });

        console.log(`SFU: consuming ${kind} from ${peerId} [consumerId=${consumer.id}]`);
        this.callbacks.onRemoteTrack?.(peerId, consumer.track, kind);
      } catch (e) {
        console.error(`SFU: consume(${producerId}) failed:`, e);
      }
    }

    // ------------------ Close ------------------

    async closeProducer(kind) {
      const producer = this.producers.get(kind);
      if (!producer) return;
      try { producer.close(); } catch {}
      this.producers.delete(kind);
      console.log(`SFU: closed ${kind} producer`);
    }

    close() {
      const socket = this.signaling.socket;

      // Remove server push listeners
      if (this._onNewProducer) socket.off("new-producer", this._onNewProducer);
      if (this._onProducerClosed) socket.off("producer-closed", this._onProducerClosed);
      this._onNewProducer = null;
      this._onProducerClosed = null;

      // Close all producers
      this.producers.forEach((producer, kind) => {
        try { producer.close(); } catch {}
      });
      this.producers.clear();

      // Close all consumers
      this.consumers.forEach(({ consumer }) => {
        try { consumer.close(); } catch {}
      });
      this.consumers.clear();

      // Close transports
      try { this.sendTransport?.close(); } catch {}
      try { this.recvTransport?.close(); } catch {}
      this.sendTransport = null;
      this.recvTransport = null;

      console.log("SFU: closed");
    }

    // ------------------ Internals ------------------

    // Promisified socket.emit with ack callback and timeout
    _request(event, data, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`SFU: ${event} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        this.signaling.socket.emit(event, data, (response) => {
          clearTimeout(timer);
          if (response && response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        });
      });
    }

    async _createTransport(direction) {
      const socket = this.signaling.socket;
      const params = await this._request("create-transport", { direction });

      const transport = direction === "send"
        ? this.device.createSendTransport(params)
        : this.device.createRecvTransport(params);

      transport.on("connect", ({ dtlsParameters }, callback, errback) => {
        this._request("connect-transport", { direction, dtlsParameters })
          .then(() => callback())
          .catch((e) => errback(e));
      });

      if (direction === "send") {
        transport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
          this._request("produce", { kind, rtpParameters, appData })
            .then((response) => {
              if (response.id) callback({ id: response.id });
              else errback(new Error("produce: no id in response"));
            })
            .catch((e) => errback(e));
        });
      }

      return transport;
    }
  }

  window.SFUClient = SFUClient;
})();
