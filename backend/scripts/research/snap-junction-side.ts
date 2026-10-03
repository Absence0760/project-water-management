// Research harness, beside a confluence (docs/design/delineation-snapping.md §
// Beside a confluence; the hydrologist persona's findings 5 and 12, issue
// #390). The confluence experiment clicked 30–50 m off each junction, where
// the server asks which river; a gauge or weir a few hundred metres above or
// below a junction is outside that question (CONFLUENCE_M), so its outlet was
// matched by area alone, and the area can't tell the main river above the
// junction from the river below it. Here every click is ON a river's line,
// 0–1 000 m along it from a HydroRIVERS junction (on into the next reach
// where the line is shorter), and the result is judged by D8 topology: on
// which side of the DEM's junction did the outlet land?
//
// The DEM's junction is the reference: junctionBranches at the mapped
// junction with all its rivers, then the main river's branch (everything
// upstream of its last cell), the tributary's, and the river below (the
// junction's path downhill). An outlet elsewhere is "other".
//
// Each click is placed four ways:
//   before  the app before delineate-7: asked within CONFLUENCE_M (the
//           editor assumed to pick the clicked river, then the junction's
//           own cell), else the nearest reach's area matched within 1 km;
//   match   the area match alone (what a click beside a junction got);
//   after   the app now: asked within CONFLUENCE_M, else the nearest reach
//           with the junction beside it (junctionBeside → junctionOutlets,
//           each river on its own channel nearest the click);
// and the distance each moved the click.
// Run by hand against the operator's local stack (not CI):
//
//   DEM_URL=http://localhost:9002/tiles/terrain.pmtiles \
//   tsx --env-file=.env.development scripts/research/snap-junction-side.ts <out.json> [--n 50] [--seed side-1] [--offset 0]
//
// --offset m: clicks that far off the line, alternating sides (an imprecise click).
// --points lon,lat;lon,lat…: instead of sampling, the clicks given (asked within CONFLUENCE_M: the main river above picked).
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { configuredDem } from '../../src/delineation/dem.js';
import { EARTH_RADIUS_M, readWindow, TARGET_ZOOM, toPx, worldPx } from '../../src/delineation/delineate.js';
import { accumulate, d8, edgeMask, fill, upstream } from '../../src/delineation/flow.js';
import { junctionBranches, junctionOutlets, type JunctionRiver } from '../../src/delineation/junction.js';
import { place } from '../../src/delineation/place.js';
import { confluenceChoices, junctionBeside, lineDistM, type NearReachLine } from '../../src/delineation/reach.js';

const args = process.argv.slice(2);
const out = args[0] ?? '';
if (!out) throw new Error('usage: snap-junction-side.ts <out.json> [--n 50] [--seed side-1] [--offset 0] [--points lon,lat;…]');
const opt = (k: string, d: string) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1]! : d;
};
const N = Number(opt('--n', '50'));
const SEED = opt('--seed', 'side-1');
const OFFSET = Number(opt('--offset', '0'));
const POINTS = opt('--points', '');
const WINDOW = 2048;
const DISTANCES = [0, 100, 200, 300, 350, 400, 500, 600, 800, 1000];
const DATASET = 'HydroRIVERS-v10';

type Pos = [number, number];
type Reach = { id: number; km2: number; line: Pos[] };

const kx = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
const KY = 110950;
const distM = (a: Pos, b: Pos) => Math.hypot((a[0] - b[0]) * kx(a[1]), (a[1] - b[1]) * KY);
const same = (a: Pos, b: Pos) => distM(a, b) <= 1;

/** The point `m` metres along a chain of lines from `from` (the lines in walking order), and a unit normal there. */
function along(lines: Pos[][], m: number): { at: Pos; normal: Pos } | null {
	let left = m;
	for (const line of lines) {
		for (let i = 0; i + 1 < line.length; i++) {
			const a = line[i]!;
			const b = line[i + 1]!;
			const seg = distM(a, b);
			if (seg === 0) continue;
			if (left <= seg) {
				const t = left / seg;
				const dx = (b[0] - a[0]) * kx(a[1]);
				const dy = (b[1] - a[1]) * KY;
				return { at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], normal: [-dy / seg, dx / seg] };
			}
			left -= seg;
		}
	}
	return null;
}

