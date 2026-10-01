import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { closeProfileVault, getProfileDirectory, initializeProfileVault, readProfileFile, writeProfileFile } from "../profileVault";

let directory: string;
let secrets: Map<string, string>;
const storage = {
  get: async (name: string) => secrets.get(name),
  store: async (name: string, value: string) => { secrets.set(name, value); },
};
const raw = JSON.stringify({ accessToken: "synthetic-access-token", refreshToken: "synthetic-refresh-token" });
function snapshot(slot = "account-1", name = ".credentials.json"): string {
  const folder = path.join(directory, slot);
  fs.mkdirSync(folder, { recursive: true });
  return path.join(folder, name);
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "manager-vault-test-"));
  secrets = new Map();
});
afterEach(() => {
  closeProfileVault();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("encrypted profile vault", () => {
  it("persists ciphertext and decrypts it after reopening with the same secret store", async () => {
    await initializeProfileVault(storage, directory);
    const file = snapshot();
    writeProfileFile(file, raw);
    const disk = fs.readFileSync(file, "utf8");
    expect(disk).not.toContain("synthetic-access-token");
    expect(disk).not.toContain("synthetic-refresh-token");
    expect(disk).not.toContain([...secrets.values()][0]);
    closeProfileVault();
    await initializeProfileVault(storage, directory);
    expect(readProfileFile(file)).toBe(raw);
  });
  it("uses a fresh nonce on every save", async () => {
    await initializeProfileVault(storage, directory);
    const file = snapshot();
    writeProfileFile(file, raw);
    const first = fs.readFileSync(file, "utf8");
    writeProfileFile(file, raw);
    expect(fs.readFileSync(file, "utf8")).not.toBe(first);
    expect(readProfileFile(file)).toBe(raw);
  });
  it("rejects tampered ciphertext without exposing tokens in the error", async () => {
    await initializeProfileVault(storage, directory);
    const file = snapshot();
    writeProfileFile(file, raw);
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
    envelope.data = Buffer.from(raw).toString("base64");
    fs.writeFileSync(file, JSON.stringify(envelope));
    expect(() => readProfileFile(file)).toThrow("Saved account is unreadable");
  });
  it("binds encrypted contents to their profile and filename", async () => {
    await initializeProfileVault(storage, directory);
    const first = snapshot(), second = snapshot("account-2");
    writeProfileFile(first, raw);
    fs.copyFileSync(first, second);
    expect(() => readProfileFile(second)).toThrow("Saved account is unreadable");
    const identity = snapshot("account-1", ".claude.json");
    fs.copyFileSync(first, identity);
    expect(() => readProfileFile(identity)).toThrow("Saved account is unreadable");
  });
  it("does not replace a lost key when saved profiles exist", async () => {
    await initializeProfileVault(storage, directory);
    const file = snapshot();
    writeProfileFile(file, raw);
    const before = fs.readFileSync(file, "utf8");
    secrets.clear();
    await expect(initializeProfileVault(storage, directory)).rejects.toThrow("key is missing");
    expect(secrets.size).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(() => getProfileDirectory()).toThrow("unavailable");
  });
  it("refuses plaintext snapshots", async () => {
    await initializeProfileVault(storage, directory);
    const file = snapshot();
    fs.writeFileSync(file, raw);
    expect(() => readProfileFile(file)).toThrow("Saved account is unreadable");
  });
  it("fails closed when secret storage refuses a write", async () => {
    await expect(initializeProfileVault({ get: async () => undefined, store: async () => { throw Error("storage unavailable"); } }, directory)).rejects.toThrow("storage unavailable");
    expect(() => getProfileDirectory()).toThrow("unavailable");
    expect(fs.readdirSync(directory)).toEqual([]);
  });
  it("rejects path traversal and releases initialization locks after errors", async () => {
    await initializeProfileVault(storage, directory);
    expect(() => writeProfileFile(path.join(directory, "..", "escape.json"), raw)).toThrow("Invalid account snapshot path");
    expect(fs.existsSync(path.join(directory, ".initializing"))).toBe(false);
  });
  it("does not overwrite the key when another window is initializing", async () => {
    fs.writeFileSync(path.join(directory, ".initializing"), "");
    await expect(initializeProfileVault(storage, directory)).rejects.toThrow("locked");
    expect(secrets.size).toBe(0);
  });
  it("leaves the prior ciphertext intact if a replacement fails", async () => {
    await initializeProfileVault(storage, directory);
    const file = snapshot();
    writeProfileFile(file, raw);
    expect(fs.readdirSync(path.dirname(file))).toEqual([".credentials.json"]);
    closeProfileVault();
    expect(() => writeProfileFile(file, "replacement")).toThrow("unavailable");
    await initializeProfileVault(storage, directory);
    expect(readProfileFile(file)).toBe(raw);
  });
});
