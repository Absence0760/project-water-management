// Research harness (the hydrologist's review, finding 3): Start and Divide
// from the map at real gauges. For each HydroRIVERS reach, an outlet gauge at
// its second-to-last vertex and a dam point five vertices up the same line,
// divided as Start and Divide do (delineateUnits with the outlet fixed):
//   - old: every point snapped 150 m, no reach looked up (start-6);
//   - new: each point's reach looked up and matched as Delineate does
//     (pointPlacement.ts, start-7);
// beside Delineate at the same gauge. Run by hand against the operator's
// local stack (not CI):
//
//   DEM_URL=http://localhost:9002/tiles/terrain.pmtiles \
//   tsx --env-file=.env.development scripts/research/snap-start.ts <out.json> [reachId …]
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import type { Position } from '../../src/geo/geojson.js';
import { delineate, DelineationRefused } from '../../src/delineation/delineate.js';
import { configuredDem } from '../../src/delineation/dem.js';
import { placementOf, placementWarnings, pointReaches } from '../../src/delineation/pointPlacement.js';
import { reachFor } from '../../src/delineation/reach.js';
import { OUTLET_KEY } from '../../src/delineation/start.js';
import { delineateUnits } from '../../src/delineation/subcatchments.js';

const args = process.argv.slice(2);
const out = args[0] ?? '';
if (!out) throw new Error('usage: snap-start.ts <out.json> [reachId …]');
// The finding's five: four gauges in gullies, one dam beside its river.
const REACHES = args.length > 1 ? args.slice(1).map(Number) : [11509680, 11494929, 11516319, 11511508, 11514358];

const km2 = (m2: number) => Math.round(m2 / 1e4) / 100;

async function main() {
	const dem = configuredDem();
	if (!dem) throw new Error('DEM_URL is empty');
	// A pool's client: reachFor takes the app's transaction client type.
	const pool = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL, max: 1 });
	const db = await pool.connect();
	const results: unknown[] = [];
	for (const id of REACHES) {
		const { rows } = await db.query<{ upstream_km2: number; geometry: { coordinates: Position[] } }>(
			`SELECT upstream_km2, geometry FROM river_reference WHERE dataset = 'HydroRIVERS-v10' AND reach_id = $1`,
			[id]
		);
		if (!rows[0]) {
			console.error(`${id}: no such reach`);
			continue;
		}
		const line = rows[0].geometry.coordinates;
		const gauge = line[line.length - 2]!;
		const damAt = line[Math.max(0, line.length - 7)]!;
		const points = [{ id: 'dam', role: 'dam' as const, geometry: { type: 'Point' as const, coordinates: damAt } }];
		const run = async (f: () => Promise<unknown>) => {
			try {
				return await f();
			} catch (e) {
				if (e instanceof DelineationRefused) return { refused: e.code, message: e.message };
				throw e;
			}
		};
		const old = await run(async () => {
			const r = await delineateUnits(dem, { outlet: gauge, boundary: null, points });
			return { catchmentKm2: km2(r.catchment.areaM2), outletMovedM: Math.round(r.outlet.snapDistanceM ?? 0), dam: r.units[0] ? { totalKm2: km2(r.units[0].totalAreaM2) } : r.dropped[0]?.reason };
		});
		const neu = await run(async () => {
			const reaches = await pointReaches(db, [
				{ key: OUTLET_KEY, name: 'Gauge', at: gauge },
				{ key: 'dam', name: 'Dam', at: damAt }
			]);
			const r = await delineateUnits(dem, { outlet: gauge, outletHints: reaches.get(OUTLET_KEY)?.hints, boundary: null, points: points.map((p) => ({ ...p, ...reaches.get(p.id)?.hints })) });
			const op = placementOf(r.outlet, reaches.get(OUTLET_KEY));
			const u = r.units[0];
			return {
				catchmentKm2: km2(r.catchment.areaM2),
				outlet: { placedBy: op.placedBy, movedM: Math.round(r.outlet.snapDistanceM ?? 0), reach: op.reach?.reachId ?? null, warnings: placementWarnings('Gauge', gauge, op, true) },
				dam: u ? { totalKm2: km2(u.totalAreaM2), placedBy: u.placedBy, warnings: placementWarnings('Dam', damAt, placementOf(u, reaches.get('dam'))) } : r.dropped[0]?.reason,
				method: r.method
			};
		}).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
		const del = await run(async () => {
			const f = await reachFor(db, gauge);
			const d = await delineate(dem, gauge, { expected: f.reach ? { km2: f.reach.upstreamKm2, reach: `reach ${f.reach.reachId}` } : null });
			return { km2: km2(d.areaM2), unmatched: !!d.unmatched };
		}).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
		const row = { reachId: id, reachKm2: rows[0].upstream_km2, gauge, dam: damAt, delineate: del, old, new: neu };
		results.push(row);
		console.error(JSON.stringify(row, null, 1));
		writeFileSync(out, JSON.stringify({ dataset: (await dem.info()).label, results }, null, 1));
	}
	db.release();
	await pool.end();
}

void main();
