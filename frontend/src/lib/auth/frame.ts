// Which page frame a signed-in person gets (docs/ui.md § App shell). A user
// whose every membership is `farmer` has no workspace: their home is the
// farmer view (/farm, FarmShell), so their account pages sit in that frame
// too, translated, rather than in the workspace's English sidebar.
import type { Role } from '$lib/api/types';

/** Every membership is `farmer` (and there is at least one). */
export function isFarmerOnly(roles: readonly Role[]): boolean {
	return roles.length > 0 && roles.every((r) => r === 'farmer');
}

/** /account and the pages under it (the alert emails page). */
export function isAccountPath(pathname: string, base = ''): boolean {
	const p = pathname.startsWith(base) ? pathname.slice(base.length) || '/' : pathname;
	return p === '/account' || p.startsWith('/account/');
}
