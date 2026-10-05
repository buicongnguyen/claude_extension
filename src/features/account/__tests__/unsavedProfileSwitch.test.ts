/** Switching must preserve a login that has not yet been saved. All accounts are synthetic. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const fixture = vi.hoisted(() => {
  const fileSystem = require("fs") as typeof import("fs");
  const paths = require("path") as typeof import("path");
  const os = require("os") as typeof import("os");
  const home = fileSystem.mkdtempSync(paths.join(os.tmpdir(), "manager-unsaved-switch-"));
  return { home, claude: paths.join(home, ".claude"), vault: paths.join(home, "vault") };
});
vi.mock("os", async (original) => ({ ...(await original<typeof import("os")>()), homedir: () => fixture.home }));
vi.mock("../../../core/config", () => ({ CLAUDE_DIR: fixture.claude }));
vi.mock("fs", async (original) => ({ ...(await original<typeof import("fs")>()) }));

import { closeProfileVault, initializeProfileVault } from "../profileVault";
import { clearClaudeJsonCache } from "../claudeJsonCache";
import { readAccountSnapshot, SNAPSHOT_FILE } from "../accountSnapshot";
import { getActiveProfileSlug, listProfiles, saveProfile, switchProfile } from "../profiles";
import { hasPendingSwitch, SWITCH_BACKUP } from "../liveSwitch";

const originalPlatform = process.platform;
const configFile = path.join(fixture.home, ".claude.json");
const credentialsFile = path.join(fixture.claude, ".credentials.json");
function login(account: string, email = `${account}@example.test`) {
  fs.writeFileSync(configFile, JSON.stringify({ oauthAccount: { accountUuid: account,
    emailAddress: email }, userID: "synthetic-device", projects: { preserved: true } }));
  fs.writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: {
    accessToken: `synthetic-access-${account}`, refreshToken: `synthetic-refresh-${account}`,
  } }));
  clearClaudeJsonCache();
}
function livePair() {
  return { config: fs.readFileSync(configFile, "utf8"), credentials: fs.readFileSync(credentialsFile, "utf8") };
}
function snapshot(slug: string) { return readAccountSnapshot(path.join(fixture.vault, slug)); }
function encryptedSlot(slug: string) { return fs.readFileSync(path.join(fixture.vault, slug, SNAPSHOT_FILE), "utf8"); }

beforeEach(async () => {
  // Select the fixture file backend even when this suite runs on macOS.
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  fs.mkdirSync(fixture.claude, { recursive: true });
  clearClaudeJsonCache();
  const secrets = new Map<string, string>();
  await initializeProfileVault({ get: async (name) => secrets.get(name),
    store: async (name, raw) => { secrets.set(name, raw); } }, fixture.vault);
});
afterEach(() => {
  closeProfileVault();
  clearClaudeJsonCache();
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (!path.basename(fixture.home).startsWith("manager-unsaved-switch-")) throw Error("Unsafe test cleanup");
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

describe("unsaved outgoing account preservation", () => {
  it("refuses replacing unsaved B, then allows switching both ways after saving B", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    const originalA = encryptedSlot("account-1");
    login("bob"); const outgoingB = livePair();

    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "unsaved-active-account" });
    expect(livePair()).toEqual(outgoingB);
    expect(encryptedSlot("account-1")).toBe(originalA);
    expect(listProfiles().map((profile) => profile.slug)).toEqual(["account-1"]);
    expect(hasPendingSwitch()).toBe(false);
    expect(fs.existsSync(SWITCH_BACKUP)).toBe(false);

    expect(saveProfile("Account 2").ok).toBe(true);
    expect(switchProfile("account-1").ok).toBe(true);
    expect(fs.readFileSync(credentialsFile, "utf8")).toBe(snapshot("account-1").credsRaw);
    expect(switchProfile("account-2").ok).toBe(true);
    expect(livePair().credentials).toBe(outgoingB.credentials);
    expect(JSON.parse(livePair().config)).toEqual(JSON.parse(outgoingB.config));
    expect(listProfiles().map((profile) => profile.slug)).toEqual(["account-1", "account-2"]);
  });

  it("allows restoring a saved account when no live login exists", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    fs.rmSync(credentialsFile); // Claude has signed out; stale identity metadata is harmless.
    clearClaudeJsonCache();
    expect(switchProfile("account-1").ok).toBe(true);
    expect(fs.readFileSync(credentialsFile, "utf8")).toBe(snapshot("account-1").credsRaw);
  });

  it("keeps unreadable live credentials and every saved snapshot untouched", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    const originalA = encryptedSlot("account-1");
    login("bob"); fs.writeFileSync(credentialsFile, "{synthetic interrupted write");
    const unreadableB = livePair();
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "unreadable-source" });
    expect(livePair()).toEqual(unreadableB);
    expect(encryptedSlot("account-1")).toBe(originalA);
    expect(hasPendingSwitch()).toBe(false);
  });
});
function jwt(claims: Record<string, string>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic`;
}
function setToken(claims: Record<string, string>) {
  fs.writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: {
    accessToken: jwt(claims), refreshToken: "synthetic-new-login-refresh",
  } }));
}

describe("saved account identity boundaries", () => {
  it("keeps different populated UUIDs separate despite matching email and device ID", () => {
    login("alice", "shared@example.test"); expect(saveProfile("Account 1").ok).toBe(true);
    login("bob", "shared@example.test");
    expect(getActiveProfileSlug()).toBeNull();
    expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "unsaved-active-account" });
    expect(saveProfile("Account 2").ok).toBe(true);
    expect(listProfiles().map((profile) => profile.accountUuid)).toEqual(["alice", "bob"]);
    expect(getActiveProfileSlug()).toBe("account-2");
    expect(switchProfile("account-1").ok).toBe(true);
    expect(switchProfile("account-2").ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(configFile, "utf8")).oauthAccount.accountUuid).toBe("bob");
  });

  it("does not match conflicting UUIDs through email-only legacy fallback", () => {
    login("alice", "shared@example.test");
    let config = JSON.parse(fs.readFileSync(configFile, "utf8")); delete config.userID;
    fs.writeFileSync(configFile, JSON.stringify(config)); clearClaudeJsonCache();
    expect(saveProfile("Account 1").ok).toBe(true);
    login("bob", "shared@example.test");
    config = JSON.parse(fs.readFileSync(configFile, "utf8")); delete config.userID;
    fs.writeFileSync(configFile, JSON.stringify(config)); clearClaudeJsonCache();
    expect(getActiveProfileSlug()).toBeNull();
    expect(saveProfile("Account 2").ok).toBe(true);
  });

  it.each([
    { name: "UUID", claims: { account_uuid: "bob", email: "alice@example.test" } },
    { name: "email with matching UUID", claims: { account_uuid: "alice", email: "bob@example.test" } },
    { name: "email without token UUID", claims: { email: "bob@example.test" } },
  ])("refuses saving conflicting JWT $name without changing live or saved accounts", ({ claims }) => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    const originalA = encryptedSlot("account-1");
    setToken(claims); const incompleteLogin = livePair();
    const result = saveProfile("Account 2");
    expect(result).toMatchObject({ ok: false, error: "account-mismatch" });
    if (!result.ok) {
      expect(result.detail).toContain("Finish signing in");
      expect(result.detail).not.toContain("@example.test");
    }
    expect(livePair()).toEqual(incompleteLogin);
    expect(encryptedSlot("account-1")).toBe(originalA);
    expect(listProfiles().map((profile) => profile.slug)).toEqual(["account-1"]);
    expect(fs.existsSync(path.join(fixture.vault, "account-2"))).toBe(false);
  });

  it("allows saving after stale config catches up with the new JWT login", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    setToken({ account_uuid: "bob", email: "bob@example.test", sub: "bob-user" });
    expect(saveProfile("Account 2")).toMatchObject({ ok: false, error: "account-mismatch" });
    const currentCredentials = fs.readFileSync(credentialsFile, "utf8");
    login("bob"); fs.writeFileSync(credentialsFile, currentCredentials);
    expect(saveProfile("Account 2").ok).toBe(true);
    expect(listProfiles().map((profile) => ({ slug: profile.slug, uuid: profile.accountUuid }))).toEqual([
      { slug: "account-1", uuid: "alice" }, { slug: "account-2", uuid: "bob" },
    ]);
    expect(getActiveProfileSlug()).toBe("account-2");
  });

  it("does not confuse account-level JWT sub with the device-stable config userID", () => {
    login("alice"); setToken({ account_uuid: "alice", email: "ALICE@example.test", sub: "different-account-level-id" });
    expect(saveProfile("Account 1").ok).toBe(true);
  });
});
describe("unsaved login with unavailable config", () => {
  it.each(["missing", "empty", "malformed", "unreadable"])("preserves readable outgoing tokens when config is %s", (state) => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    const originalA = encryptedSlot("account-1");
    login("bob");
    if (state === "missing") fs.rmSync(configFile);
    else if (state === "empty") fs.writeFileSync(configFile, "");
    else if (state === "malformed") fs.writeFileSync(configFile, "{synthetic interrupted config");
    clearClaudeJsonCache();
    const outgoingTokens = fs.readFileSync(credentialsFile, "utf8");
    const originalConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
    const read = fs.readFileSync;
    const denied = state === "unreadable" ? vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (String(file) === configFile) throw Object.assign(Error("Synthetic config access denied"), { code: "EACCES" });
      return read(file, options);
    }) : undefined;
    try {
      expect(switchProfile("account-1")).toMatchObject({ ok: false, error: "unsaved-active-account" });
    } finally { denied?.mockRestore(); }
    expect(fs.readFileSync(credentialsFile, "utf8")).toBe(outgoingTokens);
    expect(fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null).toBe(originalConfig);
    expect(encryptedSlot("account-1")).toBe(originalA);
    expect(hasPendingSwitch()).toBe(false);
    expect(fs.existsSync(SWITCH_BACKUP)).toBe(false);
  });
});