// The signed-in user, resolved once by the root layout via GET /auth/me.
import type { User } from '$lib/api/types';

export const session = $state<{ user: User | null; checked: boolean }>({ user: null, checked: false });

/** Routes reachable without signing in. */
export const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password'];

export function isPublicPath(pathname: string, base = ''): boolean {
	const p = pathname.startsWith(base) ? pathname.slice(base.length) || '/' : pathname;
	return PUBLIC_PATHS.some((x) => p === x || p.startsWith(`${x}/`));
}
