import { useState, useEffect, useCallback } from 'react';
import { WebRTCService } from '../services/webrtc';
import { fileTransferService, FileMetadata } from '../services/fileTransfer';
import { wsService } from '../services/websocket';

interface ReceivedFile {
  metadata: FileMetadata;
  url: string;
}

const P2P_CONNECTION_TIMEOUT_MS = 6000;

export function useFileTransfer(webrtc: WebRTCService) {
  const [isChannelReady, setIsChannelReady] = useState(false);
  const [sendingProgress, setSendingProgress] = useState(0);
  const [receivingProgress, setReceivingProgress] = useState({ progress: 0, name: '' });
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const apiBaseUrl = `http://${window.location.hostname}:3001`;

  useEffect(() => {
    webrtc.onDataChannel((channel) => {
      setIsChannelReady(true);

      fileTransferService.receiveFile(channel, {
        onMetadata: (metadata) => {
          setReceivingProgress({ progress: 0, name: metadata.name });
        },
        onProgress: (progress) => {
          setReceivingProgress((prev) => ({ ...prev, progress }));
        },
        onFileComplete: (blob, metadata) => {
          const url = URL.createObjectURL(blob);
          setReceivedFiles((prev) => [...prev, { metadata, url }]);
          setReceivingProgress({ progress: 0, name: '' });
        },
        onError: (error) => {
          console.error('Receive error:', error);
          setReceivingProgress({ progress: 0, name: '' });
        }
      });
    });
  }, [webrtc]);

  useEffect(() => {
    const unsubscribe = webrtc.onConnectionStateChange((state) => {
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        setIsChannelReady(false);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [webrtc]);

  const uploadToCloud = useCallback(async (file: File) => {
    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`${apiBaseUrl}/upload`, {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        throw new Error(`Upload failed with status ${res.status}`);
      }

      const { fileId } = await res.json();
      wsService.send({ type: 'file-ready', fileId, fileName: file.name });
      setSendingProgress(0);
    } catch (error) {
      console.error('Cloud upload error:', error);
      setSendingProgress(0);
    }
  }, [apiBaseUrl]);

  const waitForOpenChannel = useCallback(async (): Promise<RTCDataChannel | null> => {
    const existingChannel = webrtc.getDataChannel();
    if (existingChannel?.readyState === 'open') {
      return existingChannel;
    }

    return new Promise((resolve) => {
      let settled = false;
      let unsubscribeConnectionState: (() => void) | null = null;
      let intervalId: number | null = null;
      let timeoutId: number | null = null;

      const finish = (channel: RTCDataChannel | null) => {
        if (settled) {
          return;
        }

        settled = true;
        unsubscribeConnectionState?.();
        if (intervalId !== null) {
          window.clearInterval(intervalId);
        }
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        resolve(channel);
      };

      const checkChannel = () => {
        const channel = webrtc.getDataChannel();
        if (channel?.readyState === 'open') {
          finish(channel);
        }
      };

      unsubscribeConnectionState = webrtc.onConnectionStateChange((state) => {
        if (state === 'failed' || state === 'disconnected') {
          finish(null);
          return;
        }

        if (state === 'connected') {
          checkChannel();
        }
      });

      intervalId = window.setInterval(checkChannel, 100);
      timeoutId = window.setTimeout(() => finish(null), P2P_CONNECTION_TIMEOUT_MS);

      checkChannel();
    });
  }, [webrtc]);

  const sendFile = useCallback(async (file: File) => {
    setSendingProgress(0);
    let fallbackTriggered = false;

    const triggerFallback = () => {
      if (fallbackTriggered) {
        return;
      }

      fallbackTriggered = true;
      setSendingProgress(0);
      uploadToCloud(file);
    };

    const unsubscribeConnectionState = webrtc.onConnectionStateChange((state) => {
      if (state === 'failed' || state === 'disconnected') {
        triggerFallback();
      }
    });

    const channel = await waitForOpenChannel();

    if (!channel || channel.readyState !== 'open') {
      triggerFallback();
      unsubscribeConnectionState();
      return;
    }

    try {
      await fileTransferService.sendFile(file, channel, {
        onProgress: setSendingProgress,
        onComplete: () => {
          setSendingProgress(0);
        },
        onError: (error) => {
          console.error('Send error:', error);
          triggerFallback();
        }
      });
    } catch (error) {
      console.error('Send file error:', error);
      triggerFallback();
    } finally {
      unsubscribeConnectionState();
    }
  }, [webrtc, uploadToCloud, waitForOpenChannel]);

  return {
    isChannelReady,
    sendFile,
    sendingProgress,
    receivingProgress,
    receivedFiles
  };
}
