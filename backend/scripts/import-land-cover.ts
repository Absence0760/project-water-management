// Load a land-cover product's cropland grid for the cultivated-area
// proposals (issue #326 B-landcover; docs/maps.md § Cultivated area from
// land cover):
//
//   pnpm import:land-cover                                   the committed synthetic grid (dev, e2e)
//   pnpm import:land-cover <tile.tif> [<tile.tif> …] --dataset WorldCover-2021-v200 [--cell 0.0025] [--bbox w,s,e,n]
//                          [--classes 40] [--source "…"] [--version "…"] [--attribution "…"]
//   pnpm import:land-cover <tile.tif> … --dataset <label> --out <grid.json[.gz]> [same options]
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like import-dam-register:
// the app role only reads cropland_dataset and cropland_cell_reference. A
// .tif is a land-cover classification GeoTIFF (an ESA WorldCover 3° tile, by
// default: class 40 counted, its citation and attribution); a .json is the
// fixture's form. Every file is pre-summarised here into grid cells and only
// the cells with cropland are stored: the app never reads a raster. A load
// replaces every row of its dataset. Paths resolve from the directory the
// command was typed in.
//
// With --out it loads nothing (no database needed): it writes the
// pre-summarised grid, in the JSON form, to the file (gzipped when it ends in
// .gz). That file is what a production load reads from the private reference
// bucket (docs/deployment.md § Reference datasets): the tiles are read here,
// once, and only the summary travels.
//
// The repo ships only invented data (backend/fixtures/geo/). ESA WorldCover is
// CC BY 4.0 (docs/maps.md § Sources): the tiles are the operator's own
// download, never committed.
import { loadDevEnv } from '../src/config/devEnv.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { SYNTHETIC_CROPLAND_DATASET } from '../src/geo/cropland.js';
import {
	croplandCellsFromTiff,
	croplandFromJson,
	croplandToJson,
	jsonDatasetMeta,
	mergeCells,
	DEFAULT_CELL_DEG,
	methodFor,
	replaceCroplandDataset,
	WORLDCOVER_2021,
	WORLDCOVER_CROPLAND,
	type Bbox,
	type CroplandCell,
	type CroplandDatasetMeta
} from '../src/geo/loadCropland.js';

/** The committed synthetic grid. */
export const SYNTHETIC_LAND_COVER_FILE = fileURLToPath(new URL('../fixtures/geo/land-cover.synthetic.json', import.meta.url));

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export interface LandCoverArgs {
	files: string[];
	dataset: string;
	cellDeg: number;
	classes: number[];
	bbox: Bbox | null;
	source: string | null;
	version: string | null;
	attribution: string | null;
	/** Write the pre-summarised grid here instead of loading it (.json or .json.gz). */
	out: string | null;
}

const FLAGS = ['--dataset', '--cell', '--bbox', '--classes', '--source', '--version', '--attribution', '--out'];

export function parseLandCoverArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): LandCoverArgs | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const unknown = argv.find((a) => a.startsWith('--') && !FLAGS.includes(a));
	if (unknown) return `unknown option ${unknown}`;
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && FLAGS.includes(argv[i - 1]!)));
	const base = { cellDeg: DEFAULT_CELL_DEG, classes: [WORLDCOVER_CROPLAND], bbox: null, source: null, version: null, attribution: null, out: null };
	if (positional.length === 0) return { ...base, files: [SYNTHETIC_LAND_COVER_FILE], dataset: SYNTHETIC_CROPLAND_DATASET };
	const bad = positional.find((p) => !['.tif', '.tiff', '.json'].includes(extname(p).toLowerCase()));
	if (bad) return `${bad}: give GeoTIFF tiles (.tif) or the fixture's .json form`;
	const dataset = flag('--dataset');
	if (!dataset || dataset.length > 50) return 'give the dataset a label of at most 50 characters with --dataset (e.g. WorldCover-2021-v200)';
	if (dataset === SYNTHETIC_CROPLAND_DATASET) return `"${SYNTHETIC_CROPLAND_DATASET}" is the committed fixture's label; pick another`;
	const cellText = flag('--cell');
	const cellDeg = cellText === null ? DEFAULT_CELL_DEG : Number(cellText);
	if (!(cellDeg > 0 && cellDeg <= 0.1)) return '--cell takes a cell size in degrees, above 0 and at most 0.1 (default 0.0025)';
	const classesText = flag('--classes');
	const classes = classesText === null ? [WORLDCOVER_CROPLAND] : classesText.split(',').map((x) => Number(x.trim()));
	if (!classes.length || !classes.every((c) => Number.isInteger(c) && c >= 0 && c < 256)) return '--classes takes class codes 0–255, comma-separated (WorldCover cropland: 40)';
	const bboxText = flag('--bbox');
	let bbox: Bbox | null = null;
	if (bboxText !== null) {
		const [west, south, east, north] = bboxText.split(',').map(Number);
		if (![west, south, east, north].every((x) => Number.isFinite(x)) || !(west! < east! && south! < north!)) return '--bbox takes west,south,east,north in degrees';
		bbox = { west: west!, south: south!, east: east!, north: north! };
	}
	const out = flag('--out');
	if (out !== null && !/\.json(\.gz)?$/i.test(out)) return '--out takes a .json or .json.gz file';
	return {
		files: positional.map((p) => cliPath(p, env)),
		dataset,
		cellDeg,
		classes,
		bbox,
		source: flag('--source'),
		version: flag('--version'),
		attribution: flag('--attribution'),
		out: out === null ? null : cliPath(out, env)
	};
}

