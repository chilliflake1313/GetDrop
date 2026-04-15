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

import { createLogger } from "./lib/logger.js";
import { sessionManager } from "./lib/sessionManager.js";
import { ConnectionManager } from "./lib/connectionManager.js";
import { FileCleanupManager } from "./lib/fileCleanupManager.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

dotenv.config({
	path: fileURLToPath(new URL(".env", import.meta.url)),
	override: true
});

const appLogger = createLogger("server");
const PORT = Number(process.env.PORT) || 3001;
const BUCKET = process.env.R2_BUCKET || "get-drop";
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;

function normalizeR2Endpoint(value) {
	if (!value) return undefined;
	try {
		return new URL(value).origin;
	} catch {
		return value;
	}
}

const R2_ENDPOINT =
	normalizeR2Endpoint(process.env.R2_ENDPOINT) ||
	(R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const HUNDRED_MB_BYTES = 100 * 1024 * 1024;

function getNumericEnv(name, fallbackValue) {
	const rawValue = process.env[name];
	if (rawValue === undefined) return fallbackValue;
	const parsed = Number(rawValue);
	return Number.isFinite(parsed) ? parsed : fallbackValue;
}

const MAX_UPLOAD_SIZE_BYTES = getNumericEnv("MAX_UPLOAD_SIZE_BYTES", 1024 * 1024 * 1024);
const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_ACTIVE_FILES = getNumericEnv("MAX_ACTIVE_FILES", 500);
const UPLOAD_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const UPLOAD_RATE_LIMIT_MAX = 30;

// ============================================================================
// INITIALIZE SERVICES
// ============================================================================

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const upload = multer({
	dest: "tmp_uploads/",
	limits: { fileSize: MAX_UPLOAD_SIZE_BYTES }
});

const uploadRateLimiter = rateLimit({
	windowMs: UPLOAD_RATE_LIMIT_WINDOW_MS,
	max: UPLOAD_RATE_LIMIT_MAX,
	skip: (req) => req.path === "/health"
});

const uploadedFiles = new Map(); // fileId -> metadata

// Initialize S3 client
const s3 =
	R2_ENDPOINT &&
	new S3Client({
		region: "auto",
		endpoint: R2_ENDPOINT,
		credentials: {
			accessKeyId: process.env.R2_ACCESS_KEY || "",
			secretAccessKey: process.env.R2_SECRET_KEY || ""
		},
		forcePathStyle: true
	});

// Initialize managers
const connectionManager = new ConnectionManager(appLogger);
const fileCleanupManager = new FileCleanupManager(appLogger, s3);

// Configure file cleanup manager
fileCleanupManager.setBucket(BUCKET);

// Start background processes
connectionManager.startHeartbeat();
fileCleanupManager.start();

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

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

function isAllowedMimeType(mimeType) {
	const blockedMimeTypes = new Set([
		"text/html",
		"application/javascript",
		"text/javascript",
		"application/x-msdownload"
	]);

	if (!mimeType) return false;
	return !blockedMimeTypes.has(mimeType.toLowerCase());
}

function getFileExpiryMs(size) {
	return size > HUNDRED_MB_BYTES ? FIFTEEN_MINUTES_MS : FIVE_MINUTES_MS;
}

function trackUploadedFile(fileId, size) {
	const uploadedAt = Date.now();
	const expiresAt = uploadedAt + getFileExpiryMs(size);

	uploadedFiles.set(fileId, {
		uploadedAt,
		size,
		expiresAt
	});

	fileCleanupManager.registerFile(fileId, expiresAt, size);
}

async function objectExists(key) {
	try {
		await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
		return true;
	} catch (error) {
		if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") {
			return false;
		}
		throw error;
	}
}

async function createUniqueFileId(extension) {
	for (let attempt = 0; attempt < 10; attempt++) {
		const fileId = `${randomUUID()}${extension}`;
		const exists = await objectExists(fileId);
		if (!exists) return fileId;
	}
	throw new Error("Could not generate unique file ID");
}

async function uploadWithRetry(params) {
	let lastError;
	for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
		try {
			await s3.send(new PutObjectCommand(params));
			return;
		} catch (error) {
			lastError = error;
			if (attempt < MAX_UPLOAD_ATTEMPTS) {
				await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
			}
		}
	}
	throw lastError;
}

async function createSignedDownloadUrl(fileId) {
	return getSignedUrl(
		s3,
		new GetObjectCommand({
			Bucket: BUCKET,
			Key: fileId,
			ResponseContentDisposition: `attachment; filename="${fileId}"`
		}),
		{ expiresIn: 300 }
	);
}

