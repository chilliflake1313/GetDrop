import PQueue from "p-queue";
import {
	S3Client,
	DeleteObjectCommand,
	HeadObjectCommand
} from "@aws-sdk/client-s3";

const CLEANUP_INTERVAL_MS = 60_000; // 1 minute
const CLEANUP_CONCURRENCY = 3; // Max 3 concurrent cleanup operations
const MAX_CLEANUP_RETRIES = 3;
const RETRY_DELAY_BASE_MS = 2_000; // 2 seconds base delay

export class FileCleanupManager {
	constructor(logger, s3Client = null) {
		this.logger = logger || console;
		this.s3Client = s3Client;
		this.bucket = null;
		this.cleanupInterval = null;
		this.queue = new PQueue({ concurrency: CLEANUP_CONCURRENCY });
		this.pendingFiles = new Map(); // fileId -> { expiresAt, size, attempts }
		this.stats = {
			totalCleaned: 0,
			totalFailed: 0,
			totalRetried: 0,
			queueSize: 0
		};
	}

	setS3Client(s3Client) {
		this.s3Client = s3Client;
	}

	setBucket(bucket) {
		this.bucket = bucket;
	}

	registerFile(fileId, expiresAt, size) {
		if (!fileId || !expiresAt) {
			this.logger.warn("Invalid file registration parameters");
			return;
		}

		this.pendingFiles.set(fileId, {
			fileId,
			expiresAt,
			size,
			attempts: 0,
			registeredAt: Date.now()
		});

		this.logger.debug(
			{ fileId, expiresAt: new Date(expiresAt).toISOString() },
			"File registered for cleanup"
		);
	}

	unregisterFile(fileId) {
		if (this.pendingFiles.delete(fileId)) {
			this.logger.debug({ fileId }, "File unregistered from cleanup");
			return true;
		}
		return false;
	}

	async deleteFile(fileId) {
		if (!this.s3Client || !this.bucket) {
			throw new Error("S3 client or bucket not configured");
		}

		try {
			// First check if file exists
			try {
				await this.s3Client.send(
					new HeadObjectCommand({
						Bucket: this.bucket,
						Key: fileId
					})
				);
			} catch (error) {
				// If file doesn't exist (404), consider it cleaned
				if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") {
					this.logger.debug({ fileId }, "File already deleted");
					return;
				}
				throw error;
			}

			// Delete the file
			await this.s3Client.send(
				new DeleteObjectCommand({
					Bucket: this.bucket,
					Key: fileId
				})
			);

			this.logger.info({ fileId }, "File deleted from S3");
		} catch (error) {
			this.logger.error(
				{ fileId, error: error.message },
				"Failed to delete file from S3"
			);
			throw error;
		}
	}

	async processCleanupTask(task) {
		const { fileId } = task;

		try {
			await this.deleteFile(fileId);
			this.pendingFiles.delete(fileId);
			this.stats.totalCleaned++;
			this.logger.debug({ fileId }, "Cleanup task completed");
		} catch (error) {
			task.attempts++;
			this.stats.totalRetried++;

			if (task.attempts < MAX_CLEANUP_RETRIES) {
				const delay = RETRY_DELAY_BASE_MS * Math.pow(2, task.attempts - 1);
				this.logger.warn(
					{ fileId, attempt: task.attempts, nextRetryIn: delay },
					"Cleanup failed, retrying"
				);

				setTimeout(() => {
					this.queue.add(() => this.processCleanupTask(task));
				}, delay);
			} else {
				this.stats.totalFailed++;
				this.pendingFiles.delete(fileId);
				this.logger.error(
					{ fileId, attempts: task.attempts },
					"Cleanup failed after max retries"
				);
			}
		}
	}

	async processExpiredFiles() {
		const now = Date.now();
		const expiredFiles = [];

		for (const [fileId, task] of this.pendingFiles) {
			if (now >= task.expiresAt) {
				expiredFiles.push(task);
			}
		}

		if (expiredFiles.length === 0) {
			return;
		}

		this.logger.info({ count: expiredFiles.length }, "Processing expired files");

		// Add all expired files to the queue
		for (const task of expiredFiles) {
			this.queue.add(() => this.processCleanupTask(task));
		}

		this.stats.queueSize = this.queue.size;
	}

	start() {
		if (this.cleanupInterval) {
			this.logger.warn("File cleanup already running");
			return;
		}

		this.cleanupInterval = setInterval(() => {
			this.processExpiredFiles();
		}, CLEANUP_INTERVAL_MS);

		this.logger.info("File cleanup manager started");
	}

	stop() {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
			this.logger.info("File cleanup manager stopped");
		}
	}

	async drain() {
		this.logger.info("Draining cleanup queue...");
		await this.queue.onIdle();
		this.logger.info("Cleanup queue drained");
	}

	getStats() {
		return {
			pending: this.pendingFiles.size,
			queueSize: this.queue.size,
			stats: this.stats
		};
	}

	async destroy() {
		this.stop();
		await this.drain();
		this.pendingFiles.clear();
		this.logger.info("FileCleanupManager destroyed");
	}
}
