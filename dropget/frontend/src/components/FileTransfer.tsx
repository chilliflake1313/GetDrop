import { useEffect, useRef, useState } from 'react';
import { wsService } from '../services/websocket';
import { API_BASE_URL } from '../config/endpoints';

interface FileTransferProps {
  isChannelReady: boolean;
  isPeerConnected: boolean;
  onSendFile: (file: File) => void;
  sendingProgress: number;
  receivingProgress: { progress: number; name: string };
  receivedFiles: Array<{ metadata: { name: string; size: number }; url: string }>;
  sessionCode: string;
}

export function FileTransfer({
  isChannelReady,
  isPeerConnected,
  onSendFile,
  sendingProgress,
  receivingProgress,
  receivedFiles,
  sessionCode
}: FileTransferProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const handler = async (msg: any) => {
      if (msg.type !== 'file-ready' || !msg.fileId) {
        return;
      }

      try {
        const res = await fetch(`${API_BASE_URL}/download/${msg.fileId}`);
        if (!res.ok) {
          throw new Error(`Download URL request failed: ${res.status}`);
        }

        const { url } = await res.json();
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = msg.fileName || 'dropget-file';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } catch (error) {
        console.error('Cloud download fallback error:', error);
      }
    };

    wsService.onMessage(handler);
    return () => {
      wsService.removeHandler(handler);
    };
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && isPeerConnected) {
      onSendFile(file);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file && isPeerConnected) {
      onSendFile(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.status}>
          <div style={styles.statusDot(isPeerConnected)}></div>
          {isPeerConnected ? 'Connected • Private Session' : 'Waiting for peer...'}
        </div>
        <div style={styles.code}>Code: {sessionCode}</div>
      </div>

      {!isPeerConnected && (
        <div style={styles.waiting}>
          <div style={styles.spinner}></div>
          <h2>Waiting for other device...</h2>
          <p style={styles.hint}>Share code <strong>{sessionCode}</strong> with other device</p>
        </div>
      )}

      {isPeerConnected && !isChannelReady && (
        <div style={styles.waiting}>
          <div style={styles.spinner}></div>
          <h2>Establishing connection...</h2>
        </div>
      )}

      {isPeerConnected && (
        <div
          style={{
            ...styles.dropZone,
            ...(isDragging ? styles.dropZoneActive : {})
          }}
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileSelect}
            style={styles.fileInput}
          />
          <div style={styles.uploadIcon}>↑</div>
          <h2>Drop files here</h2>
          <p style={styles.hint}>or click to select</p>
        </div>
      )}

      {sendingProgress > 0 && (
        <div style={styles.progressContainer}>
          <div style={styles.progressText}>
            Sending... {sendingProgress}%
          </div>
          <div style={styles.progressBar}>
            <div style={styles.progressFill(sendingProgress)}></div>
          </div>
        </div>
      )}

      {receivingProgress.progress > 0 && (
        <div style={styles.progressContainer}>
          <div style={styles.progressText}>
            Receiving {receivingProgress.name}... {receivingProgress.progress}%
          </div>
          <div style={styles.progressBar}>
            <div style={styles.progressFill(receivingProgress.progress)}></div>
          </div>
        </div>
      )}

      {receivedFiles.length > 0 && (
        <div style={styles.filesSection}>
          <h3>Recent Files</h3>
          <div style={styles.fileList}>
            {receivedFiles.map((file, index) => (
              <div key={index} style={styles.fileItem}>
                <div style={styles.fileInfo}>
                  <div style={styles.fileName}>{file.metadata.name}</div>
                  <div style={styles.fileSize}>{formatBytes(file.metadata.size)}</div>
                </div>
                <a
                  href={file.url}
                  download={file.metadata.name}
                  style={styles.downloadButton}
                >
                  Download
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    maxWidth: '800px',
    margin: '0 auto',
    padding: '20px'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '30px',
    padding: '15px',
    backgroundColor: 'white',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
  },
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '14px',
    fontWeight: '500' as const
  },
  statusDot: (connected: boolean) => ({
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: connected ? '#28a745' : '#ffc107'
  }),
  code: {
    fontSize: '14px',
    fontWeight: 'bold' as const,
    color: '#666'
  },
  dropZone: {
    border: '3px dashed #ddd',
    borderRadius: '12px',
    padding: '80px 40px',
    textAlign: 'center' as const,
    cursor: 'pointer',
    backgroundColor: 'white',
    transition: 'all 0.3s',
    marginBottom: '30px'
  },
  dropZoneActive: {
    borderColor: '#007bff',
    backgroundColor: '#f0f8ff'
  },
  uploadIcon: {
    fontSize: '64px',
    marginBottom: '20px',
    color: '#007bff'
  },
  fileInput: {
    display: 'none'
  },
  waiting: {
    textAlign: 'center' as const,
    padding: '60px 20px',
    backgroundColor: 'white',
    borderRadius: '12px',
    marginBottom: '30px'
  },
  spinner: {
    width: '40px',
    height: '40px',
    margin: '0 auto 20px',
    border: '4px solid #f3f3f3',
    borderTop: '4px solid #007bff',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite'
  },
  hint: {
    marginTop: '12px',
    color: '#666',
    fontSize: '14px'
  },
  progressContainer: {
    backgroundColor: 'white',
    padding: '20px',
    borderRadius: '8px',
    marginBottom: '20px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
  },
  progressText: {
    marginBottom: '10px',
    fontSize: '14px',
    fontWeight: '500' as const
  },
  progressBar: {
    width: '100%',
    height: '8px',
    backgroundColor: '#e9ecef',
    borderRadius: '4px',
    overflow: 'hidden'
  },
  progressFill: (progress: number) => ({
    width: `${progress}%`,
    height: '100%',
    backgroundColor: '#007bff',
    transition: 'width 0.3s'
  }),
  filesSection: {
    backgroundColor: 'white',
    padding: '20px',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
  },
  fileList: {
    marginTop: '15px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '10px'
  },
  fileItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px',
    backgroundColor: '#f8f9fa',
    borderRadius: '6px'
  },
  fileInfo: {
    flex: 1
  },
  fileName: {
    fontWeight: '500' as const,
    marginBottom: '4px'
  },
  fileSize: {
    fontSize: '12px',
    color: '#666'
  },
  downloadButton: {
    padding: '8px 16px',
    backgroundColor: '#007bff',
    color: 'white',
    textDecoration: 'none',
    borderRadius: '4px',
    fontSize: '14px'
  }
};
