// Load a mean annual precipitation (MAP) grid for the Map tab's MAP grid layer
// (docs/maps.md § MAP grid):
//
//   pnpm import:map-grid                                   the committed synthetic grid (dev, e2e)
//   pnpm import:map-grid <grid.asc> --dataset <label> --source "…" [--version "…"] [--attribution "…"] [--bbox w,s,e,n]
//                          an ESRI ASCII grid in WGS84 degrees, cut to the box
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like import-evaporation:
// the app role only reads rain_map_dataset and rain_map_cell_reference. A load
// replaces every row of its dataset. Paths resolve from the directory the
// command was typed in.
//
// Any GIS writes the ASCII form: `gdal_translate -of AAIGrid -a_srs EPSG:4326
// map.tif map.asc` (reproject first if the grid isn't in WGS84 degrees: a
// grid on the Cape datum needs `gdalwarp -s_srs EPSG:4222 -t_srs EPSG:4326`).
// A 100 m provincial surface is millions of cells: load the box around the
// catchments with --bbox. The repo ships only invented data
// (backend/fixtures/geo/); a real grid is the operator's own, never committed,
// and its licence decides whether it may be shown (docs/maps.md § Sources).
import { loadDevEnv } from '../src/config/devEnv.js';
import { createReadStream, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { rainMapFromAscii, rainMapFromJson, replaceRainMapDataset, SYNTHETIC_RAIN_MAP_DATASET, type Box, type RainMapGrid, type RainMapMeta } from '../src/geo/rainMap.js';

/** The committed synthetic grid. */
export const SYNTHETIC_MAP_GRID_FILE = fileURLToPath(new URL('../fixtures/geo/map-grid.synthetic.json', import.meta.url));

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export interface MapGridArgs {
	file: string;
	dataset: string;
	source: string | null;
	version: string | null;
	attribution: string | null;
	bbox: Box | null;
}

const FLAGS = ['--dataset', '--bbox', '--source', '--version', '--attribution'];

export function parseMapGridArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): MapGridArgs | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const unknown = argv.find((a) => a.startsWith('--') && !FLAGS.includes(a));
	if (unknown) return `unknown option ${unknown}`;
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && FLAGS.includes(argv[i - 1]!)));
	let bbox: Box | null = null;
	const bboxText = flag('--bbox');
	if (bboxText !== null) {
		const [w, s, e, n] = bboxText.split(',').map(Number);
		if (![w, s, e, n].every((x) => Number.isFinite(x)) || !(w! < e! && s! < n!)) return '--bbox takes west,south,east,north in degrees';
		bbox = { w: w!, s: s!, e: e!, n: n! };
	}
	const base = { source: flag('--source'), version: flag('--version'), attribution: flag('--attribution'), bbox };
	if (positional.length === 0) return { ...base, file: SYNTHETIC_MAP_GRID_FILE, dataset: SYNTHETIC_RAIN_MAP_DATASET };
	if (positional.length > 1) return 'give one grid file';
	const file = positional[0]!;
	if (!['.asc', '.json'].includes(extname(file).toLowerCase())) return `${file}: give an ESRI ASCII grid (.asc) or one fixture-form .json`;
	const dataset = flag('--dataset');
	if (!dataset || dataset.length > 50) return 'give the dataset a label of at most 50 characters with --dataset (e.g. Lynch-2004)';
	if (dataset === SYNTHETIC_RAIN_MAP_DATASET) return `"${SYNTHETIC_RAIN_MAP_DATASET}" is the committed fixture's label; pick another`;
	if (extname(file).toLowerCase() === '.asc' && !base.source) return 'say where the grid comes from with --source (the product, its author and year)';
	return { ...base, file: cliPath(file, env), dataset };
}

/** What `args`' file describes: the dataset row and its cells. A file that can't be read throws, naming it. */
export async function readMapGridFile(args: MapGridArgs): Promise<{ meta: RainMapMeta; grid: RainMapGrid }> {
	let grid: RainMapGrid;
	let own: { source?: string; version?: string; attribution?: string } = {};
	try {
		if (extname(args.file).toLowerCase() === '.json') {
			const got = rainMapFromJson(JSON.parse(readFileSync(args.file, 'utf8')));
			if (typeof got === 'string') throw new Error(got);
			grid = got.grid;
			own = got.meta;
			if (args.bbox) {
				const b = args.bbox;
				const centre = (i: number, o: number) => o + (i + 0.5) * grid.cellDeg;
				grid = { ...grid, cells: grid.cells.filter((c) => centre(c.col, grid.originLon) >= b.w && centre(c.col, grid.originLon) <= b.e && centre(c.row, grid.originLat) >= b.s && centre(c.row, grid.originLat) <= b.n) };
			}
		} else {
			grid = await rainMapFromAscii(createInterface({ input: createReadStream(args.file), crlfDelay: Infinity }), args.bbox);
		}
	} catch (e) {
		throw new Error(`${args.file}: ${e instanceof Error ? e.message : String(e)}`);
	}
	const source = args.source ?? own.source;
	if (!source) throw new Error(`${args.file}: the file names no source; say where it comes from with --source`);
	return {
		meta: {
			dataset: args.dataset,
			source,
			version: args.version ?? own.version ?? 'as loaded',
			attribution: args.attribution ?? own.attribution ?? source
		},
		grid
	};
}

/** Load `args` into the database at `url`; returns the cells written. */
export async function importMapGrid(url: string, args: MapGridArgs): Promise<number> {
	const { meta, grid } = await readMapGridFile(args);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		return await replaceRainMapDataset(client, meta, grid);
	} finally {
		await client.end();
	}
}

/** Load the committed synthetic grid into the database at `url` (the DB tests' and e2e's setup; idempotent). */
export const loadSyntheticMapGrid = (url: string) => {
	const args = parseMapGridArgs([]);
	if (typeof args === 'string') throw new Error(args);
	return importMapGrid(url, args);
};

const USAGE = 'usage: pnpm import:map-grid [<grid.asc> --dataset <label> --source "…" [--version "…"] [--attribution "…"] [--bbox w,s,e,n]]';

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const args = parseMapGridArgs(process.argv.slice(2));
	if (typeof args === 'string') {
		console.error(`${args}\n${USAGE}`);
		process.exit(2);
	}
	const url = process.env.MIGRATION_DATABASE_URL;
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	importMapGrid(url, args)
		.then((written) => {
			console.log(`${written} cell${written === 1 ? '' : 's'} loaded as "${args.dataset}"`);
			process.exit(0);
		})
		.catch((err: Error) => {
			console.error(err.message);
			process.exit(1);
		});
}
