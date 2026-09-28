import { describe, expect, it } from 'vitest';
import { safeNext } from './redirect';
import { isLandingRoot, isPublicPath, routeAccess } from './session.svelte';

describe('safeNext', () => {
	it('allows app-relative paths only', () => {
		expect(safeNext('/projects/1?tab=runs', '/')).toBe('/projects/1?tab=runs');
		expect(safeNext('//evil.example', '/')).toBe('/');
		expect(safeNext('https://evil.example', '/')).toBe('/');
		expect(safeNext(null, '/x')).toBe('/x');
	});

	it('refuses a path a browser reads as another host once it strips tabs and newlines, or as a script URL', () => {
		for (const hostile of ['/\t/evil.example', '/\n/evil.example', '/\r\n/evil.example/x', '/\\evil.example', 'javascript:alert(1)', ' /x', '\t//evil.example']) {
			expect(safeNext(hostile, '/home'), JSON.stringify(hostile)).toBe('/home');
		}
		// Positive control: an ordinary app path with a query and hash survives unchanged.
		expect(safeNext('/farm/p1?node=n%2F1#notice', '/home')).toBe('/farm/p1?node=n%2F1#notice');
	});
});

describe('isPublicPath', () => {
	it('recognises auth pages with and without a base path', () => {
		expect(isPublicPath('/login')).toBe(true);
		expect(isPublicPath('/app/register', '/app')).toBe(true);
		expect(isPublicPath('/projects/1')).toBe(false);
		expect(isPublicPath('/loginx')).toBe(false);
	});
});

describe('routeAccess', () => {
	it('sends signed-out visitors to login except on public pages', () => {
		expect(routeAccess('/projects/1', '', false)).toBe('login');
		expect(routeAccess('/projects', '', false)).toBe('login');
		for (const p of ['/login', '/register', '/forgot-password', '/reset-password', '/verify-email']) {
			expect(routeAccess(p, '', false)).toBe('show');
		}
	});

	it('moves signed-in users off the sign-in pages only', () => {
		expect(routeAccess('/login', '', true)).toBe('leave');
		expect(routeAccess('/app/register', '/app', true)).toBe('leave');
		expect(routeAccess('/forgot-password', '', true)).toBe('leave');
		expect(routeAccess('/projects/1', '', true)).toBe('show');
	});

	it('keeps an invitation link open to a signed-in user (the page explains it)', () => {
		const q = (s: string) => new URLSearchParams(s);
		expect(routeAccess('/register', '', true, q('invite=abc'))).toBe('show');
		expect(routeAccess('/app/register', '/app', true, q('invite='))).toBe('show');
		expect(routeAccess('/register', '', true, q('next=/x'))).toBe('leave');
		expect(routeAccess('/login', '', true, q('invite=abc'))).toBe('leave');
		expect(routeAccess('/register', '', false, q('invite=abc'))).toBe('show');
	});

	it('keeps emailed reset and confirmation links usable while signed in', () => {
		expect(routeAccess('/reset-password', '', true)).toBe('show');
		expect(routeAccess('/app/verify-email', '/app', true)).toBe('show');
	});

	it('opens an alert email’s unsubscribe link signed in or out, on its own screen (WP-2.13); the alerts preferences need a session', () => {
		expect(routeAccess('/alerts/unsubscribe', '', false)).toBe('show');
		expect(routeAccess('/alerts/unsubscribe', '', true)).toBe('show');
		expect(isPublicPath('/app/alerts/unsubscribe', '/app')).toBe(true);
		expect(routeAccess('/account/alerts', '', false)).toBe('login');
		expect(routeAccess('/alerts', '', false)).toBe('login');
	});

	it('opens a share link signed in or out, on its own screen', () => {
		expect(routeAccess('/share', '', false)).toBe('show');
		expect(routeAccess('/share', '', true)).toBe('show');
		expect(isPublicPath('/app/share', '/app')).toBe(true);
		expect(routeAccess('/shares', '', false)).toBe('login');
	});

	it('shows a signed-out visitor the landing page at / and /welcome; a signed-in one keeps / as the projects (issue #57)', () => {
		expect(routeAccess('/', '', false)).toBe('show');
		expect(routeAccess('/app/', '/app', false)).toBe('show');
		expect(isLandingRoot('/', '', false)).toBe(true);
		expect(isLandingRoot('/app', '/app', false)).toBe(true);
		expect(isLandingRoot('/', '', true)).toBe(false);
		expect(isLandingRoot('/projects', '', false)).toBe(false);
		expect(routeAccess('/', '', true)).toBe('show');
		expect(routeAccess('/welcome', '', false)).toBe('show');
		expect(routeAccess('/welcome', '', true)).toBe('show');
		expect(isPublicPath('/app/welcome', '/app')).toBe(true);
		expect(routeAccess('/welcomes', '', false)).toBe('login');
	});

	it('opens the legal pages and the methods page to anyone, signed in or out', () => {
		for (const p of ['/privacy', '/terms', '/methods']) {
			expect(routeAccess(p, '', false)).toBe('show');
			expect(routeAccess(p, '', true)).toBe('show');
		}
		expect(routeAccess('/privacyx', '', false)).toBe('login');
	});
});
