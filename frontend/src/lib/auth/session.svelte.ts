// The signed-in user, resolved once by the root layout via GET /auth/me.
import type { User } from '$lib/api/types';

export const session = $state<{ user: User | null; checked: boolean }>({ user: null, checked: false });

/** Sign-in pages: reachable signed out, and a signed-in user is sent on to the app. */
export const GUEST_PATHS = ['/login', '/register', '/forgot-password'];

/**
 * Emailed-link pages: reachable either way. Someone who is signed in (maybe as
 * another account, maybe on another device) must still be able to use a reset
 * or confirmation link instead of being bounced to the project list.
 */
export const OPEN_PATHS = ['/reset-password', '/verify-email'];

/** Routes reachable without signing in. */
export const PUBLIC_PATHS = [...GUEST_PATHS, ...OPEN_PATHS];

function strip(pathname: string, base: string): string {
	return pathname.startsWith(base) ? pathname.slice(base.length) || '/' : pathname;
}
const matches = (list: string[], p: string) => list.some((x) => p === x || p.startsWith(`${x}/`));

export function isPublicPath(pathname: string, base = ''): boolean {
	return matches(PUBLIC_PATHS, strip(pathname, base));
}

export function isGuestPath(pathname: string, base = ''): boolean {
	return matches(GUEST_PATHS, strip(pathname, base));
}

/**
 * What the root layout's guard does with a route: render it, send a
 * signed-out visitor to /login, or move a signed-in user off a sign-in page.
 */
export function routeAccess(pathname: string, base: string, signedIn: boolean): 'show' | 'login' | 'leave' {
	if (!signedIn) return isPublicPath(pathname, base) ? 'show' : 'login';
	return isGuestPath(pathname, base) ? 'leave' : 'show';
}
