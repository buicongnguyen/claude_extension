/** Snapshot age is a reminder only, never proof of token expiration. */
export function savedLoginReminder(savedAt: string, isActive: boolean, now: number): string {
  const saved = Date.parse(savedAt);
  if (isActive || !Number.isFinite(saved) || !Number.isFinite(now) || now - saved < 6 * 3_600_000) return "";
  return "Review saved login (6h+)";
}
