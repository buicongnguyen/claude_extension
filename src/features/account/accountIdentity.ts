/** Local consistency only: this does not authenticate the account with Claude. */
export function savedIdentityConflicts(
  live: { accountUuid: string; email: string },
  saved: { accountUuid: string; email: string; credentialsHash: string } | undefined,
  liveCredentialsHash: string | undefined,
): boolean {
  if (!saved || !liveCredentialsHash || saved.credentialsHash !== liveCredentialsHash) return false;
  // UUID remains stable when someone changes their email address.
  if (live.accountUuid && saved.accountUuid) return live.accountUuid !== saved.accountUuid;
  return !!live.email && !!saved.email && live.email.toLowerCase() !== saved.email.toLowerCase();
}
