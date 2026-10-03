// Research harness, third experiment (docs/design/delineation-snapping.md §
// Confluences, issue #374's follow-up): clicks at real junctions. The first
// experiment clicked each reach a cell above its lower end and scored it
// against that same reach, so it never asked which of several rivers a click
// at a junction means: a gauge on a junction was matched to a 67 km²
// tributary beside a 497 km² river. Here every click is at a HydroRIVERS
// junction where reaches of clearly different areas meet. For each one:
//   - does the server see the ambiguity (confluenceChoices) instead of taking
//     the nearest line, and what would the nearest line have picked;
//   - for each river offered, picked, does matching its area (place.ts) land
//     on a channel within 50 % of that area.
// Run by hand against the operator's local stack (not CI):
//
//   DEM_URL=http://localhost:9002/tiles/terrain.pmtiles \
//   tsx --env-file=.env.development scripts/research/snap-confluence.ts <out.json> [--n 60] [--seed s]
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { configuredDem } from '../../src/delineation/dem.js';
import { EARTH_RADIUS_M, readWindow, TARGET_ZOOM, toPx, worldPx } from '../../src/delineation/delineate.js';
import { accumulate, d8, edgeMask, fill } from '../../src/delineation/flow.js';
import { junctionOutlets } from '../../src/delineation/junction.js';
import { place } from '../../src/delineation/place.js';
import { confluenceChoices, lineDistM, type NearReachLine } from '../../src/delineation/reach.js';

const args = process.argv.slice(2);
const out = args[0] ?? '';
if (!out) throw new Error('usage: snap-confluence.ts <out.json> [--n 60] [--seed s]');
const opt = (k: string, d: string) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1]! : d;
};
const N = Number(opt('--n', '60'));
const SEED = opt('--seed', 'confluence-1');
const WINDOW = 2048;

type Coords = [number, number][];

