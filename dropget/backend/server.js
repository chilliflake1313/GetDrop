import express from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname } from "node:path";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "os";
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	DeleteObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { sessionManager } from "./lib/sessionManager.js";

dotenv.config({ path: fileURLToPath(new URL(".env", import.meta.url)), override: true });

const PORT = Number(process.env.PORT) || 3001;
const BUCKET = process.env.R2_BUCKET || "get-drop";
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
function normalizeR2Endpoint(value) {
	if (!value) {
		return undefined;
	}

	try {
		return new URL(value).origin;
	} catch {
		return value;
	}
}

const R2_ENDPOINT = normalizeR2Endpoint(process.env.R2_ENDPOINT) ||
	(R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const HUNDRED_MB_BYTES = 100 * 1024 * 1024;
const CLEANUP_INTERVAL_MS = 60 * 1000;
function getNumericEnv(name, fallbackValue) {
	const rawValue = process.env[name];
	if (rawValue === undefined) {
		return fallbackValue;
	}

	const parsed = Number(rawValue);
	return Number.isFinite(parsed) ? parsed : fallbackValue;
}

const MAX_UPLOAD_SIZE_BYTES = getNumericEnv("MAX_UPLOAD_SIZE_BYTES", 1024 * 1024 * 1024);
const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_CLEANUP_ATTEMPTS = 3;
const MAX_ACTIVE_FILES = getNumericEnv("MAX_ACTIVE_FILES", 500);
const UPLOAD_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const UPLOAD_RATE_LIMIT_MAX = 30;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const upload = multer({
	dest: "tmp_uploads/",
	limits: {
		fileSize: MAX_UPLOAD_SIZE_BYTES
	}
});
const uploadRateLimiter = rateLimit({
	windowMs: UPLOAD_RATE_LIMIT_WINDOW_MS,
	max: UPLOAD_RATE_LIMIT_MAX
});

const uploadedFiles = new Map();

const s3 = R2_ENDPOINT
	? new S3Client({
		region: "auto",
		endpoint: R2_ENDPOINT,
		credentials: {
			accessKeyId: process.env.R2_ACCESS_KEY || "",
			secretAccessKey: process.env.R2_SECRET_KEY || ""
		},
		forcePathStyle: true
	})
	: null;

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

function sendJson(socket, payload) {
	if (socket.readyState === socket.OPEN) {
		socket.send(JSON.stringify(payload));
	}
}

function getS3Client() {
	if (!s3) {
		throw new Error("Cloudflare R2 is not configured");
	}
	return s3;
}

function getFileExpiryMs(size) {
	return size > HUNDRED_MB_BYTES ? FIFTEEN_MINUTES_MS : FIVE_MINUTES_MS;
}

function trackUploadedFile(fileId, size) {
	const uploadedAt = Date.now();
	uploadedFiles.set(fileId, {
		uploadedAt,
		size,
		expiresAt: uploadedAt + getFileExpiryMs(size),
		cleanupAttempts: 0
	});
}

function isAllowedMimeType(mimeType) {
	const blockedMimeTypes = new Set([
		"text/html",
		"application/javascript",
		"text/javascript",
		"application/x-msdownload"
	]);

	if (!mimeType) {
		return false;
	}

	return !blockedMimeTypes.has(mimeType.toLowerCase());
}

function getTotalActiveFiles() {
	return uploadedFiles.size;
}

async function createSignedDownloadUrl(fileId) {
	return getSignedUrl(
		getS3Client(),
		new GetObjectCommand({
			Bucket: BUCKET,
			Key: fileId,
			ResponseContentDisposition: `attachment; filename="${fileId}"`
		}),
		{ expiresIn: 300 }
	);
}

async function objectExists(key) {
	try {
		await getS3Client().send(
			new HeadObjectCommand({
				Bucket: BUCKET,
				Key: key
			})
		);
		return true;
	} catch (error) {
		if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") {
			return false;
		}
		throw error;
	}
}

