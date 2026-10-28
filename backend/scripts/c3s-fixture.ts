// The committed copy's C3S seasonal forecasts and hindcasts (issue #620 step
// 7): invented members over a 3 × 3 block of 1° cells, in the layout
// ingest/c3s_seasonal.py writes (`c3s/<YYYY-MM>/tp_mm`,
// `c3s-hc/<system>/<MM>/tp_mm`, each group's attributes, a manifest per
// product and `c3s/index.json`), so the outlook's bridge (src/outlooks/c3s.ts)
// reads in dev, CI and e2e what it reads in production. Called by
// gen-mirror-fixture.ts (pnpm gen:mirror-fixture), so
// src/mirror/fixture.test.ts covers it too. No real forecast, place or
// measurement: each day's value is a repeating pattern scaled per year and
// member.
//
// What it holds (C3S_FIXTURE): two systems' forecasts from the 2018-09 init
// (both issued in September), ECMWF's alone from 2018-10 (issued on the 6th,
// so an outlook deciding on 1 October can't use it), and the hindcasts of
// both init months, 1993–2016. The cells are 33–35° S, 20–22° E, so a
// catchment drawn round 33.7° S, 21.3° E (the DB and e2e tests' boundary)
// averages over the cell centred at 34° S, 21° E; every other cell is NaN.
import type { AbsolutePath } from '@zarrita/storage';
import * as zarr from 'zarrita';
import { CODECS } from '../src/mirror/arrays.js';
import { gridOf, regionSize, SEASONAL_REGION } from '../src/mirror/grid.js';
import { manifestHash } from '../src/mirror/manifest.js';
import { C3S_LEAD_DAYS } from '../src/outlooks/c3s.js';
import type { MirrorStore } from '../src/mirror/store.js';

/** Every system ingest/c3srequest.py SYSTEMS lists, in its order: a forecast group has a slot for each. */
const SYSTEMS = ['ecmwf-51', 'ukmo-604', 'meteo_france-9', 'dwd-22', 'cmcc-35', 'ncep-2', 'jma-3', 'eccc-4', 'eccc-5'];
const CENTRE_NAMES: Record<string, string> = {
	ecmwf: 'European Centre for Medium-Range Weather Forecasts (ECMWF)',
	ukmo: 'Met Office'
};
// ingest/c3s_seasonal.py's words, as the arrays carry them.
const SOURCE = 'C3S seasonal-original-single-levels';
const LICENCE = 'CC BY 4.0, and the Additional licence to use non European contributions (CDS dataset seasonal-original-single-levels)';
const CREDIT =
	'Contains modified Copernicus Climate Change Service information [year]. Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains.';
const CITATION =
	'Copernicus Climate Change Service, Climate Data Store (2018): Seasonal forecast daily and subdaily data on single levels. Copernicus Climate Change Service (C3S) Climate Data Store (CDS). DOI: 10.24381/cds.181d637e';

export const C3S_FIXTURE = {
	/** Members per system. */
	members: { 'ecmwf-51': 3, 'ukmo-604': 2 } as Record<string, number>,
	/** Each init and the systems held for it. */
	inits: { '2018-09': ['ecmwf-51', 'ukmo-604'], '2018-10': ['ecmwf-51'] } as Record<string, string[]>,
	/** Each system's hindcast init months. */
	hindcasts: { 'ecmwf-51': ['09', '10'], 'ukmo-604': ['09'] } as Record<string, string[]>,
	hindcastYears: Array.from({ length: 24 }, (_, i) => 1993 + i),
	/** The cells written: rows y0… (36° S is row 0) and columns x0… (10° E is column 0). */
	block: { y0: 1, x0: 10, h: 3, w: 3 },
	fetchedAt: '2026-02-09T00:00:00Z'
} as const;

/** The invented daily value (mm) of `system`'s member on lead day `d` of a start in `year`, at block cell (i, j). */
export function c3sFixtureValue(system: string, year: number, member: number, d: number, i: number, j: number): number {
	const scale = 0.4 + ((year * 7 + member * 3 + (system.startsWith('ukmo') ? 5 : 0)) % 11) / 10;
	return ((d * 5 + i * 3 + j * 2) % 7) * 0.6 * scale;
}

const { rows, cols } = regionSize(SEASONAL_REGION, 1);
const enc = new TextEncoder();
const centresOf = (systems: readonly string[]) => [...new Set(systems.map((s) => CENTRE_NAMES[s.replace(/-\d+$/, '')]!))];
const common = (systems: readonly string[]) => ({
	source: SOURCE,
	licence: LICENCE,
	credit: CREDIT,
	citation: CITATION,
	centres: centresOf(systems),
	variable: 'tp_mm',
	region: { ...SEASONAL_REGION },
	grid: gridOf(SEASONAL_REGION, 1)
});
const arrayAttrs = (firstDay: string | null) => ({
	units: 'mm/day',
	long_name: 'daily precipitation (de-accumulated from C3S total_precipitation)',
	...(firstDay ? { firstDay } : {}),
	leadDays: C3S_LEAD_DAYS,
	region: { ...SEASONAL_REGION },
	grid: gridOf(SEASONAL_REGION, 1)
});

/** One member's whole slab (lead_day, lat, lon), NaN outside the block. */
function slab(system: string, year: number, member: number): Float32Array {
	const { y0, x0, h, w } = C3S_FIXTURE.block;
	const out = new Float32Array(C3S_LEAD_DAYS * rows * cols).fill(Number.NaN);
	for (let d = 0; d < C3S_LEAD_DAYS; d++) for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) out[(d * rows + y0 + i) * cols + x0 + j] = c3sFixtureValue(system, year, member, d, i, j);
	return out;
}

