import { useState } from 'react';

interface ConnectionProps {
  onCreateSession: () => void;
  onJoinSession: (code: string) => void;
  sessionCode: string;
  isConnected: boolean;
  error: string;
}

export function Connection({
  onCreateSession,
  onJoinSession,
  sessionCode,
  isConnected,
  error
}: ConnectionProps) {
  const [inputCode, setInputCode] = useState('');

  const handleJoin = () => {
    onJoinSession(inputCode);
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>DropGet</h1>
        <p style={styles.subtitle}>Instant file transfer between devices</p>

        {error && <div style={styles.error}>{error}</div>}

        {sessionCode && (
          <div style={styles.codeDisplay}>
            <div style={styles.codeLabel}>Session Code</div>
            <div style={styles.code}>{sessionCode}</div>
            <div style={styles.codeHint}>Share this code with other device</div>
          </div>
        )}

        {!isConnected && !sessionCode && (
          <>
            <button onClick={onCreateSession} style={styles.primaryButton}>
              Create New Session
            </button>

            <div style={styles.divider}>
              <span>OR</span>
            </div>

            <div style={styles.joinSection}>
              <input
                type="text"
                placeholder="Enter session code"
                value={inputCode}
                onChange={(e) => setInputCode(e.target.value.toUpperCase())}
                style={styles.input}
                maxLength={8}
              />
              <button onClick={handleJoin} style={styles.secondaryButton}>
                Join Session
              </button>
            </div>
          </>
        )}

        {sessionCode && !isConnected && (
          <div style={styles.waiting}>
            <div style={styles.spinner}></div>
            <p>Connecting...</p>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '20px'
  },
  card: {
    backgroundColor: 'white',
    padding: '40px',
    borderRadius: '12px',
    boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
    maxWidth: '400px',
    width: '100%'
  },
  title: {
    fontSize: '32px',
    fontWeight: 'bold',
    textAlign: 'center' as const,
    marginBottom: '8px',
    color: '#007bff'
  },
  subtitle: {
    textAlign: 'center' as const,
    color: '#666',
    marginBottom: '30px'
  },
  error: {
    padding: '12px',
    backgroundColor: '#fee',
    color: '#c33',
    borderRadius: '6px',
    marginBottom: '20px',
    textAlign: 'center' as const
  },
  codeDisplay: {
    textAlign: 'center' as const,
    padding: '20px',
    backgroundColor: '#f8f9fa',
    borderRadius: '8px',
    marginBottom: '20px'
  },
  codeLabel: {
    fontSize: '14px',
    color: '#666',
    marginBottom: '8px'
  },
  code: {
    fontSize: '36px',
    fontWeight: 'bold',
    letterSpacing: '4px',
    color: '#007bff',
    marginBottom: '8px'
  },
  codeHint: {
    fontSize: '12px',
    color: '#999'
  },
  primaryButton: {
    width: '100%',
    padding: '14px',
    backgroundColor: '#007bff',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    fontSize: '16px',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'background-color 0.2s'
  },
  secondaryButton: {
    width: '100%',
    padding: '14px',
    backgroundColor: '#28a745',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    fontSize: '16px',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
    marginTop: '10px'
  },
  divider: {
    display: 'flex',
    alignItems: 'center',
    textAlign: 'center' as const,
    margin: '20px 0',
    color: '#999',
    fontSize: '14px'
  },
  joinSection: {
    marginTop: '20px'
  },
  input: {
    width: '100%',
    padding: '14px',
    border: '2px solid #ddd',
    borderRadius: '6px',
    fontSize: '16px',
    textAlign: 'center' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '2px',
    fontWeight: '500'
  },
  waiting: {
    textAlign: 'center' as const,
    padding: '20px'
  },
  spinner: {
    width: '40px',
    height: '40px',
    margin: '0 auto 16px',
    border: '4px solid #f3f3f3',
    borderTop: '4px solid #007bff',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite'
  }
};