async function createUniqueFileId(extension) {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const fileId = `${randomUUID()}${extension}`;
		const exists = await objectExists(fileId);
		if (!exists) {
			return fileId;
		}
	}

	throw new Error("Could not generate unique file id");
}

async function uploadWithRetry(params) {
	let lastError;
	for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
		try {
			await getS3Client().send(new PutObjectCommand(params));
			return;
		} catch (error) {
			lastError = error;
			if (attempt === MAX_UPLOAD_ATTEMPTS) {
				break;
			}
		}
	}

	throw lastError;
}

export const cleanupFile = async (key) => {
	await getS3Client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
	uploadedFiles.delete(key);
};

async function cleanupExpiredFiles() {
	const now = Date.now();
	for (const [fileId, metadata] of uploadedFiles.entries()) {
		if (metadata.expiresAt > now) {
			continue;
		}

		try {
			await cleanupFile(fileId);
		} catch (error) {
			metadata.cleanupAttempts = (metadata.cleanupAttempts || 0) + 1;
			uploadedFiles.set(fileId, metadata);
			if (metadata.cleanupAttempts >= MAX_CLEANUP_ATTEMPTS) {
				uploadedFiles.delete(fileId);
			}
			console.error("R2 cleanup error: - server.js:254", error);
		}
	}
}

setInterval(() => {
	cleanupExpiredFiles().catch((error) => {
		console.error("R2 cleanup interval error: - server.js:261", error);
	});
}, CLEANUP_INTERVAL_MS);

app.post("/upload", uploadRateLimiter, upload.single("file"), async (req, res) => {
	let tempFilePath = null;
	try {
		if (!req.file) {
			res.status(400).json({ message: "No file uploaded" });
			return;
		}

		tempFilePath = req.file.path || null;

		if ((req.file.size || 0) > MAX_UPLOAD_SIZE_BYTES) {
			res.status(400).json({ message: "File too large" });
			return;
		}

		if (!isAllowedMimeType(req.file.mimetype || "")) {
			res.status(400).json({ message: "Invalid file type" });
			return;
		}

		if (getTotalActiveFiles() >= MAX_ACTIVE_FILES) {
			res.status(503).json({ message: "Active storage limit reached" });
			return;
		}

		if (!s3) {
			res.status(500).json({ message: "R2 is not configured" });
			return;
		}

		const extension = extname(req.file.originalname || "");
		const fileId = await createUniqueFileId(extension);
		const fileStream = createReadStream(req.file.path);

		await uploadWithRetry({
			Bucket: BUCKET,
			Key: fileId,
			Body: fileStream,
			ContentType: req.file.mimetype || "application/octet-stream"
		});

		trackUploadedFile(fileId, req.file.size || 0);

		res.json({ fileId });
	} catch (error) {
		console.error("Upload error: - server.js:310", error);
		res.status(500).json({ message: "Upload failed" });
	} finally {
		if (tempFilePath) {
			unlink(tempFilePath).catch(() => {
				// Best effort temp cleanup.
			});
		}
	}
});

app.get("/download/:fileId", async (req, res) => {
	try {
		const metadata = uploadedFiles.get(req.params.fileId);
		if (!metadata) {
			res.status(404).json({ message: "File not available" });
			return;
		}

		if (metadata.expiresAt <= Date.now()) {
			cleanupFile(req.params.fileId).catch((error) => {
				console.error("Late cleanup error: - server.js:331", error);
			});
			res.status(410).json({ message: "File expired" });
			return;
		}

		const url = await createSignedDownloadUrl(req.params.fileId);

		res.json({ url });
	} catch (error) {
		console.error("Download URL error: - server.js:341", error);
		res.status(500).json({ message: "Could not create download URL" });
	}
});

app.use((error, req, res, next) => {
	if (error?.code === "LIMIT_FILE_SIZE") {
		res.status(400).json({ message: "File too large" });
		return;
	}

	next(error);
});

