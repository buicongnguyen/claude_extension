// Modified for the personal fork, September 2026. See NOTICE.
/**
 * Account profiles — snapshot and swap Claude CLI credentials so users
 * can move between multiple accounts without going through the full
 * `/logout` + `/login` browser dance each time.
 *
 * Storage layout:
 *   VS Code globalStorage/local-personal.claude-manager-personal/accounts/<slug>/
 *     profile.enc — one authenticated identity + credentials + metadata snapshot
 * Legacy encrypted multi-file snapshots remain readable until the first update.
 *
 * Switching merges identity into live state: `oauthAccount` + `userID`
 * are overwritten from the snapshot; every other key in `~/.claude.json`
 * (projects, numStartups, migration flags, caches, onboarding, MCP
 * config, …) is preserved as-is. `~/.claude/.credentials.json` is
 * swapped wholesale because it holds only OAuth tokens.
 *
 * Active-profile detection falls through four matchers in this order:
 *   1. byte-identical credentials hash (same token = same snapshot)
 *   2. `oauthAccount.accountUuid` (account-stable; primary identity)
 *   3. `userID` + email cross-check (legacy snapshots without accountUuid)
 *   4. email (oldest snapshots, pre-userID storage)
 *
 * The identity cascade is a display hint, not authority to overwrite a slot.
 * Automatic refresh requires unchanged token lineage plus matching identity.
 * A full opaque token replacement needs an explicit, hash-bound confirmation;
 * local identity metadata alone cannot distinguish refresh from a new login.
 *
 * About `userID` vs `accountUuid`: the top-level `userID` field in
 * `.claude.json` is device-stable (same value across accounts on one
 * machine), NOT account-distinct. `oauthAccount.accountUuid` is the
 * authoritative per-account id. Pre-fix snapshots stored userID as the
 * dedupe key, which is why the cascade still cross-checks email when
 * matching on it.
 *
 * Personal fork: snapshots are encrypted using AES-256-GCM. The key is held
 * by VS Code SecretStorage; no plaintext snapshot fallback is permitted.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getProfileDirectory } from "./profileVault";
import { readAccountSnapshot, writeAccountSnapshot, SNAPSHOT_FILE, type AccountSnapshot } from "./accountSnapshot";
import { hasPendingSwitch, recoverPendingSwitchUnlocked, writeLiveAccount } from "./liveSwitch";
import { readClaudeJsonRaw } from "./claudeJsonCache";
import { withLocks, CREDENTIAL_LOCKS, CONFIG_LOCK, describeLockFailure } from "./claudeLocks";
import {
  readCredentials,
  hashCredentials,
  type CredentialsSource,
} from "./credentials";

const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");
function slotDirectory(slug: string): string {
  if (!/^[a-z0-9_-]+$/.test(slug)) throw new Error("Invalid account profile identifier.");
  const directory = path.join(getProfileDirectory(), slug);
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Linked account profiles are not supported.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return directory;
}

/** Public per-profile metadata for the webview. Never contains tokens. */
export interface SavedProfile {
  /** URL-safe slug used as the directory name. Unique per profile. */
  slug: string;
  /** User-provided label. Displayed as the card title fallback. */
  label: string;
  /** Captured email at save time (for display + disambiguation). */
  email: string;
  /** Captured organization name (empty for personal accounts). */
  organizationName: string;
  /** Subscription tier captured when the snapshot was taken. */
  subscriptionType: string;
  /** ISO timestamp the snapshot was written. */
  savedAt: string;
  /** OAuth token expiry (ms epoch) from the snapshot. 0 if missing. */
  tokenExpiresAt: number;
  /**
   * SHA-256 of the snapshot's credentials file. Used as the primary
   * (exact) match when detecting which profile matches the live
   * `~/.claude/.credentials.json`. Secondary matchers (userID, email)
   * cover the common case where Claude CLI has rotated the token since
   * the snapshot was written, so hashes diverge but identity is stable.
   */
  credentialsHash: string;
  /**
   * Anthropic `userID` captured from the snapshot's `.claude.json`.
   * Note: this field is device-stable (same value across accounts on
   * one machine), NOT account-distinct. Kept as a secondary matcher
   * for legacy snapshots; new code should prefer `accountUuid`.
   */
  userID: string;
  /**
   * `oauthAccount.accountUuid` from the snapshot's `.claude.json` —
   * Anthropic's per-account UUID. Account-distinct and stable across
   * token rotations, so this is the primary identity key for both
   * `getActiveProfileSlug` matching and `saveProfile` dedupe. Empty
   * for snapshots taken before this field was introduced.
   */
  accountUuid: string;
}

