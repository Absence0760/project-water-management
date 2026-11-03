// Load WR2012's monthly S-pan and A-pan per quaternary (310; docs/maps.md §
// Quaternary evaporation):
//
//   pnpm import:quaternary-evaporation                                      the committed synthetic rows (dev, e2e)
//   pnpm import:quaternary-evaporation <evaporation.csv> --dataset <label> [--source "<study>"]
//
// The CSV is the one `scripts/wbt-import/wrsm_evaporation.py` writes from
// WR2012's WRSM2000 network configurations (loadQuaternaryEvaporation.ts
// describes it). Runs as the schema owner (MIGRATION_DATABASE_URL), like
// migrate.ts; a load replaces every row of its dataset. Paths resolve from the
// directory the command was typed in. The repo ships only invented rows (region
// Z, backend/fixtures/geo/); the real file is the operator's own, never
// committed. In production the same CSV is loaded by load-reference.yml, kind
// `quaternary-evaporation` (docs/deployment.md § Reference datasets).
import { loadDevEnv } from '../src/config/devEnv.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { QUATERNARY_EVAPORATION_SOURCE, quaternaryEvaporationRecords, replaceQuaternaryEvaporation } from '../src/geo/loadQuaternaryEvaporation.js';
import { SYNTHETIC_DATASET } from '../src/geo/quaternary.js';

/** The committed synthetic rows. */
export const SYNTHETIC_EVAPORATION_FILE = fileURLToPath(new URL('../fixtures/geo/quaternary-evaporation.synthetic.csv', import.meta.url));
export const SYNTHETIC_EVAPORATION_SOURCE = 'SYNTHETIC test data, invented for this repository (not WR2012): monthly S-pan and A-pan of region Z';

export interface Args {
	file: string;
	dataset: string;
	source: string;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
	if (!positional.length) return { file: SYNTHETIC_EVAPORATION_FILE, dataset: SYNTHETIC_DATASET, source: SYNTHETIC_EVAPORATION_SOURCE };
	const dataset = flag('--dataset');
	if (!dataset || dataset.length > 50) return 'give the dataset a label of 1 to 50 characters with --dataset (e.g. WR2012-WRSM2000)';
	if (dataset === SYNTHETIC_DATASET) return `"${SYNTHETIC_DATASET}" is the committed fixture's label; pick another`;
	const source = flag('--source');
	return { file: resolve(env.INIT_CWD ?? process.cwd(), positional[0]!), dataset, source: source?.trim() ? source.trim().slice(0, 500) : QUATERNARY_EVAPORATION_SOURCE };
}

/** Load `args` into the database at `url`; returns the rows written and the rows refused. */
export async function importQuaternaryEvaporation(url: string, args: Args): Promise<{ written: number; problems: string[] }> {
	const { records, problems } = quaternaryEvaporationRecords(readFileSync(args.file, 'utf8'));
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const written = records.length ? await replaceQuaternaryEvaporation(client, args.dataset, records, args.source) : 0;
		return { written, problems };
	} finally {
		await client.end();
	}
}

/** Load the committed synthetic rows into the database at `url`. */
export const loadSyntheticQuaternaryEvaporation = (url: string) => importQuaternaryEvaporation(url, parseArgs([]) as Args);

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseArgs(process.argv.slice(2));
	if (typeof args === 'string') {
		console.error(`${args}\nusage: pnpm import:quaternary-evaporation [<evaporation.csv> --dataset <label> [--source "<study>"]]`);
		process.exit(2);
	}
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	importQuaternaryEvaporation(url, args)
		.then(({ written, problems }) => {
			for (const p of problems) console.warn(`refused: ${p}`);
			console.log(`${written} quaternar${written === 1 ? 'y' : 'ies'}' evaporation loaded as "${args.dataset}"`);
			process.exit(written ? 0 : 1);
		})
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
