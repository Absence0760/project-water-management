// The bridge from the data mirror's C3S seasonal forecasts to the engine's
// forecast-conditioned outlook (issue #620 step 7; docs/model.md §2.15d
// § The backend bridge, docs/api.md § Seasonal outlooks). The engine takes
// each system's catchment-average monthly totals (SeasonalForecastSystem,
// SeasonalHindcastSystem); this module makes them from the copy's 1° daily
// arrays (ingest/c3s_seasonal.py):
//
//   c3s/<YYYY-MM>/tp_mm             (system, member, lead_day, lat, lon), the init month's forecasts
//   c3s-hc/<system>/<MM>/tp_mm      (year, member, lead_day, lat, lon), that init month's hindcasts
//   c3s/index.json                  { inits: { "YYYY-MM": [systems] }, hindcasts: { system: ["MM"] } }
//
// lead_day 0 is the init month's 1st (a hindcast year's own), 215 days, mm a
// day; NaN past what a system gives and in a member slot it doesn't fill.
//
// 1. **The area.** The project's catchment boundary on the map, else the
//    union of its units' polygons (the unit feeds' rule, geo/unitPolygon.ts).
//    Each 1° cell it touches weighs share inside × cos(the cell's latitude),
//    as feeds/boundaryCells.ts weighs CHIRPS cells: the mean is area weighted.
//    Without either polygon the outlook is off (`noArea`): there is nowhere to
//    average the forecasts over. Under runoff from each unit's own rain
//    (§2.4h) each unit's polygon is averaged on its own too, reported beside
//    the outlook (`units`); the engine rescales each unit's rain by the
//    catchment's factor, so only the catchment's totals drive it.
// 2. **The init.** Only forecasts *issued* on or before the decision date
//    (§2.15: nothing after it is known): C3S releases ECMWF's forecast from
//    init month M on the 6th of M and the other centres' on the 10th, at 12
//    UTC (ingest/c3srequest.py release_at, checked against it by
//    c3s.test.ts). The init is the newest whose month starts on or before the
//    decision date with at least one system issued by then; only those
//    systems are passed (the engine takes one init). A system issued later
//    is listed as not issued.
// 3. **Monthly totals.** Each member's daily catchment mean is Σ w·v ÷ Σ w
//    over the cells; a day with a NaN cell has none. Lead month k is the
//    calendar month k after the init month, its days counted from the init
//    month's 1st (a hindcast year's own, so a leap February is 29 days); a
//    member's months run up to the first that isn't whole, which is all the
//    engine reads (completeMonths). A member slot the system doesn't fill
//    (`members` attribute) isn't passed; one that is filled but has no whole
//    month is passed empty, so the engine counts it as dropped.
// 4. **The hindcasts.** For each system passed, its hindcast of the init's
//    calendar month, every year it holds; the engine fits on the years whose
//    months the record holds wholly before the decision date, needs 20, and
//    without one the outlook is off (`noHindcast`, `noQualifyingSystem`).
//
// Reads go through the mirror store (MIRROR_URL), one member's slab of the
// cells' bounding block at a time (its chunk is one member's whole forecast),
// READ_CONCURRENCY at once. The cost is a chunk per member per hindcast year:
// a system's 24 hindcast years × 25 members is 600 chunk reads, ~0.4 MB each.
import type { AbsolutePath } from '@zarrita/storage';
import * as zarr from 'zarrita';
import { z } from 'zod';
import { toEpochDay } from '@water-management/engine/calendar';
import type { SeasonalForecastSystem, SeasonalHindcastSystem } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { eachBand, GRID_WORK_BUDGET, GridWorkExceeded, openRing, signedArea2, type SignedPiece } from '../geo/clip.js';
import type { Geometry } from '../geo/geojson.js';
import { ONLY_PARCEL_SQL, UNIT_POLYGONS_SQL } from '../geo/unitPolygon.js';
import { MirrorFormatError } from '../mirror/arrays.js';
import { regionSize, SEASONAL_REGION, type Region } from '../mirror/grid.js';
import { registerNodeGzip, type MirrorStore } from '../mirror/store.js';

