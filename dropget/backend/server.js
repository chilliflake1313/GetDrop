import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT) || 3001;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map();

function sendJson(socket, payload) {
	if (socket.readyState === socket.OPEN) {
		socket.send(JSON.stringify(payload));
	}
}

function broadcastExcept(senderId, payload) {
	for (const [id, socket] of clients.entries()) {
		if (id !== senderId && socket.readyState === socket.OPEN) {
			sendJson(socket, payload);
		}
	}
}

wss.on("connection", (socket) => {
	const clientId = randomUUID();
	clients.set(clientId, socket);

	sendJson(socket, { type: "welcome", clientId });

	broadcastExcept(clientId, {
		type: "peer-joined",
		clientId
	});

	socket.on("message", (data) => {
		let message;

		try {
			message = JSON.parse(data.toString());
		} catch {
			sendJson(socket, { type: "error", message: "Invalid JSON payload" });
			return;
		}

		const targetId = message?.targetId;

		if (targetId && clients.has(targetId)) {
			sendJson(clients.get(targetId), {
				...message,
				from: clientId
			});
			return;
		}

		broadcastExcept(clientId, {
			...message,
			from: clientId
		});
	});

	socket.on("close", () => {
		clients.delete(clientId);
		broadcastExcept(clientId, {
			type: "peer-left",
			clientId
		});
	});

	socket.on("error", () => {
		clients.delete(clientId);
	});
});

console.log(`Signaling server listening on ws://localhost:${PORT}`);
