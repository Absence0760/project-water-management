// Load a crop-type product's orchard and vine grid for the planted-areas
// drawer's proposals (issue #604 R5-D; docs/maps.md § Orchards and vines from
// SANLC):
//
//   pnpm import:crop-types                                        the committed synthetic grid (dev, CI, e2e)
//   pnpm import:crop-types <sanlc-2022.tif> --dataset SANLC-2022 [--baseline <sanlc-2018.tif> --baseline-version 2018]
//                          [--cell 0.0025] [--bbox w,s,e,n] [--orchard-classes 32] [--vine-classes 33]
//                          [--source "…"] [--version "…"] [--attribution "…"]
//   pnpm import:crop-types <…> --dataset <label> --out <grid.json[.gz]>    write the summary instead of loading it
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like import-land-cover:
// the app role only reads crop_type_dataset and crop_type_cell_reference. A
// .tif is a classification GeoTIFF in EPSG:4326 (SANLC warped from its
// Albers grid first; the earlier edition warped onto the same pixels); a
// .json is the fixture's form. The rasters are pre-summarised here into grid
// cells and only the cells with an orchard or a vine are stored: the app
// never reads a raster. A load replaces every row of its dataset. Paths
// resolve from the directory the command was typed in.
//
// SANLC's terms are not yet recorded (docs/maps.md § Sources, #618 step 8b),
// so production refuses the kind (geo/referenceLoad.ts); a local load of the
// operator's own download is for evaluation only. The repo ships only
// invented data (backend/fixtures/geo/); never commit SANLC or anything
// derived from it.
import { loadDevEnv } from '../src/config/devEnv.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { SYNTHETIC_CROPLAND_DATASET } from '../src/geo/cropland.js';
import {
	cropTypeJsonMeta,
	cropTypeMethodFor,
	cropTypesFromJson,
	cropTypesToJson,
	replaceCropTypeDataset,
	SANLC_2022,
	SANLC_ORCHARDS,
	SANLC_VINES,
	type CropTypeCell,
	type CropTypeDatasetMeta
} from '../src/geo/cropTypeGrid.js';
import { DEFAULT_CELL_DEG, type Bbox } from '../src/geo/loadCropland.js';
import { cropTypeCellsFromTiff } from '../src/geo/loadCropTypes.js';

/** The committed synthetic grid. */
export const SYNTHETIC_CROP_TYPES_FILE = fileURLToPath(new URL('../fixtures/geo/crop-types.synthetic.json', import.meta.url));

/** Printed with every load of a real raster. */
export const TERMS_PENDING =
	"SANLC's terms are not yet recorded (docs/maps.md § Sources): this load is for local evaluation only, production refuses it, and nothing derived from it may be committed or shown to a client.";

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export interface CropTypeArgs {
	file: string;
	baseline: string | null;
	baselineVersion: string | null;
	dataset: string;
	cellDeg: number;
	orchardClasses: number[];
	vineClasses: number[];
	bbox: Bbox | null;
	source: string | null;
	version: string | null;
	attribution: string | null;
	out: string | null;
}

const FLAGS = ['--dataset', '--baseline', '--baseline-version', '--cell', '--bbox', '--orchard-classes', '--vine-classes', '--source', '--version', '--attribution', '--out'];

const classList = (text: string | null, fallback: number): number[] | null => {
	if (text === null) return [fallback];
	const c = text.split(',').map((x) => Number(x.trim()));
	return c.length && c.every((x) => Number.isInteger(x) && x >= 0 && x < 256) ? c : null;
};

export function parseCropTypeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CropTypeArgs | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const unknown = argv.find((a) => a.startsWith('--') && !FLAGS.includes(a));
	if (unknown) return `unknown option ${unknown}`;
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && FLAGS.includes(argv[i - 1]!)));
	const base = {
		baseline: null,
		baselineVersion: null,
		cellDeg: DEFAULT_CELL_DEG,
		orchardClasses: [SANLC_ORCHARDS],
		vineClasses: [SANLC_VINES],
		bbox: null,
		source: null,
		version: null,
		attribution: null,
		out: null
	};
	if (positional.length === 0) return { ...base, file: SYNTHETIC_CROP_TYPES_FILE, dataset: SYNTHETIC_CROPLAND_DATASET };
	if (positional.length > 1) return 'give one raster (the current edition), and the earlier one with --baseline';
	const file = positional[0]!;
	const ext = extname(file).toLowerCase();
	if (!['.tif', '.tiff', '.json'].includes(ext)) return `${file}: give a GeoTIFF (.tif) or the fixture's .json form`;
	const dataset = flag('--dataset');
	if (!dataset || dataset.length > 50) return 'give the dataset a label of at most 50 characters with --dataset (e.g. SANLC-2022)';
	if (dataset === SYNTHETIC_CROPLAND_DATASET) return `"${SYNTHETIC_CROPLAND_DATASET}" is the committed fixture's label; pick another`;
	const baseline = flag('--baseline');
	const baselineVersion = flag('--baseline-version');
	if (baseline !== null && ext === '.json') return '--baseline takes the earlier edition\'s raster: a .json file already holds its new plantings';
	if (baseline !== null && !['.tif', '.tiff'].includes(extname(baseline).toLowerCase())) return '--baseline takes the earlier edition as a GeoTIFF (.tif)';
	if ((baseline === null) !== (baselineVersion === null) && ext !== '.json') return 'give --baseline and --baseline-version together (e.g. --baseline sanlc-2018.tif --baseline-version 2018)';
	if (baselineVersion !== null && !(baselineVersion.trim().length >= 1 && baselineVersion.length <= 100)) return '--baseline-version takes the earlier edition\'s name, at most 100 characters';
	const cellText = flag('--cell');
	const cellDeg = cellText === null ? DEFAULT_CELL_DEG : Number(cellText);
	if (!(cellDeg > 0 && cellDeg <= 0.1)) return '--cell takes a cell size in degrees, above 0 and at most 0.1 (default 0.0025)';
	const orchardClasses = classList(flag('--orchard-classes'), SANLC_ORCHARDS);
	const vineClasses = classList(flag('--vine-classes'), SANLC_VINES);
	if (!orchardClasses || !vineClasses) return '--orchard-classes and --vine-classes take class codes 0–255, comma-separated (SANLC: 32 and 33)';
	if (orchardClasses.some((c) => vineClasses.includes(c))) return 'a class can be an orchard or a vine, not both';
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
		file: cliPath(file, env),
		baseline: baseline === null ? null : cliPath(baseline, env),
		baselineVersion: baselineVersion?.trim() ?? null,
		dataset,
		cellDeg,
		orchardClasses,
		vineClasses,
		bbox,
		source: flag('--source'),
		version: flag('--version'),
		attribution: flag('--attribution'),
		out: out === null ? null : cliPath(out, env)
	};
}