/** Days on the lead axis (ingest/c3srequest.py LEAD_DAYS). */
export const C3S_LEAD_DAYS = 215;
/** The day of the init month each centre's forecast is released on the CDS, at 12 UTC (ingest/c3srequest.py RELEASE_DAY). */
export const C3S_RELEASE_DAY: Readonly<Record<string, number>> = { ecmwf: 6 };
/** Every other centre's release day (ingest/c3srequest.py RELEASE_DAY_OTHERS). */
export const C3S_RELEASE_DAY_OTHERS = 10;
/** A bound on the work one outlook reads: systems of one init, members per system, hindcast years per system. */
export const C3S_SYSTEMS_MAX = 12;
export const C3S_MEMBERS_MAX = 60;
export const C3S_HINDCAST_YEARS_MAX = 40;
/** Chunk reads in flight at once. */
const READ_CONCURRENCY = 8;
/** A cell with less than this share of its area inside the polygon is left out (feeds/boundaryCells.ts MIN_SHARE). */
const MIN_SHARE = 1e-3;

const SYSTEM = /^[a-z_]+-\d+$/;
const INIT = /^\d{4}-(0[1-9]|1[0-2])$/;
const MM = /^(0[1-9]|1[0-2])$/;

const pad2 = (n: number) => String(n).padStart(2, '0');
const round = (x: number, places = 9) => Number(x.toFixed(places));

/** The day (ISO) `system`'s forecast from `init` (YYYY-MM) is released on the CDS: the 6th for ECMWF, the 10th for the others. */
export function c3sIssuedOn(system: string, init: string): string {
	const centre = system.replace(/-\d+$/, '');
	return `${init}-${pad2(Object.hasOwn(C3S_RELEASE_DAY, centre) ? C3S_RELEASE_DAY[centre]! : C3S_RELEASE_DAY_OTHERS)}`;
}

// ─── The area ───────────────────────────────────────────────────────────────

/** One 1° cell an area covers: its (y, x) on the seasonal grid, its centre, its share inside and its weight. */
export interface SeasonalCell {
	y: number;
	x: number;
	lat: number;
	lon: number;
	share: number;
	weight: number;
}

/**
 * The seasonal grid's cells a Polygon or MultiPolygon covers, each weighted
 * by its share inside × cos(its latitude), or why there are none. Exact
 * clipping (geo/clip.ts eachBand), the polygon shifted so band i is the
 * grid's row or column i (cell centres on whole degrees, edges on halves).
 */
export function seasonalCells(g: Geometry, what = 'the catchment boundary', region: Region = SEASONAL_REGION): { cells: SeasonalCell[] } | { problem: string } {
	if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return { problem: `${what} is not a polygon` };
	const { rows, cols } = regionSize(region, 1);
	const polygons = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((rings) => rings.map((r) => openRing(r).map(([lon, lat]) => [lon - region.w, lat - region.s] as [number, number])));
	let [s, n, w, e] = [Infinity, -Infinity, Infinity, -Infinity];
	for (const rings of polygons) {
		for (const [x, y] of rings[0] ?? []) {
			s = Math.min(s, y);
			n = Math.max(n, y);
			w = Math.min(w, x);
			e = Math.max(e, x);
		}
	}
	if (!(s < n && w < e)) return { problem: `${what} has no area` };
	if (s < 0 || w < 0 || n > rows || e > cols) {
		return { problem: `${what} reaches outside the region the seasonal forecasts are copied for (${region.w + 0.5}–${region.e - 0.5}° E, ${-(region.n - 0.5)}–${-(region.s + 0.5)}° S)` };
	}
	const all: SignedPiece[] = polygons.flatMap((rings) => rings.map((ring, i) => ({ ring, sign: i === 0 ? 1 : -1 })));
	const cells: SeasonalCell[] = [];
	const work = { vertices: 0, limit: GRID_WORK_BUDGET };
	try {
		eachBand(all, Math.floor(s), Math.ceil(n), 1, 'y', (y, pieces) => {
			const lat = round(region.s + 0.5 + y);
			const cos = Math.cos((lat * Math.PI) / 180);
			eachBand(pieces, Math.floor(w), Math.ceil(e), 1, 'x', (x, inCell) => {
				let area = 0;
				for (const p of inCell) area += (p.sign * Math.abs(signedArea2(p.ring))) / 2;
				const share = Math.min(1, area);
				if (!(share >= MIN_SHARE)) return;
				cells.push({ y, x, lat, lon: round(region.w + 0.5 + x), share: round(share, 6), weight: round(share * cos) });
			}, work);
		}, work);
	} catch (err) {
		if (err instanceof GridWorkExceeded) return { problem: `${what}’s outline is too detailed to average the forecasts over (more than ${err.limit.toLocaleString('en-ZA')} vertex cuts); simplify it` };
		throw err;
	}
	if (!cells.length) return { problem: `${what} covers no 1° cell enough to read` };
	return { cells };
}

