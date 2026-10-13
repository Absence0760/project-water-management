// Which page frame a signed-in person gets (docs/ui.md § App shell). A user
// whose every membership is `farmer` has no workspace: their home is the
// farmer view (/farm, FarmShell), so their account pages sit in that frame
// too, translated, rather than in the workspace's English sidebar.
import { getContext, setContext } from 'svelte';
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

const FARM_FRAME = Symbol('farm-frame');

/** The root layout: whether the page sits in the farm view's frame (a farmer-only user's account pages). */
export function provideFarmFrame(inFarmFrame: () => boolean): void {
	setContext(FARM_FRAME, inFarmFrame);
}

/**
 * Read in a component's set-up; the result says, when called (reactively),
 * whether the page sits in the farm frame. Outside the root layout, never.
 */
export function farmFrameReader(): () => boolean {
	return getContext<(() => boolean) | undefined>(FARM_FRAME) ?? (() => false);
}
