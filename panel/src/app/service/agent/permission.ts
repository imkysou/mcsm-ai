import type { PermissionRule } from "./types";

/**
 * opencode-style permission evaluation:
 * tools map to permission keys and ask for a resource pattern.
 * Rules are last-match-wins with wildcards; default action is "ask".
 */
export { PermissionRule };

export function wildcardMatch(pattern: string, value: string): boolean {
  const p = String(pattern || '').toLowerCase();
  const v = String(value || '').toLowerCase();
  let pi = 0;
  let vi = 0;
  let star = -1;
  let match = 0;
  while (vi < v.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === v[vi])) { pi++; vi++; }
    else if (pi < p.length && p[pi] === '*') { star = pi; match = vi; pi++; }
    else if (star !== -1) { pi = star + 1; match++; vi = match; }
    else return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

export function evaluatePermission(
  rules: PermissionRule[] | undefined,
  permission: string,
  pattern: string
): 'allow' | 'ask' | 'deny' {
  const list = rules || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const rule = list[i];
    if (wildcardMatch(rule.permission, permission) && wildcardMatch(rule.pattern, pattern)) {
      return rule.action;
    }
  }
  return 'ask';
}
