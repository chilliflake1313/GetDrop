import { randomBytes } from "node:crypto";

const SESSION_EXPIRY_MS = 2 * 60 * 1000; // 2 minutes
const SESSION_CODE_LENGTH = 6;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export class SessionManager {
	constructor(logger) {
		this.logger = logger || console;
		this.sessions = new Map(); // code -> session
		this.sessionCodeToId = new Map(); // code -> sessionId
		this.clientToCode = new Map(); // clientId -> code
		this.cleanupInterval = null;
		this.stats = {
			totalCreated: 0,
			totalClosed: 0,
			totalExpired: 0
		};
		this.startCleanup();
	}

	generateSessionCode() {
		// Generate 6 bytes = 36^6 = ~2.17 billion combinations
		const bytes = randomBytes(SESSION_CODE_LENGTH);
		let code = "";
		for (let i = 0; i < SESSION_CODE_LENGTH; i++) {
			code += ALPHABET[bytes[i] % ALPHABET.length];
		}
		return code;
	}

	createSession(initiatorClientId) {
		if (!initiatorClientId) {
			throw new Error("Initiator client ID is required");
		}

		let code;
		let attempts = 0;
		const maxAttempts = 100;

		// Collision avoidance loop
		do {
			code = this.generateSessionCode();
			attempts++;
		} while (this.sessions.has(code) && attempts < maxAttempts);

		if (attempts >= maxAttempts) {
			throw new Error("Failed to generate unique session code after 100 attempts");
		}

		// Generate unique session ID
		const sessionId = `sess_${Date.now()}_${randomBytes(4).toString("hex")}`;
		const now = Date.now();

		const session = {
			id: sessionId,
			code,
			initiatorClientId,
			peers: [initiatorClientId],
			createdAt: now,
			expiresAt: now + SESSION_EXPIRY_MS,
			state: "pending" // pending | active | closed
		};

		this.sessions.set(code, session);
		this.sessionCodeToId.set(code, sessionId);
		this.clientToCode.set(initiatorClientId, code);

		this.stats.totalCreated++;
		this.logger.info(
			{
				code: code.slice(0, 4),
				sessionId: sessionId.slice(0, 8),
				clientId: initiatorClientId.slice(0, 8)
			},
			"Session created"
		);

		return { code, sessionId };
	}

	joinSession(code, joinerClientId) {
		if (!code || !joinerClientId) {
			return { success: false, error: "Code and client ID are required" };
		}

		const session = this.sessions.get(code);

		if (!session) {
			return { success: false, error: "Session not found" };
		}

		if (Date.now() > session.expiresAt) {
			this.sessions.delete(code);
			this.sessionCodeToId.delete(code);
			this.stats.totalExpired++;
			return { success: false, error: "Session expired" };
		}

		if (session.peers.length >= 2) {
			return { success: false, error: "Session full" };
		}

		if (session.peers.includes(joinerClientId)) {
			return { success: false, error: "Already in session" };
		}

		session.peers.push(joinerClientId);
		session.state = "active";
		session.expiresAt = Date.now() + SESSION_EXPIRY_MS; // Reset expiry
		this.clientToCode.set(joinerClientId, code);

		this.logger.info(
			{ code: code.slice(0, 4), peersCount: session.peers.length },
			"Client joined session"
		);

		return { success: true, sessionId: session.id };
	}

	getSession(code) {
		if (!code) return null;
		const session = this.sessions.get(code);

		// Check if expired
		if (session && Date.now() > session.expiresAt) {
			this.sessions.delete(code);
			this.sessionCodeToId.delete(code);
			this.stats.totalExpired++;
			return null;
		}

		return session;
	}

	getSessionByClientId(clientId) {
		if (!clientId) return null;

		const code = this.clientToCode.get(clientId);
		if (!code) return null;

		const session = this.sessions.get(code);

		// Check if expired
		if (session && Date.now() > session.expiresAt) {
			this.sessions.delete(code);
			this.sessionCodeToId.delete(code);
			this.clientToCode.delete(clientId);
			this.stats.totalExpired++;
			return null;
		}

		return session ? { code, session } : null;
	}

	removeClientFromSession(clientId) {
		if (!clientId) return null;

		const code = this.clientToCode.get(clientId);
		if (!code) return null;

		const session = this.sessions.get(code);
		if (!session) return null;

		// Remove client from peers
		session.peers = session.peers.filter((id) => id !== clientId);
		this.clientToCode.delete(clientId);

		if (session.peers.length === 0) {
			this.sessions.delete(code);
			this.sessionCodeToId.delete(code);
			session.state = "closed";
			this.stats.totalClosed++;
			this.logger.info({ code: code.slice(0, 4) }, "Session closed");
		} else {
			this.logger.info(
				{ code: code.slice(0, 4), peersRemaining: session.peers.length },
				"Client removed from session"
			);
		}

		return session;
	}

	startCleanup() {
		if (this.cleanupInterval) return;

		this.cleanupInterval = setInterval(() => {
			this.cleanup();
		}, CLEANUP_INTERVAL_MS);

		this.logger.debug("Session cleanup started");
	}

	cleanup() {
		const now = Date.now();
		const expiredCodes = [];

		for (const [code, session] of this.sessions) {
			if (now > session.expiresAt) {
				expiredCodes.push(code);
			}
		}

		expiredCodes.forEach((code) => {
			const session = this.sessions.get(code);
			this.sessions.delete(code);
			this.sessionCodeToId.delete(code);

			// Also remove from clientToCode mapping
			for (const clientId of session.peers) {
				this.clientToCode.delete(clientId);
			}

			this.stats.totalExpired++;
		});

		if (expiredCodes.length > 0) {
			this.logger.debug(
				{ count: expiredCodes.length },
				"Cleaned up expired sessions"
			);
		}

		return expiredCodes.length;
	}

	destroy() {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
		this.sessions.clear();
		this.sessionCodeToId.clear();
		this.clientToCode.clear();
		this.logger.info("SessionManager destroyed");
	}

	getStats() {
		return {
			activeSessions: this.sessions.size,
			stats: this.stats,
			details: Array.from(this.sessions.values()).map((s) => ({
				code: s.code,
				peers: s.peers.length,
				state: s.state,
				age: Date.now() - s.createdAt,
				timeUntilExpiry: s.expiresAt - Date.now()
			}))
		};
	}
}

export const sessionManager = new SessionManager();