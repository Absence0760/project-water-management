// FEED_SOURCE=fixtures (the default): the sources' URLs answered from the
// synthetic files in backend/fixtures/feeds/, never the network. The
// fixtures are re-dated to "now", like the real products' publishing lags,
// so a feed attached in dev or e2e fills with recent days and shows healthy:
//
//   CHIRPS  sat: from 1998, final up to finalLagDays before today,
//           preliminary up to prelimLagDays before it, 404 after; rnl: from
//           1981, final only, up to rnlLagDays before today, the pattern a
//           day later (chirps-sample.json)
//   GEFS    an issue every day, 16 forecast days (gefs-sample.json)
//   DWS     the sample page's values replayed for the requested window,
//           ending DWS_FIXTURE_LAG_DAYS before today (dws-sample.html)
//
// Every file has a tag (FeedHttp.rangeTagged / head): a hash of its bytes, as
// an ETag would change with them. With `rewrite` (FEED_FIXTURE_REWRITE=1, or
// a test's option) the sat and rnl finals of the days chirps-rewrite.json
// names, counted back from today, are served rewritten in place: other
// values, so another tag, at the same URL, as CHC rewrote the 2024 dailies
// in 2025-12. The re-check of cached finals is tested against it offline
// (docs/architecture.md § Data feeds → Re-checking finals).
//
// The grids are encoded as real LZW GeoTIFFs in the CHC layout
// (sources/tiff-write.ts), so fixtures exercise the same reader as
// production. Each file covers the fixture's `cover` (21.0–25.4° E, 20.0–34.0° S),
// the invented 8 × 6 grid repeated around it, so a feed over a seeded
// example's synthetic catchment (backend/scripts/examples/map.ts) reads rain
// offline. Any other URL is a 404. Invented grid and station: no real
// place, catchment or measurement.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { utcToday } from './fetch.js';
import type { FeedHttp } from './http.js';
import { CHC_BASE, GEFS_DAYS } from './sources/chirps.js';
import { DWS_BASE, parseDwsDaily } from './sources/dws.js';
import { writeGrid } from './sources/tiff-write.js';

export const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/feeds/', import.meta.url));

interface GridFixture {
	grid: { originLon: number; originLat: number; scale: number; width: number; height: number; sea: [number, number][] };
	/**
	 * The wider grid the files cover (same scale, aligned with `grid`): the
	 * cells of `grid` hold its values, and every other cell repeats them
	 * (row mod height, column mod width) with no sea, so a feed over the
	 * seeded examples' synthetic catchments reads plausible rain offline
	 * (issue #326 B-rain: the rain feed from a boundary there).
	 */
	cover?: { originLon: number; originLat: number; width: number; height: number };
	colGradient: number;
	rowGradient: number;
	pattern: number[];
	finalLagDays?: number;
	prelimLagDays?: number;
	rnlLagDays?: number;
	exampleCell?: { lat: number; lon: number };
}

const load = <T>(name: string): T => JSON.parse(readFileSync(`${FIXTURE_DIR}${name}`, 'utf8')) as T;

// The first days the fixture serves each CHIRPS v3 daily product, as the real ones start.
const SAT_FIRST = toEpochDay('1998-01-01');
const RNL_FIRST = toEpochDay('1981-01-01');

/** The DWS fixture's newest day is this many days before today. */
export const DWS_FIXTURE_LAG_DAYS = 90;

/** The rainfall of the fixture grid at (row, col) on pattern step `k`. */
export function fixtureValue(f: GridFixture, k: number, row: number, col: number): number {
	if (f.grid.sea.some(([r, c]) => r === row && c === col)) return -9999;
	const base = f.pattern[((k % f.pattern.length) + f.pattern.length) % f.pattern.length]!;
	return Math.fround(base * (1 + f.colGradient * col + f.rowGradient * row));
}

/** The rainfall of a cover cell (row, col counted from `grid`'s origin, either may be negative): `grid`'s own value, else the pattern repeated, no sea. */
export function coverValue(f: GridFixture, k: number, row: number, col: number, landOnly: GridFixture = { ...f, grid: { ...f.grid, sea: [] } }): number {
	const { width, height } = f.grid;
	if (row >= 0 && row < height && col >= 0 && col < width) return fixtureValue(f, k, row, col);
	return fixtureValue(landOnly, k, ((row % height) + height) % height, ((col % width) + width) % width);
}

function gridFile(f: GridFixture, k: number): Uint8Array {
	const g = f.grid;
	const cover = f.cover ?? { originLon: g.originLon, originLat: g.originLat, width: g.width, height: g.height };
	// Where `grid`'s origin sits in the cover, in cells (the north-west corners; rows count southward).
	const dRow = Math.round((cover.originLat - g.originLat) / g.scale);
	const dCol = Math.round((g.originLon - cover.originLon) / g.scale);
	const { width, height } = cover;
	const values = new Float32Array(width * height);
	const landOnly = { ...f, grid: { ...g, sea: [] } };
	for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) values[r * width + c] = coverValue(f, k, r - dRow, c - dCol, landOnly);
	return writeGrid({ width, height, originLon: cover.originLon, originLat: cover.originLat, scale: g.scale, values, shareStrips: true });
}

