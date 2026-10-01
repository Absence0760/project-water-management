// Load a quaternary dataset for the map's quaternary lookup (issue #288 phase
// 2; docs/maps.md § Quaternary dataset):
//
//   pnpm import:quaternaries                         the committed synthetic dataset (dev, e2e)
//   pnpm import:quaternaries <boundaries.geojson> --dataset WR2012 --source "<study, volume, table>" [--values <values.csv>]
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like migrate.ts: the app
// role only reads quaternary_reference. A load replaces every row of its
// dataset. Paths resolve from the directory the command was typed in.
//
// The repo ships only invented data (region Z, backend/fixtures/geo/). The
// real DWS quaternary boundaries are open data; the WR2012 values come from
// the operator's own registered download, whose redistribution terms are
// unconfirmed (docs/maps.md), so they are loaded into the database, never
// committed.
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseValuesCsv, quaternaryRecords, replaceDataset } from '../src/geo/loadQuaternaries.js';
import { SYNTHETIC_DATASET } from '../src/geo/quaternary.js';

/** The committed synthetic dataset. */
export const SYNTHETIC_FILE = fileURLToPath(new URL('../fixtures/geo/quaternaries.synthetic.geojson', import.meta.url));

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export interface Args {
	file: string;
	dataset: string;
	source: string;
	values: string | null;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
	if (positional.length === 0) return { file: SYNTHETIC_FILE, dataset: SYNTHETIC_DATASET, source: '', values: null };
	const dataset = flag('--dataset');
	if (!dataset) return 'give the dataset a label with --dataset (e.g. WR2012)';
	if (dataset === SYNTHETIC_DATASET) return `"${SYNTHETIC_DATASET}" is the committed fixture's label; pick another`;
	const values = flag('--values');
	return { file: cliPath(positional[0]!, env), dataset, source: flag('--source') ?? '', values: values ? cliPath(values, env) : null };
}

/** Load `args` into the database at `url`; returns the rows written and the features skipped. */
export async function importQuaternaries(url: string, args: Args): Promise<{ written: number; problems: string[] }> {
	const csv = args.values ? parseValuesCsv(readFileSync(args.values, 'utf8')) : { values: new Map(), problems: [] };
	const { records, problems } = quaternaryRecords(JSON.parse(readFileSync(args.file, 'utf8')), args.source, csv.values);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const written = records.length ? await replaceDataset(client, args.dataset, records) : 0;
		return { written, problems: [...csv.problems, ...problems] };
	} finally {
		await client.end();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	config({ path: ['.env.development.local', '.env.development'] });
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseArgs(process.argv.slice(2));
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	if (typeof args === 'string') {
		console.error(`${args}\nusage: pnpm import:quaternaries [<boundaries.geojson> --dataset <label> --source "<study>" [--values <values.csv>]]`);
		process.exit(2);
	}
	importQuaternaries(url, args)
		.then(({ written, problems }) => {
			for (const p of problems) console.warn(`skipped: ${p}`);
			console.log(`${written} quaternar${written === 1 ? 'y' : 'ies'} loaded as "${args.dataset}"`);
			process.exit(written ? 0 : 1);
		})
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
