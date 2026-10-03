// Research harness, second experiment (docs/research/delineation-snapping.md, issue #374): does burning the GLO-30
// Water Body Mask into the DEM before routing (HydroSHEDS v1.4 § 3.4.3's recipe) put the routed channel where the
// mask's rivers are, so today's 150 m snap finds it? Run after snap-methods.ts, on its reaches that have mask
// pixels within 1.2 km, plus extra clicks:
//
//   DEM_URL=http://localhost:9002/tiles/terrain.pmtiles \
//   tsx scripts/research/snap-burn.ts <snap-methods.json> <out.json> [--strata main,large] [--click lon,lat,refKm2 …]
//
// The burn: a river pixel (WBM 3) lowers the surface by 12 m, tapering linearly to 2 m at 0.005° (~500 m) from it;
// a lake pixel (WBM 2) by 14 m within 0.0025°; the deepest burn reaching a cell wins. HydroSHEDS steps the taper; a
// linear one is close enough for this question. Mask pixels are cached per 1° tile in ~/.cache/water-management-tiles/wbm/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configuredDem } from '../../src/delineation/dem.js';
import { EARTH_RADIUS_M, readWindow, TARGET_ZOOM, toPx, worldPx } from '../../src/delineation/delineate.js';
import { accumulate, d8, edgeMask, fill, touchesEdge, upstream } from '../../src/delineation/flow.js';

const [inFile, out] = process.argv.slice(2);
if (!inFile || !out) throw new Error('usage: snap-burn.ts <snap-methods.json> <out.json> [--click lon,lat,refKm2 …]');
const extra: { click: [number, number]; refKm2: number; stratum: string; reach: string }[] = [];
process.argv.forEach((a, i) => {
	if (a !== '--click') return;
	const [lon, lat, ref] = process.argv[i + 1]!.split(',').map(Number) as [number, number, number];
	extra.push({ click: [lon, lat], refKm2: ref, stratum: ref >= 20000 ? 'main' : 'extra', reach: `click ${lon},${lat}` });
});
const WINDOW = 2048;
const GDAL_IMAGE = process.env.GDAL_IMAGE ?? 'ghcr.io/osgeo/gdal:ubuntu-small-3.11.3';
// The operator's own tiles cache (as `pnpm dev:tiles:*` uses), private to the user: never the shared temp dir.
const CACHE = join(homedir(), '.cache', 'water-management-tiles', 'wbm');
mkdirSync(CACHE, { recursive: true, mode: 0o700 });

/** Every WBM water pixel (lon, lat, 2 lake | 3 river) of the 1° tile whose south-west corner is (tLon, tLat). */
function tileWater(tLon: number, tLat: number): [number, number, number][] {
	const ns = tLat < 0 ? `S${String(-tLat).padStart(2, '0')}` : `N${String(tLat).padStart(2, '0')}`;
	const ew = tLon < 0 ? `W${String(-tLon).padStart(3, '0')}` : `E${String(tLon).padStart(3, '0')}`;
	const name = `Copernicus_DSM_COG_10_${ns}_00_${ew}_00`;
	const cached = join(CACHE, `${name}.xyz`);
	let have: string | null = null;
	try {
		have = readFileSync(cached, 'utf8');
	} catch {
		have = null;
	}
	if (have === null) {
		let txt = '';
		try {
			txt = execFileSync('docker', ['run', '--rm', GDAL_IMAGE, 'gdal2xyz', '-srcnodata', '0', '-skipnodata', `/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/${name}_DEM/AUXFILES/${name}_WBM.tif`, '/vsistdout/'], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore'],
				maxBuffer: 256 << 20
			});
		} catch {
			txt = '';
		}
		// Written once, exclusively: a file already there (another run's) is kept, never overwritten.
		try {
			writeFileSync(cached, txt, { flag: 'wx', mode: 0o600 });
		} catch {
			// Someone else wrote it first: theirs stands.
		}
		have = txt;
	}
	return have
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((l) => l.split(/\s+/).map(Number) as [number, number, number])
		.filter((p) => p[2] === 2 || p[2] === 3);
}

