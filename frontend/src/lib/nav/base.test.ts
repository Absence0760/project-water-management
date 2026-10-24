// basePath(): resolve('') less its trailing '/', so the prefix `base` was in SvelteKit 2.
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = vi.hoisted(() => ({ value: '/' }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => `${root.value}${p}` }));

import { basePath } from './base';

describe('basePath', () => {
	afterEach(() => {
		root.value = '/';
	});

	it('is empty at the site root, so `${basePath()}/x` is "/x"', () => {
		expect(basePath()).toBe('');
		expect(`${basePath()}/privacy`).toBe('/privacy');
	});

	it('is the configured base under a sub-path, without a trailing slash', () => {
		root.value = '/water/';
		expect(basePath()).toBe('/water');
		expect('/water/account'.slice(basePath().length)).toBe('/account');
	});

	it('is read at each call: relative while prerendering a page one level down', () => {
		root.value = './';
		expect(basePath()).toBe('.');
		root.value = '../';
		expect(basePath()).toBe('..');
	});
});
