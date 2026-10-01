/** Claude CLI MCP names are safe shell words, not arbitrary display labels. */
export const MCP_CLI_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
export const MCP_NAME_ERROR =
  "Server names must use letters, numbers, hyphens, or underscores and cannot start with a hyphen.";
export function isMcpCliName(value: string): boolean {
  return MCP_CLI_NAME_RE.test(value) && value.trim() === value;
}