async function cleanupFileFromS3(fileId) {
	try {
		await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: fileId }));
		uploadedFiles.delete(fileId);
		appLogger.info({ fileId }, "File cleaned up from S3");
	} catch (error) {
		appLogger.error({ fileId, error: error.message }, "S3 cleanup failed");
		throw error;
	}
}

// ============================================================================
// HTTP MIDDLEWARE
// ============================================================================

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

// ============================================================================
// HTTP ROUTES
// ============================================================================

app.get("/health", (req, res) => {
	const uptime = process.uptime();
	const memUsage = process.memoryUsage();

	res.json({
		status: "healthy",
		service: "dropget-backend",
		uptime: Math.floor(uptime),
		memory: {
			heapUsed: Math.floor(memUsage.heapUsed / 1024 / 1024),
			heapTotal: Math.floor(memUsage.heapTotal / 1024 / 1024),
			rss: Math.floor(memUsage.rss / 1024 / 1024)
		},
		connections: connectionManager.getStats(),
		sessions: sessionManager.getStats(),
		files: {
			active: uploadedFiles.size,
			cleanup: fileCleanupManager.getStats()
		}
	});
});

app.get("/", (req, res) => {
	res.json({
		status: "ok",
		service: "dropget-backend",
		ws: process.env.WS_URL || "ws://localhost:3001"
	});
});

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

		if (uploadedFiles.size >= MAX_ACTIVE_FILES) {
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

		appLogger.info(
			{ fileId, size: req.file.size, type: req.file.mimetype },
			"File uploaded successfully"
		);

		res.json({ fileId });
	} catch (error) {
		appLogger.error({ error: error.message }, "Upload failed");
		res.status(500).json({ message: "Upload failed" });
	} finally {
		if (tempFilePath) {
			unlink(tempFilePath).catch(() => {
				// Best effort cleanup
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
			fileCleanupManager.unregisterFile(req.params.fileId);
			await cleanupFileFromS3(req.params.fileId);
			res.status(410).json({ message: "File expired" });
			return;
		}

		const url = await createSignedDownloadUrl(req.params.fileId);

		appLogger.info({ fileId: req.params.fileId }, "Download URL generated");

		res.json({ url });
	} catch (error) {
		appLogger.error(
			{ fileId: req.params.fileId, error: error.message },
			"Download URL generation failed"
		);
		res.status(500).json({ message: "Could not create download URL" });
	}
});

// Error handler
app.use((error, req, res, next) => {
	if (error?.code === "LIMIT_FILE_SIZE") {
		res.status(400).json({ message: "File too large" });
		return;
	}

	appLogger.error({ error: error.message, stack: error.stack }, "Unhandled HTTP error");
	res.status(500).json({ message: "Internal server error" });
});

// ============================================================================
// WEBSOCKET HANDLERS
// ============================================================================

wss.on("connection", (socket) => {
	const clientId = connectionManager.addConnection(socket);

	// Handle WebSocket errors
	socket.on("error", (error) => {
		appLogger.error(
			{ clientId: clientId.slice(0, 8), error: error.message },
			"WebSocket error"
		);
	});

	// Handle incoming messages
	socket.on("message", async (data) => {
		try {
			// Check rate limit
			if (connectionManager.isRateLimited(clientId)) {
				connectionManager.sendMessage(clientId, {
					type: "error",
					message: "Rate limit exceeded"
				});
				return;
			}

			// Parse message
			let message;
			try {
				message = JSON.parse(data.toString());
			} catch {
				connectionManager.sendMessage(clientId, {
					type: "error",
					message: "Invalid JSON payload"
				});
				return;
			}

			// Validate message structure
			if (!message?.type) {
				connectionManager.sendMessage(clientId, {
					type: "error",
					message: "Missing message type"
				});
				return;
			}

			// Get client info
			const clientInfo = connectionManager.getConnection(clientId);
			if (!clientInfo) {
				appLogger.warn({ clientId: clientId.slice(0, 8) }, "Message from unknown client");
				return;
			}

			// Update message received count
			clientInfo.messagesReceived++;

			// Handle different message types
			await handleWebSocketMessage(clientId, clientInfo, message);
		} catch (error) {
			appLogger.error(
				{ clientId: clientId.slice(0, 8), error: error.message },
				"WebSocket message handler error"
			);
			connectionManager.sendMessage(clientId, {
				type: "error",
				message: "Internal server error"
			});
		}
	});

	// Handle client disconnect
	socket.on("close", () => {
		handleClientDisconnect(clientId);
	});
});

