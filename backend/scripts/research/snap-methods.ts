// Research harness (docs/research/delineation-snapping.md, issue #374): how
// well do ways of moving a click onto the DEM's channel recover the catchment
// a river line says is there? Not part of the app or CI; run by hand against
// the operator's local stack:
//
//   DEM_URL=http://localhost:9002/tiles/terrain.pmtiles \
//   (MIGRATION_DATABASE_URL from .env.development: the reference tables are read as their owner) \
//   tsx --env-file=.env.development scripts/research/snap-methods.ts <out.json> [--per-stratum 40] [--main 30] [--seed s]
//
// Samples HydroRIVERS reaches (the loaded `HydroRIVERS-v10` dataset) inside
// South Africa by upstream area, clicks each one's vertex next to its
// downstream end (where an editor clicks the drawn line), routes one window
// around it with the app's own fill, D8 and accumulation, and applies every
// method to that one routing. The reference is the reach's own upstream area
// (UPLAND_SKM): independent of the GLO-30 routing, though not ground truth
// (HydroSHEDS 15″). Water-mask snapping reads the GLO-30 Water Body Mask of
// the click's 1° tile from the public AWS copy through GDAL in docker.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { configuredDem } from '../../src/delineation/dem.js';
import { EARTH_RADIUS_M, readWindow, TARGET_ZOOM, toLonLat, toPx, worldPx } from '../../src/delineation/delineate.js';
import { accumulate, d8, edgeMask, fill, touchesEdge, upstream } from '../../src/delineation/flow.js';

const args = process.argv.slice(2);
const out = args[0] ?? '';
if (!out) throw new Error('usage: snap-methods.ts <out.json> [--per-stratum n] [--main n] [--seed s]');
const opt = (k: string, d: string) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1]! : d;
};
const PER = Number(opt('--per-stratum', '40'));
const MAIN = Number(opt('--main', '30'));
const SEED = opt('--seed', 'snap-1');
const WINDOW = 2048;
const GDAL_IMAGE = process.env.GDAL_IMAGE ?? 'ghcr.io/osgeo/gdal:ubuntu-small-3.11.3';

const STRATA = [
	{ id: 'small', lo: 10, hi: 100, n: PER },
	{ id: 'medium', lo: 100, hi: 1000, n: PER },
	{ id: 'large', lo: 1000, hi: 1500, n: PER },
	{ id: 'main', lo: 20000, hi: 1e9, n: MAIN }
] as const;

interface Reach {
	reach_id: string;
	strahler: number;
	upstream_km2: number;
	coords: [number, number][];
	stratum: string;
}

async function sample(): Promise<Reach[]> {
	const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL });
	await db.connect();
	const all: Reach[] = [];
	for (const s of STRATA) {
		// South Africa's box, the reach whole inside it; a stable pseudo-random order by md5 of the id and the seed.
		const { rows } = await db.query(
			`SELECT reach_id::text, strahler, upstream_km2, geometry->'coordinates' AS coords
			   FROM river_reference
			  WHERE dataset = 'HydroRIVERS-v10' AND upstream_km2 >= $1 AND upstream_km2 < $2
			    AND min_lat > -34.8 AND max_lat < -22.2 AND min_lon > 16.5 AND max_lon < 32.8
			    AND jsonb_array_length(geometry->'coordinates') >= 2
			  ORDER BY md5(reach_id::text || $3) LIMIT $4`,
			[s.lo, s.hi, SEED, s.n]
		);
		for (const r of rows) all.push({ ...r, stratum: s.id });
	}
	await db.end();
	return all;
}

/** GLO-30 Water Body Mask pixels (2 lake, 3 river) within ~1.2 km of the point, from the public AWS COG (GDAL range reads). */
function waterMask([lon, lat]: [number, number]): [number, number, number][] {
	const tLat = Math.floor(lat);
	const tLon = Math.floor(lon);
	const ns = tLat < 0 ? `S${String(-tLat).padStart(2, '0')}` : `N${String(tLat).padStart(2, '0')}`;
	const ew = tLon < 0 ? `W${String(-tLon).padStart(3, '0')}` : `E${String(tLon).padStart(3, '0')}`;
	const name = `Copernicus_DSM_COG_10_${ns}_00_${ew}_00`;
	const url = `/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/${name}_DEM/AUXFILES/${name}_WBM.tif`;
	const d = 0.012;
	try {
		const txt = execFileSync(
			'docker',
			['run', '--rm', GDAL_IMAGE, 'gdal_translate', '-q', '-of', 'XYZ', '-projwin', String(lon - d), String(lat + d), String(lon + d), String(lat - d), url, '/vsistdout/'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }
		);
		return txt
			.trim()
			.split('\n')
			.map((l) => l.split(/\s+/).map(Number) as [number, number, number])
			.filter((p) => p[2] === 2 || p[2] === 3);
	} catch {
		return [];
	}
}

