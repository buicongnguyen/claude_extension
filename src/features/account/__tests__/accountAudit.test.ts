import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import type * as Audit from "../accountAudit";

// A forwarding mock keeps real Temp IO while permitting precise failure injection.
vi.mock("fs", async importOriginal => ({ ...await importOriginal<typeof import("fs")>() }));

let directory: string;
let audit: typeof Audit;
const instances: typeof Audit[] = [];
const MAX_BYTES = 256 * 1024;
async function instance(): Promise<typeof Audit> {
  vi.resetModules();
  const value = await import("../accountAudit");
  instances.push(value);
  return value;
}
function records(value = audit.readAccountAuditLog()): Record<string, unknown>[] {
  return value.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
}
function ownFiles(): string[] {
  return fs.readdirSync(directory).filter(name => /^account-switch-\d{13}-[0-9a-f-]{36}\.jsonl$/.test(name));
}
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { timestampUTC: "2026-10-09T01:00:00.000Z", version: "2.15.9", opId: randomUUID(),
    action: "switch", event: "operation_completed", ...overrides };
}
function fixtureFile(contents: string): string {
  const file = path.join(directory, `account-switch-${Date.now()}-${randomUUID()}.jsonl`);
  fs.writeFileSync(file, contents);
  return file;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "manager-account-audit-"));
  expect(path.dirname(directory)).toBe(os.tmpdir());
  audit = await instance();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const value of instances.splice(0)) value.closeAccountAudit();
  // Every test owns this mkdtemp child; cleanup cannot reach the real log directory.
  expect(path.dirname(directory)).toBe(os.tmpdir());
  expect(path.basename(directory).startsWith("manager-account-audit-")).toBe(true);
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("persistent account audit", () => {
  it("creates an immediate safe lifecycle record and a private current log", () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    const file = audit.accountAuditFile()!;
    expect(path.dirname(file)).toBe(directory);
    expect(records()).toEqual([expect.objectContaining({ version: "2.15.9", action: "lifecycle", event: "logger_started", stage: "activation" })]);
    expect(records()[0].timestampUTC).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(records()[0].opId).toMatch(/^[0-9a-f-]{36}$/);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps previous activation history while giving the new host a distinct file", async () => {
    audit.initializeAccountAudit(directory, "2.15.8");
    const previous = audit.accountAuditFile();
    audit.withAccountAudit("switch", () => audit.auditAccountEvent("operation_completed", { reason: "local_operation_succeeded" }));
    audit.closeAccountAudit();
    expect(audit.accountAuditFile()).toBeUndefined();
    const reloaded = await instance();
    reloaded.initializeAccountAudit(directory, "2.15.9");
    expect(reloaded.accountAuditFile()).not.toBe(previous);
    const rows = records(reloaded.readAccountAuditLog());
    expect(rows.some(row => row.event === "operation_completed" && row.version === "2.15.8")).toBe(true);
    expect(rows.some(row => row.event === "logger_started" && row.version === "2.15.9")).toBe(true);
  });

  it("separates simultaneous hosts without sharing their write files or operation ids", async () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    const second = await instance();
    second.initializeAccountAudit(directory, "2.15.9");
    const firstFile = audit.accountAuditFile()!, secondFile = second.accountAuditFile()!;
    expect(firstFile).not.toBe(secondFile);
    audit.withAccountAudit("switch", () => audit.auditAccountEvent("apply_completed"));
    second.withAccountAudit("recovery", () => second.auditAccountEvent("recovery_completed"));
    const first = records(fs.readFileSync(firstFile, "utf8")), other = records(fs.readFileSync(secondFile, "utf8"));
    expect(first.some(row => row.action === "recovery")).toBe(false);
    expect(other.some(row => row.action === "switch")).toBe(false);
    expect(first.find(row => row.action === "switch")!.opId).not.toBe(other.find(row => row.action === "recovery")!.opId);
  });

  it("rotates at 256KiB and retains at most eight owned files", () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    const original = audit.accountAuditFile()!;
    const unrelated = path.join(directory, "unrelated.txt");
    fs.writeFileSync(unrelated, "keep");
    for (let i = 0; i < 11; i++) {
      const file = audit.accountAuditFile()!;
      fs.appendFileSync(file, "\n".repeat(MAX_BYTES - fs.statSync(file).size - 1));
      audit.withAccountAudit("switch", () => audit.auditAccountEvent("operation_completed"));
    }
    expect(ownFiles()).toHaveLength(8);
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("keep");
    expect(ownFiles().every(name => fs.statSync(path.join(directory, name)).size <= MAX_BYTES)).toBe(true);
  });

  it("reopens a host log safely if another host pruned its old file", () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    const old = audit.accountAuditFile()!;
    fs.unlinkSync(old);
    expect(audit.accountAuditFile()).toBeUndefined();
    audit.withAccountAudit("switch", () => audit.auditAccountEvent("operation_completed"));
    expect(audit.accountAuditFile()).toBeDefined();
    expect(audit.accountAuditFile()).not.toBe(old);
    expect(records().some(row => row.event === "operation_completed")).toBe(true);
  });

  it("does not create a ninth file if retention deletion is unavailable", () => {
    for (let i = 0; i < 8; i++) fixtureFile(JSON.stringify(record()) + "\n");
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw new Error("secret file path"); });
    expect(() => audit.initializeAccountAudit(directory, "2.15.9")).not.toThrow();
    expect(audit.accountAuditFile()).toBeUndefined();
    expect(ownFiles()).toHaveLength(8);
    expect(audit.readAccountAuditLog()).toContain("recording is unavailable");
  });
});

