// The worker's side of observed actual ET (issue #623 step 4; handover.ts
// for the files, 277_et_observation.sql, 281_et_units.sql). Not a job:
// runTick (jobs/runner.ts) calls runEtTick once per tick, with no user,
// beside the dams tick.
//
// Only with ET_OBSERVATIONS=on (off by default; in production the worker's
// environment in infra/jobs.tf sets it from et_observations_enabled,
// docs/deployment.md § Observed actual ET), and only against a bucket the
// pass reads: MIRROR_URL in a live process, else a MIRROR_URL of its own
// (never the committed synthetic copy; `pnpm dev:et:run` uses a scratch
// directory). Each tick:
//   1. Lists every unit with farm parcels (app_et_units) and, for each, the
//      land cover's cropland under its parcels (app_et_cropland, the default
//      dataset), kept in this process per unit until its parcels change or
//      CROPLAND_REFRESH_MS passes, at most CROPLAND_PER_TICK lookups a tick.
//   2. Publishes et/wanted.json once every listed unit's cropland is known:
//      each unit's parcels as one MultiPolygon, when they last changed, and
//      its cropland cells. Written only when it differs from what this
//      process last wrote (one GET when it hasn't). Until then the list
//      already in the bucket stands, so a cold worker never hands the pass a
//      partial list (which would drop units from its bookkeeping).
//   3. Loads what the pass fetched into et_observation
//      (app_et_observation_load), with what was loaded kept in the database
//      (et_observation_load_mark, per source and unit: the status's lastGood
//      it was checked against, the file's fetchedAt), so a restarted or cold
//      worker repeats nothing. A unit is due when its status lastGood is newer
//      than its mark's (277's parcel trigger clears the mark, so a unit whose
//      parcels changed is due at once). A due unit's file is read and loaded
//      when its fetchedAt is newer than the mark's; the loader refuses a file
//      made from parcels older than their last change (the file's parcelsAt),
//      and the pass rewrites it from the next wanted list. At most
//      LOADS_PER_TICK files a tick, oldest lastGood first, units whose last
//      attempt failed after the others.
// A failure is logged and left to the next tick; the rest of the tick goes on.
// The log names counts only, never a unit, project or place.
import { withoutUser, type Db } from '../../db/tx.js';
import { logEvent } from '../../logging/logEvent.js';
import { safeError } from '../../logging/safeError.js';
import type { MirrorStore } from '../../mirror/store.js';
import {
	type EtFile,
	etStore,
	MAX_CROPLAND_CELLS,
	MAX_PARCEL_POINTS,
	MAX_PARCEL_POLYGONS,
	MAX_UNITS,
	type ParcelsGeometry,
	type Position,
	readEtFile,
	readStatus,
	readWanted,
	type WantedCropland,
	type WantedList,
	type WantedUnit,
	writeWanted
} from './handover.js';

type Env = Record<string, string | undefined>;

/** The most files read (and loaded) in one tick: each one GET inside the VPC and one load of at most a few hundred rows. */
export const LOADS_PER_TICK = 200;
/** The most units whose cropland is looked up in one tick (one indexed range query each). */
export const CROPLAND_PER_TICK = 500;
/** How long a unit's cropland is kept in this process before it is looked up again (a land-cover reload shows within this). */
export const CROPLAND_REFRESH_MS = 60 * 60_000;

/** Whether this process runs the ET tick: ET_OBSERVATIONS on, off or unset (off). */
export function etObservationsOn(env: Env = process.env): boolean {
	const v = env.ET_OBSERVATIONS?.trim() ?? '';
	if (v !== '' && v !== 'on' && v !== 'off') throw new Error(`unknown ET_OBSERVATIONS "${v}" (expected on or off)`);
	return v === 'on';
}

interface UnitRow {
	node_id: string;
	parcels: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown }[];
	parcels_changed_at: Date | null;
}

/** A unit's parcels as one MultiPolygon. */
export function parcelsOf(geometries: UnitRow['parcels']): ParcelsGeometry {
	const coordinates: Position[][][] = [];
	for (const g of geometries) {
		if (g.type === 'Polygon') coordinates.push(g.coordinates as Position[][]);
		else if (g.type === 'MultiPolygon') coordinates.push(...(g.coordinates as Position[][][]));
	}
	return { type: 'MultiPolygon', coordinates };
}

/** The parcels' lon/lat box: west, south, east, north. */
export function parcelsBox(p: ParcelsGeometry): [number, number, number, number] {
	let w = Infinity;
	let s = Infinity;
	let e = -Infinity;
	let n = -Infinity;
	for (const poly of p.coordinates) {
		for (const [lon, lat] of poly[0] ?? []) {
			w = Math.min(w, lon);
			e = Math.max(e, lon);
			s = Math.min(s, lat);
			n = Math.max(n, lat);
		}
	}
	return [w, s, e, n];
}

