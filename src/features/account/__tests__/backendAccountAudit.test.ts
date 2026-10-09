/** Diagnostic stage regressions use encrypted synthetic accounts and mocked I/O failures. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const fixture = vi.hoisted(() => {
  const fileSystem = require("fs") as typeof import("fs");
  const paths = require("path") as typeof import("path");
  const os = require("os") as typeof import("os");
  const home = fileSystem.mkdtempSync(paths.join(os.tmpdir(), "manager-backend-audit-"));
  return { home, claude: paths.join(home, ".claude"), vault: paths.join(home, "vault") };
});
const audit = vi.hoisted(() => ({ event: vi.fn(), lockFailure: null as null | { reason: "busy" | "unavailable"; lock: string; detail?: string } }));
vi.mock("os", async (original) => ({ ...(await original<typeof import("os")>()), homedir: () => fixture.home }));
vi.mock("../../../core/config", () => ({ CLAUDE_DIR: fixture.claude }));
vi.mock("fs", async (original) => ({ ...(await original<typeof import("fs")>()) }));
vi.mock("../accountAudit", async (original) => ({ ...(await original<typeof import("../accountAudit")>()), auditAccountEvent: audit.event }));
vi.mock("../claudeLocks", async (original) => {
  const actual = await original<typeof import("../claudeLocks")>();
  return { ...actual, withLocks: (...args: Parameters<typeof actual.withLocks>) => audit.lockFailure
    ? { ok: false, failure: audit.lockFailure } : actual.withLocks(...args) };
});

import { initializeProfileVault, closeProfileVault, writeProfileFile } from "../profileVault";
import { saveProfile, switchProfile } from "../profiles";
import { readAccountSnapshot, SNAPSHOT_FILE } from "../accountSnapshot";
import { clearClaudeJsonCache } from "../claudeJsonCache";
import { hashCredentials } from "../credentials";
import { recoverPendingSwitch, hasPendingSwitch, SWITCH_BACKUP } from "../liveSwitch";

const originalPlatform = process.platform;
const configFile = path.join(fixture.home, ".claude.json");
const credentialsFile = path.join(fixture.claude, ".credentials.json");
const journalFile = path.join(fixture.vault, ".switch-recovery.enc");
const targetFile = path.join(fixture.vault, "account-1", SNAPSHOT_FILE);
const outgoingFile = path.join(fixture.vault, "account-2", SNAPSHOT_FILE);
const denied = () => Object.assign(new Error("Private diagnostic detail must never be logged"), { code: "EACCES" });
function login(account: string) {
  fs.writeFileSync(configFile, JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: `${account}@example.test` }, userID: "synthetic-device", projects: { preserved: true } }));
  fs.writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: `synthetic-access-${account}`, refreshToken: `synthetic-refresh-${account}` } }));
  clearClaudeJsonCache();
}
function seedAccounts() {
  login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
  login("bob"); expect(saveProfile("Account 2").ok).toBe(true);
  audit.event.mockClear();
}
function livePair() { return { config: fs.readFileSync(configFile, "utf8"), credentials: fs.readFileSync(credentialsFile, "utf8") }; }
function event(name: string, fields: object) { return expect(audit.event).toHaveBeenCalledWith(name, expect.objectContaining(fields)); }
function committedIndex() { return audit.event.mock.calls.findIndex(([name, fields]) => name === "verify_completed" && fields.reason === "committed"); }
function expectPrivate() {
  const serialized = JSON.stringify(audit.event.mock.calls);
  for (const privateText of ["alice", "bob", "@example.test", "synthetic-access", "synthetic-refresh", "oauthAccount", "accessToken", fixture.home, "account-1", "account-2", "Private diagnostic detail"]) {
    expect(serialized).not.toContain(privateText);
  }
  for (const [, fields] of audit.event.mock.calls) expect(Object.keys(fields ?? {}).every(key => ["stage", "code", "reason"].includes(key))).toBe(true);
}

beforeEach(async () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  fs.mkdirSync(fixture.claude, { recursive: true });
  clearClaudeJsonCache(); audit.event.mockReset(); audit.lockFailure = null;
  const secrets = new Map<string, string>();
  await initializeProfileVault({ get: async name => secrets.get(name), store: async (name, value) => { secrets.set(name, value); } }, fixture.vault);
});
afterEach(() => {
  vi.restoreAllMocks(); closeProfileVault(); clearClaudeJsonCache();
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (!path.basename(fixture.home).startsWith("manager-backend-audit-")) throw Error("Unsafe fixture cleanup");
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

describe("switch diagnostic boundaries", () => {
  it("records outgoing save, target load and a verified commit using only fixed fields", () => {
    seedAccounts();
    expect(switchProfile("account-1").ok).toBe(true);
    event("save_current_started", { stage: "outgoing_snapshot" });
    event("save_current_completed", { stage: "outgoing_snapshot", reason: "saved" });
    event("target_read_completed", { stage: "target_snapshot" });
    event("verify_completed", { stage: "commit_verify", reason: "committed" });
    event("recovery_completed", { reason: "committed" });
    expect(committedIndex()).toBeGreaterThan(-1);
    expect(audit.event.mock.calls.findIndex(([name]) => name === "recovery_completed")).toBeGreaterThan(committedIndex());
    expectPrivate();
  });

  it("distinguishes an unsaved outgoing refusal before any live transaction", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true); login("bob");
    const before = livePair(); audit.event.mockClear();
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "unsaved-active-account" });
    event("switch_preflight_failed", { stage: "outgoing_snapshot", code: "unsaved-active-account", reason: "unsaved" });
    expect(audit.event.mock.calls.some(([name]) => name === "apply_started")).toBe(false);
    expect(livePair()).toEqual(before); expectPrivate();
  });

  it.each(["busy", "unavailable"] as const)("records a %s native lock refusal without its path or detail", reason => {
    seedAccounts(); const before = livePair();
    audit.lockFailure = { reason, lock: fixture.home, detail: "Private diagnostic detail" };
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "copy-failed" });
    event("locks_failed", { stage: "locks", code: "copy-failed", reason });
    expect(livePair()).toEqual(before); expectPrivate();
  });

  it("captures outgoing snapshot EACCES before returning the unchanged generic error", () => {
    seedAccounts(); const before = livePair(); const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === outgoingFile) throw denied(); return rename(from, to); });
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "copy-failed" });
    event("snapshot_failed", { stage: "outgoing_snapshot", code: "EACCES" });
    event("save_current_failed", { stage: "outgoing_snapshot", code: "copy-failed" });
    expect(livePair()).toEqual(before); expect(hasPendingSwitch()).toBe(false); expectPrivate();
  });

  it("records an unreadable target without replacing the outgoing login", () => {
    seedAccounts(); const before = livePair(); const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => { if (String(file) === targetFile) throw denied(); return read(file, options); });
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "unreadable-source" });
    event("target_read_failed", { stage: "target_snapshot", reason: "unreadable" });
    expect(livePair()).toEqual(before); expect(hasPendingSwitch()).toBe(false); expectPrivate();
  });

  it("does not reread target metadata after the verified live commit", () => {
    seedAccounts(); const read = fs.readFileSync; let readsAfterCommit = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (String(file) === targetFile && JSON.parse(read(credentialsFile, "utf8")).claudeAiOauth.accessToken === "synthetic-access-alice") {
        readsAfterCommit++; throw denied();
      }
      return read(file, options);
    });
    expect(switchProfile("account-1")).toMatchObject({ ok: true, data: { email: "alice@example.test" } });
    expect(readsAfterCommit).toBe(0); expect(committedIndex()).toBeGreaterThan(-1); expectPrivate();
  });
});

describe("transaction failure and recovery diagnostics", () => {
  it.each(["write_journal", "backup_create"] as const)("records %s EACCES and verified restoration", stage => {
    seedAccounts(); const before = livePair(); const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      const name = String(file);
      if (stage === "backup_create" ? name === SWITCH_BACKUP : name.startsWith(journalFile + ".") && name.endsWith(".tmp")) throw denied();
      return write(file, data, options);
    });
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "copy-failed" });
    event("apply_failed", { stage, code: "EACCES", reason: "backend_failed" });
    if (stage === "backup_create") event("rollback_completed", { reason: "restored" });
    expect(livePair()).toEqual(before); expect(hasPendingSwitch()).toBe(false); expectPrivate();
  });

  it("records config replace failure and successful rollback", () => {
    seedAccounts(); const before = livePair(); const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === configFile) throw denied(); return rename(from, to); });
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "copy-failed" });
    event("apply_failed", { stage: "config_replace", code: "EACCES" });
    event("rollback_completed", { stage: "recovery_verify", reason: "restored" });
    expect(livePair()).toEqual(before); expectPrivate();
  });

  it("records a generic credential backend failure instead of inventing its swallowed error code", () => {
    seedAccounts(); const before = livePair(); const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => { if (String(file) === credentialsFile + ".tmp") throw denied(); return write(file, data, options); });
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "copy-failed" });
    event("apply_failed", { stage: "credentials_write", code: "copy-failed", reason: "backend_failed" });
    event("rollback_completed", { reason: "restored" });
    expect(livePair()).toEqual(before); expectPrivate();
  });

  it.each(["recovery_cleanup_backup", "recovery_cleanup_journal"] as const)("retains the verified committed outcome when %s fails", stage => {
    seedAccounts(); const remove = fs.rmSync;
    const spy = vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
      if (String(file) === (stage === "recovery_cleanup_backup" ? SWITCH_BACKUP : journalFile)) throw denied();
      return remove(file, options);
    });
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "recovery-required" });
    event("verify_completed", { stage: "commit_verify", reason: "committed" });
    event("recovery_failed", { stage, code: "EACCES", reason: "required" });
    const cleanupFailure = audit.event.mock.calls.findIndex(([name, fields]) => name === "recovery_failed" && fields.stage === stage);
    expect(cleanupFailure).toBeGreaterThan(committedIndex());
    expect(audit.event.mock.calls.some(([name]) => name === "rollback_completed")).toBe(false);
    expect(fs.readFileSync(credentialsFile, "utf8")).toBe(readAccountSnapshot(path.join(fixture.vault, "account-1")).credsRaw);
    expect(hasPendingSwitch()).toBe(true); expectPrivate();
    spy.mockRestore(); audit.event.mockClear();
    expect(recoverPendingSwitch()).toEqual({ ok: true });
    event("recovery_completed", { reason: "committed" }); expect(hasPendingSwitch()).toBe(false);
  });

  it("records an invalid recovery record without changing the live login", () => {
    seedAccounts(); const before = livePair(); writeProfileFile(journalFile, "{}");
    expect(recoverPendingSwitch()).toMatchObject({ ok: false, error: "recovery-required" });
    event("recovery_failed", { stage: "recovery_validate", reason: "invalid_journal" });
    expect(livePair()).toEqual(before); expect(hasPendingSwitch()).toBe(true); expectPrivate();
  });
});

function leaveSyntheticJournal() {
  const before = livePair();
  const target = readAccountSnapshot(path.join(fixture.vault, "account-1"));
  writeProfileFile(journalFile, JSON.stringify({ version: 1, beforeConfig: before.config, beforeCredentials: before.credentials,
    afterConfig: target.claudeJsonRaw, afterCredentialsHash: hashCredentials(target.credsRaw),
    source: { kind: "file", locator: credentialsFile } }));
  return { before, target };
}

describe("precise recovery outcome diagnostics", () => {
  it("does not infer committed from a successful recovery result that actually restored the old pair", () => {
    seedAccounts(); const before = livePair(); const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      // Simulate a non-locking writer changing one side after the credential swap.
      if (String(to) === credentialsFile) fs.writeFileSync(configFile, before.config);
    });
    // Preserve the existing public result behavior; diagnostic outcome is independently verified.
    expect(switchProfile("account-1").ok).toBe(true);
    event("verify_completed", { stage: "recovery_verify", reason: "restored" });
    event("apply_completed", { stage: "commit_verify" });
    expect(audit.event.mock.calls.filter(([name]) => name === "apply_completed").every(([, fields]) => fields.reason !== "committed")).toBe(true);
    expect(committedIndex()).toBe(-1); expect(livePair()).toEqual(before); expectPrivate();
  });

  it("reports read-before EACCES without claiming a credential write", () => {
    seedAccounts(); const before = livePair(); const read = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => { if (String(file) === configFile) throw denied(); return read(file, options); });
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "copy-failed" });
    event("apply_failed", { stage: "read_before", code: "EACCES" });
    expect(audit.event.mock.calls.some(([, fields]) => fields.stage === "credentials_write")).toBe(false);
    spy.mockRestore(); expect(livePair()).toEqual(before); expectPrivate();
  });

  it("refuses an orphan config backup without overwriting it", () => {
    seedAccounts(); const before = livePair(); fs.writeFileSync(SWITCH_BACKUP, "synthetic orphan backup");
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "recovery-required" });
    event("apply_failed", { stage: "backup_check", code: "recovery-required", reason: "required" });
    expect(livePair()).toEqual(before); expect(fs.readFileSync(SWITCH_BACKUP, "utf8")).toBe("synthetic orphan backup");
    expect(hasPendingSwitch()).toBe(false); expectPrivate();
  });

  it("records rollback credential-write failure and retains recovery data", () => {
    seedAccounts(); const { before, target } = leaveSyntheticJournal();
    fs.writeFileSync(credentialsFile, target.credsRaw); // Only credentials moved; config remains before.
    const mixed = livePair(); const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => { if (String(file) === credentialsFile + ".tmp") throw denied(); return write(file, data, options); });
    expect(recoverPendingSwitch()).toMatchObject({ ok: false, error: "recovery-required" });
    event("rollback_failed", { stage: "recovery_credentials_restore", reason: "backend_failed" });
    event("recovery_failed", { stage: "recovery_credentials_restore", code: "recovery-required" });
    expect(livePair()).toEqual(mixed); expect(mixed.config).toBe(before.config);
    expect(hasPendingSwitch()).toBe(true); expectPrivate();
  });

  it("records failed rollback verification without deleting the recovery record", () => {
    seedAccounts(); const { target } = leaveSyntheticJournal();
    fs.writeFileSync(configFile, target.claudeJsonRaw); // Only config moved; credentials remain before.
    const read = fs.readFileSync; let credentialReads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (String(file) === credentialsFile && ++credentialReads === 2) return ""; // Transient read during verification.
      return read(file, options);
    });
    expect(recoverPendingSwitch()).toMatchObject({ ok: false, error: "recovery-required" });
    event("verify_failed", { stage: "recovery_verify", reason: "transient_store" });
    event("rollback_failed", { stage: "recovery_verify", reason: "transient_store" });
    expect(hasPendingSwitch()).toBe(true); expectPrivate();
  });

  it("leaves an unrelated later login untouched and reports the comparison refusal", () => {
    seedAccounts(); leaveSyntheticJournal(); login("charlie"); const later = livePair();
    expect(recoverPendingSwitch()).toMatchObject({ ok: false, error: "recovery-required" });
    event("verify_failed", { stage: "recovery_compare", reason: "unknown_live_state" });
    event("recovery_failed", { stage: "recovery_compare", reason: "unknown_live_state" });
    expect(livePair()).toEqual(later); expect(hasPendingSwitch()).toBe(true); expectPrivate();
    expect(JSON.stringify(audit.event.mock.calls)).not.toContain("charlie");
  });
});