/** Live-account identity extracted from `.claude.json` or the access token. */
interface LiveIdentity {
  /** `oauthAccount.accountUuid` — primary, account-distinct. */
  accountUuid: string;
  /** Top-level `userID` — device-stable; secondary matcher only. */
  userID: string;
  /** `oauthAccount.emailAddress`. Lowercase comparisons in matchers. */
  email: string;
}

/**
 * Slugify a free-form label into a safe directory name. Keeps letters,
 * digits, dash, and underscore; collapses other runs into `-`.
 */
function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "profile";
}

/** SHA-256 hex of a file's content, or "" when the file can't be read. */
function hashFile(filePath: string): string {
  try { return hashCredentials(readAccountSnapshot(path.dirname(filePath)).credsRaw); }
  catch { return ""; }
}

/**
 * Read the live identity in a race-safe way: read credentials, read
 * .claude.json, re-read credentials. If credentials moved between the
 * pre- and post-read (Claude CLI mid-refresh, profile switch in flight),
 * retry once. Returns null on unrecoverable error — callers treat that
 * as "no active account".
 *
 * Credentials come through the credentials module so we transparently
 * handle the macOS Keychain backend in addition to the file backend.
 * `.claude.json` is always disk-resident across every supported
 * platform, so it stays a direct `fs.readFileSync`.
 *
 * Without this, `saveProfile` could capture claude.json with one
 * token generation and credentials with another, producing a
 * snapshot that never matches either identity cleanly.
 */
function readLivePairRaceSafe(): {
  claudeJsonRaw: string;
  credsRaw: string;
  source: CredentialsSource;
} | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const pre = readCredentials();
    if (!pre) return null;
    const claudeJsonRaw = readClaudeJsonRaw();
    if (claudeJsonRaw === null || !claudeJsonRaw.trim()) return null;
    const post = readCredentials();
    if (!post) return null;
    if (post.hash === pre.hash && readClaudeJsonRaw() === claudeJsonRaw) {
      return { claudeJsonRaw, credsRaw: post.raw, source: post.source };
    }
    // Token rotated mid-read; retry once.
  }
  return null;
}

/** Parse identity fields from a `.claude.json` payload. */
function extractIdentity(claudeJsonRaw: string): LiveIdentity {
  try {
    const parsed = JSON.parse(claudeJsonRaw) as Record<string, unknown>;
    const oauth = parsed.oauthAccount as Record<string, unknown> | undefined;
    const email = typeof oauth?.emailAddress === "string" ? oauth.emailAddress : "";
    const accountUuid = typeof oauth?.accountUuid === "string" ? oauth.accountUuid : "";
    const userID = typeof parsed.userID === "string" ? parsed.userID : "";
    return { accountUuid, userID, email };
  } catch {
    return { accountUuid: "", userID: "", email: "" };
  }
}

/**
 * Decode a JWT access token's payload (no signature verification — we
 * only need the claims for identity correlation, not auth). Returns
 * null on any parse failure; callers fall back to other identity
 * sources.
 *
 * Why this exists: during Claude CLI's `/login` flow, `.credentials.json`
 * is rewritten with the new tokens BEFORE `.claude.json` gets the new
 * `oauthAccount` + `userID` blocks. Reading identity from `.claude.json`
 * during that window returns the PREVIOUS account's identity — which
 * makes `getActiveProfileSlug` match the old saved slot, hide the
 * "Save profile" button, and mislabel the switcher's active row. The
 * JWT inside `.credentials.json` is always current; trusting it sidesteps
 * the file-write ordering entirely.
 */