async function main() {
	const dem = configuredDem();
	if (!dem) throw new Error('DEM_URL is empty');
	const info = await dem.info();
	const z = Math.min(TARGET_ZOOM, info.maxZoom);
	const prev = JSON.parse(readFileSync(inFile!, 'utf8')) as { results: { reach: string; stratum: string; refKm2: number; click: [number, number]; wbmPixels: number }[] };
	// --strata a,b: only those classes (the burn barely reaches small reaches: the mask lies near few of them).
	const si = process.argv.indexOf('--strata');
	const strata = si >= 0 ? new Set(process.argv[si + 1]!.split(',')) : null;
	const samples = [...prev.results.filter((r) => r.wbmPixels > 0 && (!strata || strata.has(r.stratum))).map((r) => ({ click: r.click, refKm2: r.refKm2, stratum: r.stratum, reach: r.reach })), ...extra];
	console.error(`${samples.length} clicks with water-mask pixels nearby`);
	const results: unknown[] = [];
	let k = 0;
	for (const s of samples) {
		k++;
		// A dropped DEM read (MinIO under load) retries the sample once, then skips it.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await one(s, k);
				break;
			} catch (err) {
				console.error(`${k}/${samples.length} ${s.reach}: ${(err as Error).message}${attempt ? ', skipped' : ', retrying'}`);
			}
		}
	}
	async function one(s: (typeof samples)[number], k: number) {
		const t0 = performance.now();
		const p = toPx(s.click[0], s.click[1], 2 ** z);
		const tile = await dem!.tile(z, Math.floor(p[0]), Math.floor(p[1]));
		if (!tile) return;
		const W = worldPx(z, tile.size);
		const [gx, gy] = toPx(s.click[0], s.click[1], W);
		const x0 = Math.floor(gx) - WINDOW / 2;
		const y0 = Math.floor(gy) - WINDOW / 2;
		const cellM = (2 * Math.PI * EARTH_RADIUS_M * Math.cos((s.click[1] * Math.PI) / 180)) / W;
		const km2 = (cells: number) => (cells * cellM * cellM) / 1e6;
		const cx = gx - x0;
		const cy = gy - y0;
		const distM = (c: number) => Math.hypot((c % WINDOW) + 0.5 - cx, Math.floor(c / WINDOW) + 0.5 - cy) * cellM;
		// The mask over the window: every 1° tile the window meets.
		const lonOf = (x: number) => ((x0 + x) / W) * 360 - 180;
		const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y0 + y)) / W))) * 180) / Math.PI;
		const water: [number, number, number][] = [];
		for (let tLat = Math.floor(latOf(WINDOW)); tLat <= Math.floor(latOf(0)); tLat++) for (let tLon = Math.floor(lonOf(0)); tLon <= Math.floor(lonOf(WINDOW)); tLon++) for (const w of tileWater(tLon, tLat)) water.push(w);
		const routed: Record<string, unknown> = {};
		for (const burnt of [false, true]) {
			const grid = await readWindow(dem!, z, tile.size, x0, y0, WINDOW);
			let maskCells = 0;
			if (burnt) {
				const burn = new Float32Array(grid.z.length);
				const riverR = Math.ceil(500 / cellM);
				const lakeR = Math.ceil(250 / cellM);
				for (const [lon, lat, v] of water) {
					const [px, py] = toPx(lon, lat, W);
					const wx = Math.floor(px - x0);
					const wy = Math.floor(py - y0);
					const R = v === 3 ? riverR : lakeR;
					if (wx < -R || wy < -R || wx >= WINDOW + R || wy >= WINDOW + R) continue;
					maskCells++;
					for (let y = wy - R; y <= wy + R; y++) {
						if (y < 0 || y >= WINDOW) continue;
						for (let x = wx - R; x <= wx + R; x++) {
							if (x < 0 || x >= WINDOW) continue;
							const dM = Math.hypot(x - wx, y - wy) * cellM;
							const depth = v === 3 ? (dM <= 500 ? 12 - (10 * dM) / 500 : 0) : dM <= 250 ? 14 : 0;
							const i = y * WINDOW + x;
							if (depth > burn[i]!) burn[i] = depth;
						}
					}
				}
				for (let i = 0; i < burn.length; i++) if (burn[i]) grid.z[i] = grid.z[i]! - burn[i]!;
			}
			const edge = edgeMask(grid);
			fill(grid, edge);
			const dir = d8(grid, edge);
			const acc = accumulate(WINDOW, WINDOW, dir);
			const within = (mm: number) => {
				const rr = Math.ceil(mm / cellM);
				const cells: number[] = [];
				for (let y = Math.floor(cy) - rr; y <= Math.floor(cy) + rr; y++)
					for (let x = Math.floor(cx) - rr; x <= Math.floor(cx) + rr; x++) {
						if (x < 1 || y < 1 || x >= WINDOW - 1 || y >= WINDOW - 1) continue;
						const c = y * WINDOW + x;
						if (!edge[c] && distM(c) <= mm) cells.push(c);
					}
				return cells;
			};
			const maxAcc = (cells: number[]) => cells.reduce((b, c) => (b < 0 || acc[c]! > acc[b]! ? c : b), -1);
			const m0 = maxAcc(within(150));
			const big = maxAcc(within(1000));
			const up = upstream(WINDOW, WINDOW, dir, m0);
			const touch = touchesEdge(grid, edge, up);
			routed[burnt ? 'burnt' : 'plain'] = {
				km2: km2(acc[m0]!),
				ratio: km2(acc[m0]!) / s.refKm2,
				edge: touch.edge || touch.noData,
				onTrunk: acc[m0]! >= 0.5 * acc[big]!,
				distM: distM(m0),
				trunkKm2: km2(acc[big]!),
				maskCells: burnt ? maskCells : undefined
			};
		}
		results.push({ ...s, cellM, waterPixels: water.length, ...routed, ms: Math.round(performance.now() - t0) });
		const pl = routed.plain as { km2: number };
		const bu = routed.burnt as { km2: number };
		console.error(`${k}/${samples.length} ${s.stratum} ${s.reach} ref ${s.refKm2.toFixed(0)}: plain ${pl.km2.toFixed(1)} km², burnt ${bu.km2.toFixed(1)} km² (${Math.round(performance.now() - t0)} ms)`);
		writeFileSync(out!, JSON.stringify({ window: WINDOW, zoom: z, dataset: info.label, results }, null, 1));
	}
}

void main();
