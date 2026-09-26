import { describe, expect, it } from 'vitest';
import { safeNext } from './redirect';
import { isPublicPath, routeAccess } from './session.svelte';

describe('safeNext', () => {
	it('allows app-relative paths only', () => {
		expect(safeNext('/projects/1?tab=runs', '/')).toBe('/projects/1?tab=runs');
		expect(safeNext('//evil.example', '/')).toBe('/');
		expect(safeNext('https://evil.example', '/')).toBe('/');
		expect(safeNext(null, '/x')).toBe('/x');
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
		expect(routeAccess('/', '', false)).toBe('login');
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

	it('opens a share link signed in or out, on its own screen', () => {
		expect(routeAccess('/share', '', false)).toBe('show');
		expect(routeAccess('/share', '', true)).toBe('show');
		expect(isPublicPath('/app/share', '/app')).toBe(true);
		expect(routeAccess('/shares', '', false)).toBe('login');
	});
});