type Pick = { method: string; cell: number | null; flagged?: boolean; note?: string };

async function main() {
	const dem = configuredDem();
	if (!dem) throw new Error('DEM_URL is empty');
	const info = await dem.info();
	const z = Math.min(TARGET_ZOOM, info.maxZoom);
	const reaches = await sample();
	console.error(`${reaches.length} reaches; window ${WINDOW} cells at zoom ${z}`);
	const results: unknown[] = [];
	let k = 0;
	for (const r of reaches) {
		k++;
		const t0 = performance.now();
		const click = r.coords[r.coords.length - 2]!;
		const p = toPx(click[0], click[1], 2 ** z);
		const tile = await dem.tile(z, Math.floor(p[0]), Math.floor(p[1]));
		if (!tile) {
			results.push({ ...r, coords: undefined, click, skipped: 'no DEM tile' });
			continue;
		}
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
		const cx = gx - x0;
		const cy = gy - y0;
		const distM = (c: number) => Math.hypot((c % WINDOW) + 0.5 - cx, Math.floor(c / WINDOW) + 0.5 - cy) * cellM;
		const within = (m: number) => {
			const rr = Math.ceil(m / cellM);
			const cells: number[] = [];
			for (let y = Math.floor(cy) - rr; y <= Math.floor(cy) + rr; y++)
				for (let x = Math.floor(cx) - rr; x <= Math.floor(cx) + rr; x++) {
					if (x < 1 || y < 1 || x >= WINDOW - 1 || y >= WINDOW - 1) continue;
					const c = y * WINDOW + x;
					if (!edge[c] && distM(c) <= m) cells.push(c);
				}
			return cells;
		};
		const maxAcc = (cells: number[]) => cells.reduce((b, c) => (b < 0 || acc[c]! > acc[b]! ? c : b), -1);
		const nearest = (cells: number[]) => cells.reduce((b, c) => (b < 0 || distM(c) < distM(b) ? c : b), -1);
		const ref = r.upstream_km2;
		const in150 = within(150);
		const in500 = within(500);
		const in1000 = within(1000);
		const in2500 = within(2500);
		const picks: Pick[] = [];
		const m0 = maxAcc(in150);
		picks.push({ method: 'M0 max-acc 150 m (today)', cell: m0 });
		picks.push({ method: 'M1 max-acc 300 m', cell: maxAcc(within(300)) });
		picks.push({ method: 'M1 max-acc 500 m', cell: maxAcc(in500) });
		for (const th of [1, 10]) {
			const stream = in500.filter((c) => km2(acc[c]!) >= th);
			picks.push({ method: `M2 Jenson nearest ≥${th} km² within 500 m`, cell: stream.length ? nearest(stream) : null });
		}
		for (const R of [1000, 2500]) {
			const cand = R === 1000 ? in1000 : in2500;
			let best = -1;
			let bestScore = Infinity;
			for (const c of cand) {
				const s = Math.abs(Math.log(km2(acc[c]!) / ref));
				if (s < bestScore - 1e-9 || (Math.abs(s - bestScore) <= 1e-9 && distM(c) < distM(best))) (best = c), (bestScore = s);
			}
			const ok = best >= 0 && Math.abs(km2(acc[best]!) / ref - 1) <= 0.5;
			picks.push({ method: `M3 Lehner area match ≤50% within ${R / 1000} km`, cell: ok ? best : null, flagged: !ok, note: ok ? undefined : 'no cell within 50% of the reference area' });
		}
		// M3L: Lehner (2012) as restated by Burek & Smilovic (2023, ESSD 15, §2.1.1): cells within 50 % of the reference area,
		// ranked by OC = RA + 2·RD (RA = 100 − area accordance %, 0–50; RD = distance scaled 0 at the click to 50 at the radius).
		for (const R of [1000, 2500]) {
			const cand = R === 1000 ? in1000 : in2500;
			let best = -1;
			let bestOc = Infinity;
			for (const c of cand) {
				const a = km2(acc[c]!);
				const accordance = (100 * Math.min(a, ref)) / Math.max(a, ref);
				if (accordance < 50) continue;
				const oc = 100 - accordance + 2 * ((50 * distM(c)) / R);
				if (oc < bestOc) (best = c), (bestOc = oc);
			}
			picks.push({ method: `M3L Lehner OC=RA+2RD within ${R / 1000} km`, cell: best >= 0 ? best : null, flagged: best < 0, note: best >= 0 ? undefined : 'no cell within 50 % of the reference area' });
		}
		// M4: today's snap with the guard: a cell with ≥100× its accumulation within 1 km flags it.
		const big = maxAcc(in1000);
		picks.push({ method: 'M4 today + 100× guard within 1 km', cell: m0, flagged: big >= 0 && m0 >= 0 && acc[big]! >= 100 * acc[m0]! });
		// M5: the water mask: the most-drained cell holding a WBM river or lake pixel within 500 m; else today's snap.
		const wbm = waterMask(click);
		const wbmCells = new Set<number>();
		let wbmNearestM: number | null = null;
		for (const [lon, lat] of wbm) {
			const [px, py] = toPx(lon, lat, W);
			const c = Math.floor(py - y0) * WINDOW + Math.floor(px - x0);
			const dM = Math.hypot(px - x0 - cx, py - y0 - cy) * cellM;
			if (wbmNearestM === null || dM < wbmNearestM) wbmNearestM = dM;
			if (dM <= 500 && c >= 0 && c < acc.length && !edge[c]) wbmCells.add(c);
		}
		const m5 = wbmCells.size ? maxAcc([...wbmCells]) : m0;
		picks.push({ method: 'M5 water-mask snap 500 m', cell: m5, note: wbmCells.size ? 'on the mask' : 'no mask within 500 m: today’s snap' });
		// How far the DEM's own channel for this reach is: the nearest cell within 2.5 km whose accumulation is within 50% of the reference.
		const match = in2500.filter((c) => Math.abs(km2(acc[c]!) / ref - 1) <= 0.5);
		const channelM = match.length ? distM(nearest(match)) : null;
		// Each distinct picked cell's catchment: its routed area and whether it reaches the window's edge (then the area is a lower bound).
		const seen = new Map<number, { km2: number; edge: boolean }>();
		const evalCell = (c: number) => {
			if (!seen.has(c)) {
				const up = upstream(WINDOW, WINDOW, dir, c);
				const touch = touchesEdge(grid, edge, up);
				seen.set(c, { km2: km2(acc[c]!), edge: touch.edge || touch.noData });
			}
			return seen.get(c)!;
		};
		const scored = picks.map((pk) => {
			if (pk.cell === null || pk.cell < 0) return { method: pk.method, km2: null, ratio: null, distM: null, flagged: pk.flagged ?? false, note: pk.note };
			const e = evalCell(pk.cell);
			return { method: pk.method, km2: e.km2, ratio: e.km2 / ref, edge: e.edge, distM: distM(pk.cell), flagged: pk.flagged ?? false, onTrunk: big >= 0 ? acc[pk.cell]! >= 0.5 * acc[big]! : null, note: pk.note, at: toLonLat(x0 + (pk.cell % WINDOW) + 0.5, y0 + Math.floor(pk.cell / WINDOW) + 0.5, W) };
		});
		results.push({ reach: r.reach_id, stratum: r.stratum, strahler: r.strahler, refKm2: ref, click, cellM, channelM, wbmPixels: wbm.length, wbmNearestM, picks: scored, ms: Math.round(performance.now() - t0) });
		console.error(`${k}/${reaches.length} ${r.stratum} reach ${r.reach_id} ref ${ref.toFixed(0)} km²: M0 ${scored[0]!.km2?.toFixed(1)} km², channel ${channelM?.toFixed(0) ?? '–'} m, mask ${wbmNearestM?.toFixed(0) ?? '–'} m (${Math.round(performance.now() - t0)} ms)`);
		writeFileSync(out, JSON.stringify({ seed: SEED, window: WINDOW, zoom: z, dataset: info.label, results }, null, 1));
	}
}

void main();
