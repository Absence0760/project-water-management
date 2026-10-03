// Research harness, fourth experiment (docs/design/delineation-snapping.md §
// Gauges, issue #390 part 1): Delineate at real gauging stations and compare
// with each station's *published* catchment area, a reference that comes
// from neither HydroRIVERS nor GLO-30. The first three experiments clicked
// HydroRIVERS vertices and junctions and scored against HydroRIVERS' own
// areas, so a rule that agrees with HydroRIVERS scored well even where both
// are wrong, and no click was where a gauge actually sits.
//
// For each station inside the DEM, the click is the station's published
// position, and the path is the app's own (routes.ts → POST …/map/delineation):
//   reachFor (the nearest HydroRIVERS reach within 1 km, or a 422 confluence
//   question) → delineate (the request's window ladder, place.ts's area match
//   or snap with the larger-channel guard, junction.ts at a confluence) and,
//   when the request stops too_large at its last window, the worker's windows
//   from the next, the first placed over where the request's cut the
//   catchment (jobs/handlers/delineate.ts; `stage` says which proposed it).
// At a confluence the editor's pick is simulated by an oracle: the river whose
// area is nearest the published one (the best an editor who knows the gauge's
// river could do). A larger-channel refusal is followed both ways an editor
// can answer it: "Use that channel" (a new request at the channel's point)
// and "Keep my point" (keepPoint).
//
// Start's path too (`start`, unless --no-start): Start from the map with the
// station as the outlet gauge and no other point, its reach looked up as
// pointReaches does and divided by delineateUnits with Start's own windows
// (start.ts; no worker); after the outlet's larger-channel warning, "Use that
// channel for the outlet" (`startLarger`).
//
// Every failure (a refusal other than too_large on a main stem, or an area
// outside ½–2×) gets a diagnosis routed once more at the largest window:
// does the area match find the river in a 3 072-cell window (persona finding
// 1), within 2.5 km (finding 7), what is the most-drained cell within 1 and
// 2.5 km, and where is the nearest HydroRIVERS junction (finding 5).
//
// The station list is local and never committed (CLAUDE.md rule 11; the
// licence allows research use, not redistribution): a CSV with either the
// GRDC catalogue's columns (grdc_no, river, lat, long, area) or the
// gauge-station import's (code, river, lat, lon, catchment_km2). The results
// file holds station rows, so write it outside the repo (e.g. ~/.cache);
// `--summary` prints only aggregates, which is what the doc quotes.
//
//   DEM_URL=http://localhost:9002/tiles/terrain.pmtiles \
//   tsx --env-file=.env.development scripts/research/snap-gauges.ts <stations.csv> <out.json> [--shard i/n] [--limit n] [--no-start]
//   (rerun the same command to resume a shard that stopped)
//   DEM_URL=… tsx scripts/research/snap-gauges.ts --shift <out.json> …   (finding 6's probe on the too_large refusals, written back)
//   tsx scripts/research/snap-gauges.ts --summary <out.json> [<out2.json> …]
//
// The reference tables are read as their owner (MIGRATION_DATABASE_URL), as
// in the other harnesses. Delineate's 20 s budget is lifted (budgetMs:
// Infinity): this machine's speed under several shards is not the Lambda's,
// and a refusal from the clock would hide what the window ladder does.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import type { Position } from '../../src/geo/geojson.js';
import { configuredDem, type Dem } from '../../src/delineation/dem.js';
import { DelineationRefused, EARTH_RADIUS_M, JOB_WINDOWS, readWindow, TARGET_ZOOM, toPx, WINDOWS, worldPx, delineate } from '../../src/delineation/delineate.js';
import { accumulate, d8, edgeMask, fill, touchesEdge, upstream } from '../../src/delineation/flow.js';
import { MATCH_RADIUS_M, place } from '../../src/delineation/place.js';
import { pointReaches, PointsAtConfluence } from '../../src/delineation/pointPlacement.js';
import { ConfluenceAmbiguity, lineDistM, reachesNear, reachFor } from '../../src/delineation/reach.js';
import { delineateUnits, type PlacementHints } from '../../src/delineation/subcatchments.js';
import type { Db } from '../../src/db/tx.js';

interface Station {
	id: string;
	river: string;
	lon: number;
	lat: number;
	km2: number;
}

/** One request through the app's path, and what came back. */
interface Attempt {
	click: Position;
	reach: { reachId: number; km2: number; distanceM: number } | null;
	/** The confluence question was asked: how many rivers, and the one the oracle picked. */
	confluence: { choices: number; picked: { reachId: number; km2: number; role: string } } | null;
	how: 'matched' | 'snapped' | 'junction' | null;
	km2: number | null;
	movedM: number | null;
	windowCells: number | null;
	unmatched: boolean;
	/** Placed at the DEM's junction more than JUNCTION_FLAG_M from the click (flagged with the proposal). */
	farJunction?: boolean;
	refused: { code: string; message: string; larger?: { at: Position; km2: number; distanceM: number; reachKm2?: number } } | null;
	/** Where it ended: the request's windows, or (a too_large at the request's last window) the worker's from the next. Absent in runs before r5. */
	stage?: 'request' | 'worker';
	ms: number;
}

/** Start from the map with the station as its outlet gauge and no other point (start.ts → delineateUnits, its default windows). */
interface StartAttempt {
	confluence: boolean;
	placedBy: string | null;
	km2: number | null;
	unmatched: boolean;
	/** The outlet's larger-channel warning (Start proposes and warns; it doesn't refuse). */
	larger: { km2: number; reachKm2?: number } | null;
	refused: { code: string; message: string } | null;
	windowCells: number | null;
	ms: number;
}