wss.on("connection", (socket) => {
	const clientId = randomUUID();
	clients.set(clientId, { socket, sessionCode: null });

	console.log(`Client connected: ${clientId} - server.js:359`);

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
			try {
				const { code, sessionId } = sessionManager.createSession(clientId);
				clientInfo.sessionCode = code;
				sendJson(socket, { type: "created", code, sessionId });
			} catch (error) {
				console.error("Session create error: - server.js:376", error);
				sendJson(socket, { type: "error", message: "Could not create session" });
			}
			console.log(`Session created: ${code} - server.js:380`);
			return;
		}

		// Handle session join
		if (message.type === "join") {
			const { code } = message;
			console.log(`JOIN REQUEST: code="${code}" - server.js:387`);
			if (!code) {
				sendJson(socket, { type: "error", message: "Session not found" });
				return;
			}

			const joinResult = sessionManager.joinSession(code, clientId);
			if (!joinResult.success) {
				sendJson(socket, { type: "error", message: joinResult.error });
				return;
			}

			const session = sessionManager.getSession(code);
			if (!session) {
				sendJson(socket, { type: "error", message: "Session not found" });
				return;
			}

			clientInfo.sessionCode = code;

			// Notify both peers
			sendJson(socket, { type: "joined", code, sessionId: session.id });

			const otherPeerId = session.peers[0];
			const otherClient = clients.get(otherPeerId);
			if (otherClient) {
				sendJson(otherClient.socket, { type: "peer-joined", peerId: clientId });
			}

			console.log(`Client joined session ${code}: ${clientId} - server.js:412`);
			return;
		}

		// Relay WebRTC signaling messages between paired peers
		if (["offer", "answer", "ice-candidate", "file-ready"].includes(message.type)) {
			if (!clientInfo.sessionCode) {
				console.log(`ERROR: ${message.type} received but client not in session - server.js:419`);
				sendJson(socket, { type: "error", message: "Not in a session" });
				return;
			}

			const session = sessionManager.getSession(clientInfo.sessionCode);
			if (!session || session.peers.length < 2) {
				console.log(`ERROR: ${message.type} received but peer not found in session - server.js:426`);
				sendJson(socket, { type: "error", message: "Peer not found" });
				return;
			}

			// Find the other peer in the session
			const otherPeerId = session.peers.find(id => id !== clientId);
			if (!otherPeerId) {
				console.log(`ERROR: No other peer found for ${message.type} - server.js:434`);
				sendJson(socket, { type: "error", message: "Peer not found" });
				return;
			}

			const otherClient = clients.get(otherPeerId);
			if (otherClient) {
				console.log(`RELAYED ${message.type} from ${clientId.slice(0, 8)} to ${otherPeerId.slice(0, 8)} - server.js:441`);
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
			const session = sessionManager.removeClientFromSession(clientId);
			if (session) {
				// Notify the other peer
				const otherPeerId = session.peers.find((id) => id !== clientId);
				if (otherPeerId) {
					const otherClient = clients.get(otherPeerId);
					if (otherClient) {
						sendJson(otherClient.socket, { type: "peer-left" });
					}
				}
			}
		}
		clients.delete(clientId);
		console.log(`Client disconnected: ${clientId} - server.js:472`);
	});

	socket.on("error", () => {
		clients.delete(clientId);
	});
});

const localIP = getLocalIP();
server.listen(PORT, "0.0.0.0", () => {
	console.log("DropGet server listening on: - server.js:482");
	console.log(`Local HTTP: http://localhost:${PORT} - server.js:483`);
	console.log(`Network HTTP: http://${localIP}:${PORT} - server.js:484`);
	console.log(`Local WS: ws://localhost:${PORT} - server.js:485`);
	console.log(`Network WS: ws://${localIP}:${PORT} - server.js:486`);
});

