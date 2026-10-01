/** Personal fork: encrypted snapshots; the encryption key lives in VS Code SecretStorage. */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

interface Secrets {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
}

let root: string | undefined;
let key: Buffer | undefined;
const FORMAT = "claude-manager-personal/aes-256-gcm/v1";

export function closeProfileVault(): void {
  key?.fill(0);
  key = undefined;
  root = undefined;
}

/** Initialize before registering commands or reading profiles. Never fall back to plaintext. */
export async function initializeProfileVault(secrets: Secrets, directory: string): Promise<void> {
  closeProfileVault();
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const lock = path.join(resolved, ".initializing");
  // Exclusive creation prevents two VS Code windows from creating different keys.
  // A crash can leave this marker: fail closed rather than guess which key is correct.
  let handle: number;
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      handle = fs.openSync(lock, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error("Account vault initialization could not access its storage folder.");
      }
      if (Date.now() >= deadline) {
        throw new Error("Account vault is locked by another initialization. Retry after it finishes. If a crash left .initializing in the vault folder, remove only that marker while VS Code is closed.");
      }
      // Let the owning window finish its SecretStorage operation. Never steal its lock.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    const secretName = `account-vault-v1:${crypto.createHash("sha256").update(resolved).digest("hex")}`;
    let encoded = await secrets.get(secretName);
    if (!encoded) {
      if (fs.readdirSync(resolved).some((entry) => entry !== ".initializing")) {
        throw new Error("Account vault key is missing. Existing saved profiles were left untouched. Restore the matching VS Code secret storage to recover them.");
      }
      encoded = crypto.randomBytes(32).toString("base64");
      await secrets.store(secretName, encoded);
      if (await secrets.get(secretName) !== encoded) {
        throw new Error("VS Code could not persist the account vault key.");
      }
    }
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || Buffer.from(encoded, "base64").length !== 32) {
      throw new Error("Account vault key is invalid. No saved profiles were changed.");
    }
    key = Buffer.from(encoded, "base64");
    root = resolved;
  } finally {
    fs.closeSync(handle);
    fs.unlinkSync(lock);
  }
}

export function getProfileDirectory(): string {
  if (!root || !key) throw new Error("Encrypted account storage is unavailable. Reload VS Code to unlock it.");
  return root;
}

function authenticatedPath(file: string): string {
  const relative = path.relative(getProfileDirectory(), path.resolve(file));
  if (relative.startsWith("..") || path.isAbsolute(relative) || !relative) {
    throw new Error("Invalid account snapshot path.");
  }
  // Reject symlinked slots so writes/deletion cannot escape the vault directory.
  const parts = relative.split(path.sep);
  let current = getProfileDirectory();
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Linked account snapshot paths are not supported.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return `${FORMAT}:${parts.join("/")}`;
}

export function readProfileFile(file: string): string {
  const aad = authenticatedPath(file);
  try {
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
    if (envelope.format !== FORMAT || typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.data !== "string") {
      throw new Error("Invalid envelope");
    }
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid envelope");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key!, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // Never expose raw token-bearing input, JSON parse excerpts, or crypto internals.
    throw new Error("Saved account is unreadable, damaged, or belongs to a different vault.");
  }
}

export function writeProfileFile(file: string, plaintext: string): void {
  const aad = authenticatedPath(file);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key!, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope = JSON.stringify({ format: FORMAT, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, envelope, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    // A cleanup error must not report failure after the replacement committed.
    try { fs.rmSync(temporary, { force: true }); } catch { /* encrypted temporary only */ }
  }
}