function extractIdentityFromToken(credsRaw: string): LiveIdentity | null {
  try {
    const parsed = JSON.parse(credsRaw) as { claudeAiOauth?: { accessToken?: string } };
    const token = parsed.claudeAiOauth?.accessToken;
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    const claims = JSON.parse(payload) as Record<string, unknown>;
    // Claim names vary across OAuth implementations; accept the most
    // common ones and fall through silently if none present. `sub` is
    // the standard JWT subject; `account_uuid` is what Anthropic uses
    // for the per-account UUID; `email` / `email_address` for email.
    const accountUuid =
      (typeof claims.account_uuid === "string" && claims.account_uuid) || "";
    const userID =
      (typeof claims.sub === "string" && claims.sub) ||
      (typeof claims.user_id === "string" && claims.user_id) ||
      "";
    const email =
      (typeof claims.email === "string" && claims.email) ||
      (typeof claims.email_address === "string" && claims.email_address) ||
      "";
    if (!accountUuid && !userID && !email) return null;
    return { accountUuid, userID, email };
  } catch {
    return null;
  }
}

/**
 * Parse a credentials snapshot without exposing the token. Returns the
 * fields the UI needs for the saved-profile card.
 */
function snapshotMeta(snapshot: AccountSnapshot): Partial<SavedProfile> {
  const identity = extractIdentity(snapshot.claudeJsonRaw);
  const config = JSON.parse(snapshot.claudeJsonRaw);
  const credentials = JSON.parse(snapshot.credsRaw);
  return {
    label: snapshot.label, savedAt: snapshot.savedAt, ...identity,
    organizationName: typeof config.oauthAccount?.organizationName === "string" ? config.oauthAccount.organizationName : "",
    subscriptionType: typeof credentials.claudeAiOauth?.subscriptionType === "string" ? credentials.claudeAiOauth.subscriptionType : "",
    tokenExpiresAt: typeof credentials.claudeAiOauth?.expiresAt === "number" ? credentials.claudeAiOauth.expiresAt : 0,
  };
}
function readSnapshotMeta(slotDir: string): Partial<SavedProfile> {
  return snapshotMeta(readAccountSnapshot(slotDir));
}

/**
 * List every saved profile. Returns [] when the directory does not
 * exist; callers treat that as "no profiles yet" (the common case on a
 * fresh install). Slots missing a credentials file are dropped — they
 * can't be switched to anyway, and surfacing them would confuse users.
 */
export function listProfiles(): SavedProfile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(getProfileDirectory());
  } catch {
    return [];
  }

  const out: SavedProfile[] = [];
  for (const slug of entries) {
    let slotDir: string;
    try {
      slotDir = slotDirectory(slug);
      if (!fs.statSync(slotDir).isDirectory()) continue;
    } catch {
      continue;
    }
    let credHash: string;
    let meta: Partial<SavedProfile>;
    try {
      const snapshot = readAccountSnapshot(slotDir);
      credHash = hashCredentials(snapshot.credsRaw);
      meta = snapshotMeta(snapshot);
    } catch { continue; }
    out.push({
      slug,
      label: meta.label ?? meta.email ?? slug,
      email: meta.email ?? "",
      organizationName: meta.organizationName ?? "",
      subscriptionType: meta.subscriptionType ?? "",
      savedAt: meta.savedAt ?? "",
      tokenExpiresAt: meta.tokenExpiresAt ?? 0,
      credentialsHash: credHash,
      userID: meta.userID ?? "",
      accountUuid: meta.accountUuid ?? "",
    });
  }

  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/**
 * Read the live identity, preferring the access-token claims when the
 * token is a JWT (covers the Claude CLI `/login` window where
 * credentials are rewritten before `.claude.json`). Falls back to
 * `.claude.json` for opaque tokens — Anthropic's current production
 * tokens are `sk-ant-oat01-…` opaque strings, so this is the steady-
 * state path. Returns null when no identity can be derived.
 *
 * The credentials read goes through the source-agnostic module so
 * macOS Keychain users get the same identity-resolution behaviour as
 * file users.
 */
function readLiveIdentity(): LiveIdentity | null {
  const live = readCredentials();
  if (!live) return null;
  const tokenIdentity = extractIdentityFromToken(live.raw);
  if (tokenIdentity) return tokenIdentity;
  const claudeJsonRaw = readClaudeJsonRaw();
  if (claudeJsonRaw !== null) {
    const fromJson = extractIdentity(claudeJsonRaw);
    if (fromJson.accountUuid || fromJson.userID || fromJson.email) return fromJson;
  }
  return null;
}

