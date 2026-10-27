// Writes the synthetic DE Africa Waterbodies fixture (issue #604 R5): invented
// waterbody polygons round the Sandspruit example's dams
// (examples/map.ts), which `pnpm import:waterbodies` loads, and an invented
// wet-area series for each, which the Waterbodies pass reads with
// FEED_SOURCE=fixtures (dams/observed/waterbodies.ts). No real waterbody,
// place or value: the outlines are drawn from the invented dams, the uids are
// geohashes of those invented outlines' centres, and the series are a
// seasonal curve. Deterministic: waterbodies-fixture.test.ts holds the
// committed files to it.
//
// What the dams get, so a seeded Sandspruit shows each case:
//   Klipdrift dam   no waterbody (as a dam under Waterbodies' 0.45 ha minimum): none
//   Grootdraai dam  a waterbody three times its width (it joins water downstream): merged
//   every other     a waterbody a little inside its outline (the historical extent): matched
// The series end on 2023-09-17, as the public series do (frozen upstream; docs/data-sources.md).
//
//   pnpm gen:waterbodies-fixture
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildExamples } from './examples/catchments.js';
import { sandspruitMap } from './examples/map.js';
import type { Position } from '../src/geo/geojson.js';
import { WATERBODIES_HEADER } from '../src/dams/observed/waterbodies.js';

export const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/waterbodies/', import.meta.url));
export const POLYGONS_FILE = `${FIXTURE_ROOT}waterbodies.synthetic.geojson`;
export const SERIES_DIR = `${FIXTURE_ROOT}series/`;

/** The fixture's dams and what each is meant to match as. */
export const FIXTURE_CASES: Record<string, 'matched' | 'merged' | 'none'> = { 'Klipdrift dam': 'none', 'Grootdraai dam': 'merged' };
export const caseOf = (dam: string) => FIXTURE_CASES[dam] ?? 'matched';
/** The last date of every series (the public series' end, 2026-10-27). */
export const SERIES_END = '2023-09-17';
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
	dam: string;
	coordinates: Position[][];
	areaM2: number;
}

/** The fixture's waterbodies, from the Sandspruit example's dams. */
export function fixtureWaterbodies(): FixtureWaterbody[] {
	const ex = buildExamples().find((e) => e.name.includes('Sandspruit'));
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
		out.push({ uid: geohash((ww + we) / 2, (ws + wn) / 2), dam: f.name, coordinates: [ring(ww, ws, we, wn)], areaM2: Math.round(km2 * 1e6) });
	}
	return out.sort((a, b) => (a.uid < b.uid ? -1 : 1));
}

/** The polygon file: a GeoJSON FeatureCollection as the v0.0.3 extract would be, its uid in `uid`. */
export function polygonsFile(wbs = fixtureWaterbodies()): string {
	return `${JSON.stringify(
		{
			type: 'FeatureCollection',
			features: wbs.map((w) => ({ type: 'Feature', properties: { uid: w.uid, area_m2: w.areaM2 }, geometry: { type: 'Polygon', coordinates: w.coordinates } })),
			name: 'waterbodies.synthetic'
		},
		null,
		1
	)}\n`;
}

/** One waterbody's series CSV: a seasonal wet share, every 7th date fully invalid, every 5th a third invalid. */
export function seriesCsv(w: FixtureWaterbody, index: number): string {
	const total = Math.max(5, Math.round(w.areaM2 / PIXEL_M2));
	const lines: string[] = [WATERBODIES_HEADER.join(',')];
	const end = Date.parse(`${SERIES_END}T00:00:00Z`);
	const start = Date.parse(`${SERIES_START}T00:00:00Z`);
	const days: number[] = [];
	for (let t = end; t >= start; t -= STEP_DAYS * 86_400_000) days.push(t);
	days.reverse();
	for (const [k, t] of days.entries()) {
		const date = new Date(t).toISOString().slice(0, 10);
		const doy = (t - Date.parse(`${date.slice(0, 4)}-01-01T00:00:00Z`)) / 86_400_000;
		const invalid = k % 7 === 3 ? total : k % 5 === 1 ? Math.round(total / 3) : 0;
		const valid = total - invalid;
		const share = 0.55 + 0.35 * Math.sin((2 * Math.PI * (doy - 30 - index * 20)) / 365.25);
		const wet = Math.round(valid * share);
		const dry = valid - wet;
		const pc = (n: number) => (valid === 0 ? '' : ((100 * n) / total).toFixed(2));
		lines.push(
			[date, total, wet, wet * PIXEL_M2, dry, dry * PIXEL_M2, invalid, invalid * PIXEL_M2, valid === 0 ? '' : pc(wet), valid === 0 ? '' : pc(dry), ((100 * invalid) / total).toFixed(2)].join(',')
		);
	}
	return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const wbs = fixtureWaterbodies();
	mkdirSync(FIXTURE_ROOT, { recursive: true });
	writeFileSync(POLYGONS_FILE, polygonsFile(wbs));
	rmSync(SERIES_DIR, { recursive: true, force: true });
	mkdirSync(SERIES_DIR, { recursive: true });
	wbs.forEach((w, i) => writeFileSync(`${SERIES_DIR}${w.uid}.csv`, seriesCsv(w, i)));
	console.log(`${wbs.length} synthetic waterbodies and their series written to ${FIXTURE_ROOT}`);
}
