const CHUNK_SIZE = 16384; // 16KB

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
}

export interface FileTransferCallbacks {
  onProgress?: (progress: number) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}

export class FileTransferService {
  async sendFile(
    file: File,
    channel: RTCDataChannel,
    callbacks?: FileTransferCallbacks
  ): Promise<void> {
    if (channel.readyState !== 'open') {
      throw new Error('Data channel is not open');
    }

    const metadata: FileMetadata = {
      name: file.name,
      size: file.size,
      type: file.type
    };

    channel.send(JSON.stringify({ type: 'metadata', metadata }));

    // Send file in chunks
    let offset = 0;
    const reader = new FileReader();

    return new Promise((resolve, reject) => {
      reader.onerror = () => {
        const error = new Error('File read error');
        callbacks?.onError?.(error);
        reject(error);
      };

      reader.onload = (e) => {
        if (e.target?.result) {
          if (channel.readyState !== 'open') {
            reject(new Error('Data channel closed'));
            return;
          }
          channel.send(e.target.result as ArrayBuffer);
          offset += CHUNK_SIZE;

          const progress = Math.min((offset / file.size) * 100, 100);
          callbacks?.onProgress?.(Math.round(progress));

          if (offset < file.size) {
            readSlice(offset);
          } else {
            channel.send(JSON.stringify({ type: 'end' }));
            callbacks?.onComplete?.();
            resolve();
          }
        }
      };

      const readSlice = (o: number) => {
        const slice = file.slice(o, o + CHUNK_SIZE);
        reader.readAsArrayBuffer(slice);
      };

      readSlice(0);
    });
  }

  receiveFile(
    channel: RTCDataChannel,
    callbacks?: FileTransferCallbacks & {
      onMetadata?: (metadata: FileMetadata) => void;
      onFileComplete?: (blob: Blob, metadata: FileMetadata) => void;
    }
  ): void {
    let receivedSize = 0;
    let fileMetadata: FileMetadata | null = null;
    const chunks: ArrayBuffer[] = [];

    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);

        if (message.type === 'metadata') {
          const metadata = message.metadata as FileMetadata;
          fileMetadata = metadata;
          callbacks?.onMetadata?.(metadata);
        } else if (message.type === 'end') {
          if (fileMetadata) {
            const blob = new Blob(chunks, { type: fileMetadata.type });
            callbacks?.onFileComplete?.(blob, fileMetadata);
            callbacks?.onComplete?.();
            
            // Reset
            chunks.length = 0;
            receivedSize = 0;
            fileMetadata = null;
          }
        }
      } else {
        chunks.push(event.data);
        receivedSize += event.data.byteLength;

        if (fileMetadata) {
          const progress = (receivedSize / fileMetadata.size) * 100;
          callbacks?.onProgress?.(Math.round(progress));
        }
      }
    };
  }
}

export const fileTransferService = new FileTransferService();
