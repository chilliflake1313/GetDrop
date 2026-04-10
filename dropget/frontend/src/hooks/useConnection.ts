import { useState, useEffect, useCallback } from 'react';
import { wsService } from '../services/websocket';
import { WebRTCService } from '../services/webrtc';
import { WS_URL } from '../config/endpoints';

export function useConnection() {
  const [sessionCode, setSessionCode] = useState<string>('');
  const [isConnected, setIsConnected] = useState(false);
  const [isPeerConnected, setIsPeerConnected] = useState(false);
  const [error, setError] = useState<string>('');
  const [webrtc] = useState(() => new WebRTCService());

  useEffect(() => {
    wsService.connect(WS_URL).catch((err) => {
      setError('Failed to connect to server');
      console.error(err);
    });

    const handleMessage = async (message: any) => {
      switch (message.type) {
        case 'created':
        case 'joined':
          setSessionCode(message.code);
          setIsConnected(true);
          setError('');
          
          if (message.type === 'created') {
            webrtc.init(true);
          } else {
            webrtc.init(false);
          }
          break;

        case 'peer-joined':
          setIsPeerConnected(true);
          await webrtc.createOffer();
          break;

        case 'offer':
          await webrtc.handleOffer(message.offer);
          setIsPeerConnected(true);
          break;

        case 'answer':
          await webrtc.handleAnswer(message.answer);
          break;

        case 'ice-candidate':
          await webrtc.handleIceCandidate(message.candidate);
          break;

        case 'peer-left':
          setIsPeerConnected(false);
          break;

        case 'error':
          setError(message.message);
          break;
      }
    };

    wsService.onMessage(handleMessage);

    return () => {
      wsService.removeHandler(handleMessage);
      wsService.disconnect();
      webrtc.close();
    };
  }, [webrtc]);

  const createSession = useCallback(() => {
    setError('');
    wsService.send({ type: 'create' });
  }, []);

  const joinSession = useCallback((code: string) => {
    if (!code.trim()) {
      setError('Please enter a session code');
      return;
    }
    setError('');
    wsService.send({ type: 'join', code: code.trim().toUpperCase() });
  }, []);

  return {
    sessionCode,
    isConnected,
    isPeerConnected,
    error,
    createSession,
    joinSession,
    webrtc
  };
}
