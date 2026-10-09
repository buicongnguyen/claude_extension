// Modified for the personal fork, September 2026. See NOTICE.
/**
 * Native QuickPick account switcher.
 *
 * Surfaced both from the webview (`openAccountSwitcher` message) and the
 * command palette (`claudeManager.switchAccount`). Extracted from the view
 * provider so the ~250-line QuickPick wiring doesn't bloat the coordinator.
 */
import * as vscode from "vscode";
import { auditAccountEvent, safeAccountErrorCode, withAccountAudit, type AccountAuditStage, type AccountAuditCode } from "../account/accountAudit";
import type { PanelSink } from "../../extension/panelSink";
import { postAccountData } from "./accountPush";
import { promptToSaveProfile } from "./accountHandlers";
import { parseAccountData } from "../account/parser";
import {
  removeProfile as removeProfileSnapshot,
} from "../account/profiles";
import { updateProfileWithConfirmation as updateProfileSnapshot, switchProfileWithConfirmation as switchProfileSnapshot } from "./profileActions";
import type { SavedProfile } from "../account/profiles";
import { describeProfileQuota } from "../account/profileQuota";
import { getWorkspace } from "../../extension/workspace";
import { launchClaudeWithInput, createTerminal } from "../../extension/terminal";
import { buildSwitchConfirmDetail } from "./hostContext";
import type { WebviewMessage } from "./types";

/** How a profile row reads: the dim text beside the name, and the line under it. */
export interface ProfileRowText {
  description: string;
  detail: string;
}

/**
 * Text for one account row.
 *
 * The description carries what decides the click: whether this is where
 * you already are, and how much of the account's week is gone. That
 * second part is the reason the switcher is worth opening — the live
 * quota card can only ever describe the account you are signed into, so
 * without a remembered figure per account the switcher asks you to pick
 * blind and find out afterwards. It is dated, never bare, because these
 * readings are as old as each account's last session (see
 * ../account/quotaHistory).
 */
export function profileRowText(
  profile: SavedProfile & { lastQuota?: Parameters<typeof describeProfileQuota>[0] },
  flags: { isActive: boolean; isDuplicate: boolean },
  now: number = Date.now(),
): ProfileRowText {
  const status = flags.isActive ? "Active" : flags.isDuplicate ? "Duplicate" : "";
  const quota = describeProfileQuota(profile.lastQuota ?? null, now);
  const meta: string[] = [];
  if (profile.email) meta.push(profile.email);
  if (profile.subscriptionType) meta.push(profile.subscriptionType);
  if (profile.organizationName) meta.push(profile.organizationName);
  if (flags.isDuplicate) meta.push("duplicate — remove if unused");
  return {
    description: [status, quota].filter(Boolean).join(" · "),
    // Every row keeps a `detail` so native row heights match.
    detail: meta.join(" · ") || "Saved profile",
  };
}

/** Minimal context the switcher needs from the view provider. */
export interface AccountSwitcherContext {
  getWebview(): PanelSink | undefined;
  globalState?: vscode.Memento;
  /** Re-entrant dispatch for the save-profile flow. */
  dispatch(msg: WebviewMessage): Promise<void>;
}

/**
 * Show the account switcher QuickPick. Lets the user switch to a saved
 * profile, save the current account, or log in as a new one — with
 * modal confirmation before any destructive credential overwrite.
 */