describe("strict runtime privacy", () => {
  it("discards forged fields, unknown values and raw messages before serialization", () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    const secret = "FAKE_TOKEN_email@example.com_C:\\private\\account";
    audit.withAccountAudit("switch", () => {
      audit.auditAccountEvent("apply_failed", { code: "EACCES", stage: secret, reason: secret,
        message: secret, slug: secret, token: secret, credentials: { accessToken: secret }, stack: secret } as never);
      audit.auditAccountEvent(secret as never, { code: "EPERM" });
    });
    const raw = fs.readFileSync(audit.accountAuditFile()!, "utf8");
    expect(raw).not.toContain(secret);
    const failure = records(raw).find(row => row.event === "apply_failed")!;
    expect(failure).toMatchObject({ code: "EACCES" });
    expect(Object.keys(failure).sort()).toEqual(["action", "code", "event", "opId", "timestampUTC", "version"].sort());
  });

  it("never invokes getters or toJSON while logging an untrusted details object", () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    const getter = vi.fn(() => { throw new Error("FAKE_SECRET"); });
    const fields = { code: "EACCES", toJSON: getter };
    Object.defineProperty(fields, "stage", { get: getter });
    audit.withAccountAudit("switch", () => audit.auditAccountEvent("apply_failed", fields as never));
    expect(getter).not.toHaveBeenCalled();
    expect(audit.readAccountAuditLog()).not.toContain("FAKE_SECRET");
  });

  it("handles hostile proxy descriptors without throwing", () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    const proxy = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("FAKE_SECRET"); } });
    expect(() => audit.withAccountAudit("switch", () => audit.auditAccountEvent("apply_failed", proxy as never))).not.toThrow();
    expect(audit.safeAccountErrorCode(proxy)).toBe("unknown");
    expect(audit.readAccountAuditLog()).not.toContain("FAKE_SECRET");
  });

  it("only accepts exact known error codes, without reading messages, paths or getters", () => {
    expect(audit.safeAccountErrorCode("copy-failed")).toBe("copy-failed");
    expect(audit.safeAccountErrorCode({ code: "ENOSPC", message: "FAKE_SECRET" })).toBe("ENOSPC");
    expect(audit.safeAccountErrorCode("EPERM: C:\\secret")).toBe("unknown");
    expect(audit.safeAccountErrorCode(new Error("FAKE_SECRET"))).toBe("unknown");
    const getter = vi.fn(() => "EACCES");
    expect(audit.safeAccountErrorCode(Object.defineProperty({}, "code", { get: getter }))).toBe("unknown");
    expect(getter).not.toHaveBeenCalled();
  });

  it("revalidates persisted records instead of displaying modified raw text or extra properties", () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    const secret = "FAKE_SAVED_TOKEN_email@example.com";
    fixtureFile(JSON.stringify(record({ message: secret, slug: secret, code: secret })) + "\n" + secret + "\n" + JSON.stringify(record({ event: secret })) + "\n");
    const result = audit.readAccountAuditLog();
    expect(result).not.toContain(secret);
    expect(result).toContain("could not be read");
    expect(records(result).filter(row => row.event === "operation_completed")).toHaveLength(1);
    expect(records(result).find(row => row.event === "operation_completed")).not.toHaveProperty("code");
  });

  it("normalizes an invalid version without recording its contents", () => {
    audit.initializeAccountAudit(directory, "email@example.com/FAKE_TOKEN");
    expect(records()[0].version).toBe("unknown");
    expect(audit.readAccountAuditLog()).not.toContain("FAKE_TOKEN");
  });

  it("ignores events outside an operation rather than recording uncorrelated data", () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    audit.auditAccountEvent("apply_started");
    expect(records()).toHaveLength(1);
  });
});

