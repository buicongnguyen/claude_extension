/** Explicit account binding for opaque tokens whose lineage cannot be established locally. */
import * as vscode from "vscode";
import { captureProfileUpdate, getActiveProfileSlug, listProfiles, updateProfile, switchProfile, type ProfileResult, type SavedProfile, type ProfileUpdateApproval } from "../account/profiles";

async function runWithConfirmation(
  action: (approval?: ProfileUpdateApproval) => ProfileResult<SavedProfile>,
  account: () => string | null,
): Promise<ProfileResult<SavedProfile>> {
  const result = action();
  if (result.ok || result.error !== "identity-unverified") return result;
  const slug = account();
  if (!slug) return result;
  const captured = captureProfileUpdate(slug);
  if (!captured.ok) return captured;
  const profile = listProfiles().find((item) => item.slug === slug);
  const choice = await vscode.window.showWarningMessage(
    `Save the changed login as ${profile?.email || profile?.label || slug}?`,
    { modal: true, detail: "Both login tokens changed, so Manager cannot tell whether Claude refreshed this account or you signed into another one. The displayed account name comes from local files and may be stale. Finish any login in progress. Continue only if you know this is the same account you saved here; otherwise cancel and save the new account separately." },
    "Confirm same account",
  );
  if (choice !== "Confirm same account") return { ok: false, error: "identity-unverified", detail: "Cancelled. The saved account was not changed." };
  return action(captured.data);
}

export function updateProfileWithConfirmation(slug: string): Promise<ProfileResult<SavedProfile>> {
  return runWithConfirmation((approval) => updateProfile(slug, approval), () => slug);
}
export function switchProfileWithConfirmation(slug: string): Promise<ProfileResult<SavedProfile>> {
  return runWithConfirmation((approval) => switchProfile(slug, approval), () => getActiveProfileSlug());
}