/** What the forecasts are averaged over: the catchment's cells, and each unit's under per-unit rain. */
export interface ForecastArea {
	source: 'boundary' | 'units';
	cells: SeasonalCell[];
	/** Each unit's own cells (per-unit rain, §2.4h, only); units without a polygon or whose polygon can't be read are left out. */
	units: { nodeId: string; name: string; cells: SeasonalCell[] }[];
	/** Units left out of `units` or of the union, and why. */
	notes: string[];
}

/** Sum two cell lists (a union of polygons that don't overlap: their weights add). */
function addCells(into: Map<string, SeasonalCell>, cells: readonly SeasonalCell[]): void {
	for (const c of cells) {
		const k = `${c.y},${c.x}`;
		const had = into.get(k);
		into.set(k, had ? { ...had, share: round(Math.min(1, had.share + c.share), 6), weight: round(had.weight + c.weight) } : { ...c });
	}
}

/**
 * The project's forecast area (module header, 1), as the transaction's user
 * (RLS): its catchment boundary, else its units' polygons together; with
 * `perUnit`, each unit's own cells as well. `{ problem }` with neither.
 */
export async function forecastArea(db: Db, projectId: string, perUnit: boolean): Promise<ForecastArea | { problem: string }> {
	const { rows: b } = await db.query<{ geometry: Geometry }>(
		`SELECT geometry FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' ORDER BY created_at, id LIMIT 1`,
		[projectId]
	);
	const { rows: units } = await db.query<{ nodeId: string; name: string; geometry: Geometry | null }>(
		`SELECT n.id AS "nodeId", n.name,
			(SELECT f.geometry FROM map_feature f WHERE ${UNIT_POLYGONS_SQL} AND (f.id = n.area_feature_id OR ${ONLY_PARCEL_SQL})
			 ORDER BY (f.id = n.area_feature_id) DESC NULLS LAST, f.created_at, f.id LIMIT 1) AS geometry
		 FROM node n WHERE n.project_id = $1 AND n.kind = 'farm' AND n.area_km2 > 0 ORDER BY n.sort_order, n.name, n.id`,
		[projectId]
	);
	const notes: string[] = [];
	const own: ForecastArea['units'] = [];
	for (const u of units) {
		if (!u.geometry) continue;
		const got = seasonalCells(u.geometry, `${u.name}’s polygon`);
		if ('problem' in got) notes.push(got.problem);
		else own.push({ nodeId: u.nodeId, name: u.name, cells: got.cells });
	}
	if (b[0]) {
		const got = seasonalCells(b[0].geometry);
		if ('problem' in got) return { problem: got.problem };
		return { source: 'boundary', cells: got.cells, units: perUnit ? own : [], notes: perUnit ? notes : [] };
	}
	if (!own.length) {
		return {
			problem: notes.length
				? `the catchment has no boundary on the map, and its units’ polygons can’t be read: ${notes.join('; ')}`
				: 'the catchment has no boundary on the map and no unit has a polygon, so there is nowhere to average the seasonal forecasts over'
		};
	}
	const union = new Map<string, SeasonalCell>();
	for (const u of own) addCells(union, u.cells);
	return { source: 'units', cells: [...union.values()].sort((a, c) => a.y - c.y || a.x - c.x), units: perUnit ? own : [], notes };
}

