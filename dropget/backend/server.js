import express from "express";
import multer from "multer";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "os";
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const PORT = Number(process.env.PORT) || 3001;
const BUCKET = process.env.MINIO_BUCKET || "dropget";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const upload = multer({ storage: multer.memoryStorage() });

const s3 = new S3Client({
	region: process.env.MINIO_REGION || "us-east-1",
	endpoint: process.env.MINIO_ENDPOINT || "http://localhost:9000",
	credentials: {
		accessKeyId: process.env.MINIO_ACCESS_KEY || "admin",
		secretAccessKey: process.env.MINIO_SECRET_KEY || "password"
	},
	forcePathStyle: true
});

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

app.use((req, res, next) => {
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
	res.header("Access-Control-Allow-Headers", "Content-Type");
	if (req.method === "OPTIONS") {
		res.sendStatus(204);
		return;
	}
	next();
});

app.use(express.json());

app.get("/", (req, res) => {
	res.json({
		status: "ok",
		service: "dropget-backend",
		ws: "wss://getdrop-3.onrender.com"
	});
});

function generateSessionCode() {
	return Math.random().toString(36).substring(2, 10).toUpperCase();
}

function sendJson(socket, payload) {
	if (socket.readyState === socket.OPEN) {
		socket.send(JSON.stringify(payload));
	}
}

export const cleanupFile = async (key) => {
	await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
};

app.post("/upload", upload.single("file"), async (req, res) => {
	try {
		if (!req.file) {
			res.status(400).json({ message: "No file uploaded" });
			return;
		}

		const fileId = randomUUID();

		await s3.send(
			new PutObjectCommand({
				Bucket: BUCKET,
				Key: fileId,
				Body: req.file.buffer,
				ContentType: req.file.mimetype || "application/octet-stream"
			})
		);

		setTimeout(() => {
			cleanupFile(fileId).catch((error) => {
				console.error("MinIO cleanup error:", error);
			});
		}, 15 * 60 * 1000);

		res.json({ fileId, fileName: req.file.originalname });
	} catch (error) {
		console.error("Upload error:", error);
		res.status(500).json({ message: "Upload failed" });
	}
});

app.get("/download/:fileId", async (req, res) => {
	try {
		const url = await getSignedUrl(
			s3,
			new GetObjectCommand({
				Bucket: BUCKET,
				Key: req.params.fileId
			}),
			{ expiresIn: 600 }
		);

		res.json({ url });
	} catch (error) {
		console.error("Download URL error:", error);
		res.status(500).json({ message: "Could not create download URL" });
	}
});

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
		if (["offer", "answer", "ice-candidate", "file-ready"].includes(message.type)) {
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
				session.peers = session.peers.filter(id => id !== clientId);

				// Notify the other peer
				const otherPeerId = session.peers.find(id => id !== clientId);
				if (otherPeerId) {
					const otherClient = clients.get(otherPeerId);
					if (otherClient) {
						sendJson(otherClient.socket, { type: "peer-left" });
					}
				}

				if (session.peers.length === 0) {
					sessions.delete(clientInfo.sessionCode);
				}
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
server.listen(PORT, "0.0.0.0", () => {
	console.log("DropGet server listening on:");
	console.log(`  Local HTTP: http://localhost:${PORT}`);
	console.log(`  Network HTTP: http://${localIP}:${PORT}`);
	console.log(`  Local WS: ws://localhost:${PORT}`);
	console.log(`  Network WS: ws://${localIP}:${PORT}`);
});

