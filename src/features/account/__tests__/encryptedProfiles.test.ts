import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const fixture = vi.hoisted(() => {
  const f = require("fs") as typeof import("fs");
  const p = require("path") as typeof import("path");
  const o = require("os") as typeof import("os");
  const home = f.mkdtempSync(p.join(o.tmpdir(), "manager-encrypted-profiles-"));
  return { home, claude: p.join(home, ".claude"), vault: p.join(home, "vault") };
});
vi.mock("fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("fs")>()) }));
vi.mock("os", async (importOriginal) => ({ ...(await importOriginal<typeof import("os")>()), homedir: () => fixture.home }));
vi.mock("../../../core/config", () => ({ CLAUDE_DIR: fixture.claude }));
import { closeProfileVault, initializeProfileVault, readProfileFile } from "../profileVault";
import { getActiveProfileSlug, listProfiles, readProfileListing, removeProfile, saveProfile, switchProfile } from "../profiles";

import { readAccountSnapshot, SNAPSHOT_FILE } from "../accountSnapshot";

let secrets: Map<string, string>;
const storage = { get: async (name: string) => secrets.get(name), store: async (name: string, raw: string) => { secrets.set(name, raw); } };
const liveConfig = path.join(fixture.home, ".claude.json");
const liveCredentials = path.join(fixture.claude, ".credentials.json");
function login(account: string) {
  fs.writeFileSync(liveConfig, JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: `${account}@example.test` }, userID: "same-device", projects: { "keep-project": {} } }));
  fs.writeFileSync(liveCredentials, JSON.stringify({ claudeAiOauth: { accessToken: `synthetic-access-${account}`, refreshToken: `synthetic-refresh-${account}`, expiresAt: Date.now() + 3_600_000, subscriptionType: "max" } }));
}
beforeEach(async () => {
  fs.mkdirSync(fixture.claude, { recursive: true });
  secrets = new Map();
  await initializeProfileVault(storage, fixture.vault);
});
afterEach(() => {
  vi.restoreAllMocks();
  closeProfileVault();
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

describe("two accounts using the real encrypted vault", () => {
  it("saves two accounts encrypted and switches back without replacing project configuration", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    login("bob"); expect(saveProfile("Account 2").ok).toBe(true);
    expect(listProfiles().map(p => p.label)).toEqual(["Account 1", "Account 2"]);
    expect(getActiveProfileSlug()).toBe("account-2");
    expect(switchProfile("account-1").ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(liveCredentials, "utf8")).claudeAiOauth.accessToken).toBe("synthetic-access-alice");
    expect(JSON.parse(fs.readFileSync(liveConfig, "utf8")).projects).toEqual({ "keep-project": {} });
    expect(getActiveProfileSlug()).toBe("account-1");
    for (const slot of ["account-1", "account-2"]) {
      for (const file of fs.readdirSync(path.join(fixture.vault, slot))) {
        const disk = fs.readFileSync(path.join(fixture.vault, slot, file), "utf8");
        expect(disk).not.toContain("synthetic-access-");
        expect(disk).not.toContain("synthetic-refresh-");
      }
    }
    expect(readAccountSnapshot(path.join(fixture.vault, "account-2")).credsRaw).toContain("synthetic-access-bob");
  });
  it("does not change the live login if the target encrypted snapshot is corrupted", () => {
    login("alice"); saveProfile("Account 1");
    login("bob"); saveProfile("Account 2");
    fs.writeFileSync(path.join(fixture.vault, "account-1", SNAPSHOT_FILE), "broken snapshot");
    const before = fs.readFileSync(liveCredentials, "utf8");
    const identity = fs.readFileSync(liveConfig, "utf8");
    expect(switchProfile("account-1").ok).toBe(false);
    expect(fs.readFileSync(liveCredentials, "utf8")).toBe(before);
    expect(fs.readFileSync(liveConfig, "utf8")).toBe(identity);
  });
  it("refreshes outgoing credentials before switching to the other saved account", () => {
    login("alice"); saveProfile("Account 1");
    login("bob"); saveProfile("Account 2");
    const credentials = JSON.parse(fs.readFileSync(liveCredentials, "utf8"));
    credentials.claudeAiOauth.refreshToken = "synthetic-rotated-refresh-bob";
    fs.writeFileSync(liveCredentials, JSON.stringify(credentials));
    expect(switchProfile("account-1").ok).toBe(true);
    expect(switchProfile("account-2").ok).toBe(true);
    expect(fs.readFileSync(liveCredentials, "utf8")).toContain("synthetic-rotated-refresh-bob");
  });
  it("rejects traversal when deleting a saved profile", () => {
    login("alice"); saveProfile("Account 1");
    expect(() => removeProfile("../.claude")).toThrow("Invalid account profile identifier");
    expect(fs.existsSync(liveCredentials)).toBe(true);
  });
  it("refuses switching while Claude's credential refresh lock is held", () => {
    login("alice"); saveProfile("Account 1");
    login("bob"); saveProfile("Account 2");
    const before = fs.readFileSync(liveCredentials, "utf8");
    const lock = path.join(fixture.claude, ".oauth_refresh.lock");
    fs.mkdirSync(lock);
    let time = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => { time += 500; return time; });
    vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const result = switchProfile("account-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("refreshing its credentials");
    expect(fs.readFileSync(liveCredentials, "utf8")).toBe(before);
    expect(fs.existsSync(lock)).toBe(true);
  });
});


