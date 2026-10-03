// Research harness, the windows (docs/design/delineation-snapping.md §
// Outlets of quaternaries, issue #390): Delineate's whole path, as the route
// and the worker run it, at headwater quaternaries' outlets, scored against
// the DWS quaternary area. The other harnesses route one fixed window around
// each click, so they can't see what the windows do: a river bigger than the
// first window, a catchment running one way from its outlet, the DEM's edge.
// Run by hand against the operator's local stack (not CI):
//
//   DEM_URL=http://localhost:9002/tiles/terrain.pmtiles \
//   tsx --env-file=.env.development scripts/research/snap-outlets.ts <out.json> [--n 30] [--seed s] [--src <dir>] [--click lon,lat …]
//
// A headwater quaternary (100–1 500 km²): the HydroRIVERS reach with the
// largest upstream area among those with a vertex inside it, no more than
// 1.25× its area (so nothing much flows in from a quaternary above); the
// click is that reach's last vertex inside it. The path: reachFor (asking at
// a confluence: the river nearest the quaternary's area is picked), then
// delineate with the request's windows and, when it stops too_large at a
// window the worker goes beyond, the worker's windows from the next, with the
// job's budget. --src runs another checkout's delineation code (default this
// one's src/), to compare before and after. Each line on stderr is one
// outlet; <out.json> has them all.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { pointInRing, type Position } from '../../src/geo/geojson.js';

const args = process.argv.slice(2);
const out = args[0] ?? '';
if (!out) throw new Error('usage: snap-outlets.ts <out.json> [--n 30] [--seed s] [--src <dir>] [--click lon,lat …]');
const opt = (k: string, d: string) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1]! : d;
};
const N = Number(opt('--n', '30'));
const SEED = opt('--seed', 'outlets-1');
const SRC = pathToFileURL(resolve(opt('--src', new URL('../../src', import.meta.url).pathname))).href;
const extra = args.flatMap((a, i) => (a === '--click' ? [args[i + 1]!.split(',').map(Number) as [number, number]] : []));

type Coords = Position[];

async function main() {
	const { configuredDem } = await import(`${SRC}/delineation/dem.js`);
	const D = await import(`${SRC}/delineation/delineate.js`);
	const R = await import(`${SRC}/delineation/reach.js`);
	const dem = configuredDem();
	if (!dem) throw new Error('DEM_URL is empty');
	const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL });
	await db.connect();
	const { rows: quats } = await db.query<{ code: string; area_km2: number; geometry: { type: string; coordinates: unknown } }>(
		`SELECT code, area_km2, geometry FROM quaternary_reference WHERE dataset = 'DWS-quaternaries' AND area_km2 BETWEEN 100 AND 1500
		 ORDER BY md5(code || $1)`,
		[SEED]
	);
	const outlets: { code: string; refKm2: number; click: Position }[] = [];
	for (const q of quats) {
		if (outlets.length >= N) break;
		const rings = (q.geometry.type === 'Polygon' ? [q.geometry.coordinates] : (q.geometry.coordinates as unknown[])) as Coords[][];
		const inside = (p: Position) => rings.some((poly) => pointInRing(p, poly[0]!));
		const lons = rings.flatMap((p) => p[0]!.map((c) => c[0]!));
		const lats = rings.flatMap((p) => p[0]!.map((c) => c[1]!));
		const { rows } = await db.query<{ upstream_km2: number; geometry: { type: string; coordinates: Coords } }>(
			`SELECT upstream_km2, geometry FROM river_reference WHERE dataset = 'HydroRIVERS-v10' AND upstream_km2 <= $5
			   AND max_lon >= $1 AND min_lon <= $3 AND max_lat >= $2 AND min_lat <= $4 AND geometry->>'type' = 'LineString'
			 ORDER BY upstream_km2 DESC`,
			[Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats), 1.25 * q.area_km2]
		);
		const reach = rows.find((r) => r.geometry.coordinates.some(inside));
		if (!reach || reach.upstream_km2 < 0.5 * q.area_km2) continue;
		const last = [...reach.geometry.coordinates].reverse().find(inside)!;
		outlets.push({ code: q.code, refKm2: q.area_km2, click: last });
	}
	for (const c of extra) outlets.push({ code: 'click', refKm2: Number.NaN, click: c });
	const results: unknown[] = [];
	for (const o of outlets) {
		const t0 = performance.now();
		const cpu0 = process.cpuUsage();
		let near;
		let asked = false;
		try {
			near = await R.reachFor(db, o.click, null);
		} catch (err) {
			if (!(err instanceof R.ConfluenceAmbiguity)) throw err;
			// At a confluence: the river whose area is nearest the quaternary's, as an editor would pick it.
			const pick = (err as { choices: { dataset: string; reachId: number; upstreamKm2: number }[] }).choices.reduce((b, x) =>
				Math.abs(Math.log(x.upstreamKm2 / o.refKm2)) < Math.abs(Math.log(b.upstreamKm2 / o.refKm2)) ? x : b
			);
			near = await R.reachFor(db, o.click, { dataset: pick.dataset, reachId: pick.reachId });
			asked = true;
		}
		const base = {
			expected: near.reach ? { km2: near.reach.upstreamKm2, reach: `reach ${near.reach.reachId} of ${near.reach.dataset}`, chosen: asked } : null,
			junction: near.junction
		};
		let r: Record<string, unknown>;
		let stage = 'request';
		const run = async (opts: Record<string, unknown>) => {
			const d = await D.delineate(dem, o.click, { ...base, ...opts });
			return {
				km2: d.areaM2 / 1e6,
				window: d.windowCells,
				snapM: Math.round(d.snapDistanceM),
				how: /DEM's own junction/.test(d.method) ? 'junction' : /best matches/.test(d.method) ? 'matched' : 'snapped',
				unmatched: !!d.unmatched,
				version: d.methodVersion
			};
		};
		try {
			try {
				r = await run({ windows: D.WINDOWS, capCells: D.JOB_WINDOWS.at(-1) });
			} catch (err) {
				const e = err as { code?: string; windowCells?: number };
				const from = e.code === 'too_large' && e.windowCells ? D.JOB_WINDOWS.find((w: number) => w > e.windowCells!) : undefined;
				if (from === undefined) throw err;
				stage = `job from ${from}`;
				r = await run({ windows: D.JOB_WINDOWS.filter((w: number) => w >= from), budgetMs: D.JOB_TIME_BUDGET_MS });
			}
		} catch (err) {
			const e = err as { code?: string; message: string };
			r = { refused: e.code ?? 'error', message: e.message.slice(0, 200) };
		}
		const cpu = process.cpuUsage(cpu0);
		const row = {
			...o,
			reachKm2: near.reach?.upstreamKm2 ?? null,
			asked,
			stage,
			ms: Math.round(performance.now() - t0),
			cpuMs: Math.round((cpu.user + cpu.system) / 1000),
			...r,
			ratio: typeof r.km2 === 'number' ? Math.round((r.km2 / o.refKm2) * 1000) / 1000 : null
		};
		results.push(row);
		console.error(JSON.stringify(row));
	}
	writeFileSync(out, JSON.stringify(results, null, 1));
	await db.end();
}

main().catch((e: unknown) => {
	console.error(e);
	process.exit(1);
});
