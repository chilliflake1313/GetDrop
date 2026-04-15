import { unlink } from "node:fs/promises";
import PQueue from "p-queue";

const CLEANUP_CHECK_INTERVAL_MS = 30_000; // Check every 30s
const CLEANUP_BATCH_SIZE = 10;
const CLEANUP_CONCURRENCY = 5;

class FileCleanupTask {
	constructor(fileId, expiresAt, size) {
		this.fileId = fileId;
		this.expiresAt = expiresAt;
		this.size = size;
		this.attempts = 0;
		this.maxAttempts = 3;
	}

	get priority() {
		// Higher priority = earlier expiry
		return -this.expiresAt;
	}

	get isExpired() {
		return Date.now() > this.expiresAt;
	}

	get canRetry() {
		return this.attempts < this.maxAttempts;
	}
}

export class FileCleanupManager {
	constructor(logger, s3Client = null) {
		this.logger = logger;
		this.s3Client = s3Client;
		this.bucket = null;
		this.queue = new PQueue({ concurrency: CLEANUP_CONCURRENCY });
		this.tasks = new Map(); // fileId -> FileCleanupTask
		this.checkInterval = null;
		this.stats = {
			totalCleaned: 0,
			totalFailed: 0,
			totalRetried: 0
		};
	}

	setBucket(bucket) {
		this.bucket = bucket;
	}

	registerFile(fileId, expiresAt, size) {
		const task = new FileCleanupTask(fileId, expiresAt, size);
		this.tasks.set(fileId, task);
		return task;
	}

	unregisterFile(fileId) {
		this.tasks.delete(fileId);
	}

	async deleteFile(fileId) {
		// Override this method for custom deletion logic
		if (this.s3Client && this.bucket) {
			const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
			await this.s3Client.send(
				new DeleteObjectCommand({ Bucket: this.bucket, Key: fileId })
			);
			return;
		}

		await unlink(fileId);
	}

	async processTask(task) {
		try {
			await this.deleteFile(task.fileId);
			this.tasks.delete(task.fileId);
			this.stats.totalCleaned++;
			this.logger.info({ fileId: task.fileId }, "File cleaned");
		} catch (error) {
			task.attempts++;
			if (task.canRetry) {
				this.stats.totalRetried++;
				this.logger.warn(
					{ fileId: task.fileId, attempt: task.attempts },
					"File cleanup retry"
				);
				// Re-queue for retry
				await new Promise((resolve) => setTimeout(resolve, 1000 * task.attempts));
				this.queue.add(() => this.processTask(task));
			} else {
				this.stats.totalFailed++;
				this.tasks.delete(task.fileId);
				this.logger.error(
					{ fileId: task.fileId, error: error.message },
					"File cleanup failed"
				);
			}
		}
	}

	async checkAndCleanup() {
		const expiredTasks = Array.from(this.tasks.values())
			.filter((task) => task.isExpired)
			.sort((a, b) => a.priority - b.priority) // Sort by priority
			.slice(0, CLEANUP_BATCH_SIZE); // Process in batches

		if (expiredTasks.length === 0) return;

		this.logger.info(
			{ count: expiredTasks.length },
			"Starting file cleanup batch"
		);

		// Add all tasks to queue (non-blocking)
		for (const task of expiredTasks) {
			this.queue.add(() => this.processTask(task));
		}
	}

	start() {
		if (this.checkInterval) return;

		this.checkInterval = setInterval(
			() => this.checkAndCleanup(),
			CLEANUP_CHECK_INTERVAL_MS
		);

		this.logger.info("File cleanup manager started");
	}

	stop() {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
		}
		this.logger.info("File cleanup manager stopped");
	}

	async drain() {
		await this.queue.onIdle();
	}

	getStats() {
		return {
			pendingTasks: this.tasks.size,
			queueSize: this.queue.size,
			queuePending: this.queue.pending,
			...this.stats
		};
	}

	async destroy() {
		this.stop();
		await this.drain();
	}
}