interface Diagnosis {
	/** The app's path again, with only the largest window. */
	at3072: { km2: number | null; how: string | null; refused: string | null };
	/** On one 3 072-cell routing: the area match for the reach within 1 km and 2.5 km, and for the published area within 2.5 km. */
	reachMatch1km: { km2: number; distM: number } | null;
	reachMatch2500: { km2: number; distM: number } | null;
	publishedMatch2500: { km2: number; distM: number } | null;
	maxWithin1kmKm2: number;
	maxWithin2500Km2: number;
	/** The nearest HydroRIVERS junction (a downstream end two or more reaches share) within 1.5 km (m). */
	junctionM: number | null;
}

interface Result {
	station: Station;
	/** The nearest HydroRIVERS reach at any distance up to 5 km: how far the published position is from a mapped river. */
	nearestReach: { reachId: number; km2: number; distanceM: number } | null;
	/** The reach within 2 km whose area is nearest the published one: is the gauge's river mapped nearby at all. */
	bestReach2km: { reachId: number; km2: number; distanceM: number } | null;
	first: Attempt;
	/** After a larger-channel refusal: "Use that channel". */
	followed: Attempt | null;
	/** After a larger-channel refusal: "Keep my point" (keepPoint), the editor's other answer. Absent in runs before r5. */
	kept?: Attempt | null;
	/** Start's path at the station (absent in runs before r5); `startLarger`: its "Use that channel for the outlet" after a warning. */
	start?: StartAttempt | null;
	startLarger?: StartAttempt | null;
	diagnosis: Diagnosis | null;
	/** `--shift` on a too_large refusal: the same 3 072-cell window moved towards the cut catchment (persona finding 6). */
	shift?: Shift;
	skipped?: string;
}

function parseCsv(text: string): Record<string, string>[] {
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	const split = (l: string) => {
		const out: string[] = [];
		let cur = '';
		let q = false;
		for (let i = 0; i < l.length; i++) {
			const ch = l[i]!;
			if (q) {
				if (ch === '"' && l[i + 1] === '"') (cur += '"'), i++;
				else if (ch === '"') q = false;
				else cur += ch;
			} else if (ch === '"') q = true;
			else if (ch === ',') out.push(cur), (cur = '');
			else cur += ch;
		}
		out.push(cur);
		return out;
	};
	const head = split(lines[0]!).map((h) => h.trim().toLowerCase());
	return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v.trim()])));
}

function stationsFrom(file: string): Station[] {
	return parseCsv(readFileSync(file, 'utf8'))
		.map((r) => ({
			id: r.grdc_no ?? r.code ?? '',
			river: r.river ?? '',
			lon: Number(r.long ?? r.lon),
			lat: Number(r.lat),
			km2: Number(r.area ?? r.catchment_km2)
		}))
		.filter((s) => s.id && Number.isFinite(s.lon) && Number.isFinite(s.lat) && s.km2 > 0);
}

const STRATA = [
	{ id: '< 100 km²', lo: 0, hi: 100 },
	{ id: '100–1 000 km²', lo: 100, hi: 1000 },
	{ id: '1 000–10 000 km²', lo: 1000, hi: 10000 },
	{ id: '≥ 10 000 km² (main stems)', lo: 10000, hi: Infinity }
];
const OFF_RIVER = [
	{ id: '≤ 150 m', lo: 0, hi: 150 },
	{ id: '150–500 m', lo: 150, hi: 500 },
	{ id: '500 m–1 km', lo: 500, hi: 1000 },
	{ id: '> 1 km (no reach for the app)', lo: 1000, hi: Infinity }
];

async function attempt(db: Db, dem: Dem, click: Position, published: number, keepPoint = false): Promise<Attempt> {
	const t0 = performance.now();
	const base = { click, reach: null, confluence: null, how: null, km2: null, movedM: null, windowCells: null, unmatched: false, refused: null } as Omit<Attempt, 'ms'>;
	let r;
	let confluence: Attempt['confluence'] = null;
	try {
		r = await reachFor(db, click, null);
	} catch (err) {
		if (!(err instanceof ConfluenceAmbiguity)) throw err;
		// The oracle: the river whose area is nearest the published one.
		const pick = err.choices.reduce((b, c) => (Math.abs(Math.log(c.upstreamKm2 / published)) < Math.abs(Math.log(b.upstreamKm2 / published)) ? c : b));
		confluence = { choices: err.choices.length, picked: { reachId: pick.reachId, km2: pick.upstreamKm2, role: pick.role } };
		r = await reachFor(db, click, { dataset: pick.dataset, reachId: pick.reachId });
	}
	const reach = r.reach ? { reachId: r.reach.reachId, km2: r.reach.upstreamKm2, distanceM: r.reach.distanceM } : null;
	// As routes.ts sends it: the request's windows capped at the worker's last; a too_large at the request's last window goes to the
	// worker (jobs/handlers/delineate.ts) from the next window, its first placed over where the request's cut the catchment.
	const opts = {
		expected: r.reach ? { km2: r.reach.upstreamKm2, reach: `reach ${r.reach.reachId} of ${r.reach.dataset}`, chosen: !!confluence, distanceM: r.reach.distanceM } : null,
		junction: r.junction,
		keepPoint,
		budgetMs: Infinity
	};
	let stage: 'request' | 'worker' = 'request';
	try {
		let d;
		try {
			d = await delineate(dem, click, { ...opts, windows: WINDOWS, capCells: JOB_WINDOWS[JOB_WINDOWS.length - 1] });
		} catch (err) {
			const from = err instanceof DelineationRefused && err.code === 'too_large' && err.windowCells !== undefined ? JOB_WINDOWS.find((w) => w > err.windowCells!) : undefined;
			if (from === undefined) throw err;
			stage = 'worker';
			d = await delineate(dem, click, { ...opts, windows: JOB_WINDOWS.filter((w) => w >= from), aim: (err as DelineationRefused).aim ?? null });
		}
		const how = d.method.includes("DEM's own junction") ? 'junction' : d.method.includes('best matches') ? 'matched' : 'snapped';
		return { ...base, reach, confluence, how, km2: d.areaM2 / 1e6, movedM: d.snapDistanceM, windowCells: d.windowCells, unmatched: !!d.unmatched, farJunction: !!d.farJunction, stage, ms: performance.now() - t0 };
	} catch (err) {
		if (!(err instanceof DelineationRefused)) throw err;
		const larger = err.larger ? { at: err.larger.at, km2: err.larger.km2, distanceM: err.larger.distanceM, ...(err.larger.reachKm2 !== undefined ? { reachKm2: err.larger.reachKm2 } : {}) } : undefined;
		return { ...base, reach, confluence, refused: { code: err.code, message: err.message, ...(larger ? { larger } : {}) }, stage, ms: performance.now() - t0 };
	}
}

