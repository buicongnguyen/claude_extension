/** Fixed at activation; switching workload modes requires a window reload. */
let accountFocused = false;
export function setAccountFocusedMode(enabled: boolean): void { accountFocused = enabled; }
export function isAccountFocusedMode(): boolean { return accountFocused; }
