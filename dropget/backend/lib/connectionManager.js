import { randomUUID } from "node:crypto";

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const HEARTBEAT_TIMEOUT_MS = 60_000; // 60 seconds
const MAX_MESSAGE_SIZE = 256 * 1024; // 256KB
const WS_RATE_LIMIT_WINDOW_MS = 1_000; // 1 second
const WS_RATE_LIMIT_MAX = 10; // 10 messages per second

class RateLimiter {
	constructor(maxMessages, windowMs) {
		this.maxMessages = maxMessages;
		this.windowMs = windowMs;
		this.messages = [];
	}

	isAllowed() {
		const now = Date.now();
		// Remove old messages outside the window
		this.messages = this.messages.filter((t) => now - t < this.windowMs);

		if (this.messages.length >= this.maxMessages) {
			return false;
		}

		this.messages.push(now);
		return true;
	}

	reset() {
		this.messages = [];
	}
}

export class ConnectionManager {
	constructor(logger) {
		this.clients = new Map(); // clientId -> clientInfo
		this.rateLimiters = new Map(); // clientId -> RateLimiter
		this.logger = logger || console;
		this.heartbeatInterval = null;
		this.stats = {
			totalConnected: 0,
			totalDisconnected: 0,
			totalErrors: 0
		};
	}

	addConnection(socket) {
		const clientId = randomUUID();
		const now = Date.now();

		const clientInfo = {
			id: clientId,
			socket,
			sessionCode: null,
			isAlive: true,
			lastHeartbeat: now,
			createdAt: now,
			messagesReceived: 0,
			messagesSent: 0
		};

		this.clients.set(clientId, clientInfo);
		this.rateLimiters.set(clientId, new RateLimiter(WS_RATE_LIMIT_MAX, WS_RATE_LIMIT_WINDOW_MS));

		// Handle pong responses from client
		socket.on("pong", () => {
			const client = this.clients.get(clientId);
			if (client) {
				client.isAlive = true;
				client.lastHeartbeat = Date.now();
			}
		});

		this.stats.totalConnected++;
		this.logger.info(
			{ clientId: clientId.slice(0, 8), total: this.clients.size },
			"Client connected"
		);

		return clientId;
	}

	getConnection(clientId) {
		return this.clients.get(clientId);
	}

	updateSessionCode(clientId, sessionCode) {
		const client = this.clients.get(clientId);
		if (client) {
			client.sessionCode = sessionCode;
		}
	}

	isRateLimited(clientId) {
		const limiter = this.rateLimiters.get(clientId);
		if (!limiter) {
			return false;
		}
		return !limiter.isAllowed();
	}

	sendMessage(clientId, payload) {
		const client = this.clients.get(clientId);
		if (!client) {
			this.logger.warn({ clientId: clientId.slice(0, 8) }, "Client not found for sendMessage");
			return false;
		}

		const { socket } = client;
		if (socket.readyState !== 1) {
			// 1 = OPEN
			this.logger.warn(
				{ clientId: clientId.slice(0, 8), state: socket.readyState },
				"Socket not open"
			);
			return false;
		}

		try {
			const message = JSON.stringify(payload);

			// Check message size
			if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_SIZE) {
				this.logger.error(
					{ clientId: clientId.slice(0, 8), size: Buffer.byteLength(message, "utf8") },
					"Message too large"
				);
				return false;
			}

			socket.send(message);
			client.messagesSent++;
			return true;
		} catch (error) {
			this.logger.error(
				{ clientId: clientId.slice(0, 8), error: error.message },
				"Failed to send message"
			);
			this.stats.totalErrors++;
			return false;
		}
	}

	removeConnection(clientId) {
		const client = this.clients.get(clientId);
		if (!client) {
			return null;
		}

		try {
			// Only terminate if socket is not already closed
			if (client.socket.readyState !== 3) {
				// 3 = CLOSED
				client.socket.terminate();
			}
		} catch (error) {
			this.logger.warn(
				{ clientId: clientId.slice(0, 8), error: error.message },
				"Error terminating socket"
			);
		}

		this.clients.delete(clientId);
		this.rateLimiters.delete(clientId);
		this.stats.totalDisconnected++;

		this.logger.info(
			{ clientId: clientId.slice(0, 8), total: this.clients.size },
			"Client removed"
		);

		return client;
	}

	startHeartbeat() {
		if (this.heartbeatInterval) {
			this.logger.warn("Heartbeat already running");
			return;
		}

		this.heartbeatInterval = setInterval(() => {
			const now = Date.now();
			const deadClients = [];

			for (const [clientId, client] of this.clients) {
				// Check if client is dead
				if (!client.isAlive || now - client.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
					deadClients.push(clientId);
					continue;
				}

				// Mark as not alive, wait for pong
				client.isAlive = false;

				// Send ping
				try {
					client.socket.ping();
				} catch (error) {
					this.logger.warn(
						{ clientId: clientId.slice(0, 8), error: error.message },
						"Ping failed"
					);
					deadClients.push(clientId);
				}
			}

			// Remove dead clients
			deadClients.forEach((clientId) => {
				this.logger.info({ clientId: clientId.slice(0, 8) }, "Removing stale connection");
				this.removeConnection(clientId);
			});

			if (deadClients.length > 0) {
				this.logger.debug({ count: deadClients.length }, "Cleaned up stale connections");
			}
		}, HEARTBEAT_INTERVAL_MS);

		this.logger.info("Heartbeat monitoring started");
	}

	stopHeartbeat() {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
			this.logger.info("Heartbeat monitoring stopped");
		}
	}

	getStats() {
		return {
			activeConnections: this.clients.size,
			stats: this.stats,
			connections: Array.from(this.clients.values()).map((c) => ({
				id: c.id.slice(0, 8),
				sessionCode: c.sessionCode || null,
				isAlive: c.isAlive,
				age: Date.now() - c.createdAt,
				messagesReceived: c.messagesReceived,
				messagesSent: c.messagesSent
			}))
		};
	}

	destroy() {
		this.stopHeartbeat();

		// Terminate all connections
		for (const [clientId, client] of this.clients) {
			try {
				if (client.socket.readyState !== 3) {
					client.socket.terminate();
				}
			} catch {
				// Ignore errors on destroy
			}
		}

		this.clients.clear();
		this.rateLimiters.clear();
		this.logger.info("ConnectionManager destroyed");
	}
}