/**
 * `accountUuid` of the account whose credentials are live right now, or
 * "" when nobody is signed in (or the credential predates the field).
 *
 * Exposed separately from `getActiveProfileSlug` because callers that
 * only need identity should not pay for the profile scan: resolving a
 * slug stats and hashes every saved snapshot, while this reads the one
 * credential file. The quota recorder runs on every statusline render,
 * which is every turn of an active session.
 */
export function readLiveAccountUuid(): string {
  return readLiveIdentity()?.accountUuid ?? "";
}

/**
 * Return the slug of the profile that matches the live credentials, or
 * null when none do. Match cascade:
 *   1. credentials hash (byte-identical = same snapshot)
 *   2. accountUuid (Anthropic per-account UUID; account-distinct)
 *   3. userID + email cross-check (legacy snapshots)
 *   4. email (oldest snapshots, pre-userID storage)
 *
 * Without the cascade, Claude CLI's background token refresh would
 * silently "unsave" the active profile because the hash diverges even
 * though the account is unchanged.
 */
export function getActiveProfileSlug(
  knownProfiles?: SavedProfile[],
): string | null {
  const live = readCredentials();
  if (!live) return null;
  const liveHash = live.hash;

  // Callers that already hold the profile list (parseAccountData lists
  // it for its payload anyway) pass it in — listProfiles is O(#profiles)
  // in stats + hashes and this function runs on every account parse.
  const profiles = knownProfiles ?? listProfiles();

  // Pass 1: exact hash match.
  for (const p of profiles) {
    if (p.credentialsHash === liveHash) return p.slug;
  }

  const liveIdentity = readLiveIdentity();
  if (!liveIdentity) return null;

  // Tie-break by freshest savedAt when more than one profile matches
  // the same identity. Without this, duplicate slots (legacy state
  // before dedupe landed, or an intentional double-save) would always
  // resolve to the alphabetically-first slug — rarely what the user
  // means in the switcher. Newest wins.
  const freshestFirst = (a: SavedProfile, b: SavedProfile): number => {
    const at = Date.parse(a.savedAt || "") || 0;
    const bt = Date.parse(b.savedAt || "") || 0;
    return bt - at;
  };

  // Stage 2: accountUuid match — primary identity. Account-distinct
  // and stable across token rotations, so this is the strongest
  // matcher we have once the byte-hash pass fails.
  if (liveIdentity.accountUuid) {
    const candidates = profiles
      .filter((p) => p.accountUuid && p.accountUuid === liveIdentity.accountUuid)
      .sort(freshestFirst);
    if (candidates[0]) return candidates[0].slug;
  }

  // Stage 3: userID + email cross-check for legacy snapshots that
  // predate accountUuid storage. The `userID` field in `.claude.json`
  // is device-stable (same value across accounts on one machine), so
  // matching on it alone would collide accounts; the email cross-
  // check disambiguates.
  if (liveIdentity.userID) {
    const emailLower = liveIdentity.email.toLowerCase();
    const candidates = profiles
      .filter((p) => {
        if (!p.userID || p.userID !== liveIdentity.userID) return false;
        if (p.accountUuid) return false; // would already have matched at stage 2
        if (!p.email || !emailLower) return true;
        return p.email.toLowerCase() === emailLower;
      })
      .sort(freshestFirst);
    if (candidates[0]) return candidates[0].slug;
  }

  // Stage 4: email-only match (snapshots saved before any id storage,
  // or whose stored ids got corrupted by the pre-fix /login race).
  if (liveIdentity.email) {
    const emailLower = liveIdentity.email.toLowerCase();
    const candidates = profiles
      .filter((p) => p.email && p.email.toLowerCase() === emailLower)
      .sort(freshestFirst);
    if (candidates[0]) return candidates[0].slug;
  }

  return null;
}

/** Error codes returned from write operations. Keeps UI text stable. */
export type ProfileError =
  | "no-active-account"
  | "slug-exists"
  | "slot-missing"
  | "copy-failed"
  | "unreadable-source"
  | "already-saved"
  | "account-mismatch"
  | "identity-unverified"
  | "stale-confirmation"
  | "recovery-required";

