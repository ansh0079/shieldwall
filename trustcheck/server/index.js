// Entry point: `node server/index.js`. Validates configuration, opens the database, runs jobs, serves, and shuts down gracefully.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { ReportStore } from "./store.js";
import { createServer, shutdown } from "./server.js";
import { createLogger, Metrics } from "./log.js";
import { createAlerter, createJobs } from "./jobs.js";
import { safeFetchText } from "./fetch-safe.js";

const { config, errors, warnings } = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel, base: { service: "trustcheck-reports" } });
if (errors.length) { for (const e of errors) logger.error("config_error", { problem: e }); console.error(`\n${errors.length} configuration problem(s); refusing to start.`); process.exit(1); }
for (const w of warnings) logger.warn("config_warning", { problem: w });

fs.mkdirSync(path.dirname(path.resolve(config.dbFile)), { recursive: true });
const metrics = new Metrics();
const store = new ReportStore({ file: config.dbFile, salt: config.salt, secret: config.secret, config: config.report, fetchText: safeFetchText, metrics });
try { fs.chmodSync(config.dbFile, 0o600); } catch { /* not fatal */ }
const alerter = createAlerter({ logger, webhookUrl: config.alertWebhook || "", metrics });
const jobs = createJobs({ store, config, logger, metrics, alerter });
const stopJobs = jobs.start();

const srv = createServer(store, { ...config, logger, metrics });
srv.listen(config.port, config.host, () => logger.info("server_start", { port: config.port, schema: store.schema().current, adminEnabled: config.adminTokens.length > 0, backups: !!config.backupDir, production: config.production }));

let stopping = false;
async function stop(signal) {
  if (stopping) return; stopping = true;
  logger.info("server_stopping", { signal });
  const hard = setTimeout(() => process.exit(1), 15_000); hard.unref();
  const d = await srv.drain(10_000); stopJobs();
  await shutdown(srv); store.close();
  logger.info("server_stopped", d); process.exit(0);
}
process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT"));
process.on("uncaughtException", (e) => { logger.error("uncaught_exception", { error: String(e?.message || e) }); process.exit(1); });
process.on("unhandledRejection", (e) => { logger.error("unhandled_rejection", { error: String(e?.message || e) }); process.exit(1); });
