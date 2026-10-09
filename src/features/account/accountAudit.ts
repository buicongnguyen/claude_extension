/** Privacy-safe account diagnostics: fixed vocabulary only, never credential data. */
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";

export const ACCOUNT_AUDIT_EVENTS = [
  "logger_started", "operation_started", "operation_completed", "operation_cancelled", "operation_failed",
  "confirmation_requested", "confirmation_accepted",
  "identity_confirmation_requested", "identity_confirmation_accepted", "identity_confirmation_cancelled",
  "reload_requested", "reload_deferred", "reload_failed", "ui_failed",
  "switch_preflight_started", "switch_preflight_completed", "switch_preflight_failed", "locks_failed",
  "save_current_started", "save_current_completed", "save_current_failed",
  "target_read_started", "target_read_completed", "target_read_failed",
  "clients_check_started", "clients_check_completed", "clients_check_failed",
  "snapshot_started", "snapshot_completed", "snapshot_failed",
  "apply_started", "apply_completed", "apply_failed",
  "verify_started", "verify_completed", "verify_failed",
  "rollback_started", "rollback_completed", "rollback_failed",
  "recovery_started", "recovery_completed", "recovery_failed",
] as const;
export const ACCOUNT_AUDIT_STAGES = [
  "confirmation", "identity_confirmation", "save_current", "switch", "reload", "refresh_ui", "activation", "notification",
  "locks", "preflight", "approval", "target_presence", "outgoing_snapshot", "target_snapshot",
  "recovery_read", "recovery_validate", "recovery_compare", "recovery_config_restore", "recovery_credentials_restore",
  "recovery_verify", "recovery_cleanup_backup", "recovery_cleanup_journal",
  "backup_check", "read_before", "write_journal", "backup_create", "config_replace", "credentials_write", "commit_verify",
  "result_metadata", "target_read", "clients_check", "snapshot", "apply", "verify", "rollback", "recovery",
] as const;
export const ACCOUNT_AUDIT_REASONS = [
  "user_cancelled", "save_not_completed", "local_switch_verified", "local_operation_succeeded", "restart_required", "unexpected_exception",
  "busy", "unavailable", "unsaved", "already_active", "saved", "missing_target", "unreadable", "identity_changed",
  "invalid_journal", "unknown_live_state", "transient_store", "committed", "restored", "required", "backend_failed", "no_live_account",
] as const;
export const ACCOUNT_AUDIT_CODES = [
  "no-active-account", "unsaved-active-account", "slug-exists", "slot-exists", "slot-missing", "not-signed-in",
  "copy-failed", "unreadable-source", "already-saved", "account-mismatch", "identity-unverified", "stale-confirmation",
  "recovery-required", "profile-unreadable", "storage-unavailable",
  "EACCES", "EPERM", "ENOENT", "EBUSY", "ENOSPC", "EIO", "EROFS", "ENOTDIR", "EISDIR", "EEXIST", "EMFILE", "ENFILE", "EINVAL", "ETIMEDOUT", "unknown",
] as const;
export type AccountAuditEvent = typeof ACCOUNT_AUDIT_EVENTS[number];
export type AccountAuditStage = typeof ACCOUNT_AUDIT_STAGES[number];
export type AccountAuditReason = typeof ACCOUNT_AUDIT_REASONS[number];
export type AccountAuditCode = typeof ACCOUNT_AUDIT_CODES[number];
export type AccountAuditAction = "switch" | "recovery";
export interface AccountAuditFields { code?: AccountAuditCode; stage?: AccountAuditStage; reason?: AccountAuditReason }

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 8;
const OWN_FILE = /^account-switch-\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
interface Context { opId: string; action: AccountAuditAction | "lifecycle"; activation: string | undefined }
interface Logger { directory: string; version: string; activation: string; file: string; fd: number }
interface RecordData extends AccountAuditFields { timestampUTC: string; version: string; opId: string; action: Context["action"]; event: AccountAuditEvent }
const operations = new AsyncLocalStorage<Context>();
let logger: Logger | undefined;
let logDirectory: string | undefined;
let recordingUnavailable = false;

