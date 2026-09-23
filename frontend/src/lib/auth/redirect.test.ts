import { describe, expect, it } from 'vitest';
import { safeNext } from './redirect';
import { isPublicPath } from './session.svelte';

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
