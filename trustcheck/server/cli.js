// Operator CLI. `node server/cli.js <command>`; DATABASE_FILE / BACKUP_DIR come from the environment.
//   status | migrate [--dry-run] | backup | verify <file> | restore <backup> <target> [--force] | import-json <file.json> | list-backups
import fs from "node:fs";
import { Database, migrate, schemaStatus } from "./db.js";
import { createBackup, verifyBackup, restoreBackup, listBackups } from "./backup.js";
import { importJson } from "./import-json.js";
import { MIGRATIONS } from "./migrations.js";

const [cmd, ...args] = process.argv.slice(2), flag = (f) => args.includes(f), pos = args.filter((a) => !a.startsWith("--"));
const dbFile = process.env.DATABASE_FILE || process.env.DATA_FILE || "data.db", backupDir = process.env.BACKUP_DIR || "backups";
const out = (o) => console.log(JSON.stringify(o, null, 2));
try {
  if (cmd === "status") { const d = new Database(dbFile); out({ file: dbFile, ...schemaStatus(d), applied: undefined }); d.close(); }
  else if (cmd === "migrate") { const d = new Database(dbFile); out(migrate(d, { dryRun: flag("--dry-run") })); d.close(); }
  else if (cmd === "backup") { const d = new Database(dbFile); migrate(d); out(createBackup(d, backupDir, { keep: Number(process.env.BACKUP_KEEP || 28) })); d.close(); }
  else if (cmd === "verify") { const r = verifyBackup(pos[0]); out(r); process.exitCode = r.ok ? 0 : 1; }
  else if (cmd === "restore") { out(restoreBackup(pos[0], pos[1] || dbFile, { force: flag("--force") })); }
  else if (cmd === "list-backups") out(listBackups(backupDir).map((b) => ({ name: b.name, mtime: new Date(b.mtime).toISOString() })));
  else if (cmd === "import-json") { const d = new Database(dbFile); migrate(d); out(importJson(d, JSON.parse(fs.readFileSync(pos[0], "utf8")))); d.close(); }
  else { console.error("usage: node server/cli.js status | migrate [--dry-run] | backup | verify <file> | restore <backup> [target] [--force] | import-json <file> | list-backups"); process.exitCode = 2; }
} catch (e) { console.error("error:", e.message); process.exitCode = 1; }
void MIGRATIONS;