/**
 * Start from the map at the station (start.ts): the station as the outlet gauge, no other point, its reach looked up as pointReaches
 * does (the oracle's river at a confluence), divided by delineateUnits with Start's own windows (no worker). `useLarger`: the
 * editor's "Use that channel for the outlet" after the outlet's larger-channel warning.
 */
async function startAttempt(db: Db, dem: Dem, s: Station, useLarger = false): Promise<StartAttempt> {
	const t0 = performance.now();
	const at: Position = [s.lon, s.lat];
	let confluence = false;
	let hints: PlacementHints | undefined;
	try {
		hints = (await pointReaches(db, [{ key: '', name: 'Gauge', at, useLarger }])).get('')?.hints;
	} catch (err) {
		if (!(err instanceof PointsAtConfluence)) throw err;
		const choices = err.points[0]!.choices;
		const pick = choices.reduce((b, c) => (Math.abs(Math.log(c.upstreamKm2 / s.km2)) < Math.abs(Math.log(b.upstreamKm2 / s.km2)) ? c : b));
		confluence = true;
		hints = (await pointReaches(db, [{ key: '', name: 'Gauge', at, reach: { dataset: pick.dataset, reachId: pick.reachId }, useLarger }])).get('')?.hints;
	}
	try {
		const r = await delineateUnits(dem, { outlet: at, outletHints: hints, boundary: null, points: [] }, { budgetMs: Infinity });
		const o = r.outlet;
		return {
			confluence,
			placedBy: o.placedBy ?? null,
			km2: r.catchment.areaM2 / 1e6,
			unmatched: !!o.unmatched,
			larger: o.larger ? { km2: o.larger.km2, ...(o.larger.reachKm2 !== undefined ? { reachKm2: o.larger.reachKm2 } : {}) } : null,
			refused: null,
			windowCells: r.windowCells,
			ms: performance.now() - t0
		};
	} catch (err) {
		if (!(err instanceof DelineationRefused)) throw err;
		return { confluence, placedBy: null, km2: null, unmatched: false, larger: null, refused: { code: err.code, message: err.message }, windowCells: null, ms: performance.now() - t0 };
	}
}

