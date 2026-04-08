import React from 'react';
import { Connection } from './components/Connection';
import { FileTransfer } from './components/FileTransfer';
import { useConnection } from './hooks/useConnection';
import { useFileTransfer } from './hooks/useFileTransfer';

function App() {
  const {
    sessionCode,
    isConnected,
    isPeerConnected,
    error,
    createSession,
    joinSession,
    webrtc
  } = useConnection();

  const {
    isChannelReady,
    sendFile,
    sendingProgress,
    receivingProgress,
    receivedFiles
  } = useFileTransfer(webrtc);

  if (!isConnected) {
    return (
      <Connection
        onCreateSession={createSession}
        onJoinSession={joinSession}
        sessionCode={sessionCode}
        isConnected={isConnected}
        error={error}
      />
    );
  }

  return (
    <FileTransfer
      isChannelReady={isChannelReady}
      isPeerConnected={isPeerConnected}
      onSendFile={sendFile}
      sendingProgress={sendingProgress}
      receivingProgress={receivingProgress}
      receivedFiles={receivedFiles}
      sessionCode={sessionCode}
    />
  );
}

export default App;
