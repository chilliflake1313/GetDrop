import { useState, useEffect, useCallback } from 'react';
import { WebRTCService } from '../services/webrtc';
import { fileTransferService, FileMetadata } from '../services/fileTransfer';
import { wsService } from '../services/websocket';

interface ReceivedFile {
  metadata: FileMetadata;
  url: string;
}

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

  const sendFile = useCallback(async (file: File) => {
    const channel = webrtc.getDataChannel();
    setSendingProgress(0);

    const fallbackTimeout = window.setTimeout(() => {
      if (!channel || channel.readyState !== 'open') {
        uploadToCloud(file);
      }
    }, 5000);

    if (!channel || channel.readyState !== 'open') {
      return;
    }

    clearTimeout(fallbackTimeout);

    try {
      await fileTransferService.sendFile(file, channel, {
        onProgress: setSendingProgress,
        onComplete: () => {
          setSendingProgress(0);
        },
        onError: (error) => {
          console.error('Send error:', error);
          setSendingProgress(0);
          uploadToCloud(file);
        }
      });
    } catch (error) {
      console.error('Send file error:', error);
      setSendingProgress(0);
      uploadToCloud(file);
    }
  }, [webrtc, uploadToCloud]);

  return {
    isChannelReady,
    sendFile,
    sendingProgress,
    receivingProgress,
    receivedFiles
  };
}