async function main() {
	const dem = configuredDem();
	if (!dem) throw new Error('DEM_URL is empty');
	const info = await dem.info();
	const z = Math.min(TARGET_ZOOM, info.maxZoom);
	const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL });
	await db.connect();
	const reachesAround = async (p: Pos, radiusM: number): Promise<Reach[]> => {
		const dLat = radiusM / KY;
		const dLon = radiusM / kx(p[1]);
		const { rows } = await db.query<{ reach_id: string; upstream_km2: number; geometry: { coordinates: Pos[] } }>(
			`SELECT reach_id, upstream_km2, geometry FROM river_reference WHERE dataset = $5 AND upstream_km2 IS NOT NULL
			   AND max_lon >= $1 AND min_lon <= $3 AND max_lat >= $2 AND min_lat <= $4`,
			[p[0] - dLon, p[1] - dLat, p[0] + dLon, p[1] + dLat, DATASET]
		);
		return rows.map((r) => ({ id: Number(r.reach_id), km2: r.upstream_km2, line: r.geometry.coordinates }));
	};
	const nearOf = (click: Pos, reaches: Reach[]): NearReachLine[] =>
		reaches
			.map((r) => ({ dataset: DATASET, reachId: r.id, upstreamKm2: r.km2, distanceM: lineDistM(click, r.line), start: r.line[0]!, end: r.line.at(-1)! }))
			.filter((r) => r.distanceM <= 1000)
			.sort((a, b) => a.distanceM - b.distanceM);

	// Junctions: the shared lower end of exactly two reaches whose areas differ by 2× or more, the larger ≤ 800 km², inside South Africa.
	const junctions: { lon: number; lat: number }[] = POINTS
		? POINTS.split(';').map((s) => {
				const [lon, lat] = s.split(',').map(Number);
				return { lon: lon!, lat: lat! };
			})
		: (
				await db.query<{ lon: number; lat: number }>(
					`WITH ends AS (
					   SELECT reach_id, upstream_km2, (geometry->'coordinates'->-1->>0)::float8 AS lon, (geometry->'coordinates'->-1->>1)::float8 AS lat
					     FROM river_reference WHERE dataset = $3 AND upstream_km2 IS NOT NULL
					       AND min_lat > -34.8 AND max_lat < -22.2 AND min_lon > 16.5 AND max_lon < 32.8)
					 SELECT lon, lat FROM ends GROUP BY lon, lat
					 HAVING count(*) = 2 AND max(upstream_km2) / min(upstream_km2) >= 2 AND max(upstream_km2) <= 800
					 ORDER BY md5(lon::text || lat::text || $1) LIMIT $2`,
					[SEED, N, DATASET]
				)
			).rows;
	console.error(`${junctions.length} junctions`);
	const results: unknown[] = [];
	let k = 0;
	for (const j of junctions) {
		k++;
		const J: Pos = [j.lon, j.lat];
		const reaches = await reachesAround(J, 3000);
		// The junction's rivers, by the mapped geometry (for --points: confluenceChoices at the click).
		let into = reaches.filter((r) => same(r.line.at(-1)!, J));
		let outOf = reaches.filter((r) => same(r.line[0]!, J));
		let click0 = J;
		if (POINTS) {
			const choices = confluenceChoices(J, nearOf(J, reaches));
			if (!choices) {
				console.error(`${k}: no confluence at ${J}`);
				continue;
			}
			into = choices.filter((c) => c.role === 'above').map((c) => reaches.find((r) => r.id === c.reachId)!);
			outOf = choices.filter((c) => c.role === 'below').map((c) => reaches.find((r) => r.id === c.reachId)!);
			click0 = J;
		}
		if (into.length < 2) continue;
		const sorted = [...into].sort((a, b) => a.km2 - b.km2);
		const trib = sorted[0]!;
		const main = sorted.at(-1)!;
		const below = outOf[0] ?? null;
		const rivers: JunctionRiver[] = [...into.map((r) => ({ key: String(r.id), role: 'above' as const, km2: r.km2 })), ...outOf.map((r) => ({ key: String(r.id), role: 'below' as const, km2: r.km2 }))];
		// The DEM around the junction, routed once.
		const p = toPx(J[0], J[1], 2 ** z);
		const tile = await dem.tile(z, Math.floor(p[0]), Math.floor(p[1]));
		if (!tile) continue;
		const W = worldPx(z, tile.size);
		const [jx, jy] = toPx(J[0], J[1], W);
		const x0 = Math.floor(jx) - WINDOW / 2;
		const y0 = Math.floor(jy) - WINDOW / 2;
		const grid = await readWindow(dem, z, tile.size, x0, y0, WINDOW);
		const edge = edgeMask(grid);
		fill(grid, edge);
		const dir = d8(grid, edge);
		const acc = accumulate(WINDOW, WINDOW, dir);
		const cellM = (2 * Math.PI * EARTH_RADIUS_M * Math.cos((J[1] * Math.PI) / 180)) / W;
		const km2 = (c: number) => (acc[c]! * cellM * cellM) / 1e6;
		const g = { nx: WINDOW, ny: WINDOW, acc, edge, cellSizeM: cellM, dir };
		const gridOf = (q: Pos): [number, number] => {
			const [x, y] = toPx(q[0], q[1], W);
			return [x - x0, y - y0];
		};
		const ref = junctionBranches(g, ...gridOf(J), rivers, 150);
		if (!ref) {
			console.error(`${k}/${junctions.length}: the DEM's junction not found`);
			results.push({ junction: J, found: false });
			continue;
		}
		const mainMask = upstream(WINDOW, WINDOW, dir, ref.main.end);
		const tribMask = upstream(WINDOW, WINDOW, dir, ref.tributary.end);
		const belowPath = new Set<number>();
		for (let c = ref.junction, n = 0; c >= 0 && n < 20000; n++) {
			belowPath.add(c);
			const d = dir[c]!;
			if (d === 255) break;
			const xx = (c % WINDOW) + [1, 1, 0, -1, -1, -1, 0, 1][d]!;
			const yy = Math.floor(c / WINDOW) + [0, 1, 1, 1, 0, -1, -1, -1][d]!;
			c = xx < 0 || yy < 0 || xx >= WINDOW || yy >= WINDOW ? -1 : yy * WINDOW + xx;
		}
		const side = (c: number | null | undefined) =>
			c === null || c === undefined ? 'none' : mainMask[c] ? 'main' : tribMask[c] ? 'trib' : belowPath.has(c) ? 'below' : 'other';
		const movedM = (c: number | null | undefined, q: Pos) => {
			if (c === null || c === undefined) return null;
			const [qx, qy] = gridOf(q);
			const cx = c % WINDOW;
			return Math.round(Math.hypot(cx + 0.5 - qx, (c - cx) / WINDOW + 0.5 - qy) * cellM);
		};
		// Each river's line walked away from the junction: up the river above (its line reversed, then the biggest reach
		// flowing into its start), down the river below.
		const chainUp = (r: Reach): { lines: Pos[][]; ids: number[] } => {
			const lines: Pos[][] = [];
			const ids: number[] = [];
			let cur: Reach | undefined = r;
			for (let n = 0; cur && n < 6; n++) {
				lines.push([...cur.line].reverse());
				ids.push(cur.id);
				const head: Pos = cur.line[0]!;
				cur = reaches.filter((x) => same(x.line.at(-1)!, head)).sort((a, b) => b.km2 - a.km2)[0];
			}
			return { lines, ids };
		};
		const chainDown = (r: Reach): { lines: Pos[][]; ids: number[] } => {
			const lines: Pos[][] = [];
			const ids: number[] = [];
			let cur: Reach | undefined = r;
			for (let n = 0; cur && n < 6; n++) {
				lines.push(cur.line);
				ids.push(cur.id);
				const foot: Pos = cur.line.at(-1)!;
				cur = reaches.find((x) => same(x.line[0]!, foot));
			}
			return { lines, ids };
		};
		const arms: { role: 'main' | 'trib' | 'below'; reach: Reach; lines: Pos[][]; ids: number[] }[] = [
			{ role: 'main', reach: main, ...chainUp(main) },
			{ role: 'trib', reach: trib, ...chainUp(trib) },
			...(below ? [{ role: 'below' as const, reach: below, ...chainDown(below) }] : [])
		];
		const clicks: unknown[] = [];
		let ci = 0;
		for (const arm of arms) {
			for (const dm of POINTS ? [0] : DISTANCES) {
				const a = POINTS ? { at: click0, normal: [0, 0] as Pos } : along(arm.lines, dm);
				if (!a) continue;
				const sign = ci++ % 2 ? 1 : -1;
				const click: Pos = [a.at[0] + (sign * OFFSET * a.normal[0]) / kx(a.at[1]), a.at[1] + (sign * OFFSET * a.normal[1]) / KY];
				const near = nearOf(click, reaches);
				if (!near.length) continue;
				const [cx, cy] = gridOf(click);
				const choices = confluenceChoices(click, near);
				// The editor, asked, picks the clicked river (the reach of that role at the click).
				const pick = choices ? (choices.find((c) => c.reachId === arm.reach.id) ?? null) : null;
				const askedRivers = choices ? choices.map((c) => ({ key: String(c.reachId), role: c.role, km2: c.upstreamKm2 })) : null;
				const matchOf = (km: number, radius: number) => place(g, cx, cy, { snapRadiusM: 150, expectedKm2: km, matchRadiusM: radius });
				const nearest = near[0]!;
				const match = matchOf(nearest.upstreamKm2, 1000);
				let before: number | null | undefined;
				let after: number | null | undefined;
				let afterHow = '';
				if (choices && pick) {
					const b = junctionBranches(g, cx, cy, askedRivers!, 150);
					before = b?.ends.get(String(pick.reachId)) ?? matchOf(pick.upstreamKm2, 2500)?.cell;
					after = junctionOutlets(g, cx, cy, askedRivers!, 150)?.get(String(pick.reachId)) ?? matchOf(pick.upstreamKm2, 2500)?.cell;
					afterHow = 'asked';
				} else if (!choices) {
					before = match?.cell;
					const beside = junctionBeside(click, near);
					const jo = beside ? junctionOutlets(g, cx, cy, beside.rivers.map((r) => ({ ...r, key: r.key.split(':')[1]! })), 150)?.get(beside.chosenKey.split(':')[1]!) : undefined;
					after = jo ?? match?.cell;
					afterHow = beside ? (jo === undefined ? 'beside, not found' : 'beside') : 'matched';
				}
				const row = {
					arm: arm.role,
					alongM: dm,
					click,
					toJunctionM: Math.round(distM(click, J)),
					nearest: { reachId: nearest.reachId, km2: nearest.upstreamKm2, onArm: arm.ids.includes(nearest.reachId) },
					asked: !!choices,
					before: { side: side(before), km2: before == null ? null : km2(before), movedM: movedM(before, click) },
					match: { side: side(match?.cell), how: match?.how ?? null, km2: match ? km2(match.cell) : null, movedM: movedM(match?.cell, click) },
					after: { side: side(after), how: afterHow, km2: after == null ? null : km2(after), movedM: movedM(after, click) }
				};
				clicks.push(row);
			}
		}
		results.push({ junction: J, found: true, demJunctionM: movedM(ref.junction, J), main: main.km2, trib: trib.km2, below: below?.km2 ?? null, clicks });
		const cs = clicks as { arm: string; before: { side: string }; after: { side: string } }[];
		const wrong = (w: 'before' | 'after') => cs.filter((c) => c[w].side !== c.arm).length;
		console.error(`${k}/${junctions.length}: DEM junction ${movedM(ref.junction, J)} m off; wrong side before ${wrong('before')}/${cs.length}, after ${wrong('after')}/${cs.length}`);
		writeFileSync(out, JSON.stringify({ seed: SEED, offset: OFFSET, window: WINDOW, zoom: z, dataset: info.label, results }, null, 1));
	}
	await db.end();
}

void main();
