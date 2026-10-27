// Production reference loads (geo/referenceLoad.ts, docs/deployment.md §
// Reference datasets), without a database:
//  - only the kinds docs/maps.md § Sources marks allowed load; every other
//    kind is refused, naming its decision, and the table here can't drift
//    from the Sources table (each kind's rows, read from the doc);
//  - a malformed request is refused with fixed text, never echoing the input
//    (the refusal reaches a public Actions log);
//  - the file must exist, stay under the caps (gzip bombs included) and hash
//    to the SHA-256 the operator gave;
//  - the migrate Lambda's failure summary carries a code and a fixed reason,
//    never the error's own text.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadFailureSummary } from '../lambda-migrate.js';
import { limitsFor, LoadError, MAX_OBJECT_BYTES, parseLoadRequest, readReferenceText, REFERENCE_KINDS, type ReadObject, type ReferenceKind } from './referenceLoad.js';

const MAPS_MD = fileURLToPath(new URL('../../../docs/maps.md', import.meta.url));
const GATES = new URL('../../../scripts/release/map-data-gates.mjs', import.meta.url).href;
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const ok = { kind: 'land-cover', key: 'reference/land-cover/worldcover-2021.json.gz', sha256: 'a'.repeat(64), dataset: 'WorldCover-2021-v200' };
const rivers = { kind: 'rivers', key: 'reference/rivers/hydrorivers-za.geojson.gz', sha256: 'b'.repeat(64), dataset: 'HydroRIVERS-v10', source: 'HydroRIVERS v1.0 © WWF' };

/** The error a call throws, which must be a LoadError. */
const thrown = (f: () => unknown): LoadError => {
	try {
		f();
	} catch (e) {
		expect(e).toBeInstanceOf(LoadError);
		return e as LoadError;
	}
	throw new Error('did not throw');
};
const thrownAsync = async (p: Promise<unknown>): Promise<LoadError> => {
	const e = await p.then(
		() => null,
		(err: unknown) => err
	);
	expect(e).toBeInstanceOf(LoadError);
	return e as LoadError;
};
const object =
	(bytes: Uint8Array, contentLength = bytes.byteLength): ReadObject =>
	async () => ({ contentLength, bytes: async () => bytes });