/** What `args`' files describe: the product and its cells. A file that can't be read is a string, naming it. */
export function readCropTypeFiles(args: CropTypeArgs): { meta: CropTypeDatasetMeta; cells: CropTypeCell[]; problems: string[]; pixels: number | null } | string {
	if (extname(args.file).toLowerCase() === '.json') {
		const got = cropTypesFromJson(JSON.parse(readFileSync(args.file, 'utf8')));
		if (typeof got === 'string') return `${args.file}: ${got}`;
		return {
			meta: cropTypeJsonMeta(args.dataset, got, { source: args.source, version: args.version, baselineVersion: args.baselineVersion, attribution: args.attribution }),
			cells: got.cells,
			problems: got.problems.map((p) => `${args.file}: ${p}`),
			pixels: null
		};
	}
	const got = cropTypeCellsFromTiff(readFileSync(args.file), args.baseline ? readFileSync(args.baseline) : null, args.cellDeg, { orchard: args.orchardClasses, vine: args.vineClasses }, args.bbox ?? undefined);
	if (typeof got === 'string') return `${args.file}: ${got}`;
	return {
		meta: {
			dataset: args.dataset,
			source: args.source ?? SANLC_2022.source,
			version: args.version ?? SANLC_2022.version,
			baselineVersion: args.baselineVersion,
			attribution: args.attribution ?? SANLC_2022.attribution,
			method: cropTypeMethodFor(args.cellDeg, args.orchardClasses, args.vineClasses, args.baselineVersion),
			cellDeg: args.cellDeg,
			orchardClasses: args.orchardClasses,
			vineClasses: args.vineClasses
		},
		cells: got.cells,
		problems: [],
		pixels: got.pixels
	};
}

/** Load `args` into the database at `url`; returns the cells written and what was skipped. */
export async function importCropTypes(url: string, args: CropTypeArgs): Promise<{ written: number; problems: string[] }> {
	const read = readCropTypeFiles(args);
	if (typeof read === 'string') throw new Error(read);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		return { written: await replaceCropTypeDataset(client, read.meta, read.cells), problems: read.problems };
	} finally {
		await client.end();
	}
}

/** Write `args`' files, pre-summarised, to `args.out` (gzipped for .gz) instead of loading them. Refuses an empty grid, as the load does. */
export function writeCropTypesJson(args: CropTypeArgs & { out: string }): { written: number; problems: string[] } {
	const read = readCropTypeFiles(args);
	if (typeof read === 'string') throw new Error(read);
	if (!read.cells.length) throw new Error('no cell has any orchard or vine: check the files and the classes');
	const json = cropTypesToJson(read.meta, read.cells);
	writeFileSync(args.out, /\.gz$/i.test(args.out) ? gzipSync(json) : json);
	return { written: read.cells.length, problems: read.problems };
}

/** Load the committed synthetic grid into the database at `url` (the DB tests' and e2e's setup; idempotent). */
export const loadSyntheticCropTypes = (url: string) => {
	const args = parseCropTypeArgs([]);
	if (typeof args === 'string') throw new Error(args);
	return importCropTypes(url, args);
};

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseCropTypeArgs(process.argv.slice(2));
	if (typeof args === 'string') {
		console.error(
			`${args}\nusage: pnpm import:crop-types [<current.tif> --dataset <label> [--baseline <earlier.tif> --baseline-version <name>] [--cell 0.0025] [--bbox w,s,e,n] [--orchard-classes 32] [--vine-classes 33] [--source "…"] [--version "…"] [--attribution "…"] [--out <grid.json[.gz]>]]`
		);
		process.exit(2);
	}
	if (args.file !== SYNTHETIC_CROP_TYPES_FILE) console.warn(TERMS_PENDING);
	if (args.out) {
		try {
			const { written, problems } = writeCropTypesJson({ ...args, out: args.out });
			for (const p of problems) console.warn(`skipped: ${p}`);
			console.log(`${written} cell${written === 1 ? '' : 's'} with orchards or vines written to ${args.out}`);
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
	importCropTypes(url, args)
		.then(({ written, problems }) => {
			for (const p of problems) console.warn(`skipped: ${p}`);
			console.log(`${written} cell${written === 1 ? '' : 's'} with orchards or vines loaded as "${args.dataset}"`);
			process.exit(0);
		})
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