async function diagnose(db: Db, dem: Dem, s: Station, reachKm2: number | null): Promise<Diagnosis> {
	const click: Position = [s.lon, s.lat];
	let at3072: Diagnosis['at3072'];
	try {
		const r = await reachFor(db, click, null).catch(() => ({ reach: null, junction: null }));
		const d = await delineate(dem, click, { windows: [3072], budgetMs: Infinity, expected: r.reach ? { km2: r.reach.upstreamKm2, reach: String(r.reach.reachId) } : null });
		at3072 = { km2: d.areaM2 / 1e6, how: d.method.includes('best matches') ? 'matched' : 'snapped', refused: null };
	} catch (err) {
		if (!(err instanceof DelineationRefused)) throw err;
		at3072 = { km2: null, how: null, refused: err.code };
	}
	const info = await dem.info();
	const z = Math.min(TARGET_ZOOM, info.maxZoom);
	const p = toPx(s.lon, s.lat, 2 ** z);
	const tile = await dem.tile(z, Math.floor(p[0]), Math.floor(p[1]));
	const N = 3072;
	const W = worldPx(z, tile!.size);
	const [gx, gy] = toPx(s.lon, s.lat, W);
	const x0 = Math.floor(gx) - N / 2;
	const y0 = Math.floor(gy) - N / 2;
	const grid = await readWindow(dem, z, tile!.size, x0, y0, N);
	const edge = edgeMask(grid);
	fill(grid, edge);
	const dir = d8(grid, edge);
	const acc = accumulate(N, N, dir);
	const cellSizeM = (2 * Math.PI * EARTH_RADIUS_M * Math.cos((s.lat * Math.PI) / 180)) / W;
	const cellKm2 = (cellSizeM * cellSizeM) / 1e6;
	const g = { nx: N, ny: N, acc, edge, cellSizeM };
	const cx = gx - x0;
	const cy = gy - y0;
	const distM = (c: number) => Math.hypot((c % N) + 0.5 - cx, Math.floor(c / N) + 0.5 - cy) * cellSizeM;
	const match = (km2: number | null, R: number) => {
		if (!km2) return null;
		// place() takes no radius since delineate-5: 1 km is an unnamed click as placed (rule 3 can decline it), 2.5 km a named river.
		const pl = place(g, cx, cy, { snapRadiusM: 150, expectedKm2: km2, chosen: R > MATCH_RADIUS_M });
		return pl && pl.how === 'matched' ? { km2: acc[pl.cell]! * cellKm2, distM: distM(pl.cell) } : null;
	};
	const maxWithin = (m: number) => {
		let best = 0;
		const r = Math.ceil(m / cellSizeM);
		for (let y = Math.floor(cy) - r; y <= Math.floor(cy) + r; y++)
			for (let x = Math.floor(cx) - r; x <= Math.floor(cx) + r; x++) {
				const c = y * N + x;
				if (!edge[c] && distM(c) <= m && acc[c]! > best) best = acc[c]!;
			}
		return best * cellKm2;
	};
	// Junctions: downstream ends two or more reaches share (HydroRIVERS lines meet on a shared vertex).
	const near = await reachesNear(db, click, 1500);
	const ends = new Map<string, number>();
	for (const n of near) ends.set(n.end.join(','), (ends.get(n.end.join(',')) ?? 0) + 1);
	let junctionM: number | null = null;
	for (const [k, count] of ends) {
		if (count < 2) continue;
		const d = lineDistM(click, [k.split(',').map(Number) as Position, k.split(',').map(Number) as Position]);
		if (junctionM === null || d < junctionM) junctionM = d;
	}
	return {
		at3072,
		reachMatch1km: match(reachKm2, MATCH_RADIUS_M),
		reachMatch2500: match(reachKm2, 2500),
		publishedMatch2500: match(s.km2, 2500),
		maxWithin1kmKm2: maxWithin(1000),
		maxWithin2500Km2: maxWithin(2500),
		junctionM
	};
}

interface Shift {
	/** Which sides of the click-centred window the cut catchment touched (n, e, s, w). */
	sides: string[];
	/** Its extent from the outlet in the click-centred window (km): up to the window's half side on a touched side. */
	extentKm: { n: number; e: number; s: number; w: number };
	/** After up to three moves of the window towards the catchment: whole, its area (km²), or still cut. */
	whole: boolean;
	km2: number | null;
	moves: number;
}

/**
 * Persona finding 6: Delineate centres every window on the click, so half of it lies downstream and a catchment
 * longer than half the window is refused. Route the 3 072-cell window, place the outlet as the app does, and while
 * the catchment touches the window's edge, move the window's centre to the cut catchment's box (the click kept at
 * least 1 km inside), up to three times.
 */