// ─── Reading the copy ───────────────────────────────────────────────────────

const C3sIndex = z
	.object({
		inits: z.record(z.string().regex(INIT), z.array(z.string().regex(SYSTEM)).max(C3S_SYSTEMS_MAX * 2)),
		hindcasts: z.record(z.string().regex(SYSTEM), z.array(z.string().regex(MM)).max(12))
	})
	.strict();
export type C3sIndex = z.output<typeof C3sIndex>;

const dec = new TextDecoder();
const key = (p: string) => `/${p}` as AbsolutePath;

async function readJson(store: MirrorStore, p: string): Promise<unknown> {
	const bytes = await store.get(key(p));
	if (bytes === undefined) return undefined;
	try {
		return JSON.parse(dec.decode(bytes));
	} catch {
		throw new MirrorFormatError(`the rain data copy's ${p} is not valid JSON`);
	}
}

/** `c3s/index.json`, or null when the copy holds no seasonal forecast yet. */
export async function readC3sIndex(store: MirrorStore): Promise<C3sIndex | null> {
	const raw = await readJson(store, 'c3s/index.json');
	if (raw === undefined) return null;
	const r = C3sIndex.safeParse(raw);
	if (!r.success) throw new MirrorFormatError(`the rain data copy's c3s/index.json is invalid: ${r.error.issues[0]!.path.join('.') || '(root)'} ${r.error.issues[0]!.message}`);
	return r.data;
}

/** The init an outlook takes (module header, 2), with the systems issued by the decision date and those not yet. */
export interface C3sInitPick {
	init: string;
	issued: { system: string; issuedOn: string }[];
	notIssued: { system: string; issuedOn: string }[];
}

/** The newest init whose month starts on or before `decisionDate` with a system issued by then; null when none is. */
export function pickC3sInit(index: Pick<C3sIndex, 'inits'>, decisionDate: string): C3sInitPick | null {
	for (const init of Object.keys(index.inits).sort().reverse()) {
		if (`${init}-01` > decisionDate) continue;
		const systems = [...new Set(index.inits[init]!)];
		const all = systems.map((system) => ({ system, issuedOn: c3sIssuedOn(system, init) }));
		const issued = all.filter((s) => s.issuedOn <= decisionDate);
		if (issued.length) return { init, issued, notIssued: all.filter((s) => s.issuedOn > decisionDate) };
	}
	return null;
}

const GroupAttrs = z
	.object({
		centres: z.array(z.string()).optional(),
		systems: z.array(z.string()).optional(),
		members: z.union([z.array(z.number().int().nonnegative()), z.number().int().nonnegative()]).optional(),
		years: z.array(z.number().int()).optional(),
		initMonth: z.number().int().optional(),
		init: z.string().optional()
	})
	.passthrough();

const LooseManifest = z.object({ revision: z.number().int(), files: z.array(z.object({ url: z.string(), fetchedAt: z.string(), revision: z.number().int() }).passthrough()) }).passthrough();

type C3sArray = zarr.Array<'float32', MirrorStore>;

/** Open a C3S group's `tp_mm` and its group attributes, checked against the layout; null when the copy doesn't hold it. */
async function openC3s(store: MirrorStore, product: string, outer: 'system' | 'year'): Promise<{ arr: C3sArray; attrs: z.output<typeof GroupAttrs> } | null> {
	registerNodeGzip();
	const group = (await readJson(store, `${product}/zarr.json`)) as { attributes?: unknown } | undefined;
	const meta = (await readJson(store, `${product}/tp_mm/zarr.json`)) as Record<string, unknown> | undefined;
	if (group === undefined || meta === undefined) return null;
	const bad = (what: string) => new MirrorFormatError(`the rain data copy's ${product} is not laid out as expected (${what})`);
	const attrs = GroupAttrs.safeParse(group.attributes ?? {});
	if (!attrs.success) throw bad('group attributes');
	const arr = (await zarr.open.v3(zarr.root(store).resolve(`${product}/tp_mm`), { kind: 'array' })) as C3sArray;
	const { rows, cols } = regionSize(SEASONAL_REGION, 1);
	if (arr.dtype !== 'float32') throw bad(`data type ${arr.dtype}`);
	const dims = arr.dimensionNames ?? [];
	if (dims.join(',') !== `${outer},member,lead_day,lat,lon`) throw bad('dimension names');
	if (arr.shape.length !== 5 || arr.shape[2] !== C3S_LEAD_DAYS || arr.shape[3] !== rows || arr.shape[4] !== cols) throw bad(`shape ${arr.shape.join('×')}`);
	if (arr.chunks.join(',') !== `1,1,${C3S_LEAD_DAYS},${rows},${cols}`) throw bad(`chunks ${arr.chunks.join('×')}`);
	return { arr, attrs: attrs.data };
}