/** The cropland under a unit's parcels, or undefined when none is loaded there, the box passes 1°, or it holds more than MAX_CROPLAND_CELLS cells. */
export async function croplandFor(db: Db, parcels: ParcelsGeometry): Promise<WantedCropland | undefined> {
	const [w, s, e, n] = parcelsBox(parcels);
	if (!(e - w <= 1 && n - s <= 1)) return undefined;
	const { rows } = await db.query<{ dataset: string; cell_deg: number; row_idx: number; col_idx: number; fraction: number }>(
		'SELECT dataset, cell_deg, row_idx, col_idx, fraction FROM app_et_cropland($1, $2, $3, $4)',
		[w, s, e, n]
	);
	if (!rows.length || rows.length > MAX_CROPLAND_CELLS) return undefined;
	return { dataset: rows[0]!.dataset, cellDeg: rows[0]!.cell_deg, cells: rows.map((r) => [r.row_idx, r.col_idx, Math.round(r.fraction * 1e6) / 1e6]) };
}

/** Load one unit's file, as the worker (no user): rows written and revised, or false when refused (see the header). */
export async function loadEtFile(db: Db, f: EtFile): Promise<{ written: number; revised: number } | false> {
	const { rows } = await db.query<{ written: number; revised: number; applied: boolean }>(
		'SELECT written, revised, applied FROM app_et_observation_load($1, $2, $3::date[], $4::float8[], $5::float8[], $6::float8[], $7, $8::text[], $9::text[], $10, $11)',
		[
			f.source,
			f.unitKey,
			f.rows.map((r) => r.dekad),
			f.rows.map((r) => r.etaMmDay),
			f.rows.map((r) => r.validShare),
			f.rows.map((r) => r.areaM2),
			f.mask,
			f.rows.map((r) => r.file),
			f.rows.map((r) => r.etag ?? null),
			f.version,
			f.parcelsAt
		]
	);
	const r = rows[0]!;
	return r.applied ? { written: r.written, revised: r.revised } : false;
}

export interface EtTickResult {
	/** Units with farm parcels. */
	units: number;
	/** Units left out of the list: parcels past MAX_PARCEL_POINTS or MAX_PARCEL_POLYGONS (never observed; logged as a count). */
	tooLarge: number;
	/** Units whose cropland was looked up this tick, and those still waiting for a lookup (the list waits for them). */
	croplandLooked: number;
	croplandPending: number;
	/** The wanted list was written this tick. */
	published: boolean;
	/** Files loaded, refused by the loader (parcels changed since), failed (logged; tried next tick). */
	loaded: number;
	refused: number;
	failed: number;
	/** Files read whose fetch was already loaded: the mark moved, nothing was loaded. */
	unchanged: number;
	/** Due files left for the next tick (past LOADS_PER_TICK). */
	deferred: number;
	/** Rows inserted or changed, and the changed ones among them (a rewritten upstream file). */
	rows: number;
	revised: number;
}

/** Per process: the wanted list last written, and each unit's cropland with the parcels it was looked up for. */
let published: string | null = null;
const cropland = new Map<string, { parcels: string; at: number; value: WantedCropland | undefined }>();
/** Forget what this process saw (tests: a fresh process). What was loaded is in the database, not here. */
export function resetEtTick(): void {
	published = null;
	cropland.clear();
}

interface LoadMark {
	source: 'wapor';
	node_id: string;
	last_good: Date | null;
	fetched_at: Date | null;
	failed_at: Date | null;
}

const ms = (d: Date | null | undefined) => (d ? new Date(d).getTime() : -Infinity);
const writeMark = (db: Db, nodeId: string, lastGood: string | null, fetchedAt: string | null, failed: boolean) =>
	db.query('SELECT applied FROM app_et_load_mark_write($1, $2, $3, $4, $5)', ['wapor', nodeId, lastGood, fetchedAt, failed]);