async function shiftProbe(dem: Dem, s: Station, reachKm2: number | null): Promise<Shift> {
	const info = await dem.info();
	const z = Math.min(TARGET_ZOOM, info.maxZoom);
	const p = toPx(s.lon, s.lat, 2 ** z);
	const tile = await dem.tile(z, Math.floor(p[0]), Math.floor(p[1]));
	const N = 3072;
	const W = worldPx(z, tile!.size);
	const [gx, gy] = toPx(s.lon, s.lat, W);
	const cellSizeM = (2 * Math.PI * EARTH_RADIUS_M * Math.cos((s.lat * Math.PI) / 180)) / W;
	const margin = Math.ceil(1000 / cellSizeM);
	let x0 = Math.floor(gx) - N / 2;
	let y0 = Math.floor(gy) - N / 2;
	let first: Pick<Shift, 'sides' | 'extentKm'> | null = null;
	for (let move = 0; move <= 3; move++) {
		const grid = await readWindow(dem, z, tile!.size, x0, y0, N);
		const edge = edgeMask(grid);
		fill(grid, edge);
		const dir = d8(grid, edge);
		const acc = accumulate(N, N, dir);
		const pl = place({ nx: N, ny: N, acc, edge, cellSizeM }, gx - x0, gy - y0, { snapRadiusM: 150, expectedKm2: reachKm2 });
		if (!pl) return { ...(first ?? { sides: [], extentKm: { n: 0, e: 0, s: 0, w: 0 } }), whole: false, km2: null, moves: move };
		const mask = upstream(N, N, dir, pl.cell);
		let minX = N, maxX = 0, minY = N, maxY = 0, cells = 0;
		for (let i = 0; i < mask.length; i++) {
			if (!mask[i]) continue;
			cells++;
			const x = i % N;
			const y = (i - x) / N;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
		const touch = touchesEdge(grid, edge, mask);
		if (!first) {
			const ox = pl.cell % N;
			const oy = (pl.cell - ox) / N;
			const km = (c: number) => Math.round((c * cellSizeM) / 100) / 10;
			first = {
				sides: [minY <= 1 ? 'n' : '', maxX >= N - 2 ? 'e' : '', maxY >= N - 2 ? 's' : '', minX <= 1 ? 'w' : ''].filter(Boolean),
				extentKm: { n: km(oy - minY), e: km(maxX - ox), s: km(maxY - oy), w: km(ox - minX) }
			};
		}
		if (!touch.edge) return { ...first, whole: true, km2: (cells * cellSizeM * cellSizeM) / 1e6, moves: move };
		if (touch.noData) break;
		// Centre on the cut catchment's box, keeping the click inside by the margin.
		const cx = x0 + (minX + maxX) / 2;
		const cy = y0 + (minY + maxY) / 2;
		const clamp = (c: number, g: number) => Math.min(Math.max(Math.floor(c - N / 2), Math.floor(g) - N + margin), Math.floor(g) - margin);
		const nx0 = clamp(cx, gx);
		const ny0 = clamp(cy, gy);
		if (nx0 === x0 && ny0 === y0) break;
		x0 = nx0;
		y0 = ny0;
	}
	return { ...first!, whole: false, km2: null, moves: 3 };
}

/** Local MinIO sometimes closes a kept-alive socket under several shards ("fetch failed"): try the station again. */
async function retried<T>(f: () => Promise<T>): Promise<T> {
	for (let k = 0; ; k++) {
		try {
			return await f();
		} catch (err) {
			if (k >= 3 || !(err instanceof TypeError && err.message === 'fetch failed')) throw err;
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}

async function shiftAll(files: string[]) {
	const dem = configuredDem();
	if (!dem) throw new Error('DEM_URL is empty');
	for (const f of files) {
		const data = JSON.parse(readFileSync(f, 'utf8')) as { results: Result[] };
		for (const r of data.results) {
			if (r.shift || r.first.refused?.code !== 'too_large' || isMain(r.station)) continue;
			r.shift = await retried(() => shiftProbe(dem, r.station, r.first.reach?.km2 ?? null));
			console.error(`${r.station.km2} km²: ${r.shift.sides.join('')} → ${r.shift.whole ? `whole ${r.shift.km2!.toFixed(0)} after ${r.shift.moves}` : 'still cut'}`);
			writeFileSync(f, JSON.stringify(data, null, 1));
		}
	}
}

const ok = (a: Attempt, km2: number) => a.km2 !== null && a.km2 / km2 >= 0.5 && a.km2 / km2 <= 2;
const isMain = (s: Station) => s.km2 >= 10000;
/** A failure worth diagnosing: a refusal (other than too_large on a main stem) or an area outside ½–2×. */
const failed = (r: Result) => (r.first.refused ? !(r.first.refused.code === 'too_large' && isMain(r.station)) : !ok(r.first, r.station.km2));

async function run(csv: string, out: string, shard: [number, number], limit: number, noStart: boolean) {
	const dem = configuredDem();
	if (!dem) throw new Error('DEM_URL is empty');
	const info = await dem.info();
	const [w, so, e, n] = info.bounds;
	const all = stationsFrom(csv);
	const inside = all.filter((s) => s.lon >= w && s.lon <= e && s.lat >= so && s.lat <= n);
	const mine = inside.filter((_, i) => i % shard[1] === shard[0]).slice(0, limit);
	console.error(`${all.length} stations, ${inside.length} inside ${info.label}; shard ${shard[0]}/${shard[1]}: ${mine.length}`);
	const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL });
	await db.connect();
	// Resume: a rerun with the same out file keeps what it has (a dropped connection to the DEM ends a run).
	const results: Result[] = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { results: Result[] }).results : [];
	const done = new Set(results.map((r) => r.station.id));
	for (const [k, s] of mine.entries()) {
		if (done.has(s.id)) continue;
		const click: Position = [s.lon, s.lat];
		const around = await reachesNear(db as unknown as Db, click, 5000);
		const nearestReach = around[0] ? { reachId: around[0].reachId, km2: around[0].upstreamKm2, distanceM: around[0].distanceM } : null;
		const within2 = around.filter((r) => r.distanceM <= 2000);
		const best = within2.reduce<(typeof within2)[number] | null>((b, r) => (!b || Math.abs(Math.log(r.upstreamKm2 / s.km2)) < Math.abs(Math.log(b.upstreamKm2 / s.km2)) ? r : b), null);
		const bestReach2km = best ? { reachId: best.reachId, km2: best.upstreamKm2, distanceM: best.distanceM } : null;
		const first = await retried(() => attempt(db as unknown as Db, dem, click, s.km2));
		const followed = first.refused?.larger ? await retried(() => attempt(db as unknown as Db, dem, first.refused!.larger!.at, s.km2)) : null;
		const kept = first.refused?.larger ? await retried(() => attempt(db as unknown as Db, dem, click, s.km2, true)) : null;
		const start = noStart ? null : await retried(() => startAttempt(db as unknown as Db, dem, s));
		const startLarger = start?.larger ? await retried(() => startAttempt(db as unknown as Db, dem, s, true)) : null;
		const r: Result = { station: s, nearestReach, bestReach2km, first, followed, kept, start, startLarger, diagnosis: null };
		if (failed(r)) r.diagnosis = await retried(() => diagnose(db as unknown as Db, dem, s, first.reach?.km2 ?? null));
		results.push(r);
		const shown = first.refused ? first.refused.code : `${first.how} ${first.km2!.toFixed(0)}${first.stage === 'worker' ? ' (worker)' : ''}`;
		const started = start ? ` | start ${start.refused?.code ?? `${start.placedBy} ${start.km2!.toFixed(0)}`}` : '';
		console.error(`${k + 1}/${mine.length}: ${s.km2} km² → ${shown}${followed ? ` → ${followed.refused?.code ?? followed.km2?.toFixed(0)}` : ''}${started} (${(first.ms / 1000).toFixed(1)} s)`);
		writeFileSync(out, JSON.stringify({ dataset: info.label, shard, results }, null, 1));
	}
	await db.end();
}

