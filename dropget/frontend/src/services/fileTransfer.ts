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

function downloadFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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

    try {
      channel.send(JSON.stringify({
        type: 'meta',
        name: file.name,
        size: file.size,
        fileType: file.type
      }));

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

      channel.send('EOF');
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
    let chunks: BlobPart[] = [];
    let receivedSize = 0;
    let fileSize = 0;
    let fileName = '';
    let fileType = 'application/octet-stream';

    channel.binaryType = 'arraybuffer';

    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        if (event.data === 'EOF') {
          const blob = new Blob(chunks, { type: fileType });
          const metadata: FileMetadata = {
            name: fileName || 'download',
            size: fileSize,
            type: fileType
          };

          downloadFile(blob, metadata.name);
          callbacks?.onFileComplete?.(blob, metadata);
          callbacks?.onComplete?.();

          chunks = [];
          receivedSize = 0;
          fileSize = 0;
          fileName = '';
          fileType = 'application/octet-stream';
          return;
        }

        try {
          const message = JSON.parse(event.data);

          if (message.type === 'meta') {
            fileName = String(message.name || 'download');
            fileSize = Number(message.size) || 0;
            fileType = String(message.fileType || 'application/octet-stream');
            callbacks?.onMetadata?.({
              name: fileName,
              size: fileSize,
              type: fileType
            });
          }
        } catch {
          console.warn('Unknown text frame received on data channel');
        }
        return;
      }

      chunks.push(event.data);
      receivedSize += event.data.byteLength;

      console.log('Received:', receivedSize);
      console.log('Expected:', fileSize);

      if (fileSize > 0) {
        const progress = (receivedSize / fileSize) * 100;
        callbacks?.onProgress?.(Math.round(progress));
      }
    };
  }
}

export const fileTransferService = new FileTransferService();