async function main() {
	const dem = configuredDem();
	if (!dem) throw new Error('DEM_URL is empty');
	const info = await dem.info();
	const z = Math.min(TARGET_ZOOM, info.maxZoom);
	const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL });
	await db.connect();
	// Junctions: the shared lower end of two or more reaches whose areas differ by 1.5×, inside South Africa, a stable pseudo-random order.
	const { rows: junctions } = await db.query<{ lon: number; lat: number }>(
		`WITH ends AS (
		   SELECT reach_id, upstream_km2, (geometry->'coordinates'->-1->>0)::float8 AS lon, (geometry->'coordinates'->-1->>1)::float8 AS lat
		     FROM river_reference WHERE dataset = 'HydroRIVERS-v10' AND upstream_km2 IS NOT NULL
		       AND min_lat > -34.8 AND max_lat < -22.2 AND min_lon > 16.5 AND max_lon < 32.8)
		 SELECT lon, lat FROM ends GROUP BY lon, lat
		 HAVING count(*) >= 2 AND max(upstream_km2) / min(upstream_km2) >= 1.5 AND max(upstream_km2) < 1500
		 ORDER BY md5(lon::text || lat::text || $1) LIMIT $2`,
		[SEED, N]
	);
	console.error(`${junctions.length} junctions`);
	const results: unknown[] = [];
	let k = 0;
	for (const j of junctions) {
		k++;
		// The click: 30–50 m off the junction, in a direction from the seed, as a click on a junction lands.
		const ang = ((k * 137.5) % 360) * (Math.PI / 180);
		const off = 30 + (k % 3) * 10;
		const click: [number, number] = [j.lon + (off * Math.cos(ang)) / (111320 * Math.cos((j.lat * Math.PI) / 180)), j.lat + (off * Math.sin(ang)) / 110950];
		const dLat = 1000 / 110950;
		const dLon = 1000 / (111320 * Math.cos((click[1] * Math.PI) / 180));
		const { rows } = await db.query<{ reach_id: string; upstream_km2: number; geometry: { coordinates: Coords } }>(
			`SELECT reach_id, upstream_km2, geometry FROM river_reference WHERE dataset = 'HydroRIVERS-v10' AND upstream_km2 IS NOT NULL
			   AND max_lon >= $1 AND min_lon <= $3 AND max_lat >= $2 AND min_lat <= $4`,
			[click[0] - dLon, click[1] - dLat, click[0] + dLon, click[1] + dLat]
		);
		const near: NearReachLine[] = rows
			.map((r) => ({ dataset: 'HydroRIVERS-v10', reachId: Number(r.reach_id), upstreamKm2: r.upstream_km2, distanceM: lineDistM(click, r.geometry.coordinates), start: r.geometry.coordinates[0]!, end: r.geometry.coordinates.at(-1)!, line: r.geometry.coordinates }))
			.filter((r) => r.distanceM <= 1000)
			.sort((a, b) => a.distanceM - b.distanceM);
		const choices = confluenceChoices(click, near);
		// The DEM around the click, routed once; each river offered matched in turn.
		const p = toPx(click[0], click[1], 2 ** z);
		const tile = await dem.tile(z, Math.floor(p[0]), Math.floor(p[1]));
		if (!tile) continue;
		const W = worldPx(z, tile.size);
		const [gx, gy] = toPx(click[0], click[1], W);
		const x0 = Math.floor(gx) - WINDOW / 2;
		const y0 = Math.floor(gy) - WINDOW / 2;
		const grid = await readWindow(dem, z, tile.size, x0, y0, WINDOW);
		const edge = edgeMask(grid);
		fill(grid, edge);
		const dir = d8(grid, edge);
		const acc = accumulate(WINDOW, WINDOW, dir);
		const cellM = (2 * Math.PI * EARTH_RADIUS_M * Math.cos((click[1] * Math.PI) / 180)) / W;
		const km2 = (cells: number) => (cells * cellM * cellM) / 1e6;
		const g = { nx: WINDOW, ny: WINDOW, acc, edge, cellSizeM: cellM };
		const topo = choices ? junctionOutlets({ ...g, dir }, gx - x0, gy - y0, choices.map((c) => ({ key: String(c.reachId), role: c.role, km2: c.upstreamKm2 })), 150) : null;
		const matched = (choices ?? []).map((c) => {
			// 1000: as an unnamed click is placed; 2500: as the river picked at the confluence is (place.ts `chosen`).
			const at = (radiusM: 1000 | 2500) => {
				const pl = place(g, gx - x0, gy - y0, { snapRadiusM: 150, expectedKm2: c.upstreamKm2, chosen: radiusM === 2500 });
				const a = pl ? km2(acc[pl.cell]!) : null;
				return { how: pl?.how ?? null, km2: a, ratio: a === null ? null : a / c.upstreamKm2, guarded: !!pl?.larger };
			};
			const tc = topo?.get(String(c.reachId));
			const tk = tc === undefined ? null : km2(acc[tc]!);
			return { reachId: c.reachId, role: c.role, label: c.label, refKm2: c.upstreamKm2, r1000: at(1000), r2500: at(2500), junction: { how: tc === undefined ? null : 'junction', km2: tk, ratio: tk === null ? null : tk / c.upstreamKm2, guarded: false } };
		});
		results.push({ junction: [j.lon, j.lat], click, nearest: near[0] ? { reachId: near[0].reachId, km2: near[0].upstreamKm2, distanceM: Math.round(near[0].distanceM) } : null, reachesWithin200m: near.filter((r) => r.distanceM <= 200).length, ambiguous: !!choices, matched });
		console.error(`${k}/${junctions.length}: ${choices ? `${choices.length} choices` : 'NOT detected'}; ${matched.map((m) => `${m.label} ${Math.round(m.refKm2)}→${m.r1000.km2?.toFixed(0) ?? '–'}/${m.r2500.km2?.toFixed(0) ?? '–'}/${m.junction.km2?.toFixed(0) ?? '–'}`).join(', ')}`);
		writeFileSync(out, JSON.stringify({ seed: SEED, window: WINDOW, zoom: z, dataset: info.label, results }, null, 1));
	}
	await db.end();
}

void main();
