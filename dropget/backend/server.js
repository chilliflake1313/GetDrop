import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "os";

const PORT = Number(process.env.PORT) || 3001;
const wss = new WebSocketServer({ port: PORT, host: "0.0.0.0" });

function getLocalIP() {
	const interfaces = networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name] || []) {
			if (iface.family === "IPv4" && !iface.internal) {
				return iface.address;
			}
		}
	}
	return "localhost";
}

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
			console.log(`JOIN REQUEST: code="${code}", sessions=${Array.from(sessions.keys()).join(", ")}`);
			if (!code || !sessions.has(code)) {
				console.log(`ERROR: Session "${code}" not found`);
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
				console.log(`ERROR: ${message.type} received but client not in session`);
				sendJson(socket, { type: "error", message: "Not in a session" });
				return;
			}

			const session = sessions.get(clientInfo.sessionCode);
			if (!session || session.peers.length < 2) {
				console.log(`ERROR: ${message.type} received but peer not found in session`);
				sendJson(socket, { type: "error", message: "Peer not found" });
				return;
			}

			// Find the other peer in the session
			const otherPeerId = session.peers.find(id => id !== clientId);
			if (!otherPeerId) {
				console.log(`ERROR: No other peer found for ${message.type}`);
				sendJson(socket, { type: "error", message: "Peer not found" });
				return;
			}

			const otherClient = clients.get(otherPeerId);
			if (otherClient) {
				console.log(`RELAYED ${message.type} from ${clientId.slice(0, 8)} to ${otherPeerId.slice(0, 8)}`);
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

const localIP = getLocalIP();
console.log(`Signaling server listening on:`);
console.log(`  Local: ws://localhost:${PORT}`);
console.log(`  Network: ws://${localIP}:${PORT}`);
console.log(`  All interfaces: ws://0.0.0.0:${PORT}`);

