// The signed-in user, resolved once by the root layout via GET /auth/me.
import type { User } from '$lib/api/types';
import { DEFAULT_LOCALE } from '@water-management/engine/languages';

export const session = $state<{ user: User | null; checked: boolean }>({ user: null, checked: false });

/** Sign-in pages: reachable signed out, and a signed-in user is sent on to the app. */
export const GUEST_PATHS = ['/login', '/register', '/forgot-password'];

/**
 * Emailed-link pages: reachable either way. Someone who is signed in (maybe as
 * another account, maybe on another device) must still be able to use a reset
 * or confirmation link instead of being bounced to the project list. A
 * share link (/share, WP-2.3) is the same: its token is the credential, and so
 * is an alert email's unsubscribe link (/alerts/unsubscribe, WP-2.13) and its
 * "Was this useful?" link (/alerts/feedback, 151_alert_feedback). An
 * evidence pack's verify page (/verify/<code>, WP-3.14) answers anyone holding
 * the code printed on the pack, signed in or not. The links of a reset of a
 * lost second factor (/mfa-reset, /mfa-reset/cancel, 205_mfa_recovery) are
 * opened signed out, by someone who can't sign in.
 */
export const OPEN_PATHS = ['/reset-password', '/verify-email', '/mfa-reset', '/share', '/alerts/unsubscribe', '/alerts/feedback', '/verify'];

/**
 * The public landing page's own address (issue #57): prerendered static HTML
 * for crawlers and link previews, reachable either way. A signed-out visitor
 * to `/` sees the same page there (isLandingRoot); a signed-in one, the projects.
 */
export const LANDING_PATH = '/welcome';

/**
 * The landing page in one language (issue #137): `/welcome` in English (the
 * default), `/welcome/<code>` in every other language of the table, each
 * prerendered with its own `<html lang>` (routes/welcome/[[lang=locale]],
 * the `locale` param matcher, hooks.server.ts).
 */
export const landingPath = (locale: string): string => (locale === DEFAULT_LOCALE ? LANDING_PATH : `${LANDING_PATH}/${locale}`);

/** The landing page's route id: one route, the language an optional parameter. */
export const LANDING_ROUTE = '/welcome/[[lang=locale]]';

/**
 * The prerendered static pages: the landing page, the legal pages
 * (/privacy, /terms), the methods page (/methods, the engine audit's
 * public summary) and the data sources' credits (/data-sources). Reachable either way, rendered at once (their HTML is
 * written at build time), and served from their .html by CloudFront.
 */
export const STATIC_PATHS = [LANDING_PATH, '/privacy', '/terms', '/methods', '/data-sources'];

/** The same pages by route id (the root layout matches by route: while prerendering, `base` is relative). */
export const STATIC_ROUTES = [LANDING_ROUTE, '/privacy', '/terms', '/methods', '/data-sources'];

/** Routes reachable without signing in. */
export const PUBLIC_PATHS = [...GUEST_PATHS, ...OPEN_PATHS, ...STATIC_PATHS];

function strip(pathname: string, base: string): string {
	return pathname.startsWith(base) ? pathname.slice(base.length) || '/' : pathname;
}
const matches = (list: string[], p: string) => list.some((x) => p === x || p.startsWith(`${x}/`));

export function isPublicPath(pathname: string, base = ''): boolean {
	return matches(PUBLIC_PATHS, strip(pathname, base));
}

/** `/` for a signed-out visitor: the landing page instead of a sign-in redirect. */
export function isLandingRoot(pathname: string, base: string, signedIn: boolean): boolean {
	return !signedIn && strip(pathname, base) === '/';
}

export function isGuestPath(pathname: string, base = ''): boolean {
	return matches(GUEST_PATHS, strip(pathname, base));
}

/**
 * What the root layout's guard does with a route: render it, send a
 * signed-out visitor to /login, or move a signed-in user off a sign-in page.
 * A signed-out `/` shows the landing page (the root layout renders it there).
 * An emailed invitation (/register?invite=…) stays open to a signed-in user:
 * the page explains whose invitation it is instead of silently sending them on.
 */
export function routeAccess(
	pathname: string,
	base: string,
	signedIn: boolean,
	search?: URLSearchParams
): 'show' | 'login' | 'leave' {
	if (!signedIn) return isPublicPath(pathname, base) || isLandingRoot(pathname, base, false) ? 'show' : 'login';
	if (strip(pathname, base) === '/register' && search?.has('invite')) return 'show';
	return isGuestPath(pathname, base) ? 'leave' : 'show';
}

/**
 * The terms re-acceptance step (docs/legal-status.md) in place of an app
 * page: signed in, the terms changed since the account accepted them (or it
 * accepted none), and not a public page. Never for the report renderer's
 * session (`renderSession` on /auth/me, reports/scope.ts): it can read one
 * report and accept nothing, so the step would stand where the report should
 * be and every PDF of an account that hasn't re-accepted would time out.
 */
export function termsGateApplies(user: Pick<User, 'termsCurrent' | 'renderSession'> | null, pathname: string, base = ''): boolean {
	return user?.termsCurrent === false && !user.renderSession && !isPublicPath(pathname, base);
}