export type ProfileResult<T> = { ok: true; data: T } | { ok: false; error: ProfileError; detail?: string };

/**
 * Snapshot the current `~/.claude.json` + `~/.claude/.credentials.json`
 * into a new slot. Fails when no active account exists (either file
 * missing / empty), when the slug collides with an existing slot, or
 * when a slot already exists for the live userID (prevents duplicate
 * accretion after Bug 1's hash-only active detection mis-fired).
 */
export function saveProfile(label: string): ProfileResult<SavedProfile> {
  return withProfileLocks(() => saveProfileUnlocked(label));
}
function saveProfileUnlocked(label: string): ProfileResult<SavedProfile> {
  if (hasPendingSwitch()) return pendingRecovery();
  const trimmed = label.trim();
  if (!trimmed) {
    return { ok: false, error: "copy-failed", detail: "Label is empty" };
  }

  const pair = readLivePairRaceSafe();
  if (!pair) {
    return { ok: false, error: "no-active-account" };
  }
  const { claudeJsonRaw, credsRaw } = pair;

  // Identity for dedupe + storage. Token claims authoritative for the
  // current credentials; .claude.json fills in fields the token omits
  // (most importantly accountUuid, which opaque Anthropic tokens
  // don't expose). Merge so we get the broadest possible identity.
  const tokenIdentity = extractIdentityFromToken(credsRaw);
  const jsonIdentity = extractIdentity(claudeJsonRaw);
  const identity: LiveIdentity = {
    accountUuid: tokenIdentity?.accountUuid || jsonIdentity.accountUuid,
    userID: tokenIdentity?.userID || jsonIdentity.userID,
    email: tokenIdentity?.email || jsonIdentity.email,
  };

  if (identity.accountUuid || identity.userID || identity.email) {
    const existing = listProfiles().find((p) => {
      if (identity.accountUuid && p.accountUuid && identity.accountUuid === p.accountUuid) {
        return true;
      }
      if (identity.userID && p.userID && identity.userID === p.userID) {
        // userID is device-stable, NOT account-distinct — matching on
        // it alone collides distinct accounts on the same machine.
        // Cross-check email so this only fires for the same account.
        if (identity.email && p.email) {
          return p.email.toLowerCase() === identity.email.toLowerCase();
        }
        return false;
      }
      if (identity.email && p.email) {
        return p.email.toLowerCase() === identity.email.toLowerCase();
      }
      return false;
    });
    if (existing) {
      return {
        ok: false,
        error: "already-saved",
        detail: existing.slug,
      };
    }
  }

  // Generate a unique slug: slugify + suffix if collision.
  fs.mkdirSync(getProfileDirectory(), { recursive: true, mode: 0o700 });
  const base = slugify(trimmed);
  let slug = base;
  let attempt = 2;
  while (fs.existsSync(slotDirectory(slug))) {
    slug = `${base}-${attempt++}`;
    if (attempt > 99) {
      return { ok: false, error: "slug-exists", detail: base };
    }
  }

  const slotDir = slotDirectory(slug);
  try {
    // Exclusive allocation avoids another window reusing this slot between exists/mkdir.
    fs.mkdirSync(slotDir, { mode: 0o700 });
    writeAccountSnapshot(slotDir, { version: 2, claudeJsonRaw, credsRaw, label: trimmed, savedAt: new Date().toISOString() });
  } catch (err) {
    return {
      ok: false,
      error: "copy-failed",
      detail: "The account operation could not complete. Check storage access and sign in again if necessary.",
    };
  }

  // Re-derive the full SavedProfile so the returned object matches
  // what listProfiles would produce on the next load.
  const meta = readSnapshotMeta(slotDir);
  return {
    ok: true,
    data: {
      slug,
      label: meta.label ?? trimmed,
      email: meta.email ?? identity.email,
      organizationName: meta.organizationName ?? "",
      subscriptionType: meta.subscriptionType ?? "",
      savedAt: meta.savedAt ?? new Date().toISOString(),
      tokenExpiresAt: meta.tokenExpiresAt ?? 0,
      credentialsHash: hashFile(path.join(slotDir, ".credentials.json")),
      userID: meta.userID ?? identity.userID,
      accountUuid: meta.accountUuid ?? identity.accountUuid,
    },
  };
}

