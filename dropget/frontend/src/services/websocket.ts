export type MessageHandler = (message: any) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private manualClose = false;

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        resolve();
        return;
      }

      this.manualClose = false;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('WebSocket connected - websocket.ts:23');
        this.reconnectAttempts = 0;
        resolve();
      };

      this.ws.onerror = (error) => {
        const errorMessage = error instanceof Event ? 'WebSocket connection failed' : String(error);
        console.error('WebSocket error: - websocket.ts:30', errorMessage);
        reject(new Error(errorMessage));
      };

      this.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        this.handlers.forEach(handler => handler(message));
      };

      this.ws.onclose = () => {
        console.log('WebSocket closed - websocket.ts:40');
        if (!this.manualClose) {
          this.attemptReconnect(url);
        }
      };
    });
  }

  private attemptReconnect(url: string) {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      setTimeout(() => {
        console.log(`Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts}) - websocket.ts:52`);
        this.connect(url);
      }, 2000);
    }
  }

  send(message: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  onMessage(handler: MessageHandler) {
    this.handlers.push(handler);
  }

  removeHandler(handler: MessageHandler) {
    this.handlers = this.handlers.filter(h => h !== handler);
  }

  disconnect() {
    if (this.ws) {
      this.manualClose = true;
      this.ws.close();
      this.ws = null;
    }
  }
}

export const wsService = new WebSocketService();
