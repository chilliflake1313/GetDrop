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
      console.log('Connection state:', this.pc?.connectionState);
    };

    if (this.isInitiator) {
      this.createDataChannel();
    } else {
      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannel();
      };
    }
  }

  private createDataChannel() {
    if (!this.pc) return;
    
    this.dataChannel = this.pc.createDataChannel('fileTransfer', {
      ordered: true
    });
    this.setupDataChannel();
  }

  private setupDataChannel() {
    if (!this.dataChannel) return;

    this.dataChannel.onopen = () => {
      console.log('Data channel open');
      if (this.onDataChannelCallback) {
        this.onDataChannelCallback(this.dataChannel);
      }
    };

    this.dataChannel.onclose = () => {
      console.log('Data channel closed');
    };
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

  close() {
    if (this.dataChannel) {
      this.dataChannel.close();
    }
    if (this.pc) {
      this.pc.close();
    }
    this.pc = null;
    this.dataChannel = null;
  }
}