/** A user confirmation is bound to the exact live pair AND saved generation. */
export interface ProfileUpdateApproval {
  slug: string;
  liveHash: string;
  configHash: string;
  savedHash: string;
}
function pendingRecovery(): ProfileResult<never> {
  return { ok: false, error: "recovery-required", detail: "An interrupted account switch needs recovery. Stop Claude sessions and retry switching or reload VS Code." };
}
function sameIdentity(a: LiveIdentity, b: LiveIdentity): boolean {
  if (a.accountUuid || b.accountUuid) return !!a.accountUuid && a.accountUuid === b.accountUuid;
  return !!a.email && !!b.email && a.email.toLowerCase() === b.email.toLowerCase();
}
/** Equal access/refresh tokens establish continuity. Two new opaque tokens do not. */
function sameTokenLineage(a: string, b: string): boolean {
  try {
    const left = JSON.parse(a).claudeAiOauth;
    const right = JSON.parse(b).claudeAiOauth;
    return ["accessToken", "refreshToken"].some((name) => typeof left?.[name] === "string" && left[name].length > 0 && left[name] === right?.[name]);
  } catch { return false; }
}
function approvalFor(slug: string, pair: { claudeJsonRaw: string; credsRaw: string }, saved: AccountSnapshot): ProfileUpdateApproval {
  return { slug, liveHash: hashCredentials(pair.credsRaw), configHash: hashCredentials(pair.claudeJsonRaw), savedHash: hashCredentials(JSON.stringify(saved)) };
}
function sameApproval(a: ProfileUpdateApproval, b: ProfileUpdateApproval): boolean {
  return a.slug === b.slug && a.liveHash === b.liveHash && a.configHash === b.configHash && a.savedHash === b.savedHash;
}
export function captureProfileUpdate(slug: string): ProfileResult<ProfileUpdateApproval> {
  if (hasPendingSwitch()) return pendingRecovery();
  const pair = readLivePairRaceSafe();
  if (!pair) return { ok: false, error: "no-active-account" };
  try {
    const saved = readAccountSnapshot(slotDirectory(slug));
    if (!sameIdentity(extractIdentity(saved.claudeJsonRaw), extractIdentity(pair.claudeJsonRaw))) {
      return { ok: false, error: "account-mismatch", detail: "The current account no longer matches this saved profile. Reopen the account picker." };
    }
    return { ok: true, data: approvalFor(slug, pair, saved) };
  } catch { return { ok: false, error: "unreadable-source", detail: "The saved account could not be read." }; }
}

/** Refresh only the same account. Ambiguous full token replacement requires explicit approval. */
export function updateProfile(slug: string, approval?: ProfileUpdateApproval): ProfileResult<SavedProfile> {
  return withProfileLocks(() => updateProfileUnlocked(slug, approval));
}
function updateProfileUnlocked(slug: string, approval?: ProfileUpdateApproval): ProfileResult<SavedProfile> {
  if (hasPendingSwitch()) return pendingRecovery();
  const slotDir = slotDirectory(slug);
  if (!fs.existsSync(slotDir)) return { ok: false, error: "slot-missing", detail: slug };
  const pair = readLivePairRaceSafe();
  if (!pair) return { ok: false, error: "no-active-account" };
  try {
    const saved = readAccountSnapshot(slotDir);
    const identity = extractIdentity(pair.claudeJsonRaw);
    if (!sameIdentity(extractIdentity(saved.claudeJsonRaw), identity)) {
      return { ok: false, error: "account-mismatch", detail: "The current account no longer matches this saved profile. Reopen the account picker." };
    }
    if (approval && !sameApproval(approval, approvalFor(slug, pair, saved))) {
      return { ok: false, error: "stale-confirmation", detail: "The account changed while confirmation was open. Nothing was saved; retry after login finishes." };
    }
    if (!approval && !sameTokenLineage(saved.credsRaw, pair.credsRaw)) {
      return { ok: false, error: "identity-unverified", detail: "Both login tokens changed. Confirm the account before replacing its saved login." };
    }
    const next: AccountSnapshot = { version: 2, claudeJsonRaw: pair.claudeJsonRaw, credsRaw: pair.credsRaw, label: saved.label, savedAt: new Date().toISOString() };
    const meta = snapshotMeta(next);
    writeAccountSnapshot(slotDir, next);
    return { ok: true, data: { slug, label: saved.label, savedAt: meta.savedAt ?? "", ...identity,
      organizationName: meta.organizationName ?? "", subscriptionType: meta.subscriptionType ?? "", tokenExpiresAt: meta.tokenExpiresAt ?? 0,
      credentialsHash: hashCredentials(pair.credsRaw) } };
  } catch {
    return { ok: false, error: "copy-failed", detail: "The account snapshot could not be updated. Its previous committed snapshot was kept." };
  }
}