/** Aggregates only: counts and quantiles, no station's id, name, position or area. */
function summary(files: string[]) {
	const rs: Result[] = files.flatMap((f) => (JSON.parse(readFileSync(f, 'utf8')) as { results: Result[] }).results);
	const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)} %` : '–');
	const q = (xs: number[], p: number) => {
		if (!xs.length) return NaN;
		const s = [...xs].sort((a, b) => a - b);
		return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
	};
	const f2 = (x: number) => (Number.isNaN(x) ? '–' : x.toFixed(2));
	const lines: string[] = [];
	const table = (title: string, groups: { id: string; rs: Result[] }[]) => {
		lines.push(`### ${title}`, '', '| Stratum | n | ½–2× | accepted outside ½–2× (silent / with a caveat) | refused | too_large | larger_channel asked | asked a confluence | matched / junction / snapped | proposed by the worker (½–2×) | median ratio | ratio p10–p90 | median moved (m) |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
		for (const g of groups) {
			const n = g.rs.length;
			const good = g.rs.filter((r) => ok(r.first, r.station.km2)).length;
			const ref = g.rs.filter((r) => r.first.refused).length;
			const wrong = g.rs.filter((r) => r.first.km2 !== null && !ok(r.first, r.station.km2));
			const flagged = (a: Attempt) => a.unmatched || !!a.farJunction;
			const wrongText = `${wrong.filter((r) => !flagged(r.first)).length} / ${wrong.filter((r) => flagged(r.first)).length}`;
			const worker = g.rs.filter((r) => r.first.stage === 'worker' && !r.first.refused);
			const tl = g.rs.filter((r) => r.first.refused?.code === 'too_large').length;
			const lc = g.rs.filter((r) => r.first.refused?.code === 'larger_channel').length;
			const cf = g.rs.filter((r) => r.first.confluence).length;
			const by = (h: string) => g.rs.filter((r) => r.first.how === h).length;
			const ratios = g.rs.filter((r) => r.first.km2 !== null).map((r) => r.first.km2! / r.station.km2);
			const moved = g.rs.filter((r) => r.first.movedM !== null).map((r) => r.first.movedM!);
			lines.push(
				`| ${g.id} | ${n} | ${good} (${pct(good, n)}) | ${wrongText} | ${ref} | ${tl} | ${lc} | ${cf} | ${by('matched')} / ${by('junction')} / ${by('snapped')} | ${worker.length} (${worker.filter((r) => ok(r.first, r.station.km2)).length}) | ${f2(q(ratios, 0.5))} | ${f2(q(ratios, 0.1))}–${f2(q(ratios, 0.9))} | ${Math.round(q(moved, 0.5)) || '–'} |`
			);
		}
		lines.push('');
	};
	const valid = rs.filter((r) => !r.skipped);
	table('By published catchment area', STRATA.map((s) => ({ id: s.id, rs: valid.filter((r) => r.station.km2 >= s.lo && r.station.km2 < s.hi) })));
	const offOf = (r: Result) => r.nearestReach?.distanceM ?? Infinity;
	table('By the published position’s distance from the nearest HydroRIVERS reach', OFF_RIVER.map((o) => ({ id: o.id, rs: valid.filter((r) => offOf(r) >= o.lo && offOf(r) < o.hi) })));
	const below10k = valid.filter((r) => !isMain(r.station));
	table('Below 10 000 km², by how it was placed', ['matched', 'junction', 'snapped', null].map((h) => ({ id: h ?? 'refused', rs: below10k.filter((r) => r.first.how === h) })));

	// Does HydroRIVERS agree with the published area (the reference the first three experiments trusted)?
	const withReach = below10k.filter((r) => r.first.reach);
	const hrRatios = withReach.map((r) => r.first.reach!.km2 / r.station.km2);
	lines.push(
		`HydroRIVERS against the published area (below 10 000 km², the reach the app used, n = ${withReach.length}): median ${f2(q(hrRatios, 0.5))}, p10–p90 ${f2(q(hrRatios, 0.1))}–${f2(q(hrRatios, 0.9))}, within ½–2× ${pct(hrRatios.filter((x) => x >= 0.5 && x <= 2).length, hrRatios.length)}.`,
		''
	);

	// On the matched points: does the DEM's area at the gauge follow HydroRIVERS, or the published area?
	const m = below10k.filter((r) => r.first.how === 'matched' && r.first.reach);
	const hrOff = m.filter((r) => {
		const h = r.first.reach!.km2 / r.station.km2;
		return (h > 1.1 && h <= 2) || (h >= 0.5 && h < 0.9);
	});
	const near10 = (x: number) => x >= 0.9 && x <= 1.1;
	lines.push(
		`Matched points (n = ${m.length}): HydroRIVERS p10–p50–p90 ${f2(q(m.map((r) => r.first.reach!.km2 / r.station.km2), 0.1))}–${f2(q(m.map((r) => r.first.reach!.km2 / r.station.km2), 0.5))}–${f2(q(m.map((r) => r.first.reach!.km2 / r.station.km2), 0.9))}, the app ${f2(q(m.map((r) => r.first.km2! / r.station.km2), 0.1))}–${f2(q(m.map((r) => r.first.km2! / r.station.km2), 0.5))}–${f2(q(m.map((r) => r.first.km2! / r.station.km2), 0.9))}. Where HydroRIVERS is 10–100 % off the published area (n = ${hrOff.length}), the app is within 10 % of it at ${hrOff.filter((r) => near10(r.first.km2! / r.station.km2)).length}, and over 1.1× where HydroRIVERS is over at ${hrOff.filter((r) => r.first.reach!.km2 > 1.1 * r.station.km2 && r.first.km2! > 1.1 * r.station.km2).length} of ${hrOff.filter((r) => r.first.reach!.km2 > 1.1 * r.station.km2).length}.`,
		''
	);

	// Failure classes (below 10 000 km²), first matching class wins.
	const band = (x: number) => x >= 0.5 && x <= 2;
	const reachOff = (r: Result) => !!r.first.reach && !band(r.first.reach.km2 / r.station.km2);
	const classes: [string, (r: Result) => boolean][] = [
		['refused too_large', (r) => r.first.refused?.code === 'too_large'],
		['refused larger_channel', (r) => r.first.refused?.code === 'larger_channel'],
		['refused, other', (r) => !!r.first.refused],
		['no reach within 1 km (the published position off the mapped river): snapped', (r) => !r.first.reach],
		[
			'the nearest reach is a smaller stream, while a cell within 150 m drains the published area: moved onto that stream',
			(r) => reachOff(r) && r.first.reach!.km2 < r.station.km2 && !!r.diagnosis?.publishedMatch2500 && r.diagnosis.publishedMatch2500.distM <= 150
		],
		['the nearest reach is a larger river: moved onto it', (r) => reachOff(r) && r.first.reach!.km2 > r.station.km2 && !r.first.refused && (r.first.km2 ?? 0) > 2 * r.station.km2],
		['the nearest reach is another stream (a reach within 2 km matches the published area)', (r) => reachOff(r) && !!r.bestReach2km && band(r.bestReach2km.km2 / r.station.km2)],
		['HydroRIVERS has no reach within 2 km near the published area', (r) => reachOff(r)],
		['ok at a 3 072-cell window (the first window too small)', (r) => !!r.diagnosis?.at3072.km2 && band(r.diagnosis.at3072.km2 / r.station.km2)],
		['the reach’s area matched only at a 3 072-cell window', (r) => !!r.diagnosis?.reachMatch1km && r.first.how === 'snapped'],
		['snapped; the reach’s channel within 2.5 km', (r) => r.first.how === 'snapped' && !!r.diagnosis?.reachMatch2500],
		['snapped; no matching channel within 2.5 km', (r) => r.first.how === 'snapped'],
		['matched / junction, yet outside ½–2×', () => true]
	];
	const fails = below10k.filter((r) => failed(r));
	lines.push(`### Failures below 10 000 km² (${fails.length} of ${below10k.length})`, '', '| Class | n | silent (accepted, no caveat) | caveat only (unmatched) | ≥ 500 m from a reach | a HydroRIVERS junction within 1 km |', '|---|---|---|---|---|---|');
	const seen = new Set<Result>();
	for (const [name, test] of classes) {
		const c = fails.filter((r) => !seen.has(r) && test(r));
		c.forEach((r) => seen.add(r));
		if (!c.length) continue;
		const silent = c.filter((r) => !r.first.refused && !r.first.unmatched && !r.first.farJunction).length;
		const caveat = c.filter((r) => !r.first.refused && (r.first.unmatched || r.first.farJunction)).length;
		lines.push(`| ${name} | ${c.length} | ${silent} | ${caveat} | ${c.filter((r) => offOf(r) >= 500).length} | ${c.filter((r) => r.diagnosis?.junctionM !== null && (r.diagnosis?.junctionM ?? Infinity) <= 1000).length} |`);
	}
	const shifted = below10k.filter((r) => r.shift);
	if (shifted.length) {
		const whole = shifted.filter((r) => r.shift!.whole);
		const wr = whole.map((r) => r.shift!.km2! / r.station.km2);
		const sides = (n: number) => shifted.filter((r) => r.shift!.sides.length === n).length;
		lines.push(
			'',
			`too_large below 10 000 km², the 3 072-cell window moved towards the cut catchment (\`--shift\`, n = ${shifted.length}): touched one side ${sides(1)}, two ${sides(2)}, more ${shifted.length - sides(1) - sides(2)}; whole after moving ${whole.length} (median ${f2(q(wr, 0.5))}× the published area, ${whole.filter((r) => band(r.shift!.km2! / r.station.km2)).length} within ½–2×); still cut ${shifted.length - whole.length}.`
		);
	}
	lines.push('');
	const lc = valid.filter((r) => r.followed);
	if (lc.length) {
		const fixed = lc.filter((r) => ok(r.followed!, r.station.km2)).length;
		const kept = lc.filter((r) => r.kept);
		const keptOk = kept.filter((r) => ok(r.kept!, r.station.km2)).length;
		const either = kept.filter((r) => ok(r.followed!, r.station.km2) || ok(r.kept!, r.station.km2)).length;
		const byReach = lc.filter((r) => r.first.refused?.larger?.reachKm2 !== undefined);
		lines.push(
			`"Use that channel" after a larger_channel refusal: ${fixed} of ${lc.length} then within ½–2×${kept.length ? `; "Keep my point" ${keptOk} of ${kept.length}; either answer (an editor who knows the gauge's river) ${either} of ${kept.length}` : ''}. Offered as the reach's matching channel (place.ts rules 3 and 4): ${byReach.length}, of which "Use that channel" right at ${byReach.filter((r) => ok(r.followed!, r.station.km2)).length}${kept.length ? ` and "Keep my point" at ${byReach.filter((r) => r.kept && ok(r.kept, r.station.km2)).length}` : ''}.`,
			''
		);
	}
	const viaWorker = valid.filter((r) => r.first.stage === 'worker');
	if (viaWorker.length) {
		const slow = viaWorker.filter((r) => r.first.ms > 150_000).length;
		lines.push(
			`Sent to the worker (a too_large at the request's 3 072 cells): ${viaWorker.length}; proposed ${viaWorker.filter((r) => !r.first.refused).length} (${viaWorker.filter((r) => ok(r.first, r.station.km2)).length} within ½–2×), refused too_large ${viaWorker.filter((r) => r.first.refused?.code === 'too_large').length}, other refusals ${viaWorker.filter((r) => r.first.refused && r.first.refused.code !== 'too_large').length}. Request and worker together over the worker's 150 s on this machine (under several shards; Delineate's budget lifted): ${slow}. Request-only results over the request's 20 s: ${valid.filter((r) => r.first.stage === 'request' && r.first.ms > 20_000).length}.`,
			''
		);
	}

	// Start's path at the same stations (r5 runs on).
	const started = valid.filter((r) => r.start);
	if (started.length) {
		const okS = (a: StartAttempt | null | undefined, km2: number) => !!a && a.km2 !== null && a.km2 / km2 >= 0.5 && a.km2 / km2 <= 2;
		lines.push(
			'### Start from the map, the station as its outlet gauge',
			'',
			'| Stratum | n | ½–2× | accepted outside ½–2× (silent / with a warning) | refused too_large | refused, other | asked a confluence | matched / junction / snapped / other | median ratio | Delineate ½–2× there | both ½–2×, areas within 5 % of each other |',
			'|---|---|---|---|---|---|---|---|---|---|---|'
		);
		for (const st of STRATA) {
			const g = started.filter((r) => r.station.km2 >= st.lo && r.station.km2 < st.hi);
			const good = g.filter((r) => okS(r.start, r.station.km2)).length;
			const wrong = g.filter((r) => r.start!.km2 !== null && !okS(r.start, r.station.km2));
			const warned = (a: StartAttempt) => a.unmatched || !!a.larger;
			const by = (h: string) => g.filter((r) => r.start!.placedBy === h).length;
			const ratios = g.filter((r) => r.start!.km2 !== null).map((r) => r.start!.km2! / r.station.km2);
			const both = g.filter((r) => okS(r.start, r.station.km2) && ok(r.first, r.station.km2));
			const agree = both.filter((r) => Math.abs(r.start!.km2! / r.first.km2! - 1) <= 0.05).length;
			lines.push(
				`| ${st.id} | ${g.length} | ${good} (${pct(good, g.length)}) | ${wrong.filter((r) => !warned(r.start!)).length} / ${wrong.filter((r) => warned(r.start!)).length} | ${g.filter((r) => r.start!.refused?.code === 'too_large').length} | ${g.filter((r) => r.start!.refused && r.start!.refused.code !== 'too_large').length} | ${g.filter((r) => r.start!.confluence).length} | ${by('matched')} / ${by('junction')} / ${by('snapped')} / ${by('larger') + by('exact')} | ${f2(q(ratios, 0.5))} | ${g.filter((r) => ok(r.first, r.station.km2)).length} | ${agree} of ${both.length} |`
			);
		}
		const sl = started.filter((r) => r.startLarger);
		lines.push(
			'',
			`Start's outlet warned of a larger channel: ${started.filter((r) => r.start!.larger).length}; "Use that channel for the outlet" then within ½–2× at ${sl.filter((r) => okS(r.startLarger, r.station.km2)).length} of ${sl.length}, as proposed (the warning ignored) at ${sl.filter((r) => okS(r.start, r.station.km2)).length}. Delineate right and Start wrong (below 10 000 km²): ${started.filter((r) => !isMain(r.station) && ok(r.first, r.station.km2) && !okS(r.start, r.station.km2)).length}; Start right and Delineate wrong: ${started.filter((r) => !isMain(r.station) && !ok(r.first, r.station.km2) && okS(r.start, r.station.km2)).length}.`,
			''
		);
	}
	const main = valid.filter((r) => isMain(r.station));
	lines.push(`Main stems (≥ 10 000 km²): ${main.length}; refused too_large ${main.filter((r) => r.first.refused?.code === 'too_large').length}, other refusals ${main.filter((r) => r.first.refused && r.first.refused.code !== 'too_large').length}, accepted ${main.filter((r) => !r.first.refused).length} (median accepted ratio ${f2(q(main.filter((r) => r.first.km2 !== null).map((r) => r.first.km2! / r.station.km2), 0.5))}).`);
	console.log(lines.join('\n'));
}

const args = process.argv.slice(2);
if (args[0] === '--summary') summary(args.slice(1));
else if (args[0] === '--shift') await shiftAll(args.slice(1));
else {
	const [csv, out] = args;
	if (!csv || !out) throw new Error('usage: snap-gauges.ts <stations.csv> <out.json> [--shard i/n] [--limit n] | --summary <out.json> …');
	const opt = (k: string, d: string) => {
		const i = args.indexOf(k);
		return i >= 0 ? args[i + 1]! : d;
	};
	const [i, n] = opt('--shard', '0/1').split('/').map(Number) as [number, number];
	await run(csv, out, [i, n], Number(opt('--limit', '100000')), args.includes('--no-start'));
}
