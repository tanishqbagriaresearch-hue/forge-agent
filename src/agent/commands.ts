/** Shell metacharacters that could chain, substitute or redirect: such commands always need a human. */
const UNSAFE = /[;&|`$<>()\n\r]/;

/** True only for a single plain command that matches an auto-approve pattern. */
export function isSafeAutoApprove(cmd: string, allow: RegExp[]): boolean {
  if (UNSAFE.test(cmd)) return false;
  return allow.some((re) => re.test(cmd));
}