/** Only read own data properties: accessors and proxies cannot expose arbitrary detail. */
function ownValue(input: unknown, key: string): unknown {
  try {
    if (typeof input !== "object" || input === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
function allowed<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}
function safeFields(input: unknown): AccountAuditFields {
  const result: AccountAuditFields = {};
  const code = ownValue(input, "code"), stage = ownValue(input, "stage"), reason = ownValue(input, "reason");
  if (allowed(code, ACCOUNT_AUDIT_CODES)) result.code = code;
  if (allowed(stage, ACCOUNT_AUDIT_STAGES)) result.stage = stage;
  if (allowed(reason, ACCOUNT_AUDIT_REASONS)) result.reason = reason;
  return result;
}
/** Error messages, causes, stacks and paths are never inspected or converted to strings. */
export function safeAccountErrorCode(error: unknown): AccountAuditCode {
  const code = typeof error === "string" ? error : ownValue(error, "code");
  return allowed(code, ACCOUNT_AUDIT_CODES) ? code : "unknown";
}
function retainedFiles(directory: string): { file: string; modified: number }[] {
  return fs.readdirSync(directory).filter(name => OWN_FILE.test(name)).flatMap(name => {
    try {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() ? [{ file, modified: stat.mtimeMs }] : [];
    } catch { return []; }
  }).sort((a, b) => a.modified - b.modified || a.file.localeCompare(b.file));
}
function prune(directory: string, keep: string | undefined, maximum: number): void {
  let files = retainedFiles(directory);
  for (const entry of files) {
    if (files.length <= maximum) break;
    if (entry.file === keep) continue;
    try { fs.unlinkSync(entry.file); files = files.filter(value => value.file !== entry.file); }
    catch { /* Another host or a temporary sharing violation may prevent removal. */ }
  }
  if (retainedFiles(directory).length > maximum) throw new Error("retention unavailable");
}
function newFile(current: Omit<Logger, "file" | "fd">): Logger {
  prune(current.directory, undefined, MAX_FILES - 1);
  const file = path.join(current.directory, `account-switch-${Date.now()}-${randomUUID()}.jsonl`);
  const fd = fs.openSync(file, "wx", 0o600);
  const result = { ...current, file, fd };
  try { prune(result.directory, result.file, MAX_FILES); return result; }
  catch {
    try { fs.closeSync(fd); } catch { /* logging is best effort */ }
    try { fs.unlinkSync(file); } catch { /* never remove any existing file */ }
    throw new Error("logging unavailable");
  }
}
export function closeAccountAudit(): void {
  const current = logger;
  logger = undefined;
  if (current) { try { fs.closeSync(current.fd); } catch { /* logging must not affect account state */ } }
}
function rotate(current: Logger): Logger {
  try { fs.closeSync(current.fd); } catch { /* already closed */ }
  logger = undefined;
  logger = newFile({ directory: current.directory, version: current.version, activation: current.activation });
  return logger;
}
function writeRecord(event: AccountAuditEvent, fields: unknown, context: Context): void {
  try {
    let current = logger;
    if (!current || context.activation !== current.activation) return;
    const record: RecordData = {
      timestampUTC: new Date().toISOString(), version: current.version, opId: context.opId, action: context.action, event,
      ...safeFields(fields),
    };
    const line = JSON.stringify(record) + "\n";
    const size = Buffer.byteLength(line);
    // A different activation may have pruned an old file from under this host.
    if (!fs.existsSync(current.file) || fs.fstatSync(current.fd).size + size > MAX_FILE_BYTES) current = rotate(current);
    fs.appendFileSync(current.fd, line, "utf8");
  } catch { recordingUnavailable = true; closeAccountAudit(); }
}
/** A distinct file for each activation prevents windows from sharing a write target. */
export function initializeAccountAudit(directory: string, version: string): void {
  closeAccountAudit();
  logDirectory = undefined;
  recordingUnavailable = false;
  try {
    if (typeof directory !== "string" || !path.isAbsolute(directory)) return;
    logDirectory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    logger = newFile({ directory, version: typeof version === "string" && VERSION.test(version) ? version : "unknown", activation: randomUUID() });
    writeRecord("logger_started", { stage: "activation" }, { opId: randomUUID(), action: "lifecycle", activation: logger.activation });
  } catch { recordingUnavailable = true; closeAccountAudit(); }
}
/** Return a real current log only; never return a missing file or a symlink. */
export function accountAuditFile(): string | undefined {
  try {
    if (!logger) return undefined;
    const stat = fs.lstatSync(logger.file), opened = fs.fstatSync(logger.fd);
    return stat.isFile() && !stat.isSymbolicLink() && stat.dev === opened.dev && stat.ino === opened.ino ? logger.file : undefined;
  } catch { return undefined; }
}
/** Nested backend calls stay correlated with the initiating user action. Work errors pass through. */
export function withAccountAudit<T>(action: AccountAuditAction, work: () => T): T {
  if (operations.getStore() || (action !== "switch" && action !== "recovery")) return work();
  let context: Context;
  try { context = { opId: randomUUID(), action, activation: logger?.activation }; }
  catch { return work(); }
  return operations.run(context, () => { auditAccountEvent("operation_started"); return work(); });
}
export function auditAccountEvent(event: AccountAuditEvent, fields?: AccountAuditFields): void {
  try {
    if (!allowed(event, ACCOUNT_AUDIT_EVENTS)) return;
    const context = operations.getStore();
    if (context) writeRecord(event, fields, context);
  } catch { /* No diagnostic failure may change credential behavior. */ }
}

function safePersistedRecord(input: unknown): RecordData | undefined {
  const timestamp = ownValue(input, "timestampUTC"), version = ownValue(input, "version"), opId = ownValue(input, "opId");
  const action = ownValue(input, "action"), event = ownValue(input, "event");
  if (typeof timestamp !== "string" || !UTC_TIMESTAMP.test(timestamp) || typeof opId !== "string" || !UUID.test(opId) ||
      typeof version !== "string" || (version !== "unknown" && !VERSION.test(version)) ||
      (action !== "switch" && action !== "recovery" && action !== "lifecycle") || !allowed(event, ACCOUNT_AUDIT_EVENTS)) return undefined;
  return { timestampUTC: timestamp, version, opId, action, event, ...safeFields(input) };
}
/** Bounded, revalidated history: modified log files cannot expose arbitrary text in the viewer. */
export function readAccountAuditLog(): string {
  if (!logDirectory) return recordingUnavailable ? "Account switch diagnostic recording is unavailable." : "Account switch diagnostics are not available yet.";
  const records: RecordData[] = [];
  let unavailable = false;
  try {
    for (const entry of retainedFiles(logDirectory).slice(-MAX_FILES)) {
      let fd: number | undefined;
      try {
        const before = fs.lstatSync(entry.file);
        if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) { unavailable = true; continue; }
        fd = fs.openSync(entry.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_FILE_BYTES) { unavailable = true; continue; }
        const buffer = Buffer.alloc(stat.size);
        let count = 0;
        while (count < buffer.length) {
          const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
          if (read === 0) break;
          count += read;
        }
        for (const line of buffer.subarray(0, count).toString("utf8").split("\n")) {
          if (!line) continue;
          try {
            const record = line.length <= 1024 ? safePersistedRecord(JSON.parse(line)) : undefined;
            if (record) records.push(record); else unavailable = true;
          } catch { unavailable = true; }
        }
      } catch { unavailable = true; }
      finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } } }
    }
  } catch { unavailable = true; }
  const lines = records.sort((a, b) => a.timestampUTC.localeCompare(b.timestampUTC)).map(record => JSON.stringify(record));
  if (recordingUnavailable) lines.push("Account switch diagnostic recording is unavailable; newer events may be missing.");
  if (unavailable) lines.push("Some account switch diagnostics could not be read.");
  return lines.join("\n") || "No account switch diagnostics have been recorded.";
}
