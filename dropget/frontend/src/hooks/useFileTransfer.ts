import { useState, useEffect, useCallback } from 'react';
import { WebRTCService } from '../services/webrtc';
import { fileTransferService, FileMetadata } from '../services/fileTransfer';

interface ReceivedFile {
  metadata: FileMetadata;
  url: string;
}

export function useFileTransfer(webrtc: WebRTCService) {
  const [isChannelReady, setIsChannelReady] = useState(false);
  const [sendingProgress, setSendingProgress] = useState(0);
  const [receivingProgress, setReceivingProgress] = useState({ progress: 0, name: '' });
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);

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

  const sendFile = useCallback(async (file: File) => {
    const channel = webrtc.getDataChannel();
    if (!channel || channel.readyState !== 'open') {
      console.error('Data channel not ready');
      return;
    }

    setSendingProgress(0);

    try {
      await fileTransferService.sendFile(file, channel, {
        onProgress: setSendingProgress,
        onComplete: () => {
          setSendingProgress(0);
        },
        onError: (error) => {
          console.error('Send error:', error);
          setSendingProgress(0);
        }
      });
    } catch (error) {
      console.error('Send file error:', error);
      setSendingProgress(0);
    }
  }, [webrtc]);

  return {
    isChannelReady,
    sendFile,
    sendingProgress,
    receivingProgress,
    receivedFiles
  };
}
