// The provenance file's checks (referenceOrigin.ts parseTileProvenance: what a
// production `tiles` load records, its problems fixed text that never echoes the
// file) and the dataset line the Map shows with a recorded version (withProvenance).
import { describe, expect, it } from 'vitest';
import { parseTileProvenance, TILE_ARCHIVES, TILE_PROVENANCE_FORMAT, withProvenance } from './referenceOrigin.js';

const good = {
	format: TILE_PROVENANCE_FORMAT,
	archive: 'water',
	sha256: 'a'.repeat(64),
	bytes: 40_000_000,
	upstream: { url: 'https://example.com/occurrence.tif', version: '1.5', etag: '"x-2"', lastModified: '2026-10-20T08:00:00Z' },
	originals: [{ key: 'originals/water/1.5-occurrence_20E_30S_v1_5_2024.tif', sha256: 'b'.repeat(64), bytes: 17_000_000 }]
};

describe('parseTileProvenance', () => {
	it('takes the file tiles-upload.ts writes, unknowns as null', () => {
		const { format: _, ...p } = good;
		expect(parseTileProvenance(good)).toEqual(p);
		expect(parseTileProvenance({ ...good, upstream: { url: null }, originals: [] })).toMatchObject({ upstream: { url: null, version: null, etag: null, lastModified: null }, originals: [] });
	});

	const SECRET = 'AKIAEXAMPLESECRET';
	it.each([
		['another format', { ...good, format: 'x' }, /format/],
		['an unknown archive', { ...good, archive: SECRET }, /archive is not one of basemap, fonts, terrain, water/],
		['a short hash', { ...good, sha256: 'abc' }, /sha256/],
		['no size', { ...good, bytes: 0 }, /bytes/],
		['a plain-HTTP upstream', { ...good, upstream: { ...good.upstream, url: `http://${SECRET}` } }, /https/],
		['a version over two lines', { ...good, upstream: { ...good.upstream, version: `1\n${SECRET}` } }, /version/],
		['a local time', { ...good, upstream: { ...good.upstream, lastModified: '2026-10-20 08:00' } }, /lastModified/],
		['an original outside its archive', { ...good, originals: [{ ...good.originals[0], key: `originals/terrain/${SECRET}` }] }, /originals\/water\/<file>/],
		['an original climbing out', { ...good, originals: [{ ...good.originals[0], key: 'originals/water/..x' }] }, /originals\/water\/<file>/]
	])('refuses %s, without echoing it', (_, raw, why) => {
		const got = parseTileProvenance(raw);
		expect(typeof got).toBe('string');
		expect(got).toMatch(why);
		expect(got).not.toContain(SECRET);
	});
});

describe('withProvenance', () => {
	const line = { kind: 'tiles' as const, dataset: 'terrain', version: '0.0.13', upstreamDate: '2026-09-30', licence: TILE_ARCHIVES.terrain.licence, recordedOn: '2026-10-27' };
	it('adds the version and dates it knows to the label, and leaves the label alone with none recorded', () => {
		expect(withProvenance('Copernicus GLO-30', line)).toBe('Copernicus GLO-30 (version 0.0.13, upstream file of 2026-09-30, recorded 2026-10-27)');
		expect(withProvenance('Copernicus GLO-30', { ...line, version: null, upstreamDate: null })).toBe('Copernicus GLO-30 (recorded 2026-10-27)');
		expect(withProvenance('Copernicus GLO-30', null)).toBe('Copernicus GLO-30');
	});
});
