import { randomBytes } from "node:crypto";

const SESSION_EXPIRY_MS = 2 * 60 * 1000; // 2 minutes
const SESSION_CODE_LENGTH = 6;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export class SessionManager {
	constructor() {
		this.sessions = new Map();
		this.sessionCodeToId = new Map();
		this.cleanupInterval = setInterval(() => this.cleanup(), 30_000);
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
		let code;
		let attempts = 0;
		const maxAttempts = 100;

		// Collision avoidance
		do {
			code = this.generateSessionCode();
			attempts++;
		} while (this.sessions.has(code) && attempts < maxAttempts);

		if (attempts >= maxAttempts) {
			throw new Error("Failed to generate unique session code");
		}

		const sessionId = `sess_${Date.now()}_${randomBytes(4).toString("hex")}`;
		const session = {
			id: sessionId,
			code,
			initiatorClientId,
			peers: [initiatorClientId],
			createdAt: Date.now(),
			expiresAt: Date.now() + SESSION_EXPIRY_MS,
			state: "pending" // pending | active | closed
		};

		this.sessions.set(code, session);
		this.sessionCodeToId.set(code, sessionId);

		return { code, sessionId };
	}

	joinSession(code, joinerClientId) {
		const session = this.sessions.get(code);

		if (!session) {
			return { success: false, error: "Session not found" };
		}

		if (Date.now() > session.expiresAt) {
			this.sessions.delete(code);
			this.sessionCodeToId.delete(code);
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

		return { success: true, sessionId: session.id };
	}

	getSession(code) {
		return this.sessions.get(code);
	}

	getSessionByClientId(clientId) {
		for (const [code, session] of this.sessions) {
			if (session.peers.includes(clientId)) {
				return { code, session };
			}
		}
		return null;
	}

	removeClientFromSession(clientId) {
		const result = this.getSessionByClientId(clientId);
		if (!result) return;

		const { code, session } = result;
		session.peers = session.peers.filter((id) => id !== clientId);

		if (session.peers.length === 0) {
			this.sessions.delete(code);
			this.sessionCodeToId.delete(code);
			session.state = "closed";
		}

		return session;
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
			this.sessions.delete(code);
			this.sessionCodeToId.delete(code);
		});

		return expiredCodes.length;
	}

	destroy() {
		clearInterval(this.cleanupInterval);
		this.sessions.clear();
		this.sessionCodeToId.clear();
	}

	getStats() {
		return {
			activeSessions: this.sessions.size,
			details: Array.from(this.sessions.values()).map((s) => ({
				code: s.code,
				peers: s.peers.length,
				state: s.state,
				age: Date.now() - s.createdAt
			}))
		};
	}
}

export const sessionManager = new SessionManager();