/**
 * Best-effort watcher sync. Unknown token lineage is left untouched;
 * a manual update/switch can request confirmation for a full rotation.
 */
export function syncActiveProfile(): string | null {
  if (hasPendingSwitch()) return null;
  const slug = getActiveProfileSlug();
  if (!slug) return null;
  // Skip when already byte-identical: avoids spurious mtime bumps and
  // a self-triggering loop if the caller is running from a watcher.
  const slotCreds = path.join(slotDirectory(slug), ".credentials.json");
  const live = readCredentials();
  if (live && hashFile(slotCreds) === live.hash) return slug;
  const result = updateProfile(slug);
  return result.ok ? slug : null;
}

/**
 * Activate the named profile. Identity keys (`oauthAccount`, `userID`)
 * are merged into the live `.claude.json`; every other key (projects,
 * numStartups, migration flags, caches, onboarding state, MCP config,
 * …) is preserved so switching doesn't roll back weeks of accumulated
 * state. Credentials are swapped wholesale because the blob is an
 * identity-only payload.
 *
 * An encrypted recovery journal is committed before live files change.
 * Failed rollback preserves that journal and the config backup. Activation
 * and subsequent switches recover a known interrupted state under the same
 * locks, but never overwrite a different login created after interruption.
 *
 * Caller is responsible for user confirmation and for warning about
 * running Claude processes. This function does not itself prompt.
 */
export function switchProfile(slug: string, approval?: ProfileUpdateApproval): ProfileResult<SavedProfile> {
  // Personal fork: serialize swaps with Claude's refresh/config writers.
  return withProfileLocks(() => switchProfileUnlocked(slug, approval));
}
function withProfileLocks<T>(work: () => ProfileResult<T>): ProfileResult<T> {
  const result = withLocks([...CREDENTIAL_LOCKS, CONFIG_LOCK], work);
  return result.ok ? result.value : { ok: false, error: "copy-failed", detail: describeLockFailure(result.failure) };
}

