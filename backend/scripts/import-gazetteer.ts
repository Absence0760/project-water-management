// Load a gazetteer for the Map's search (issue #523 C5; docs/maps.md § Search):
//
//   pnpm import:gazetteer                                                 the committed synthetic places (dev, e2e)
//   pnpm import:gazetteer <ZA.txt[.gz]> --dataset GeoNames-ZA-2026-10 [--source "<attribution>"]
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like migrate.ts: the app
// role only reads gazetteer_reference. A load replaces every row of its
// dataset. Paths resolve from the directory the command was typed in.
//
// The repo ships only invented places (backend/fixtures/geo/). The real one
// is GeoNames' South Africa dump (`ZA.zip` from
// https://download.geonames.org/export/dump/, unzipped; CC BY 4.0, so the
// source defaults to its attribution, docs/maps.md § Sources): the operator's
// own download, never committed. Production loads the same file through
// load-reference.yml (docs/deployment.md § Reference datasets).
import { loadDevEnv } from '../src/config/devEnv.js';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { GEONAMES_SOURCE, SYNTHETIC_GAZETTEER } from '../src/geo/gazetteer.js';
import { placeRecords, replacePlaces } from '../src/geo/loadGazetteer.js';

/** The committed synthetic places. */
export const SYNTHETIC_GAZETTEER_FILE = fileURLToPath(new URL('../fixtures/geo/gazetteer.synthetic.txt', import.meta.url));
/** The synthetic places' source line: never a real place. */
export const SYNTHETIC_GAZETTEER_SOURCE = 'SYNTHETIC test data, invented for this repository (not GeoNames)';

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

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
	if (positional.length === 0) return { file: SYNTHETIC_GAZETTEER_FILE, dataset: SYNTHETIC_GAZETTEER, source: SYNTHETIC_GAZETTEER_SOURCE };
	if (positional.length > 1) return 'give one file: a GeoNames country dump (ZA.txt, or ZA.txt.gz)';
	const dataset = flag('--dataset');
	if (!dataset) return 'give the dataset a label with --dataset (e.g. "GeoNames-ZA-2026-10")';
	if (dataset === SYNTHETIC_GAZETTEER) return `"${SYNTHETIC_GAZETTEER}" is the committed fixture's label; pick another`;
	if (dataset.length > 50) return 'the dataset label is at most 50 characters';
	const source = flag('--source') ?? GEONAMES_SOURCE;
	if (!source.trim() || source.length > 500) return 'the source is 1 to 500 characters';
	return { file: cliPath(positional[0]!, env), dataset, source: source.trim() };
}

/** Load `args` into the database at `url`; returns the rows written, the lines skipped, the places of classes the search leaves out and the places outside South Africa. */
export async function importGazetteer(url: string, args: Args): Promise<{ written: number; problems: string[]; leftOut: number; otherCountry: number }> {
	const bytes = readFileSync(args.file);
	const text = (args.file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
	const { records, problems, leftOut, otherCountry } = placeRecords(text, basename(args.file), args.source);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const written = records.length ? await replacePlaces(client, args.dataset, records) : 0;
		return { written, problems, leftOut, otherCountry };
	} finally {
		await client.end();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseArgs(process.argv.slice(2));
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	if (typeof args === 'string') {
		console.error(`${args}\nusage: pnpm import:gazetteer [<ZA.txt[.gz]> --dataset <label> [--source "<attribution>"]]`);
		process.exit(2);
	}
	importGazetteer(url, args)
		.then(({ written, problems, leftOut, otherCountry }) => {
			for (const p of problems.slice(0, 50)) console.warn(`skipped: ${p}`);
			if (problems.length > 50) console.warn(`… and ${problems.length - 50} more skipped`);
			if (otherCountry) console.warn(`left out ${otherCountry} place${otherCountry === 1 ? '' : 's'} outside South Africa (country code not ZA): is this GeoNames' ZA dump?`);
			console.log(`${written} place${written === 1 ? '' : 's'} loaded as "${args.dataset}" (${leftOut} of the kinds the search leaves out)`);
			process.exit(written ? 0 : 1);
		})
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