describe("saved-profile listing diagnostics", () => {
  it("reports a damaged stored slot while still listing the readable account", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    login("bob"); expect(saveProfile("Account 2").ok).toBe(true);
    const damaged = path.join(fixture.vault, "account-1", SNAPSHOT_FILE);
    const broken = "damaged snapshot containing synthetic-access-alice";
    fs.writeFileSync(damaged, broken);
    fs.writeFileSync(path.join(fixture.vault, ".switch-recovery.enc"), "synthetic-recovery-record");

    const listing = readProfileListing();
    expect(listing.profiles.map(profile => profile.slug)).toEqual(["account-2"]);
    expect(listProfiles()).toEqual(listing.profiles);
    expect(listing.issues).toEqual([{
      slug: "account-1", code: "profile-unreadable",
      detail: "This saved profile is still stored, but its account snapshot could not be unlocked.",
    }]);
    const publicIssues = JSON.stringify(listing.issues);
    expect(publicIssues).not.toContain("synthetic-access-alice");
    expect(publicIssues).not.toContain("synthetic-recovery-record");
    expect(publicIssues).not.toContain(fixture.home);
    for (const secret of secrets.values()) expect(publicIssues).not.toContain(secret);
    expect(fs.readFileSync(damaged, "utf8")).toBe(broken);
  });

  it("reports temporary snapshot read failures without exposing or changing its bytes", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    const snapshot = path.join(fixture.vault, "account-1", SNAPSHOT_FILE);
    const before = fs.readFileSync(snapshot, "utf8");
    const read = fs.readFileSync;
    const failRead = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (String(file) === snapshot) throw new Error("private error: synthetic-access-alice");
      return read(file, options as never);
    });
    const listing = readProfileListing();
    expect(listing.profiles).toEqual([]);
    expect(listing.issues).toMatchObject([{ slug: "account-1", code: "profile-unreadable" }]);
    expect(JSON.stringify(listing.issues)).not.toContain("private error");
    expect(JSON.stringify(listing.issues)).not.toContain("synthetic-access-alice");
    failRead.mockRestore();
    expect(fs.readFileSync(snapshot, "utf8")).toBe(before);
    expect(readProfileListing()).toMatchObject({ profiles: [{ slug: "account-1" }], issues: [] });
  });

  it("distinguishes a locked vault from an empty account list without changing stored profiles", () => {
    login("alice"); expect(saveProfile("Account 1").ok).toBe(true);
    const snapshot = path.join(fixture.vault, "account-1", SNAPSHOT_FILE);
    const before = fs.readFileSync(snapshot, "utf8");
    closeProfileVault();
    expect(readProfileListing()).toEqual({
      profiles: [], issues: [{ slug: null, code: "storage-unavailable",
        detail: "Saved-account storage could not be read. Existing profiles have not been changed." }],
    });
    expect(listProfiles()).toEqual([]);
    expect(fs.readFileSync(snapshot, "utf8")).toBe(before);
  });

  it("reports vault directory access failures with a fixed non-secret message", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw Object.assign(new Error("private directory error: synthetic-access-alice"), { code: "EACCES" });
    });
    const listing = readProfileListing();
    expect(listing).toMatchObject({ profiles: [], issues: [{ slug: null, code: "storage-unavailable" }] });
    expect(JSON.stringify(listing.issues)).not.toContain("private directory error");
    expect(JSON.stringify(listing.issues)).not.toContain("synthetic-access-alice");
  });

  it("keeps a missing directory equivalent to an empty listing for compatibility", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw Object.assign(new Error("missing directory"), { code: "ENOENT" });
    });
    expect(readProfileListing()).toEqual({ profiles: [], issues: [] });
    expect(listProfiles()).toEqual([]);
  });
});
