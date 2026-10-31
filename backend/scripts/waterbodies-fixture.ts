// Writes the synthetic DE Africa Waterbodies fixture (issue #604 R5): invented
// waterbody polygons round the Sandspruit example's dams
// (examples/map.ts), which `pnpm import:waterbodies` loads, and an invented
// wet-area series for each, which the Waterbodies pass reads with
// FEED_SOURCE=fixtures (dams/observed/waterbodies.ts fixtureWaterbodiesHttp,
// which answers the WFS lookup from the polygons' wb_id and the API from
// series/<wb_id>.csv). No real waterbody, place or value: the outlines are
// drawn from the invented dams, the uids are geohashes of those invented
// outlines' centres, the wb_ids are invented (from 900001, in uid order),
// and the series are a seasonal curve. Deterministic:
// waterbodies-fixture.test.ts holds the committed files to it.
//
// What the dams get, so a seeded Sandspruit shows each case:
//   Klipdrift dam   no waterbody (as a dam under Waterbodies' 0.45 ha minimum): none
//   Grootdraai dam  a waterbody three times its width (it joins water downstream): merged
//   every other     a waterbody a little inside its outline (the historical extent): matched
// The series run to SERIES_END in the v0.0.3 API's layout (WATERBODIES_HEADER): some dates a little
// clouded (5 % invalid) and some a scene's edge cuts (80 % observed), as DE Africa's series hold
// only dates under 10 % invalid (docs/data-sources.md).
//
//   pnpm gen:waterbodies-fixture
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { buildExamples } from './examples/catchments.js';
import { sandspruitMap } from './examples/map.js';
import type { Position } from '../src/geo/geojson.js';
import { WATERBODIES_FIXTURE_POLYGONS, WATERBODIES_FIXTURE_ROOT, WATERBODIES_HEADER } from '../src/dams/observed/waterbodies.js';

export const FIXTURE_ROOT = WATERBODIES_FIXTURE_ROOT;
export const POLYGONS_FILE = `${FIXTURE_ROOT}${WATERBODIES_FIXTURE_POLYGONS}`;
export const SERIES_DIR = `${FIXTURE_ROOT}series/`;