async function handleWebSocketMessage(clientId, clientInfo, message) {
	const { type } = message;

	switch (type) {
		case "create":
			await handleCreateSession(clientId);
			break;

		case "join":
			await handleJoinSession(clientId, message);
			break;

		case "offer":
		case "answer":
		case "ice-candidate":
		case "file-ready":
			await handleSignalingMessage(clientId, message);
			break;

		default:
			connectionManager.sendMessage(clientId, {
				type: "error",
				message: `Unknown message type: ${type}`
			});
	}
}

async function handleCreateSession(clientId) {
	try {
		const { code, sessionId } = sessionManager.createSession(clientId);
		connectionManager.updateSessionCode(clientId, code);

		connectionManager.sendMessage(clientId, {
			type: "session-created",
			code,
			sessionId
		});

		appLogger.info(
			{ clientId: clientId.slice(0, 8), code },
			"Session created"
		);
	} catch (error) {
		appLogger.error(
			{ clientId: clientId.slice(0, 8), error: error.message },
			"Failed to create session"
		);
		connectionManager.sendMessage(clientId, {
			type: "error",
			message: "Failed to create session"
		});
	}
}

async function handleJoinSession(clientId, message) {
	const { code } = message;

	if (!code) {
		connectionManager.sendMessage(clientId, {
			type: "error",
			message: "Session code is required"
		});
		return;
	}

	const normalizedCode = code.toUpperCase();
	const result = sessionManager.joinSession(normalizedCode, clientId);

	if (!result.success) {
		connectionManager.sendMessage(clientId, {
			type: "error",
			message: result.error
		});
		return;
	}

	connectionManager.updateSessionCode(clientId, normalizedCode);

	// Notify both peers
	const session = sessionManager.getSession(normalizedCode);
	if (!session) return;

	const [initiatorId, joinerId] = session.peers;

	connectionManager.sendMessage(joinerId, {
		type: "session-joined",
		sessionId: result.sessionId
	});

	connectionManager.sendMessage(initiatorId, {
		type: "peer-joined"
	});

	appLogger.info(
		{ clientId: clientId.slice(0, 8), code: normalizedCode },
		"Client joined session"
	);
}

async function handleSignalingMessage(clientId, message) {
	const sessionData = sessionManager.getSessionByClientId(clientId);

	if (!sessionData) {
		connectionManager.sendMessage(clientId, {
			type: "error",
			message: "No active session"
		});
		return;
	}

	const { session } = sessionData;

	// Find the other peer
	const otherPeerId = session.peers.find((id) => id !== clientId);

	if (!otherPeerId) {
		connectionManager.sendMessage(clientId, {
			type: "error",
			message: "No peer connected"
		});
		return;
	}

	// Forward the message to the other peer
	connectionManager.sendMessage(otherPeerId, message);

	appLogger.debug(
		{ from: clientId.slice(0, 8), to: otherPeerId.slice(0, 8), type: message.type },
		"Signaling message relayed"
	);
}

function handleClientDisconnect(clientId) {
	// Get session info before removing
	const sessionData = sessionManager.getSessionByClientId(clientId);

	if (sessionData) {
		const { session } = sessionData;

		// Find other peer BEFORE removing current client
		const otherPeerId = session.peers.find((id) => id !== clientId);

		// Remove client from session
		sessionManager.removeClientFromSession(clientId);

		// Notify other peer if they exist
		if (otherPeerId) {
			connectionManager.sendMessage(otherPeerId, { type: "peer-left" });
			appLogger.info(
				{ peerId: otherPeerId.slice(0, 8) },
				"Notified peer of disconnect"
			);
		}
	}

	// Remove connection
	connectionManager.removeConnection(clientId);

	appLogger.info({ clientId: clientId.slice(0, 8) }, "Client disconnected");
}

const localIP = getLocalIP();
server.listen(PORT, "0.0.0.0", () => {
	appLogger.info({ port: PORT, env: process.env.NODE_ENV || "development" }, "DropGet server started");
	appLogger.info({ url: `http://localhost:${PORT}` }, "Local HTTP");
	appLogger.info({ url: `http://${localIP}:${PORT}` }, "Network HTTP");
	appLogger.info({ url: `ws://localhost:${PORT}` }, "Local WS");
	appLogger.info({ url: `ws://${localIP}:${PORT}` }, "Network WS");
});