/** The cells' bounding block, and each cell's place in it. */
function blockOf(cells: readonly SeasonalCell[]) {
	const y0 = Math.min(...cells.map((c) => c.y));
	const x0 = Math.min(...cells.map((c) => c.x));
	const h = Math.max(...cells.map((c) => c.y)) - y0 + 1;
	const w = Math.max(...cells.map((c) => c.x)) - x0 + 1;
	return { y0, x0, h, w };
}

/** One member's whole lead axis over a block, (lead_day, y, x) C order. */
async function readSlab(arr: C3sArray, outer: number, member: number, b: ReturnType<typeof blockOf>): Promise<Float32Array> {
	const got = await zarr.get(arr, [outer, member, null, zarr.slice(b.y0, b.y0 + b.h), zarr.slice(b.x0, b.x0 + b.w)]);
	const [s0, s1, s2] = got.stride as [number, number, number];
	const data = got.data as Float32Array;
	const n = C3S_LEAD_DAYS * b.h * b.w;
	if (s0 === b.h * b.w && s1 === b.w && s2 === 1 && data.length === n) return data;
	const out = new Float32Array(n);
	for (let d = 0; d < C3S_LEAD_DAYS; d++) for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) out[(d * b.h + j) * b.w + i] = data[d * s0 + j * s1 + i * s2]!;
	return out;
}

/** The daily area mean of a slab: Σ w·v ÷ Σ w; NaN on a day any cell is NaN. */
export function dailyMeans(slab: Float32Array, b: { y0: number; x0: number; h: number; w: number }, cells: readonly SeasonalCell[]): Float64Array {
	const out = new Float64Array(C3S_LEAD_DAYS);
	const total = cells.reduce((a, c) => a + c.weight, 0);
	const at = cells.map((c) => (c.y - b.y0) * b.w + (c.x - b.x0));
	for (let d = 0; d < C3S_LEAD_DAYS; d++) {
		let sum = 0;
		for (let i = 0; i < cells.length; i++) sum += cells[i]!.weight * slab[d * b.h * b.w + at[i]!]!;
		out[d] = sum / total;
	}
	return out;
}

/**
 * Whole calendar months of a daily series that starts on `firstDay` (the
 * init month's 1st): month k is the k-th calendar month from it; the list
 * stops at the first month with a day that isn't a finite number ≥ 0 or
 * past the lead axis.
 */
export function monthlyTotals(daily: ArrayLike<number>, firstDay: string): number[] {
	const y = Number(firstDay.slice(0, 4));
	const m = Number(firstDay.slice(5, 7)) - 1;
	const d0 = toEpochDay(firstDay);
	const out: number[] = [];
	for (let k = 0; ; k++) {
		const a = toEpochDay(`${y + Math.floor((m + k) / 12)}-${pad2(((m + k) % 12) + 1)}-01`) - d0;
		const b = toEpochDay(`${y + Math.floor((m + k + 1) / 12)}-${pad2(((m + k + 1) % 12) + 1)}-01`) - d0;
		if (b > daily.length) return out;
		let sum = 0;
		for (let d = a; d < b; d++) {
			const v = daily[d]!;
			if (!Number.isFinite(v) || v < 0) return out;
			sum += v;
		}
		out.push(round(sum, 6));
	}
}

