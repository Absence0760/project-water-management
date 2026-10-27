import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chirpsSource, fixtureMirrorUrl, mirrorStore, mirrorUrl } from './source.js';

describe('chirpsSource', () => {
	it('defaults to chc for a live process and mirror otherwise', () => {
		expect(chirpsSource({ FEED_SOURCE: 'live' })).toBe('chc');
		expect(chirpsSource({ FEED_SOURCE: 'fixtures' })).toBe('mirror');
		expect(chirpsSource({})).toBe('mirror');
	});
	it('takes an explicit value and refuses an unknown one', () => {
		expect(chirpsSource({ FEED_SOURCE: 'live', CHIRPS_SOURCE: 'mirror' })).toBe('mirror');
		expect(chirpsSource({ CHIRPS_SOURCE: 'chc' })).toBe('chc');
		expect(() => chirpsSource({ CHIRPS_SOURCE: 'dyn' })).toThrow('unknown CHIRPS_SOURCE "dyn"');
	});
});

describe('mirrorUrl', () => {
	it('points a non-live process at the committed copy, which exists', () => {
		expect(mirrorUrl({})).toBe(fixtureMirrorUrl());
		expect(existsSync(fileURLToPath(new URL('rnl/manifest.json', fixtureMirrorUrl())))).toBe(true);
	});
	it('takes MIRROR_URL, and refuses a live process without one', () => {
		expect(mirrorUrl({ FEED_SOURCE: 'live', MIRROR_URL: 's3://water-management-mirror-1' })).toBe('s3://water-management-mirror-1');
		expect(() => mirrorUrl({ FEED_SOURCE: 'live' })).toThrow('MIRROR_URL is not set');
	});
	it('opens one store per URL', () => {
		expect(mirrorStore({})).toBe(mirrorStore({}));
	});
});
