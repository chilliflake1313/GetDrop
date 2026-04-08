import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT) || 3001;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map();
const sessions = new Map();

function generateSessionCode() {
	return Math.random().toString(36).substring(2, 10).toUpperCase();
}

function sendJson(socket, payload) {
	if (socket.readyState === socket.OPEN) {
		socket.send(JSON.stringify(payload));
	}
}

wss.on("connection", (socket) => {
	const clientId = randomUUID();
	clients.set(clientId, { socket, sessionCode: null });

	console.log(`Client connected: ${clientId} - server.js:24`);

	socket.on("message", (data) => {
		let message;

		try {
			message = JSON.parse(data.toString());
		} catch {
			sendJson(socket, { type: "error", message: "Invalid JSON payload" });
			return;
		}

		const clientInfo = clients.get(clientId);
		if (!clientInfo) return;

		// Handle session creation
		if (message.type === "create") {
			const code = generateSessionCode();
			clientInfo.sessionCode = code;
			sessions.set(code, { peers: [clientId], createdAt: Date.now() });
			sendJson(socket, { type: "created", code });
			console.log(`Session created: ${code} - server.js:45`);
			return;
		}

		// Handle session join
		if (message.type === "join") {
			const { code } = message;
			if (!code || !sessions.has(code)) {
				sendJson(socket, { type: "error", message: "Session not found" });
				return;
			}

			const session = sessions.get(code);
			if (session.peers.length >= 2) {
				sendJson(socket, { type: "error", message: "Session full" });
				return;
			}

			clientInfo.sessionCode = code;
			session.peers.push(clientId);

			// Notify both peers
			sendJson(socket, { type: "joined", code });

			const otherPeerId = session.peers[0];
			const otherClient = clients.get(otherPeerId);
			if (otherClient) {
				sendJson(otherClient.socket, { type: "peer-joined", peerId: clientId });
			}

			console.log(`Client joined session ${code}: ${clientId} - server.js:75`);
			return;
		}

		// Relay WebRTC signaling messages between paired peers
		if (["offer", "answer", "ice-candidate"].includes(message.type)) {
			if (!clientInfo.sessionCode) {
				sendJson(socket, { type: "error", message: "Not in a session" });
				return;
			}

			const session = sessions.get(clientInfo.sessionCode);
			if (!session || session.peers.length < 2) {
				sendJson(socket, { type: "error", message: "Peer not found" });
				return;
			}

			// Find the other peer in the session
			const otherPeerId = session.peers.find(id => id !== clientId);
			if (!otherPeerId) {
				sendJson(socket, { type: "error", message: "Peer not found" });
				return;
			}

			const otherClient = clients.get(otherPeerId);
			if (otherClient) {
				sendJson(otherClient.socket, {
					...message,
					from: clientId
				});
			}
		}
	});

	socket.on("close", () => {
		const clientInfo = clients.get(clientId);
		if (clientInfo && clientInfo.sessionCode) {
			const session = sessions.get(clientInfo.sessionCode);
			if (session) {
				// Notify the other peer
				const otherPeerId = session.peers.find(id => id !== clientId);
				if (otherPeerId) {
					const otherClient = clients.get(otherPeerId);
					if (otherClient) {
						sendJson(otherClient.socket, { type: "peer-left" });
					}
				}
				// Clean up session
				sessions.delete(clientInfo.sessionCode);
			}
		}
		clients.delete(clientId);
		console.log(`Client disconnected: ${clientId} - server.js:127`);
	});

	socket.on("error", () => {
		clients.delete(clientId);
	});
});

console.log(`Signaling server listening on ws://localhost:${PORT} - server.js:135`);