/** Run `tasks` READ_CONCURRENCY at a time, in order. */
async function pooled<T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
	const out = new Array<T>(tasks.length);
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) {
			const i = next++;
			out[i] = await tasks[i]!();
		}
	};
	await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, tasks.length) }, worker));
	return out;
}

/** A unit's forecast rain (per-unit rain only): each system's mean over its members of the unit's raw monthly totals, before any mapping. */
export interface UnitForecastRain {
	nodeId: string;
	name: string;
	cells: number;
	systems: { system: string; meanMonthlyMm: number[] }[];
}

/** What the outlook read from the copy, for the record and the credit. */
export interface C3sSource {
	init: string | null;
	issued: { system: string; issuedOn: string }[];
	notIssued: { system: string; issuedOn: string }[];
	/** Each system's hindcast read: its init month, the years held and the members. */
	hindcasts: { system: string; initMonth: number; years: number[]; members: number }[];
	/** The contributing centres the copy names for the systems passed (the groups' `centres`). */
	centres: string[];
	/** When the copy fetched the newest file read (its manifests), the credit's access date; null when none was read. */
	fetchedAt: string | null;
	/** Systems or members left out by this bridge (over the limits, no hindcast held), with why. */
	notes: string[];
}

export interface C3sInputs {
	forecasts: SeasonalForecastSystem[];
	hindcasts: SeasonalHindcastSystem[];
	source: C3sSource;
	area: { source: ForecastArea['source']; cells: number; units: UnitForecastRain[]; notes: string[] };
}

/**
 * The engine's inputs for an outlook with this decision date, read from the
 * copy over `area` (module header, 2–4). No index, or no init issued by the
 * decision date: no forecasts (the engine's `noForecast`); a system with no
 * hindcast of the init's month is passed without one (the engine leaves it
 * out, `noHindcast` when none has one). A copy laid out otherwise throws
 * MirrorFormatError: the job fails rather than read it wrongly. `onSystem`
 * is awaited before each system's reads (the job's lease heartbeat).
 */
