const CHUNK_SIZE = 65536; // 64KB
const MAX_BUFFERED_AMOUNT = 1_000_000;
const BUFFER_WAIT_MS = 50;

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
  private async waitForBufferDrain(channel: RTCDataChannel): Promise<void> {
    while (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      if (channel.readyState !== 'open') {
        throw new Error('Data channel closed');
      }
      await new Promise((resolve) => window.setTimeout(resolve, BUFFER_WAIT_MS));
    }
  }

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

    try {
      channel.send(JSON.stringify({ type: 'metadata', metadata }));

      let offset = 0;

      while (offset < file.size) {
        if (channel.readyState !== 'open') {
          throw new Error('Data channel closed');
        }

        if (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
          await this.waitForBufferDrain(channel);
        }

        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();
        channel.send(buffer);

        offset += buffer.byteLength;

        const progress = Math.min((offset / file.size) * 100, 100);
        callbacks?.onProgress?.(Math.round(progress));
      }

      if (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        await this.waitForBufferDrain(channel);
      }

      channel.send(JSON.stringify({ type: 'end' }));
      callbacks?.onComplete?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error('File send error');
      callbacks?.onError?.(error);
      throw error;
    }
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
