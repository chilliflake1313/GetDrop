import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

const pinoConfig = {
	level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
	transport: isProduction
		? undefined
		: {
			target: "pino-pretty",
			options: {
				colorize: true,
				translateTime: "SYS:standard",
				ignore: "pid,hostname"
			}
		}
};

export const logger = pino(pinoConfig);

export function createLogger(module) {
	return logger.child({ module });
}