/** One tick's ET work (see the header); null when it is off. Never throws. */
export async function runEtTick(
	o: { store?: MirrorStore; env?: Env; now?: () => number; loadsPerTick?: number; croplandPerTick?: number } = {}
): Promise<EtTickResult | null> {
	const env = o.env ?? process.env;
	let on: boolean;
	try {
		on = etObservationsOn(env);
	} catch (err) {
		logEvent('error', { event: 'et_tick_failed', step: 'config', ...safeError(err) });
		return null;
	}
	if (!on) return null;
	const now = o.now ?? Date.now;
	const loadsPerTick = o.loadsPerTick ?? LOADS_PER_TICK;
	const croplandPerTick = o.croplandPerTick ?? CROPLAND_PER_TICK;
	const result: EtTickResult = { units: 0, tooLarge: 0, croplandLooked: 0, croplandPending: 0, published: false, loaded: 0, refused: 0, failed: 0, unchanged: 0, deferred: 0, rows: 0, revised: 0 };
	let store: MirrorStore;
	try {
		store = o.store ?? etStore(env);
	} catch (err) {
		logEvent('error', { event: 'et_tick_failed', step: 'store', ...safeError(err) });
		return result;
	}

	// 1–2. The units, their cropland, the wanted list.
	const listed = new Set<string>();
	try {
		const units = await withoutUser(async (db) => (await db.query<UnitRow>('SELECT node_id, parcels, parcels_changed_at FROM app_et_units($1)', ['wapor'])).rows);
		result.units = units.length;
		if (units.length >= MAX_UNITS) logEvent('warn', { event: 'et_unit_cap', cap: MAX_UNITS });
		const wanted: WantedUnit[] = [];
		for (const u of units) {
			listed.add(u.node_id);
			const parcels = parcelsOf(u.parcels);
			if (parcels.coordinates.length > MAX_PARCEL_POLYGONS || parcels.coordinates.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0) > MAX_PARCEL_POINTS) {
				result.tooLarge++;
				continue;
			}
			const key = JSON.stringify(parcels);
			let c = cropland.get(u.node_id);
			if (!c || c.parcels !== key || now() - c.at > CROPLAND_REFRESH_MS) {
				if (result.croplandLooked >= croplandPerTick) {
					// Looked up on a later tick; a cached value for the same parcels still stands meanwhile.
					if (!c || c.parcels !== key) {
						result.croplandPending++;
						continue;
					}
				} else {
					c = { parcels: key, at: now(), value: await withoutUser((db) => croplandFor(db, parcels)) };
					cropland.set(u.node_id, c);
					result.croplandLooked++;
				}
			}
			wanted.push({
				unitKey: u.node_id,
				parcels,
				...(u.parcels_changed_at ? { changedAt: new Date(u.parcels_changed_at).toISOString() } : {}),
				...(c!.value ? { cropland: c!.value } : {})
			});
		}
		for (const k of cropland.keys()) if (!listed.has(k)) cropland.delete(k);
		if (result.croplandPending === 0) {
			wanted.sort((a, b) => (a.unitKey < b.unitKey ? -1 : 1));
			const key = JSON.stringify(wanted);
			if (published !== key) {
				const there = await readWanted(store).catch(() => null);
				if (!there || JSON.stringify(there.units) !== key) {
					const list: WantedList = { generatedAt: new Date(now()).toISOString(), units: wanted };
					await writeWanted(store, list);
					result.published = true;
				}
				published = key;
			}
		}
	} catch (err) {
		logEvent('error', { event: 'et_tick_failed', step: 'wanted', ...safeError(err) });
	}

	// 3. What the pass fetched.
	let marks: Map<string, LoadMark> | null = null;
	try {
		marks = new Map(
			(await withoutUser(async (db) => (await db.query<LoadMark>('SELECT source, node_id, last_good, fetched_at, failed_at FROM app_et_load_marks()')).rows))
				.filter((m) => m.source === 'wapor')
				.map((m) => [m.node_id, m])
		);
	} catch (err) {
		logEvent('error', { event: 'et_tick_failed', step: 'marks', ...safeError(err) });
	}
	if (marks) {
		const due: { key: string; lastGood: string; mark: LoadMark | undefined }[] = [];
		try {
			const status = await readStatus(store, 'wapor');
			for (const [key, s] of Object.entries(status?.perKey ?? {})) {
				if (!s.lastGood || !listed.has(key)) continue;
				const mark = marks.get(key);
				if (mark && Date.parse(s.lastGood) <= ms(mark.last_good)) continue;
				due.push({ key, lastGood: s.lastGood, mark });
			}
		} catch (err) {
			logEvent('error', { event: 'et_tick_failed', step: 'status', ...safeError(err) });
		}
		// Never-failed (or since succeeded) first, oldest lastGood first; then the failing ones, oldest failure first.
		const failedAt = (d: (typeof due)[number]) => (d.mark?.failed_at ? ms(d.mark.failed_at) : 0);
		due.sort((a, b) => failedAt(a) - failedAt(b) || Date.parse(a.lastGood) - Date.parse(b.lastGood) || (a.key < b.key ? -1 : 1));
		result.deferred = Math.max(0, due.length - loadsPerTick);
		for (const { key, lastGood, mark } of due.slice(0, loadsPerTick)) {
			try {
				const file = await readEtFile(store, 'wapor', key);
				// The pass writes a file before the status names it, so a listed unit has its file; a missing one is retried next tick.
				if (!file) throw new Error('the status names a file that is missing');
				const fresh = !mark || Date.parse(file.fetchedAt) > ms(mark.fetched_at);
				const r = await withoutUser(async (db) => {
					const loadedNow = fresh ? await loadEtFile(db, file) : null;
					await writeMark(db, key, lastGood, file.fetchedAt, false);
					return loadedNow;
				});
				if (r === null) result.unchanged++;
				else if (r === false) result.refused++;
				else {
					result.loaded++;
					result.rows += r.written;
					result.revised += r.revised;
				}
			} catch (err) {
				result.failed++;
				logEvent('error', { event: 'et_load_failed', ...safeError(err) });
				await withoutUser((db) => writeMark(db, key, null, null, true)).catch((e) => logEvent('error', { event: 'et_tick_failed', step: 'mark', ...safeError(e) }));
			}
		}
	}
	if (result.published || result.loaded || result.failed || result.deferred || result.refused || result.croplandPending || result.tooLarge) {
		logEvent(result.failed ? 'warn' : 'info', { event: 'et_tick', ...result });
	}
	return result;
}
