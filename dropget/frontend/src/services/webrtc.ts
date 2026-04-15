import { wsService } from './websocket';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: process.env.REACT_APP_TURN_URL || 'turn:your-turn-server.com:3478',
      username: process.env.REACT_APP_TURN_USERNAME || '',
      credential: process.env.REACT_APP_TURN_CREDENTIAL || ''
    }
  ]
};

export class WebRTCService {
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private isInitiator = false;
  private onDataChannelCallback?: (channel: RTCDataChannel) => void;
  private connectionStateHandlers = new Set<(state: RTCPeerConnectionState) => void>();

  init(isInitiator: boolean) {
    this.isInitiator = isInitiator;
    this.pendingCandidates = [];
    this.pc = new RTCPeerConnection(ICE_SERVERS);

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('ICE sent - webrtc.ts:25');
        wsService.send({
          type: 'ice-candidate',
          candidate: event.candidate
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      console.log(state);
      if (!state) {
        return;
      }
      this.connectionStateHandlers.forEach((handler) => handler(state));
    };

    this.pc.ondatachannel = (event) => {
      console.log('Data channel received from remote peer - webrtc.ts:43');
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
      console.log('Data channel open - webrtc.ts:59');
      if (this.onDataChannelCallback) {
        this.onDataChannelCallback(channel);
      }
    };

    channel.onclose = () => {
      console.log('Data channel closed - webrtc.ts:66');
    };
  }

  private createDataChannel() {
    if (!this.pc) return;

    console.log('Creating local data channel - webrtc.ts:73');
    this.dataChannel = this.pc.createDataChannel('fileTransfer', {
      ordered: true
    });
    this.setupDataChannel();
  }

  private async flushPendingCandidates() {
    if (!this.pc || !this.pc.remoteDescription) {
      return;
    }

    for (const candidate of this.pendingCandidates) {
      await this.pc.addIceCandidate(candidate);
    }
    this.pendingCandidates = [];
  }

  async createOffer() {
    if (!this.pc) return;

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    
    wsService.send({
      type: 'offer',
      offer: offer
    });
    console.log('Offer sent - webrtc.ts:101');
  }

  async handleOffer(offer: RTCSessionDescriptionInit) {
    if (!this.pc) return;

    console.log('Offer received - webrtc.ts:107');
    await this.pc.setRemoteDescription(offer);
    await this.flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    wsService.send({
      type: 'answer',
      answer: answer
    });
    console.log('Answer sent - webrtc.ts:117');
  }

  async handleAnswer(answer: RTCSessionDescriptionInit) {
    if (!this.pc) return;
    console.log('Answer received - webrtc.ts:122');
    await this.pc.setRemoteDescription(answer);
    await this.flushPendingCandidates();
  }

  async handleIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.pc) return;
    console.log('ICE received - webrtc.ts:129');
    if (this.pc.remoteDescription) {
      await this.pc.addIceCandidate(candidate);
      return;
    }

    this.pendingCandidates.push(candidate);
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
    this.pendingCandidates = [];
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