/**
 * Renders rows in the DWS daily page layout (sources/dws.ts, dws-sample.html):
 * fixed columns (date 1-8, flow 10-18, quality 20-24), a gap as a blank flow
 * with code 170 ("permanent gap").
 */
export function renderDwsPage(station: string, rows: { date: string; value: number | null; quality: string }[]): string {
	if (!rows.length) return `<html><body><pre>\nStation : ${station}100.00\nNo data for this period\n</pre></body></html>`;
	const lines = rows.map((r) => `${r.date.replaceAll('-', '')} ${(r.value === null ? '' : r.value.toFixed(3)).padStart(9)} ${(r.value === null ? '170' : r.quality).padStart(5)}`);
	const format = 'POS.  1-8   = Date of daily flow  CCYYMMDD\nPOS. 10-18  = Daily avg flow rate in cubic metres/sec 99999.999\nPOS. 20-24  = Quality code';
	return `<p><pre>Data are continuously updated and reviewed.\nThe format of this file is as follows:\n${format}\n\n${station} (fixture)\nVariable 100.00 Surface Water Level\n\nDATE     D AVG F/R  QUAL\n${lines.join('\n')}\nZZZZZZZZZZZZ\n</pre></p>\n<!DOCTYPE html>\n<html><body></body></html>`;
}

/** chirps-rewrite.json: the final days served rewritten (days before today, inclusive) and how their rain changes. */
export interface RewriteFixture {
	fromDaysAgo: number;
	toDaysAgo: number;
	factor: number;
}
export const REWRITE_FIXTURE = (): RewriteFixture => load<RewriteFixture>('chirps-rewrite.json');

/** A fixture file's tag: a hash of its bytes, like an ETag that changes when the file does. */
export const fixtureTag = (bytes: Uint8Array) => `"fx-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}"`;

export function fixtureHttp(today: () => string = () => utcToday(), opts: { rewrite?: RewriteFixture | boolean } = {}): FeedHttp {
	const chirps = load<GridFixture>('chirps-sample.json');
	const rewrite = opts.rewrite === true ? REWRITE_FIXTURE() : opts.rewrite || null;
	/** Whether `day`'s final file is served rewritten. */
	const rewritten = (day: number, t: number) => rewrite !== null && day >= t - rewrite.fromDaysAgo && day <= t - rewrite.toDaysAgo;
	const scaled = (f: GridFixture) => ({ ...f, pattern: f.pattern.map((v) => v * rewrite!.factor) });
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

	const tags = new WeakMap<Uint8Array, string>();
	const tagOf = (bytes: Uint8Array) => {
		let t = tags.get(bytes);
		if (!t) tags.set(bytes, (t = fixtureTag(bytes)));
		return t;
	};

	const file = (url: string): Uint8Array | null => {
		const t = toEpochDay(today());
		let m = url.match(/^.*\/CHIRPS\/v3\.0\/daily\/final\/rnl\/\d{4}\/chirps-v3\.0\.rnl\.(\d{4})\.(\d{2})\.(\d{2})\.tif$/);
		if (m && url.startsWith(CHC_BASE)) {
			const day = toEpochDay(`${m[1]}-${m[2]}-${m[3]}`);
			if (day < RNL_FIRST || day > t - (chirps.rnlLagDays ?? 40)) return null;
			// The same pentads, other daily timing: the pattern a day later.
			if (rewritten(day, t)) return cached(`crnlx${day}`, () => gridFile(scaled(chirps), day - 1));
			return cached(`crnl${day}`, () => gridFile(chirps, day - 1));
		}
		m = url.match(/^.*\/CHIRPS\/v3\.0\/daily\/(final|prelim)\/sat\/\d{4}\/chirps-v3\.0\.(?:sat|prelim)\.(\d{4})\.(\d{2})\.(\d{2})\.tif$/);
		if (m && url.startsWith(CHC_BASE)) {
			const day = toEpochDay(`${m[2]}-${m[3]}-${m[4]}`);
			if (day < SAT_FIRST) return null;
			const final = day <= t - (chirps.finalLagDays ?? 40);
			const prelim = !final && day <= t - (chirps.prelimLagDays ?? 3);
			if (m[1] === 'final' ? !final : !prelim) return null;
			// A preliminary day reads a little high, so the final overwrite is visible.
			const k = day;
			if (m[1] === 'final' && rewritten(day, t)) return cached(`cfinalx${k}`, () => gridFile(scaled(chirps), k));
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
		async rangeTagged(url, start, end) {
			const bytes = file(url);
			return bytes ? { bytes: bytes.subarray(start, end + 1), tag: tagOf(bytes) } : null;
		},
		async head(url) {
			const bytes = file(url);
			return bytes ? { tag: tagOf(bytes) } : null;
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