describe("work correlation and failure isolation", () => {
  it("preserves sync results, work failures and the exact original Promise", async () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    const result = {};
    expect(audit.withAccountAudit("switch", () => result)).toBe(result);
    const failure = new Error("FAKE_SECRET");
    let caught: unknown;
    try { audit.withAccountAudit("switch", () => { throw failure; }); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    const promise = Promise.resolve(42);
    expect(audit.withAccountAudit("switch", () => promise)).toBe(promise);
    await promise;
    expect(audit.readAccountAuditLog()).not.toContain("FAKE_SECRET");
  });

  it("correlates interleaved async operations independently across await boundaries", async () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    let releaseSwitch!: () => void, releaseRecovery!: () => void;
    const switchGate = new Promise<void>(resolve => { releaseSwitch = resolve; });
    const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve; });
    const first = audit.withAccountAudit("switch", async () => { audit.auditAccountEvent("confirmation_requested"); await switchGate; audit.auditAccountEvent("apply_completed"); });
    const second = audit.withAccountAudit("recovery", async () => { audit.auditAccountEvent("recovery_started"); await recoveryGate; audit.auditAccountEvent("recovery_completed"); });
    releaseRecovery(); await second;
    releaseSwitch(); await first;
    const rows = records().filter(row => row.action !== "lifecycle");
    const switches = rows.filter(row => row.action === "switch"), recoveries = rows.filter(row => row.action === "recovery");
    expect(new Set(switches.map(row => row.opId)).size).toBe(1);
    expect(new Set(recoveries.map(row => row.opId)).size).toBe(1);
    expect(switches[0].opId).not.toBe(recoveries[0].opId);
    expect(rows.map(row => row.event)).toContain("apply_completed");
  });

  it("keeps nested recovery events under the initiating switch correlation", () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    audit.withAccountAudit("switch", () => audit.withAccountAudit("recovery", () => audit.auditAccountEvent("recovery_completed")));
    const rows = records().filter(row => row.action !== "lifecycle");
    expect(rows.map(row => row.event)).toEqual(["operation_started", "recovery_completed"]);
    expect(new Set(rows.map(row => row.opId)).size).toBe(1);
    expect(rows.every(row => row.action === "switch")).toBe(true);
  });

  it("does not relabel an old pending operation as a new activation", async () => {
    audit.initializeAccountAudit(directory, "2.15.8");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const work = audit.withAccountAudit("switch", async () => { await gate; audit.auditAccountEvent("apply_completed"); });
    audit.initializeAccountAudit(directory, "2.15.9");
    release(); await work;
    expect(records().some(row => row.event === "apply_completed")).toBe(false);
  });

  it("never fails credential work when creating a log directory is denied", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => { throw new Error("FAKE_SECRET_PATH"); });
    expect(() => audit.initializeAccountAudit(directory, "2.15.9")).not.toThrow();
    expect(audit.withAccountAudit("switch", () => 42)).toBe(42);
    expect(audit.accountAuditFile()).toBeUndefined();
    expect(audit.readAccountAuditLog()).toContain("recording is unavailable");
    expect(audit.readAccountAuditLog()).not.toContain("FAKE_SECRET_PATH");
  });

  it("stops recording harmlessly after an append failure and tells the viewer new events may be missing", () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => { throw new Error("FAKE_SECRET_PATH"); });
    expect(audit.withAccountAudit("switch", () => { audit.auditAccountEvent("apply_started"); return 42; })).toBe(42);
    expect(audit.accountAuditFile()).toBeUndefined();
    const result = audit.readAccountAuditLog();
    expect(result).toContain("logger_started");
    expect(result).toContain("newer events may be missing");
    expect(result).not.toContain("FAKE_SECRET_PATH");
  });
});

describe("bounded safe history reader", () => {
  it("merges records chronologically even if multiwindow file modification order differs", () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    const late = fixtureFile(JSON.stringify(record({ timestampUTC: "2026-10-09T03:00:00.000Z" })) + "\n");
    const early = fixtureFile(JSON.stringify(record({ timestampUTC: "2026-10-09T02:00:00.000Z" })) + "\n");
    fs.utimesSync(late, new Date(0), new Date(0));
    fs.utimesSync(early, new Date(1000), new Date(1000));
    const values = records().filter(row => row.event === "operation_completed").map(row => row.timestampUTC);
    expect(values).toEqual(["2026-10-09T02:00:00.000Z", "2026-10-09T03:00:00.000Z"]);
  });

  it("does not read symlink entries or unrelated files", () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    const linked = fixtureFile("FAKE_SECRET_LINK_TARGET");
    fs.writeFileSync(path.join(directory, "unrelated.txt"), "FAKE_SECRET_UNRELATED");
    const actualStat = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike) => {
      if (file === linked) return { isFile: () => true, isSymbolicLink: () => true };
      return actualStat(file);
    }) as typeof fs.lstatSync);
    const open = vi.spyOn(fs, "openSync");
    const result = audit.readAccountAuditLog();
    expect(open.mock.calls.some(args => args[0] === linked)).toBe(false);
    expect(result).not.toContain("FAKE_SECRET");
  });

  it("skips oversized and unreadable files with a harmless static status", () => {
    audit.initializeAccountAudit(directory, "2.15.9");
    fixtureFile("FAKE_SECRET".repeat(Math.ceil(MAX_BYTES / 11) + 1));
    const unreadable = fixtureFile(JSON.stringify(record()) + "\n");
    const actualOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (file === unreadable) throw new Error("FAKE_PRIVATE_PATH");
      return actualOpen(file, args[0] as number);
    }) as typeof fs.openSync);
    const result = audit.readAccountAuditLog();
    expect(result).toContain("could not be read");
    expect(result).not.toContain("FAKE_SECRET");
    expect(result).not.toContain("FAKE_PRIVATE_PATH");
    expect(Buffer.byteLength(result)).toBeLessThan(8 * MAX_BYTES + 512);
  });
});