function switchProfileUnlocked(slug: string, approval?: ProfileUpdateApproval): ProfileResult<SavedProfile> {
  const recovery = recoverPendingSwitchUnlocked();
  if (!recovery.ok) return recovery;
  if (approval) {
    const current = captureProfileUpdate(approval.slug);
    if (!current.ok || !sameApproval(approval, current.data)) return { ok: false, error: "stale-confirmation", detail: "The account changed while confirmation was open. Reopen the account picker." };
  }
  const slotDir = slotDirectory(slug);
  const slotClaudeJson = path.join(slotDir, ".claude.json");
  const slotCreds = path.join(slotDir, ".credentials.json");

  if (!fs.existsSync(path.join(slotDir, SNAPSHOT_FILE)) && (!fs.existsSync(slotClaudeJson) || !fs.existsSync(slotCreds))) {
    return { ok: false, error: "slot-missing", detail: slug };
  }

  // Capture the outgoing account's freshest tokens into its slot
  // before we replace the live identity. Without this, any rotation
  // that happened while the outgoing account was active stays only
  // in the live credentials — the slot keeps the original (now
  // server-revoked) refresh token, and switching back to it later
  // produces a 401. Abort the switch if the outgoing snapshot cannot be saved.
  try {
    const activeSlug = getActiveProfileSlug();
    if (activeSlug === slug) return updateProfileUnlocked(slug, approval);
    if (activeSlug) {
      const saved = updateProfileUnlocked(activeSlug, approval);
      if (!saved.ok) return saved;
    }
  } catch {
    return { ok: false, error: "copy-failed", detail: "The current account could not be saved. No account switch was made." };
  }

  let mergedClaudeJson: string;
  let credsRaw: string;
  try {
    const snapshot = readAccountSnapshot(slotDir);
    const snapClaudeRaw = snapshot.claudeJsonRaw;
    credsRaw = snapshot.credsRaw;
    const snap = JSON.parse(snapClaudeRaw) as Record<string, unknown>;
    JSON.parse(credsRaw); // validate only

    // Read live as a plain object (tolerate empty / corrupt by starting
    // from the snapshot's non-identity keys — i.e. treat snapshot as
    // the whole file when live is unusable). In the common case, live
    // parses fine and we preserve everything except the two identity
    // keys.
    let live: Record<string, unknown> = {};
    try {
      const liveRaw = fs.readFileSync(CLAUDE_JSON, "utf-8");
      if (liveRaw.trim()) live = JSON.parse(liveRaw) as Record<string, unknown>;
    } catch {
      // empty/corrupt — fall back to snapshot verbatim below
    }

    const merged: Record<string, unknown> =
      Object.keys(live).length > 0 ? { ...live } : { ...snap };
    // Swap identity keys only. These are the ONLY two top-level keys
    // that encode which account the CLI thinks it's running as.
    //
    // The `oauthAccount` + `userID` pair must stay consistent after
    // the swap: if we set oauthAccount from the snapshot but leave
    // userID from the live account, the CLI sees a mismatched pair
    // until its next launch rewrites userID from the token. To avoid
    // that transient inconsistency, we:
    //   - always swap oauthAccount when the snapshot has one
    //   - drop the live userID whenever we've swapped oauthAccount
    //     without a matching snapshot userID (rare: very old
    //     snapshots predate userID storage). CLI repopulates userID
    //     on next launch, so "unset" is a cleaner momentary state
    //     than "belongs to the previous account".
    if (snap.oauthAccount !== undefined) {
      merged.oauthAccount = snap.oauthAccount;
      if (snap.userID !== undefined) {
        merged.userID = snap.userID;
      } else {
        delete merged.userID;
      }
    } else if (snap.userID !== undefined) {
      // Snapshot has no oauthAccount but does have a userID —
      // exotic shape, but swap userID anyway for consistency.
      merged.userID = snap.userID;
    }
    mergedClaudeJson = JSON.stringify(merged, null, 2);
  } catch (err) {
    return {
      ok: false,
      error: "unreadable-source",
      detail: "The account operation could not complete. Check storage access and sign in again if necessary.",
    };
  }

  const written = writeLiveAccount(mergedClaudeJson, credsRaw);
  if (!written.ok) return written;

  const meta = readSnapshotMeta(slotDir);
  const liveAfter = readCredentials();
  return {
    ok: true,
    data: {
      slug,
      label: meta.label ?? slug,
      email: meta.email ?? "",
      organizationName: meta.organizationName ?? "",
      subscriptionType: meta.subscriptionType ?? "",
      savedAt: meta.savedAt ?? "",
      tokenExpiresAt: meta.tokenExpiresAt ?? 0,
      credentialsHash: liveAfter
        ? liveAfter.hash
        : hashCredentials(credsRaw),
      userID: meta.userID ?? "",
      accountUuid: meta.accountUuid ?? "",
    },
  };
}

/**
 * Permanently delete a profile slot. Returns ok even when the slot
 * doesn't exist — caller just wants the end state ("gone"), and a
 * spurious error would confuse the delete-retry UX.
 */
export function removeProfile(slug: string): ProfileResult<null> {
  return withProfileLocks(() => removeProfileUnlocked(slug));
}
function removeProfileUnlocked(slug: string): ProfileResult<null> {
  const slotDir = slotDirectory(slug);
  try {
    fs.rmSync(slotDir, { recursive: true, force: true });
    return { ok: true, data: null };
  } catch (err) {
    return {
      ok: false,
      error: "copy-failed",
      detail: "The account operation could not complete. Check storage access and sign in again if necessary.",
    };
  }
}
