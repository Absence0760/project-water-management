// Load a set of GR4J donor basins for the regional prior (issue #622 step 3;
// docs/deployment.md § Reference datasets, GR4J donors):
//
//   pnpm import:gr4j-donors                                 the committed synthetic donors (dev, CI, e2e)
//   pnpm import:gr4j-donors <donors.json[.gz]> --dataset <label>
//                          the donor file backend/scripts/fit-donors.ts wrote
//
// Runs as the schema owner (MIGRATION_DATABASE_URL): the app role only reads
// gr4j_donor_dataset and gr4j_donor. A load replaces every row of its
// dataset. Paths resolve from the directory the command was typed in. A
// production load takes the same file through load-reference.yml (kind
// gr4j-donors). The repo ships only invented donors
// (backend/fixtures/gr4j-donors/); a real set is the operator's, never committed.
import { loadDevEnv } from '../src/config/devEnv.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { donorsFromJson, GR4J_DONORS, replaceDonorDataset, SYNTHETIC_DONOR_DATASET, type DonorRecord, type DonorSetMeta } from '../src/geo/gr4jDonors.js';

/** The committed synthetic donors. */
export const SYNTHETIC_DONORS_FILE = fileURLToPath(new URL('../fixtures/gr4j-donors/gr4j-donors.synthetic.json', import.meta.url));

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export interface DonorsArgs {
	file: string;
	dataset: string;
}

export function parseDonorsArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): DonorsArgs | string {
	const unknown = argv.find((a) => a.startsWith('--') && a !== '--dataset');
	if (unknown) return `unknown option ${unknown}`;
	const i = argv.indexOf('--dataset');
	const dataset = i >= 0 ? (argv[i + 1] ?? '') : null;
	const positional = argv.filter((a, j) => !a.startsWith('--') && !(j > 0 && argv[j - 1] === '--dataset'));
	if (positional.length === 0) return dataset === null ? { file: SYNTHETIC_DONORS_FILE, dataset: SYNTHETIC_DONOR_DATASET } : 'give the donor file with --dataset';
	if (positional.length > 1) return 'give one donor file';
	const file = positional[0]!;
	if (!/\.json(\.gz)?$/i.test(file)) return `${file}: give the .json or .json.gz fit-donors.ts wrote`;
	if (!dataset || dataset.length > 50) return 'give the dataset a label of at most 50 characters with --dataset (e.g. Caravan-D1-2026)';
	if (dataset === SYNTHETIC_DONOR_DATASET) return `"${SYNTHETIC_DONOR_DATASET}" is the committed fixture's label; pick another`;
	return { file: cliPath(file, env), dataset };
}

/** What `args`' file describes. A file that can't be read, or lacks a source, method or engine version, throws, naming it. */
export function readDonorsFile(args: DonorsArgs): { meta: DonorSetMeta; donors: DonorRecord[]; skipped: string[] } {
	try {
		const bytes = readFileSync(args.file);
		const got = donorsFromJson(JSON.parse((/\.gz$/i.test(args.file) ? gunzipSync(bytes) : bytes).toString('utf8')));
		if (typeof got === 'string') throw new Error(got);
		const { source, version, method, engineVersion } = got.meta;
		if (!source || !version || !method || !engineVersion) throw new Error('the file names no source, version, method or engineVersion (fit-donors.ts writes them)');
		return {
			meta: { dataset: args.dataset, source, version, method, engineVersion, attribution: got.meta.attribution ?? GR4J_DONORS.attribution },
			donors: got.donors,
			skipped: got.problems
		};
	} catch (e) {
		throw new Error(`${args.file}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Load `args` into the database at `url`; returns the donors written and the ones skipped. */
export async function importDonors(url: string, args: DonorsArgs): Promise<{ written: number; skipped: string[] }> {
	const { meta, donors, skipped } = readDonorsFile(args);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		return { written: await replaceDonorDataset(client, meta, donors), skipped };
	} finally {
		await client.end();
	}
}

/** Load the committed synthetic donors into the database at `url` (the DB tests' setup; idempotent). */
export const loadSyntheticDonors = async (url: string) => (await importDonors(url, { file: SYNTHETIC_DONORS_FILE, dataset: SYNTHETIC_DONOR_DATASET })).written;

const USAGE = 'usage: pnpm import:gr4j-donors [<donors.json[.gz]> --dataset <label>]';

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const args = parseDonorsArgs(process.argv.slice(2));
	if (typeof args === 'string') {
		console.error(`${args}\n${USAGE}`);
		process.exit(2);
	}
	const url = process.env.MIGRATION_DATABASE_URL;
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	importDonors(url, args)
		.then(({ written, skipped }) => {
			for (const s of skipped.slice(0, 20)) console.warn(`skipped ${s}`);
			if (skipped.length > 20) console.warn(`… and ${skipped.length - 20} more skipped`);
			console.log(`${written} donor${written === 1 ? '' : 's'} loaded as "${args.dataset}"`);
			process.exit(0);
		})
		.catch((err: Error) => {
			console.error(err.message);
			process.exit(1);
		});
}