export async function readC3sInputs(store: MirrorStore, area: ForecastArea, decisionDate: string, opts: { onSystem?: () => Promise<void> } = {}): Promise<C3sInputs> {
	const source: C3sSource = { init: null, issued: [], notIssued: [], hindcasts: [], centres: [], fetchedAt: null, notes: [] };
	const out: C3sInputs = { forecasts: [], hindcasts: [], source, area: { source: area.source, cells: area.cells.length, units: [], notes: [...area.notes] } };
	const index = await readC3sIndex(store);
	const pick = index ? pickC3sInit(index, decisionDate) : null;
	if (!index || !pick) return out;
	source.init = pick.init;
	source.notIssued = pick.notIssued;
	let issued = pick.issued;
	if (issued.length > C3S_SYSTEMS_MAX) {
		source.notes.push(`${issued.length - C3S_SYSTEMS_MAX} system(s) over the limit of ${C3S_SYSTEMS_MAX} left out: ${issued.slice(C3S_SYSTEMS_MAX).map((s) => s.system).join(', ')}`);
		issued = issued.slice(0, C3S_SYSTEMS_MAX);
	}
	source.issued = issued;
	const product = `c3s/${pick.init}`;
	const fc = await openC3s(store, product, 'system');
	if (!fc) throw new MirrorFormatError(`the rain data copy's c3s/index.json lists ${pick.init}, but ${product}/tp_mm isn't there`);
	const systems = fc.attrs.systems ?? [];
	// A forecast group lists each system's members (the ingest's `members`, 0 until collected); a bare number is a hindcast's.
	if (!Array.isArray(fc.attrs.members)) throw new MirrorFormatError(`the rain data copy's ${product} is not laid out as expected (members is not a list per system)`);
	const counts = fc.attrs.members;
	const fetched: string[] = [];
	const manifestTime = async (p: string) => {
		const raw = await readJson(store, `${p}/manifest.json`);
		const m = raw === undefined ? null : LooseManifest.safeParse(raw);
		if (m?.success) for (const f of m.data.files) fetched.push(f.fetchedAt);
	};
	await manifestTime(product);
	const block = blockOf([...area.cells, ...area.units.flatMap((u) => u.cells)]);
	const firstDay = `${pick.init}-01`;
	const initMonth = Number(pick.init.slice(5, 7));
	const centres = new Set<string>();
	const unitSums = new Map<string, { system: string; sums: number[]; n: number[] }[]>(area.units.map((u) => [u.nodeId, []]));
	for (const { system } of issued) {
		// Before each system's reads: the caller's heartbeat, so a long read of the copy keeps the job's lease.
		await opts.onSystem?.();
		const s = systems.indexOf(system);
		if (s < 0 || s >= fc.arr.shape[0]!) throw new MirrorFormatError(`the rain data copy's ${product} doesn't hold ${system}, which c3s/index.json lists`);
		let n = Math.min(counts[s] ?? 0, fc.arr.shape[1]!);
		if (n > C3S_MEMBERS_MAX) {
			source.notes.push(`${system}: ${n - C3S_MEMBERS_MAX} member(s) over the limit of ${C3S_MEMBERS_MAX} left out`);
			n = C3S_MEMBERS_MAX;
		}
		const slabs = await pooled(Array.from({ length: n }, (_, m) => () => readSlab(fc.arr, s, m, block)));
		out.forecasts.push({ system, init: pick.init, members: slabs.map((slab) => ({ monthlyMm: monthlyTotals(dailyMeans(slab, block, area.cells), firstDay) })) });
		for (const u of area.units) {
			const sums: number[] = [];
			const counted: number[] = [];
			for (const slab of slabs) {
				monthlyTotals(dailyMeans(slab, block, u.cells), firstDay).forEach((v, k) => {
					sums[k] = (sums[k] ?? 0) + v;
					counted[k] = (counted[k] ?? 0) + 1;
				});
			}
			unitSums.get(u.nodeId)!.push({ system, sums, n: counted });
		}
		// The hindcast of the init's calendar month.
		const mm = pad2(initMonth);
		if (!(index.hindcasts[system] ?? []).includes(mm)) {
			source.notes.push(`${system}: the copy holds no hindcast for its ${mm} init`);
			continue;
		}
		const hp = `c3s-hc/${system}/${mm}`;
		const hc = await openC3s(store, hp, 'year');
		if (!hc) throw new MirrorFormatError(`the rain data copy's c3s/index.json lists ${hp}, but its tp_mm isn't there`);
		await manifestTime(hp);
		for (const c of hc.attrs.centres ?? []) centres.add(c);
		let years = (hc.attrs.years ?? []).slice(0, hc.arr.shape[0]!);
		if (years.length > C3S_HINDCAST_YEARS_MAX) years = years.slice(-C3S_HINDCAST_YEARS_MAX);
		const hn = Math.min(typeof hc.attrs.members === 'number' ? hc.attrs.members : hc.arr.shape[1]!, hc.arr.shape[1]!, C3S_MEMBERS_MAX);
		const all = hc.attrs.years ?? [];
		const rows = await pooled(
			years.flatMap((year) => Array.from({ length: hn }, (_, m) => async () => ({ year, monthly: monthlyTotals(dailyMeans(await readSlab(hc.arr, all.indexOf(year), m, block), block, area.cells), `${year}-${mm}-01`) })))
		);
		out.hindcasts.push({
			system,
			initMonth,
			years: years.map((year) => ({ year, members: rows.filter((r) => r.year === year).map((r) => ({ monthlyMm: r.monthly })) }))
		});
		source.hindcasts.push({ system, initMonth, years, members: hn });
	}
	for (const c of fc.attrs.centres ?? []) centres.add(c);
	source.centres = [...centres];
	source.fetchedAt = fetched.length ? fetched.sort().at(-1)! : null;
	out.area.units = area.units.map((u) => ({
		nodeId: u.nodeId,
		name: u.name,
		cells: u.cells.length,
		systems: unitSums.get(u.nodeId)!.map((x) => ({ system: x.system, meanMonthlyMm: x.sums.map((v, k) => round(v / x.n[k]!, 3)) }))
	}));
	return out;
}