describe('which kinds load', () => {
	it('the allowed kinds parse (positive control for the refusals)', () => {
		expect(parseLoadRequest(ok)).toEqual({ ...ok, source: null, minOrder: 1 });
		expect(parseLoadRequest({ ...rivers, minOrder: 3 })).toEqual({ ...rivers, minOrder: 3 });
		const evaporation = { kind: 'evaporation', key: 'reference/evaporation/dpet-1991-2020.json.gz', sha256: 'c'.repeat(64), dataset: 'dPET-1991-2020' };
		expect(parseLoadRequest(evaporation)).toEqual({ ...evaporation, source: null, minOrder: 1 });
		const gazetteer = { kind: 'gazetteer', key: 'reference/gazetteer/za-2026-10.txt.gz', sha256: 'd'.repeat(64), dataset: 'GeoNames-ZA-2026-10' };
		expect(parseLoadRequest(gazetteer)).toEqual({ ...gazetteer, source: null, minOrder: 1 });
		const mapGrid = { kind: 'map-grid', key: 'reference/map-grid/waas-swcape.json.gz', sha256: 'e'.repeat(64), dataset: 'WAAS-SWCape-2007' };
		expect(parseLoadRequest(mapGrid)).toEqual({ ...mapGrid, source: null, minOrder: 1 });
	});

	describe('MAP grids load dataset by dataset', () => {
		const mapGrid = { kind: 'map-grid', key: 'reference/map-grid/grid.json.gz', sha256: 'e'.repeat(64), dataset: 'WAAS-SWCape-2007' };

		it('the Southwestern Cape surface is allowed, stored with its recorded credit line', () => {
			expect(parseLoadRequest(mapGrid).dataset).toBe('WAAS-SWCape-2007');
			const spec = REFERENCE_KINDS['map-grid'];
			expect(spec.datasets['WAAS-SWCape-2007']).toMatchObject({
				status: 'allowed',
				attribution: 'Mean annual rainfall surface for the Southwestern Cape. Prepared for the WAAS project by Beuster Clarke & Associates. March 2007, Version 1.1.'
			});
		});

		it('the Lynch (2004) grid is refused, naming its decision', () => {
			const e = thrown(() => parseLoadRequest({ ...mapGrid, dataset: 'Lynch-2004' }));
			expect(e.code).toBe('refused');
			expect(e.publicReason).toMatch(/^map-grid dataset Lynch-2004 is blocked in production: .*Decision: the Lynch \(2004\) MAP grid's licence/);
			expect(e.publicReason).toMatch(/maps\.md § Sources/);
		});

		it('an unknown dataset is refused with the allowed list, not the input', () => {
			for (const dataset of ['Other-surface', 'toString', 'constructor', 'hasOwnProperty']) {
				const e = thrown(() => parseLoadRequest({ ...mapGrid, dataset }));
				expect(e.code, dataset).toBe('refused');
				expect(e.publicReason, dataset).toBe('map-grid loads only the datasets whose licence is recorded: WAAS-SWCape-2007 (docs/maps.md § Sources)');
			}
		});

		it('takes no source: the credit is the recorded one', () => {
			expect(thrown(() => parseLoadRequest({ ...mapGrid, source: 'My own credit' })).publicReason).toMatch(/takes no source/);
		});

		it('takes only the JSON form `--out` writes, never the ASCII grid itself', () => {
			for (const key of ['reference/map-grid/grid.asc', 'reference/map-grid/grid.asc.gz', 'reference/map-grid/grid.tif']) {
				expect(thrown(() => parseLoadRequest({ ...mapGrid, key })).publicReason, key).toMatch(/--out <file>/);
			}
		});

		it('the release gate lists the same allowed datasets (map-data-gates.mjs DATASETS)', async () => {
			const { DATASETS } = (await import(GATES)) as { DATASETS: Record<string, string[]> };
			const fromTable = Object.fromEntries(
				Object.entries(REFERENCE_KINDS).flatMap(([kind, spec]: [string, ReferenceKind]) =>
					spec.status === 'allowed' && spec.datasets
						? [
								[
									kind,
									Object.entries(spec.datasets)
										.filter(([, d]) => d.status === 'allowed')
										.map(([label]) => label)
								]
							]
						: []
				)
			);
			expect(DATASETS).toEqual(fromTable);
		});
	});

	it('the gazetteer takes a GeoNames dump (.txt) only, under its own caps', () => {
		for (const key of ['reference/gazetteer/ZA.zip', 'reference/gazetteer/places.json']) {
			const e = thrown(() => parseLoadRequest({ kind: 'gazetteer', key, sha256: 'd'.repeat(64), dataset: 'GeoNames' }));
			expect(e.publicReason).toMatch(/GeoNames country dump/);
		}
		expect(limitsFor('gazetteer').object).toBeLessThan(MAX_OBJECT_BYTES);
	});

	it('evaporation takes the JSON grid of monthly means only, never the NetCDF years', () => {
		for (const key of ['reference/evaporation/2015_daily_pet.nc', 'reference/evaporation/grid.tif']) {
			const e = thrown(() => parseLoadRequest({ kind: 'evaporation', key, sha256: 'c'.repeat(64), dataset: 'dPET' }));
			expect(e.publicReason).toMatch(/grid of monthly means/);
		}
	});

	it('the release gate offers exactly the allowed kinds (map-data-gates.mjs LOADABLE)', async () => {
		const { LOADABLE } = (await import(GATES)) as { LOADABLE: string[] };
		const allowed = Object.entries(REFERENCE_KINDS)
			.filter(([, spec]) => spec.status === 'allowed')
			.map(([kind]) => kind);
		expect([...LOADABLE].sort()).toEqual(allowed.sort());
	});

	it.each(['quaternaries', 'dam-register', 'gauge-stations', 'crop-types'])('%s is refused in production, naming the decision that would unblock it', (kind) => {
		const e = thrown(() => parseLoadRequest({ ...ok, kind, key: `reference/${kind}/x.json` }));
		expect(e.code).toBe('refused');
		expect(e.publicReason).toMatch(/blocked in production/);
		expect(e.publicReason).toMatch(/Decision:/);
		expect(e.publicReason).toMatch(/maps\.md § Sources/);
	});

	it('an unknown kind is refused with the list, not the input', () => {
		const e = thrown(() => parseLoadRequest({ ...ok, kind: 'sanlc<script>' }));
		expect(e.publicReason).toMatch(/^kind must be one of land-cover, evaporation, rivers, gazetteer, quaternaries/);
		expect(e.publicReason).not.toContain('sanlc');
		expect(thrown(() => parseLoadRequest({ ...ok, kind: '__proto__' })).code).toBe('refused');
		expect(thrown(() => parseLoadRequest({ ...ok, kind: 'toString' })).code).toBe('refused');
	});

	it('agrees with the docs/maps.md § Sources table: allowed kinds have only allowed rows, blocked kinds only blocked ones', () => {
		const doc = readFileSync(MAPS_MD, 'utf8');
		// The Sources table alone: the section's subsections (### Checksums) have tables of their own.
		const from = doc.indexOf('\n## Sources');
		const next = doc.indexOf('\n#', from + 1);
		const table = doc.slice(from, next === -1 ? undefined : next);
		const rows = table.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Dataset') && !l.startsWith('| ---'));
		expect(rows.length).toBeGreaterThan(5);
		const status = (row: string) => row.split(' | ').at(-1)!.replace(/[|*]/g, '').trim().toLowerCase();
		const rowOf = (what: string, name: string) => {
			const matched = rows.filter((r) => r.slice(2).startsWith(name));
			expect(matched, `${what}: no Sources row starts with "${name}"`).toHaveLength(1);
			return matched[0]!;
		};
		for (const [kind, spec] of Object.entries(REFERENCE_KINDS) as [string, ReferenceKind][]) {
			for (const name of spec.sourcesRows) {
				expect(status(rowOf(kind, name)), `${kind}: ${name}`).toMatch(spec.status === 'allowed' ? /^allowed/ : /^blocked/);
			}
			// A kind allowed dataset by dataset: each listed dataset's own row says the same as it does.
			if (spec.status === 'allowed' && spec.datasets) {
				for (const [label, d] of Object.entries(spec.datasets)) {
					expect(status(rowOf(`${kind} ${label}`, d.sourcesRow)), `${kind} ${label}`).toMatch(d.status === 'allowed' ? /^allowed/ : /^blocked/);
				}
			}
		}
	});
});

describe('a malformed request is refused with fixed text', () => {
	const SECRET = 'AKIAEXAMPLESECRET';
	it.each([
		['not an object', null, /not an object/],
		['an array', [ok], /not an object/],
		['a key outside its kind', { ...ok, key: `reference/rivers/${SECRET}.json` }, /reference\/land-cover\/<file>/],
		['a key outside reference/', { ...ok, key: `tiles/${SECRET}.json` }, /reference\/land-cover\/<file>/],
		['a traversal', { ...ok, key: `reference/land-cover/..${SECRET}.json` }, /reference\/land-cover\/<file>/],
		['a sub-directory', { ...ok, key: `reference/land-cover/a/${SECRET}.json` }, /reference\/land-cover\/<file>/],
		['a land-cover file that is not JSON', { ...ok, key: `reference/land-cover/${SECRET}.tif` }, /pre-summarised grid/],
		['an upper-case or short SHA-256', { ...ok, sha256: 'A'.repeat(64) }, /SHA-256/],
		['a dataset label with odd characters', { ...ok, dataset: `x;${SECRET}'` }, /dataset must be/],
		['a long dataset label', { ...ok, dataset: 'x'.repeat(51) }, /dataset must be/],
		['the fixtures’ label', { ...ok, dataset: 'synthetic' }, /fixtures/],
		['a source over two lines', { ...ok, source: `a\n${SECRET}` }, /one line/],
		['rivers without a source', { ...rivers, source: '' }, /need a source/],
		['a Strahler order of 0', { ...rivers, minOrder: 0 }, /minOrder/],
		['a fractional order', { ...rivers, minOrder: 1.5 }, /minOrder/]
	])('%s', (_, req, why) => {
		const e = thrown(() => parseLoadRequest(req));
		expect(e.code).toBe('refused');
		expect(e.publicReason).toMatch(why);
		expect(e.publicReason).not.toContain(SECRET);
	});
});

describe('reading the file', () => {
	const text = '{"cellDeg":0.005,"cells":[[21.3025,-33.6575,0.5]]}';

	it('reads a plain and a gzipped file whose SHA-256 matches', async () => {
		const plain = Buffer.from(text);
		expect(await readReferenceText(parseLoadRequest({ ...ok, key: 'reference/land-cover/g.json', sha256: sha(plain) }), object(plain))).toBe(text);
		const gz = gzipSync(text);
		expect(await readReferenceText(parseLoadRequest({ ...ok, sha256: sha(gz) }), object(gz))).toBe(text);
	});

	it('refuses other bytes than the operator hashed', async () => {
		const e = await thrownAsync(readReferenceText(parseLoadRequest(ok), object(gzipSync(text))));
		expect(e.code).toBe('checksum_mismatch');
	});

	it('refuses a missing object', async () => {
		expect((await thrownAsync(readReferenceText(parseLoadRequest(ok), async () => null))).code).toBe('not_found');
	});

	it('refuses an object over the cap before downloading it', async () => {
		let downloaded = false;
		const read: ReadObject = async () => ({
			contentLength: 2048,
			bytes: async () => {
				downloaded = true;
				return new Uint8Array(2048);
			}
		});
		const e = await thrownAsync(readReferenceText(parseLoadRequest(ok), read, { object: 1024, text: 1024 }));
		expect(e.code).toBe('too_large');
		expect(downloaded).toBe(false);
	});

	it('refuses a gzip that unpacks past the text cap (a gzip bomb) without unpacking it whole', async () => {
		const bomb = gzipSync(Buffer.alloc(1024 * 1024));
		const e = await thrownAsync(readReferenceText(parseLoadRequest({ ...ok, sha256: sha(bomb) }), object(bomb), { object: 1024 * 1024, text: 64 * 1024 }));
		expect(e.code).toBe('too_large');
		expect(e.publicReason).toMatch(/unzipped/);
	});

	it('evaporation is read under its own, smaller caps', async () => {
		const lim = limitsFor('evaporation');
		expect(lim.object).toBeLessThan(MAX_OBJECT_BYTES);
		expect(limitsFor('land-cover').object).toBe(MAX_OBJECT_BYTES);
		const req = parseLoadRequest({ kind: 'evaporation', key: 'reference/evaporation/g.json.gz', sha256: 'c'.repeat(64), dataset: 'dPET' });
		const e = await thrownAsync(readReferenceText(req, async () => ({ contentLength: lim.object + 1, bytes: async () => new Uint8Array(0) })));
		expect(e.code).toBe('too_large');
		expect(e.publicReason).toBe('the file is over 32 MiB');
		// Its unzipped cap too (a gzip bomb), here lowered so the test stays small.
		const bomb = gzipSync(Buffer.alloc(1024 * 1024));
		const bombReq = { ...req, sha256: sha(bomb) };
		const b = await thrownAsync(readReferenceText(bombReq, object(bomb), { object: lim.object, text: 64 * 1024 }));
		expect(b.code).toBe('too_large');
		expect(b.publicReason).toMatch(/unzipped/);
	});

	it('refuses a .gz that is not gzip', async () => {
		const plain = Buffer.from(text);
		const e = await thrownAsync(readReferenceText(parseLoadRequest({ ...ok, sha256: sha(plain) }), object(plain)));
		expect(e.code).toBe('unreadable');
	});
});

describe('the failure summary (printed to the public Actions log)', () => {
	const context = { logGroupName: '/aws/lambda/wm-migrate', logStreamName: 's', awsRequestId: 'r' };

	it('a LoadError: its code and fixed reason only, never its message', () => {
		const summary = loadFailureSummary(new LoadError('reach "Farmer Jones dam inflow" has no geometry', 'empty', 'the file has no reach the load can take'), context);
		expect(summary).toEqual({ code: 'empty', reason: 'the file has no reach the load can take', logGroup: '/aws/lambda/wm-migrate', logStream: 's', requestId: 'r' });
		expect(JSON.stringify(summary)).not.toContain('Jones');
	});

	it('anything else: load_failed with no reason', () => {
		const summary = loadFailureSummary(new Error('password authentication failed for user "water"'));
		expect(summary).toEqual({ code: 'load_failed', reason: null, logGroup: null, logStream: null, requestId: null });
	});
});