export async function openAccountSwitcher(ctx: AccountSwitcherContext): Promise<void> {
  const workspace = getWorkspace();
  const current = parseAccountData(workspace || undefined);
  // Overlay the active profile's displayed email with the live profile
  // email when it diverges — users who changed their email on claude.ai
  // after saving would otherwise see the snapshot's stale value.
  const savedProfiles = current.savedProfiles.map((p) => {
    if (
      p.slug === current.activeProfileSlug &&
      current.profile.email &&
      current.profile.email !== p.email
    ) {
      return { ...p, email: current.profile.email };
    }
    return p;
  });
  const activeSlug = current.activeProfileSlug;

  const UPDATE_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("sync"),
    tooltip: "Update snapshot with current credentials",
  };
  const REMOVE_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("trash"),
    tooltip: "Delete saved profile",
  };

  type Item = vscode.QuickPickItem & {
    action: "switch" | "save" | "login" | "unreadable";
    slug?: string;
  };

  // Active profile first — users see "where am I" without scanning.
  const sortedProfiles = [...savedProfiles].sort((a, b) => {
    if (a.slug === activeSlug) return -1;
    if (b.slug === activeSlug) return 1;
    return 0;
  });

  const CHECK_ICON = new vscode.ThemeIcon("check");
  const ACCOUNT_ICON = new vscode.ThemeIcon("account");
  const SAVE_ICON = new vscode.ThemeIcon("save");
  const LOGIN_ICON = new vscode.ThemeIcon("log-in");

  // Pre-scan: identify duplicate profiles so we can mark any row that
  // isn't the freshest saved slot for its identity. Grouping key prefers
  // `accountUuid`; legacy snapshots fall back to userID + email.
  const identityGroups = new Map<string, SavedProfile[]>();
  for (const p of savedProfiles) {
    let key: string;
    if (p.accountUuid) {
      key = `uuid:${p.accountUuid}`;
    } else if (p.userID && p.email) {
      key = `${p.userID}|${p.email.toLowerCase()}`;
    } else {
      continue;
    }
    const bucket = identityGroups.get(key) ?? [];
    bucket.push(p);
    identityGroups.set(key, bucket);
  }
  const duplicateSlugs = new Set<string>();
  for (const group of identityGroups.values()) {
    if (group.length <= 1) continue;
    const ranked = [...group].sort((a, b) => {
      const at = Date.parse(a.savedAt || "") || 0;
      const bt = Date.parse(b.savedAt || "") || 0;
      return bt - at;
    });
    for (let i = 1; i < ranked.length; i++) duplicateSlugs.add(ranked[i].slug);
  }

  const items: Item[] = [];
  for (const p of sortedProfiles) {
    const isActive = p.slug === activeSlug;
    const isDuplicate = duplicateSlugs.has(p.slug);
    const { description, detail } = profileRowText(p, { isActive, isDuplicate });
    items.push({
      action: "switch",
      slug: p.slug,
      iconPath: isActive ? CHECK_ICON : ACCOUNT_ICON,
      label: p.label || p.email || p.slug,
      description,
      detail,
      buttons: isActive ? [UPDATE_BUTTON, REMOVE_BUTTON] : [REMOVE_BUTTON],
    });
  }

  for (const issue of current.profileStorageIssues ?? []) {
    items.push({ action: "unreadable", label: issue.slug || "Saved account storage", description: "Cannot read saved account", detail: issue.detail });
  }

  if (items.length > 0) {
    items.push({
      action: "save",
      label: "",
      kind: vscode.QuickPickItemKind.Separator,
    } as Item);
  }

  if (current.profile.signedIn && !activeSlug) {
    items.push({
      action: "save",
      iconPath: SAVE_ICON,
      label: "Save current account as profile",
      detail: "Snapshot current credentials so you can switch back later",
    });
  }
  items.push({
    action: "login",
    iconPath: LOGIN_ICON,
    label: "Log in as a new account",
    detail: "Opens Claude and offers /login to copy and paste",
  });

  const picker = vscode.window.createQuickPick<Item>();
  picker.title = "Switch Claude account";
  picker.placeholder = savedProfiles.length
    ? "Pick an account to switch to, or add a new one"
    : "No saved profiles yet — save the current account or log in a new one";
  picker.items = items;
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;

  const pushAccountUpdate = (): void => {
    const wv2 = ctx.getWebview();
    if (wv2) {
      // NB: do NOT clear the model cache here. The available-model list
      // is read from the CLI binary and is account-independent, so a
      // switch never changes it — clearing forced a full 236 MB re-scan
      // on every switch, blocking the host for the exact reparse the
      // user is waiting on. A genuine CLI upgrade is picked up by the
      // mtime-based revalidateModelCache on the watcher path instead.
      postAccountData(wv2, parseAccountData(workspace || undefined));
    }
  };

  picker.onDidTriggerItemButton(async (e) => {
    const slug = (e.item as Item).slug;
    if (!slug) return;
    if (e.button === UPDATE_BUTTON) {
      picker.hide();
      const result = await updateProfileSnapshot(slug);
      if (!result.ok) {
        vscode.window.showErrorMessage(
          `Couldn't update profile: ${result.detail ?? result.error}.`,
        );
      } else {
        vscode.window.showInformationMessage(`Profile "${result.data.label}" updated.`);
      }
      pushAccountUpdate();
    } else if (e.button === REMOVE_BUTTON) {
      picker.hide();
      const confirm = await vscode.window.showWarningMessage(
        "Delete saved profile?",
        {
          modal: true,
          detail:
            "The encrypted saved profile will be permanently removed from this extension's storage. The live Claude account isn't affected.",
        },
        "Delete",
      );
      if (confirm === "Delete") {
        removeProfileSnapshot(slug);
        pushAccountUpdate();
      }
    }
  });

  picker.onDidAccept(async () => {
    const pick = picker.selectedItems[0];
    if (!pick) { picker.hide(); picker.dispose(); return; }
    if (pick.action === "switch" && pick.slug) {
      const slug = pick.slug;
      // VS Code does not await QuickPick event callbacks. Keep the audit context
      // and every rejection handler inside this detached action.
      await withAccountAudit("switch", async () => {
        let stage: AccountAuditStage = "confirmation";
        let localOperationSucceeded = false;
        let outcomeRecorded = false;
        try {
          picker.hide();
          picker.dispose();
          const targetProfile = savedProfiles.find((p) => p.slug === slug);
          auditAccountEvent("confirmation_requested", { stage });
          const confirm = await vscode.window.showWarningMessage(
            "Switch Claude account?",
            { modal: true, detail: buildSwitchConfirmDetail(targetProfile) },
            "Switch",
          );
          if (confirm !== "Switch") {
            auditAccountEvent("operation_cancelled", { stage, reason: "user_cancelled" });
            return;
          }
          auditAccountEvent("confirmation_accepted", { stage });
          stage = "switch";
          let result = await switchProfileSnapshot(slug);
          if (!result.ok && result.error === "unsaved-active-account") {
            stage = "save_current";
            auditAccountEvent("confirmation_requested", { stage });
            const choice = await vscode.window.showWarningMessage(
              "Save the current account before switching?",
              { modal: true, detail: "This login has no saved profile. Save it first so you can switch back later. Cancelling leaves your current login in place." },
              "Save and switch",
            );
            if (choice !== "Save and switch") {
              auditAccountEvent("operation_cancelled", { stage, reason: "user_cancelled" });
              return;
            }
            auditAccountEvent("confirmation_accepted", { stage });
            auditAccountEvent("save_current_started", { stage });
            let saveFailure: AccountAuditCode | undefined;
            if (!await promptToSaveProfile(ctx, (code) => { saveFailure = safeAccountErrorCode(code); })) {
              if (saveFailure) {
                auditAccountEvent("save_current_failed", { stage, code: saveFailure });
                auditAccountEvent("operation_failed", { stage, code: saveFailure, reason: "save_not_completed" });
              } else {
                auditAccountEvent("operation_cancelled", { stage, reason: "save_not_completed" });
              }
              return;
            }
            auditAccountEvent("save_current_completed", { stage });
            // Retry the backend guard: another window may have changed the login.
            stage = "switch";
            result = await switchProfileSnapshot(slug);
          }
          if (!result.ok) {
            auditAccountEvent(result.cancelled ? "operation_cancelled" : "operation_failed", {
              stage, code: safeAccountErrorCode(result.error),
              ...(result.cancelled ? { reason: "user_cancelled" as const } : {}),
            });
            outcomeRecorded = true;
            if (!result.cancelled) {
              stage = "notification";
              const action = await vscode.window.showErrorMessage(
                "Switch failed: " + (result.detail ?? result.error) + ".", "Open switch log",
              );
              if (action === "Open switch log") {
                await vscode.commands.executeCommand("claudeManager.showAccountSwitchLog");
              }
            }
          } else {
            // Record local success before any UI await/reload. The backend records whether a live swap or same-account snapshot update occurred.
            // This is not a claim that Claude accepted the token remotely.
            localOperationSucceeded = true;
            outcomeRecorded = true;
            auditAccountEvent("operation_completed", { stage, reason: "local_operation_succeeded" });
            stage = "notification";
            const reload = await vscode.window.showInformationMessage(
              "Switched to " + (result.data.email || result.data.label) + ". " +
                "Restart Claude terminals and reload VS Code, then verify the account in Claude's /status.",
              "Reload window",
            );
            stage = "reload";
            if (reload === "Reload window") {
              auditAccountEvent("reload_requested", { stage, reason: "restart_required" });
              await vscode.commands.executeCommand("workbench.action.reloadWindow");
            } else {
              auditAccountEvent("reload_deferred", { stage, reason: "restart_required" });
            }
          }
          stage = "refresh_ui";
          pushAccountUpdate();
        } catch (error) {
          auditAccountEvent(outcomeRecorded ? (stage === "reload" ? "reload_failed" : "ui_failed") : "operation_failed", {
            stage, code: safeAccountErrorCode(error), reason: "unexpected_exception",
          });
          // Notification failure must not escape this detached callback either.
          try {
            await vscode.window.showErrorMessage(localOperationSucceeded
              ? "The local account operation succeeded, but refreshing VS Code failed. Restart Claude terminals and reload VS Code. See Claude Code Manager: Show Account Switch Log."
              : "The account action encountered an error. See Claude Code Manager: Show Account Switch Log for the saved steps.");
          } catch { /* The host may be shutting down; the audit was already saved. */ }
        }
      });
      return;
    }
    picker.hide();
    picker.dispose();
    if (pick.action === "unreadable") {
      void vscode.window.showErrorMessage(pick.detail || "Saved account could not be read. Its stored files were left untouched.");
    } else if (pick.action === "save") {
      await promptToSaveProfile(ctx);
    } else if (pick.action === "login") {
      // Re-read after the picker was open. Save any rotated outgoing tokens
      // before /login replaces them, using the same explicit lineage check.
      const loginCurrent = parseAccountData(workspace || undefined);
      const loginActiveSlug = loginCurrent.activeProfileSlug;
      if (loginActiveSlug) {
        const saved = await updateProfileSnapshot(loginActiveSlug);
        if (!saved.ok) {
          void vscode.window.showErrorMessage(`Login was not opened: ${saved.detail ?? saved.error}.`);
          return;
        }
      }
      // Claude CLI's /login overwrites ~/.claude.json + credentials in
      // place. If the live account isn't backed by a saved profile,
      // firing /login immediately replaces it — force a save-first
      // prompt so users don't discover this the hard way.
      if (loginCurrent.profile.signedIn && !loginActiveSlug) {
        const choice = await vscode.window.showWarningMessage(
          "Save the current account first?",
          {
            modal: true,
            detail: `Logging in as a new account will overwrite ~/.claude.json and ~/.claude/.credentials.json in place — your current account (${loginCurrent.profile.email || loginCurrent.profile.displayName || "signed-in account"}) will be replaced, not added. Save it as a profile first so you can switch back later.`,
          },
          "Save and log in",
          "Log in anyway",
        );
        if (choice === undefined) return;
        if (choice === "Save and log in") {
          // Reuse the same input-box + disclaimer flow as the Account
          // tab's save button. Wait for the snapshot to land before
          // firing /login so the overwrite happens against a safely-
          // backed-up state.
          if (!await promptToSaveProfile(ctx)) return;
          // Recheck account state after saving before opening a new login.
          const refreshed = parseAccountData(workspace || undefined);
          if (!refreshed.activeProfileSlug) return;
        }
        // choice === "Log in anyway" falls through to the login.
      }
      const term = createTerminal("login");
      void launchClaudeWithInput(term, "/login");
    }
  });

  picker.onDidHide(() => picker.dispose());
  picker.show();
}
