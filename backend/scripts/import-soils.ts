// Load a soil water capacity grid for the regional GR4J prior (issue #622
// step 2; docs/maps.md § Soil water capacity):
//
//   pnpm import:soils                                    the committed synthetic grid (dev, CI, e2e)
//   pnpm import:soils <soils.json[.gz]> --dataset <label> [--source "…"] [--version "…"] [--attribution "…"]
//                          the grid ingest/soils.py wrote from SoilGrids 2.0 and iSDAsoil
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like import-evaporation:
// the app role only reads soil_dataset and soil_cell_reference. A load
// replaces every row of its dataset. Paths resolve from the directory the
// command was typed in. A production load takes the same file through
// load-reference.yml (kind soils; docs/deployment.md § Reference datasets).
// The repo ships only invented data (backend/fixtures/soils/); a real grid
// is the operator's own, never committed.
import { loadDevEnv } from '../src/config/devEnv.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { replaceSoilDataset, soilFromJson, soilMethodFor, SOILS, SYNTHETIC_SOIL_DATASET, type SoilGrid, type SoilMeta } from '../src/geo/soilGrid.js';

/** The committed synthetic grid. */
export const SYNTHETIC_SOILS_FILE = fileURLToPath(new URL('../fixtures/soils/soils.synthetic.json', import.meta.url));

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export interface SoilsArgs {
	file: string;
	dataset: string;
	source: string | null;
	version: string | null;
	attribution: string | null;
}

const FLAGS = ['--dataset', '--source', '--version', '--attribution'];

export function parseSoilsArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SoilsArgs | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const unknown = argv.find((a) => a.startsWith('--') && !FLAGS.includes(a));
	if (unknown) return `unknown option ${unknown}`;
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && FLAGS.includes(argv[i - 1]!)));
	const base = { source: flag('--source'), version: flag('--version'), attribution: flag('--attribution') };
	if (positional.length === 0) return { ...base, file: SYNTHETIC_SOILS_FILE, dataset: SYNTHETIC_SOIL_DATASET };
	if (positional.length > 1) return 'give one grid file';
	const file = positional[0]!;
	if (!/\.json(\.gz)?$/i.test(file)) return `${file}: give the .json or .json.gz ingest/soils.py wrote`;
	const dataset = flag('--dataset');
	if (!dataset || dataset.length > 50) return 'give the dataset a label of at most 50 characters with --dataset (e.g. SoilGrids2-iSDA-D1)';
	if (dataset === SYNTHETIC_SOIL_DATASET) return `"${SYNTHETIC_SOIL_DATASET}" is the committed fixture's label; pick another`;
	return { ...base, file: cliPath(file, env), dataset };
}

/** What `args`' file describes: the dataset row and its cells. A file that can't be read throws, naming it. */
export function readSoilsFile(args: SoilsArgs): { meta: SoilMeta; grid: SoilGrid; skipped: string[] } {
	try {
		const bytes = readFileSync(args.file);
		const got = soilFromJson(JSON.parse((/\.gz$/i.test(args.file) ? gunzipSync(bytes) : bytes).toString('utf8')));
		if (typeof got === 'string') throw new Error(got);
		return {
			meta: {
				dataset: args.dataset,
				source: args.source ?? got.meta.source ?? SOILS.source,
				version: args.version ?? got.meta.version ?? SOILS.version,
				attribution: args.attribution ?? got.meta.attribution ?? SOILS.attribution,
				method: soilMethodFor(got.grid.cellDeg)
			},
			grid: got.grid,
			skipped: got.problems
		};
	} catch (e) {
		throw new Error(`${args.file}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Load `args` into the database at `url`; returns the cells written and the ones skipped. */
export async function importSoils(url: string, args: SoilsArgs): Promise<{ written: number; skipped: string[] }> {
	const { meta, grid, skipped } = readSoilsFile(args);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		return { written: await replaceSoilDataset(client, meta, grid), skipped };
	} finally {
		await client.end();
	}
}

/** Load the committed synthetic grid into the database at `url` (the DB tests' setup; idempotent). */
export const loadSyntheticSoils = async (url: string) => {
	const args = parseSoilsArgs([]);
	if (typeof args === 'string') throw new Error(args);
	return (await importSoils(url, args)).written;
};

const USAGE = 'usage: pnpm import:soils [<soils.json[.gz]> --dataset <label> [--source "…"] [--version "…"] [--attribution "…"]]';

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const args = parseSoilsArgs(process.argv.slice(2));
	if (typeof args === 'string') {
		console.error(`${args}\n${USAGE}`);
		process.exit(2);
	}
	const url = process.env.MIGRATION_DATABASE_URL;
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	importSoils(url, args)
		.then(({ written, skipped }) => {
			for (const s of skipped.slice(0, 20)) console.warn(`skipped ${s}`);
			if (skipped.length > 20) console.warn(`… and ${skipped.length - 20} more skipped`);
			console.log(`${written} cell${written === 1 ? '' : 's'} loaded as "${args.dataset}"`);
			process.exit(0);
		})
		.catch((err: Error) => {
			console.error(err.message);
			process.exit(1);
		});
}
