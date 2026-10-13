// Load a gazetteer for the Map's search (issue #523 C5; docs/maps.md § Search):
//
//   pnpm import:gazetteer                                                 the committed synthetic places (dev, e2e)
//   pnpm import:gazetteer <ZA.txt[.gz]> [<BW.txt[.gz]> …] --dataset GeoNames-2026-10 [--source "<attribution>"]
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like migrate.ts: the app
// role only reads gazetteer_reference. A load replaces every row of its
// dataset (several files load as one dataset; other datasets stay). Paths
// resolve from the directory the command was typed in.
//
// The repo ships only invented places (backend/fixtures/geo/). The real ones
// are GeoNames' dumps of South Africa and its six neighbours (`ZA.zip`,
// `BW.zip`, `LS.zip`, `MZ.zip`, `NA.zip`, `SZ.zip`, `ZW.zip` from
// https://download.geonames.org/export/dump/, unzipped; CC BY 4.0, so the
// source defaults to its attribution, docs/maps.md § Sources); a neighbour's
// places load only inside the basemap (geo/loadGazetteer.ts). The operator's
// own download, never committed. Production loads the same file through
// load-reference.yml (docs/deployment.md § Reference datasets).
import { loadDevEnv } from '../src/config/devEnv.js';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { GEONAMES_SOURCE, SYNTHETIC_GAZETTEER } from '../src/geo/gazetteer.js';
import { placeRecords, placesSummary, replacePlaces, type PlaceRecords } from '../src/geo/loadGazetteer.js';

/** The committed synthetic places. */
export const SYNTHETIC_GAZETTEER_FILE = fileURLToPath(new URL('../fixtures/geo/gazetteer.synthetic.txt', import.meta.url));
/** The synthetic places' source line: never a real place. */
export const SYNTHETIC_GAZETTEER_SOURCE = 'SYNTHETIC test data, invented for this repository (not GeoNames)';

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export interface Args {
	/** One or more GeoNames dumps, loaded together as one dataset. */
	files: string[];
	dataset: string;
	source: string;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
	if (positional.length === 0) return { files: [SYNTHETIC_GAZETTEER_FILE], dataset: SYNTHETIC_GAZETTEER, source: SYNTHETIC_GAZETTEER_SOURCE };
	const dataset = flag('--dataset');
	if (!dataset) return 'give the dataset a label with --dataset (e.g. "GeoNames-ZA-2026-10")';
	if (dataset === SYNTHETIC_GAZETTEER) return `"${SYNTHETIC_GAZETTEER}" is the committed fixture's label; pick another`;
	if (dataset.length > 50) return 'the dataset label is at most 50 characters';
	const source = flag('--source') ?? GEONAMES_SOURCE;
	if (!source.trim() || source.length > 500) return 'the source is 1 to 500 characters';
	const files = positional.map((p) => cliPath(p, env));
	const twice = files.find((f, i) => files.indexOf(f) !== i);
	if (twice) return `${twice} is given twice`;
	return { files, dataset, source: source.trim() };
}

export type ImportResult = { written: number } & Omit<PlaceRecords, 'records'>;

/** Load `args` into the database at `url`, every file as one dataset; returns the rows written, the lines skipped, and the places left out on purpose (by kind, country, or a neighbour's off the basemap). */
export async function importGazetteer(url: string, args: Args): Promise<ImportResult> {
	const seen = new Set<string>();
	const all: PlaceRecords = { records: [], problems: [], leftOut: 0, otherCountry: 0, outsideMap: 0, countries: {} };
	for (const file of args.files) {
		const bytes = readFileSync(file);
		const text = (file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
		const got = placeRecords(text, basename(file), args.source, seen);
		all.records.push(...got.records);
		all.problems.push(...got.problems);
		all.leftOut += got.leftOut;
		all.otherCountry += got.otherCountry;
		all.outsideMap += got.outsideMap;
		for (const [cc, n] of Object.entries(got.countries)) all.countries[cc] = (all.countries[cc] ?? 0) + n;
	}
	const { records, ...rest } = all;
	if (!records.length) return { written: 0, ...rest };
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		return { written: await replacePlaces(client, args.dataset, records), ...rest };
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
		console.error(`${args}\nusage: pnpm import:gazetteer [<ZA.txt[.gz]> [<BW.txt[.gz]> …] --dataset <label> [--source "<attribution>"]]`);
		process.exit(2);
	}
	importGazetteer(url, args)
		.then((got) => {
			for (const p of got.problems.slice(0, 50)) console.warn(`skipped: ${p}`);
			if (got.problems.length > 50) console.warn(`… and ${got.problems.length - 50} more skipped`);
			console.log(`${got.written} place${got.written === 1 ? '' : 's'} loaded as "${args.dataset}" (${placesSummary(got)})`);
			process.exit(got.written ? 0 : 1);
		})
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
