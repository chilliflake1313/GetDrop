import { randomUUID } from "node:crypto";

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const HEARTBEAT_TIMEOUT_MS = 60_000; // 60 seconds
const MAX_MESSAGE_SIZE = 256 * 1024; // 256KB

export class ConnectionManager {
	constructor(logger) {
		this.clients = new Map();
		this.logger = logger;
		this.heartbeatInterval = null;
	}

	addConnection(socket) {
		const clientId = randomUUID();
		const clientInfo = {
			id: clientId,
			socket,
			sessionCode: null,
			isAlive: true,
			lastHeartbeat: Date.now(),
			createdAt: Date.now(),
			messagesReceived: 0,
			messagesSent: 0
		};

		this.clients.set(clientId, clientInfo);

		// Handle pong responses
		socket.on("pong", () => {
			const client = this.clients.get(clientId);
			if (client) {
				client.isAlive = true;
				client.lastHeartbeat = Date.now();
			}
		});

		this.logger.info({ clientId }, "Client connected");
		return clientId;
	}

	getConnection(clientId) {
		return this.clients.get(clientId);
	}

	setSessionCode(clientId, code) {
		const client = this.clients.get(clientId);
		if (client) {
			client.sessionCode = code;
		}
	}

	removeConnection(clientId) {
		const client = this.clients.get(clientId);
		if (client) {
			try {
				if (client.socket.readyState !== 3) {
					// 3 = CLOSED
					client.socket.terminate();
				}
			} catch {
				// Already closed
			}
			this.clients.delete(clientId);
			this.logger.info({ clientId }, "Client removed");
			return client;
		}
	}

	sendMessage(clientId, message) {
		const client = this.clients.get(clientId);
		if (!client) return false;

		if (client.socket.readyState !== 1) {
			// 1 = OPEN
			return false;
		}

		try {
			const payload = JSON.stringify(message);
			if (payload.length > MAX_MESSAGE_SIZE) {
				this.logger.warn(
					{ clientId, size: payload.length },
					"Message exceeds max size"
				);
				return false;
			}
			client.socket.send(payload);
			client.messagesSent++;
			return true;
		} catch (error) {
			this.logger.error({ clientId, error }, "Failed to send message");
			return false;
		}
	}

	startHeartbeat() {
		if (this.heartbeatInterval) return;

		this.heartbeatInterval = setInterval(() => {
			const now = Date.now();
			const deadClients = [];

			for (const [clientId, client] of this.clients) {
				// Check if client missed heartbeat
				if (!client.isAlive || now - client.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
					deadClients.push(clientId);
					continue;
				}

				// Send ping
				client.isAlive = false;
				try {
					client.socket.ping();
				} catch {
					deadClients.push(clientId);
				}
			}

			// Clean up dead connections
			deadClients.forEach((clientId) => {
				this.logger.info({ clientId }, "Terminating stale connection");
				this.removeConnection(clientId);
			});
		}, HEARTBEAT_INTERVAL_MS);
	}

	stopHeartbeat() {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}
	}

	getStats() {
		return {
			totalConnections: this.clients.size,
			connections: Array.from(this.clients.values()).map((c) => ({
				id: c.id.slice(0, 8),
				inSession: !!c.sessionCode,
				isAlive: c.isAlive,
				age: Date.now() - c.createdAt,
				messagesReceived: c.messagesReceived,
				messagesSent: c.messagesSent
			}))
		};
	}

	closeAll() {
		this.stopHeartbeat();
		for (const [clientId] of this.clients) {
			this.removeConnection(clientId);
		}
		this.clients.clear();
	}
}