/** The fixture's dams and what each is meant to match as. */
export const FIXTURE_CASES: Record<string, 'matched' | 'merged' | 'none'> = { 'Klipdrift dam': 'none', 'Grootdraai dam': 'merged' };
export const caseOf = (dam: string) => FIXTURE_CASES[dam] ?? 'matched';
/** The last date of every series (a recent date when written, 2026-10-30: the API's series are current). */
export const SERIES_END = '2026-10-11';
/** The first invented wb_id; the rest follow in uid order. */
export const FIRST_WB_ID = 900_001;
const SERIES_START = '2015-01-01';
/** Landsat's revisit, as the series list it. */
const STEP_DAYS = 16;
/** One 30 m pixel. */
const PIXEL_M2 = 900;

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
/** The standard geohash of a point, `n` characters. */
export function geohash(lon: number, lat: number, n = 10): string {
	let [lo0, lo1, la0, la1] = [-180, 180, -90, 90];
	let out = '';
	let bit = 0;
	let ch = 0;
	let even = true;
	while (out.length < n) {
		if (even) {
			const mid = (lo0 + lo1) / 2;
			if (lon >= mid) (ch = (ch << 1) | 1), (lo0 = mid);
			else (ch <<= 1), (lo1 = mid);
		} else {
			const mid = (la0 + la1) / 2;
			if (lat >= mid) (ch = (ch << 1) | 1), (la0 = mid);
			else (ch <<= 1), (la1 = mid);
		}
		even = !even;
		if (++bit === 5) {
			out += BASE32[ch];
			bit = 0;
			ch = 0;
		}
	}
	return out;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const ring = (w: number, s: number, e: number, n: number): Position[] => [
	[r6(w), r6(s)],
	[r6(e), r6(s)],
	[r6(e), r6(n)],
	[r6(w), r6(n)],
	[r6(w), r6(s)]
];

export interface FixtureWaterbody {
	uid: string;
	/** DE Africa's integer id, which the Waterbodies API is keyed by (invented). */
	wbId: number;
	dam: string;
	coordinates: Position[][];
	areaM2: number;
}

/** The fixture's waterbodies, from the Sandspruit example's dams. */
export function fixtureWaterbodies(): FixtureWaterbody[] {
	const ex = buildExamples({ fit: false }).find((e) => e.name.includes('Sandspruit'));
	if (!ex) throw new Error('no Sandspruit example');
	const out: FixtureWaterbody[] = [];
	for (const f of sandspruitMap(ex.model)) {
		if (f.kind !== 'dam' || f.geometry.type !== 'Polygon') continue;
		const c = caseOf(f.name);
		if (c === 'none') continue;
		const xs = f.geometry.coordinates[0]!.map((p) => p[0]);
		const ys = f.geometry.coordinates[0]!.map((p) => p[1]);
		const [w, e, s, n] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
		const [dx, dy] = [(e - w) * 0.1, (n - s) * 0.1];
		// Merged: the water reaches two dam-widths further east. Matched: 10 % inside each side.
		const [ww, ws, we, wn] = c === 'merged' ? [w, s, e + 2 * (e - w), n] : [w + dx, s + dy, e - dx, n - dy];
		const km2 = ((we - ww) * 111.32 * Math.cos((((ws + wn) / 2) * Math.PI) / 180)) * ((wn - ws) * 110.95);
		out.push({ uid: geohash((ww + we) / 2, (ws + wn) / 2), wbId: 0, dam: f.name, coordinates: [ring(ww, ws, we, wn)], areaM2: Math.round(km2 * 1e6) });
	}
	return out.sort((a, b) => (a.uid < b.uid ? -1 : 1)).map((w, i) => ({ ...w, wbId: FIRST_WB_ID + i }));
}

/** The polygon file: a GeoJSON FeatureCollection as the v0.0.3 extract would be, its uid in `uid` and its id in `wb_id`. */
export function polygonsFile(wbs = fixtureWaterbodies()): string {
	return `${JSON.stringify(
		{
			type: 'FeatureCollection',
			features: wbs.map((w) => ({ type: 'Feature', properties: { uid: w.uid, wb_id: w.wbId, area_m2: w.areaM2 }, geometry: { type: 'Polygon', coordinates: w.coordinates } })),
			name: 'waterbodies.synthetic'
		},
		null,
		1
	)}\n`;
}

/**
 * One waterbody's series CSV, as the API answers it: a seasonal wet share; every 5th date 5 % invalid (cloud), every
 * 11th cut by the scene's edge (80 % observed). Areas and percents both of the historical extent, wet + dry + invalid =
 * observed, as DE Africa's rows are.
 */
export function seriesCsv(w: FixtureWaterbody, index: number): string {
	const total = Math.max(20, Math.round(w.areaM2 / PIXEL_M2));
	const lines: string[] = [WATERBODIES_HEADER.join(',')];
	const end = Date.parse(`${SERIES_END}T00:00:00Z`);
	const start = Date.parse(`${SERIES_START}T00:00:00Z`);
	const days: number[] = [];
	for (let t = end; t >= start; t -= STEP_DAYS * 86_400_000) days.push(t);
	days.reverse();
	const area = (px: number) => (px * PIXEL_M2).toFixed(1);
	const pc = (px: number) => ((100 * px) / total).toFixed(2);
	for (const [k, t] of days.entries()) {
		const date = new Date(t).toISOString().slice(0, 10);
		const doy = (t - Date.parse(`${date.slice(0, 4)}-01-01T00:00:00Z`)) / 86_400_000;
		const observed = k % 11 === 4 ? Math.round(total * 0.8) : total;
		const invalid = k % 5 === 1 ? Math.round(total * 0.05) : 0;
		const valid = observed - invalid;
		const share = 0.55 + 0.35 * Math.sin((2 * Math.PI * (doy - 30 - index * 20)) / 365.25);
		const wet = Math.round(valid * share);
		const dry = valid - wet;
		lines.push([date, area(wet), pc(wet), area(dry), pc(dry), area(invalid), pc(invalid), area(observed), pc(observed)].join(','));
	}
	return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const wbs = fixtureWaterbodies();
	mkdirSync(FIXTURE_ROOT, { recursive: true });
	writeFileSync(POLYGONS_FILE, polygonsFile(wbs));
	rmSync(SERIES_DIR, { recursive: true, force: true });
	mkdirSync(SERIES_DIR, { recursive: true });
	wbs.forEach((w, i) => writeFileSync(`${SERIES_DIR}${w.wbId}.csv`, seriesCsv(w, i)));
	console.log(`${wbs.length} synthetic waterbodies and their series written to ${FIXTURE_ROOT}`);
}
