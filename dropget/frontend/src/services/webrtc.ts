import { wsService } from './websocket';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

export class WebRTCService {
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private isInitiator = false;
  private onDataChannelCallback?: (channel: RTCDataChannel) => void;
  private connectionStateHandlers = new Set<(state: RTCPeerConnectionState) => void>();

  init(isInitiator: boolean) {
    this.isInitiator = isInitiator;
    this.pc = new RTCPeerConnection(ICE_SERVERS);

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        wsService.send({
          type: 'ice-candidate',
          candidate: event.candidate
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      console.log('Connection state:', state);
      if (!state) {
        return;
      }
      this.connectionStateHandlers.forEach((handler) => handler(state));
    };

    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.setupDataChannel();
    };

    if (this.isInitiator) {
      this.createDataChannel();
    }
  }

  private setupDataChannel() {
    if (!this.dataChannel) return;

    const channel = this.dataChannel;

    channel.onopen = () => {
      console.log('Data channel open');
      if (this.onDataChannelCallback) {
        this.onDataChannelCallback(channel);
      }
    };

    channel.onclose = () => {
      console.log('Data channel closed');
    };
  }

  private createDataChannel() {
    if (!this.pc) return;
    
    this.dataChannel = this.pc.createDataChannel('fileTransfer', {
      ordered: true
    });
    this.setupDataChannel();
  }

  async createOffer() {
    if (!this.pc) return;

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    
    wsService.send({
      type: 'offer',
      offer: offer
    });
  }

  async handleOffer(offer: RTCSessionDescriptionInit) {
    if (!this.pc) return;

    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    wsService.send({
      type: 'answer',
      answer: answer
    });
  }

  async handleAnswer(answer: RTCSessionDescriptionInit) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(answer);
  }

  async handleIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.pc) return;
    await this.pc.addIceCandidate(candidate);
  }

  onDataChannel(callback: (channel: RTCDataChannel) => void) {
    this.onDataChannelCallback = callback;
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      callback(this.dataChannel);
    }
  }

  getDataChannel() {
    return this.dataChannel;
  }

  onConnectionStateChange(callback: (state: RTCPeerConnectionState) => void): () => void {
    this.connectionStateHandlers.add(callback);

    if (this.pc?.connectionState) {
      callback(this.pc.connectionState);
    }

    return () => {
      this.connectionStateHandlers.delete(callback);
    };
  }

  close() {
    if (this.dataChannel) {
      this.dataChannel.close();
    }
    if (this.pc) {
      this.pc.close();
    }
    this.pc = null;
    this.dataChannel = null;
    this.connectionStateHandlers.clear();
  }
}
