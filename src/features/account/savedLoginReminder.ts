/** Snapshot age is a reminder only, never proof of token expiration. */
export function savedLoginReminder(savedAt: string, isActive: boolean, now: number): string {
  const saved = Date.parse(savedAt);
  if (isActive || !Number.isFinite(saved) || !Number.isFinite(now) || now - saved < 6 * 3_600_000) return "";
  return "Review saved login (6h+)";
}

/** Display snapshot time in this machine's locale/time zone, plus its age. */
export function formatSavedLoginTime(savedAt: string, now: number): string {
  const saved = Date.parse(savedAt);
  if (!Number.isFinite(saved)) return "Last saved: unknown";
  const timestamp = new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(saved));
  const elapsed = now - saved;
  let age: string;
  if (!Number.isFinite(elapsed)) age = "age unknown";
  else if (elapsed < 0) age = "timestamp is ahead of this computer's clock";
  else if (elapsed < 60_000) age = "just now";
  else {
    const minutes = Math.floor(elapsed / 60_000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    age = days ? days + "d " + hours % 24 + "h ago"
      : hours ? hours + "h " + minutes % 60 + "m ago"
      : minutes + "m ago";
  }
  return "Last saved: " + timestamp + " (" + age + ")";
}
