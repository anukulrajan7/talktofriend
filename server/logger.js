// Structured logging via Pino.
//
// Usage in modules:
//   const log = require("./logger").child({ module: "sfu" });
//   log.info({ roomCode }, "router created");
//
// In production: JSON lines (machine-readable, easy to ship to Loki/ELK).
// In dev: pretty-printed with colors.

const pino = require("pino");

const isDev = process.env.NODE_ENV !== "production";

const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),

  // Proper serialization for errors, requests, responses
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },

  // Strip sensitive headers from logs
  redact: {
    paths: ["req.headers.cookie", "req.headers.authorization", "*.ip"],
    censor: "[REDACTED]",
  },

  // Timestamp as ISO string in production (easier to read in log aggregators)
  timestamp: isDev ? undefined : pino.stdTimeFunctions.isoTime,

  // Pretty-print in dev only
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});

module.exports = logger;