async function group(store: MirrorStore, p: string, attributes: Record<string, unknown> = {}) {
	await zarr.create(zarr.root(store).resolve(p), { attributes });
}

async function array(store: MirrorStore, p: string, shape: number[], dims: string[], attributes: Record<string, unknown>) {
	return zarr.create(zarr.root(store).resolve(`${p}/tp_mm`), {
		shape,
		chunkShape: [1, 1, C3S_LEAD_DAYS, rows, cols],
		dtype: 'float32',
		fillValue: Number.NaN,
		codecs: CODECS,
		dimensionNames: dims,
		attributes
	});
}

async function writeMember(arr: zarr.Array<'float32', MirrorStore>, outer: number, member: number, data: Float32Array) {
	await zarr.set(arr, [outer, member, null, null, null], { data, shape: [C3S_LEAD_DAYS, rows, cols], stride: [rows * cols, cols, 1] });
}

/** A request's manifest, as ingest/c3s_seasonal.py ingest_request writes it. */
async function manifest(store: MirrorStore, product: string, url: string, slabs: Float32Array[], years: { first: number; last: number }) {
	const days = slabs.flatMap((s) => Array.from({ length: C3S_LEAD_DAYS }, (_, d) => s.subarray(d * rows * cols, (d + 1) * rows * cols)));
	const m = {
		product,
		revision: 1,
		region: { ...SEASONAL_REGION },
		grid: gridOf(SEASONAL_REGION, 1),
		years,
		finalThrough: null,
		prelimThrough: null,
		files: [{ url, etag: null, lastModified: null, size: null, valuesSha256: manifestHash(days), revision: 1, fetchedAt: C3S_FIXTURE.fetchedAt }],
		changes: []
	};
	await store.set(`/${product}/manifest.json` as AbsolutePath, enc.encode(`${JSON.stringify(m, null, 2)}\n`));
}

/** Write the C3S part of the fixture copy into `store` (whose root group exists). */
export async function writeC3sFixture(store: MirrorStore): Promise<void> {
	await group(store, 'c3s');
	await group(store, 'c3s-hc');
	for (const [init, held] of Object.entries(C3S_FIXTURE.inits)) {
		const product = `c3s/${init}`;
		const year = Number(init.slice(0, 4));
		const members = SYSTEMS.map((s) => (held.includes(s) ? C3S_FIXTURE.members[s]! : 0));
		await group(store, product, { ...common(held), init, firstDay: `${init}-01`, leadDays: C3S_LEAD_DAYS, systems: SYSTEMS, members });
		const arr = await array(store, product, [SYSTEMS.length, Math.max(...members), C3S_LEAD_DAYS, rows, cols], ['system', 'member', 'lead_day', 'lat', 'lon'], arrayAttrs(`${init}-01`));
		const slabs: Float32Array[] = [];
		for (const system of held) {
			for (let m = 0; m < C3S_FIXTURE.members[system]!; m++) {
				const v = slab(system, year, m);
				await writeMember(arr, SYSTEMS.indexOf(system), m, v);
				slabs.push(v);
			}
		}
		// One manifest per product, one file per request; the fixture's requests are listed together.
		const last = Number(new Date(Date.UTC(year, Number(init.slice(5, 7)) - 1, C3S_LEAD_DAYS)).toISOString().slice(0, 4));
		await manifest(store, product, `cds://seasonal-original-single-levels/total_precipitation/${held[0]}/${init}`, slabs, { first: year, last });
		if (held.length > 1) {
			// Every system's request in the manifest, as the ingest's upsert_file leaves it.
			const raw = JSON.parse(new TextDecoder().decode((await store.get(`/${product}/manifest.json` as AbsolutePath))!)) as { files: { url: string }[] };
			raw.files = held.map((s) => ({ ...raw.files[0]!, url: `cds://seasonal-original-single-levels/total_precipitation/${s}/${init}` }));
			await store.set(`/${product}/manifest.json` as AbsolutePath, enc.encode(`${JSON.stringify(raw, null, 2)}\n`));
		}
	}
	for (const [system, months] of Object.entries(C3S_FIXTURE.hindcasts)) {
		await group(store, `c3s-hc/${system}`);
		for (const mm of months) {
			const product = `c3s-hc/${system}/${mm}`;
			const years = [...C3S_FIXTURE.hindcastYears];
			const n = C3S_FIXTURE.members[system]!;
			await group(store, product, { ...common([system]), system, initMonth: Number(mm), years, members: n, leadDays: C3S_LEAD_DAYS });
			const arr = await array(store, product, [years.length, n, C3S_LEAD_DAYS, rows, cols], ['year', 'member', 'lead_day', 'lat', 'lon'], arrayAttrs(null));
			const slabs: Float32Array[] = [];
			for (const [yi, year] of years.entries()) {
				for (let m = 0; m < n; m++) {
					const v = slab(system, year, m);
					await writeMember(arr, yi, m, v);
					slabs.push(v);
				}
			}
			await manifest(store, product, `cds://seasonal-original-single-levels/total_precipitation/${system}/hindcast/${mm}`, slabs, { first: years[0]!, last: years.at(-1)! });
		}
	}
	const index = { inits: Object.fromEntries(Object.entries(C3S_FIXTURE.inits).sort(([a], [b]) => (a < b ? 1 : -1))), hindcasts: C3S_FIXTURE.hindcasts };
	await store.set('/c3s/index.json' as AbsolutePath, enc.encode(`${JSON.stringify(index, null, 2)}\n`));
}