/**
 * What `args`' files describe: the product (from a .json file's own fields,
 * else the flags, else WorldCover's), and the cells, one part per file, each
 * read when it's iterated (so a GeoTIFF's pixels are counted one file at a
 * time). A file that can't be read throws, naming it.
 */
export function readLandCoverFiles(
	args: LandCoverArgs,
	log: (line: string) => void = () => {}
): { meta: CroplandDatasetMeta; parts: Iterable<CroplandCell[]>; problems: string[] } | string {
	const jsonFiles = args.files.filter((f) => extname(f).toLowerCase() === '.json');
	const tiffFiles = args.files.filter((f) => extname(f).toLowerCase() !== '.json');
	if (jsonFiles.length && tiffFiles.length) return 'give GeoTIFF tiles or .json files, not both';
	if (jsonFiles.length > 1) return 'give one .json file';
	const problems: string[] = [];
	if (jsonFiles.length) {
		const file = jsonFiles[0]!;
		const got = croplandFromJson(JSON.parse(readFileSync(file, 'utf8')));
		if (typeof got === 'string') return `${file}: ${got}`;
		problems.push(...got.problems.map((p) => `${file}: ${p}`));
		return {
			meta: jsonDatasetMeta(args.dataset, got, { source: args.source, version: args.version, attribution: args.attribution, classes: args.classes }),
			parts: [got.cells],
			problems
		};
	}
	function* parts(): Generator<CroplandCell[]> {
		for (const file of tiffFiles) {
			const got = croplandCellsFromTiff(readFileSync(file), args.cellDeg, new Set(args.classes), args.bbox ?? undefined);
			if (typeof got === 'string') throw new Error(`${file}: ${got}`);
			log(`${file}: ${got.cells.length} cells with cropland from ${got.pixels.toLocaleString('en-ZA')} pixels`);
			yield got.cells;
		}
	}
	return {
		meta: {
			dataset: args.dataset,
			source: args.source ?? WORLDCOVER_2021.source,
			version: args.version ?? WORLDCOVER_2021.version,
			attribution: args.attribution ?? WORLDCOVER_2021.attribution,
			method: methodFor(args.cellDeg, args.classes),
			cellDeg: args.cellDeg,
			classes: args.classes
		},
		parts: parts(),
		problems
	};
}

/** Load `args` into the database at `url`; returns the cells written and what was skipped. A file that can't be read loads nothing. */
export async function importLandCover(url: string, args: LandCoverArgs, log?: (line: string) => void): Promise<{ written: number; problems: string[] }> {
	const read = readLandCoverFiles(args, log);
	if (typeof read === 'string') throw new Error(read);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const written = await replaceCroplandDataset(client, read.meta, read.parts);
		return { written, problems: read.problems };
	} finally {
		await client.end();
	}
}

/**
 * Write `args`' files, pre-summarised, to `args.out` in the JSON form (gzipped
 * for .gz) instead of loading them; returns the cells written. Refuses an
 * empty grid, as the load does.
 */
export function writeLandCoverJson(args: LandCoverArgs & { out: string }, log?: (line: string) => void): { written: number; problems: string[] } {
	const read = readLandCoverFiles(args, log);
	if (typeof read === 'string') throw new Error(read);
	const cells = mergeCells([...read.parts].flat());
	if (!cells.length) throw new Error('no cell has any cropland: check the files and --classes');
	const json = croplandToJson(read.meta, cells);
	writeFileSync(args.out, /\.gz$/i.test(args.out) ? gzipSync(json) : json);
	return { written: cells.length, problems: read.problems };
}

/** Load the committed synthetic grid into the database at `url` (the DB tests' and e2e's setup; idempotent). */
export const loadSyntheticLandCover = (url: string) => {
	const args = parseLandCoverArgs([]);
	if (typeof args === 'string') throw new Error(args);
	return importLandCover(url, args);
};

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseLandCoverArgs(process.argv.slice(2));
	if (typeof args !== 'string' && args.out) {
		try {
			const { written, problems } = writeLandCoverJson({ ...args, out: args.out }, (line) => console.log(line));
			for (const p of problems) console.warn(`skipped: ${p}`);
			console.log(`${written} cell${written === 1 ? '' : 's'} with cropland written to ${args.out}`);
			process.exit(0);
		} catch (err) {
			console.error((err as Error).message);
			process.exit(1);
		}
	}
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	if (typeof args === 'string') {
		console.error(
			`${args}\nusage: pnpm import:land-cover [<tile.tif> … --dataset <label> [--cell 0.0025] [--bbox w,s,e,n] [--classes 40] [--source "…"] [--version "…"] [--attribution "…"] [--out <grid.json[.gz]>]]`
		);
		process.exit(2);
	}
	importLandCover(url, args, (line) => console.log(line))
		.then(({ written, problems }) => {
			for (const p of problems) console.warn(`skipped: ${p}`);
			console.log(`${written} cell${written === 1 ? '' : 's'} with cropland loaded as "${args.dataset}"`);
			process.exit(written ? 0 : 1);
		})
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
