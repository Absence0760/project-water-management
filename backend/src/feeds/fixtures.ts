// FEED_SOURCE=fixtures (the default): the sources' URLs answered from the
// synthetic files in backend/fixtures/feeds/, never the network. The
// fixtures are re-dated to "now", like the real products' publishing lags,
// so a feed attached in dev or e2e fills with recent days and shows healthy:
//
//   CHIRPS  final up to finalLagDays before today, preliminary up to
//           prelimLagDays before it, 404 after (chirps-sample.json)
//   GEFS    an issue every day, 16 forecast days (gefs-sample.json)
//   DWS     the sample page's values replayed for the requested window,
//           ending DWS_FIXTURE_LAG_DAYS before today (dws-sample.html)
//
// The grids are encoded as real LZW GeoTIFFs in the CHC layout
// (sources/tiff-write.ts), so fixtures exercise the same reader as
// production. Any other URL is a 404. Invented grid and station: no real
// place, catchment or measurement.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine';
import { utcToday } from './fetch.js';
import type { FeedHttp } from './http.js';
import { CHC_BASE, GEFS_DAYS } from './sources/chirps.js';
import { DWS_BASE, parseDwsDaily } from './sources/dws.js';
import { writeGrid } from './sources/tiff-write.js';

export const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/feeds/', import.meta.url));

interface GridFixture {
	grid: { originLon: number; originLat: number; scale: number; width: number; height: number; sea: [number, number][] };
	colGradient: number;
	rowGradient: number;
	pattern: number[];
	finalLagDays?: number;
	prelimLagDays?: number;
	exampleCell?: { lat: number; lon: number };
}

const load = <T>(name: string): T => JSON.parse(readFileSync(`${FIXTURE_DIR}${name}`, 'utf8')) as T;

/** The DWS fixture's newest day is this many days before today. */
export const DWS_FIXTURE_LAG_DAYS = 90;

/** The rainfall of the fixture grid at (row, col) on pattern step `k`. */
export function fixtureValue(f: GridFixture, k: number, row: number, col: number): number {
	if (f.grid.sea.some(([r, c]) => r === row && c === col)) return -9999;
	const base = f.pattern[((k % f.pattern.length) + f.pattern.length) % f.pattern.length]!;
	return Math.fround(base * (1 + f.colGradient * col + f.rowGradient * row));
}

function gridFile(f: GridFixture, k: number): Uint8Array {
	const { width, height } = f.grid;
	const values = new Float32Array(width * height);
	for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) values[r * width + c] = fixtureValue(f, k, r, c);
	return writeGrid({ width, height, originLon: f.grid.originLon, originLat: f.grid.originLat, scale: f.grid.scale, values });
}

/** Renders rows in the DWS daily page layout (sources/dws.ts). */
export function renderDwsPage(station: string, rows: { date: string; value: number | null; quality: string }[]): string {
	if (!rows.length) return `<html><body><pre>\nStation : ${station}100.00\nNo data for this period\n</pre></body></html>`;
	const lines = rows.map((r) => `${r.date.replaceAll('-', '')}   ${r.value === null ? '' : r.value.toFixed(3).padStart(8)}   ${r.value === null ? '' : r.quality.padStart(3)}`.trimEnd());
	return `<html><body><pre>\nStation : ${station}100.00  (fixture)\n\nDATE       D_AVG_FR  QUAL\n${lines.join('\n')}\n</pre></body></html>`;
}

export function fixtureHttp(today: () => string = () => utcToday()): FeedHttp {
	const chirps = load<GridFixture>('chirps-sample.json');
	const gefs = load<GridFixture>('gefs-sample.json');
	const dwsSample = parseDwsDaily(readFileSync(`${FIXTURE_DIR}dws-sample.html`, 'utf8'));
	const cache = new Map<string, Uint8Array>();
	const cached = (key: string, make: () => Uint8Array) => {
		let v = cache.get(key);
		if (!v) {
			v = make();
			if (cache.size > 200) cache.clear();
			cache.set(key, v);
		}
		return v;
	};

	const file = (url: string): Uint8Array | null => {
		const t = toEpochDay(today());
		let m = url.match(/^.*\/CHIRPS\/v3\.0\/daily\/(final|prelim)\/sat\/\d{4}\/chirps-v3\.0\.(?:sat|prelim)\.(\d{4})\.(\d{2})\.(\d{2})\.tif$/);
		if (m && url.startsWith(CHC_BASE)) {
			const day = toEpochDay(`${m[2]}-${m[3]}-${m[4]}`);
			const final = day <= t - (chirps.finalLagDays ?? 40);
			const prelim = !final && day <= t - (chirps.prelimLagDays ?? 3);
			if (m[1] === 'final' ? !final : !prelim) return null;
			// A preliminary day reads a little high, so the final overwrite is visible.
			const k = day;
			return cached(`c${m[1]}${k}`, () =>
				gridFile(m![1] === 'final' ? chirps : { ...chirps, pattern: chirps.pattern.map((v) => v * 1.1) }, k)
			);
		}
		m = url.match(/^.*\/CHIRPS-GEFS\/v3\/daily\/global\/(\d{4})\/(\d{2})\/(\d{2})\/c3g_(\d{4})\.(\d{2})\.(\d{2})\.tif$/);
		if (m && url.startsWith(CHC_BASE)) {
			const issued = toEpochDay(`${m[1]}-${m[2]}-${m[3]}`);
			const day = toEpochDay(`${m[4]}-${m[5]}-${m[6]}`);
			if (issued > t || day < issued || day >= issued + GEFS_DAYS) return null;
			return cached(`g${day}`, () => gridFile(gefs, day));
		}
		return null;
	};

	return {
		async range(url, start, end) {
			const bytes = file(url);
			return bytes ? bytes.subarray(start, end + 1) : null;
		},
		async text(url) {
			if (!url.startsWith(`${DWS_BASE}?`)) return null;
			const q = new URL(url).searchParams;
			const station = (q.get('Station') ?? '').replace(/100\.00$/, '');
			if (q.get('DataType') !== 'Daily' || !station) return null;
			const from = toEpochDay(q.get('StartDT') ?? '');
			const to = Math.min(toEpochDay(q.get('EndDT') ?? ''), toEpochDay(today()) - DWS_FIXTURE_LAG_DAYS);
			const sample = dwsSample.values;
			const rows = [];
			for (let d = from; d <= to; d++) {
				const k = ((d % sample.length) + sample.length) % sample.length;
				rows.push({ date: fromEpochDay(d), value: sample[k] ?? null, quality: '1' });
			}
			return renderDwsPage(station, rows);
		}
	};
}

/** A cell inside the fixture grid, for examples and tests. */
export const FIXTURE_CELL = (): { lat: number; lon: number } => load<GridFixture>('chirps-sample.json').exampleCell!;
