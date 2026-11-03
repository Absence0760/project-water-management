// Load a quaternary dataset for the map's quaternary lookup (issue #288 phase
// 2; docs/maps.md § Quaternary dataset):
//
//   pnpm import:quaternaries                         the committed synthetic dataset (dev, e2e)
//   pnpm import:quaternaries <boundaries.geojson> --dataset WR2012 --source "<study, volume, table>" [--values <values.csv>] [--evap-zones <zones.csv>]
//   … --out <file.geojson[.gz]>                    write the outlines with their values for a production load instead
//
// --values may carry each quaternary's MAE and evaporation zone (mae_mm,
// evap_zone), and --evap-zones the zones' monthly distribution (zone,oct,…,sep,
// % of MAE; docs/maps.md § Quaternary dataset). --out writes both into the
// one file.
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like migrate.ts: the app
// role only reads quaternary_reference. A load replaces every row of its
// dataset. Paths resolve from the directory the command was typed in.
//
// The repo ships only invented data (region Z, backend/fixtures/geo/). The
// real DWS outlines and WR2012 values are the operator's own download, never
// committed (the repo is public). Production may load them (the operator's
// decision, 2026-11-02, docs/maps.md § Sources): `--out` writes the one file
// load-reference.yml's `quaternaries` kind reads (docs/deployment.md §
// Reference datasets).
import { loadDevEnv } from '../src/config/devEnv.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { parseEvapZonesCsv, parseValuesCsv, QUATERNARY_SOURCE, quaternaryFeatureCollection, quaternaryRecords, replaceDataset, type EvapZone, type QuaternaryRecord } from '../src/geo/loadQuaternaries.js';
import { SYNTHETIC_DATASET } from '../src/geo/quaternary.js';

/** The committed synthetic dataset. */
export const SYNTHETIC_FILE = fileURLToPath(new URL('../fixtures/geo/quaternaries.synthetic.geojson', import.meta.url));

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export interface Args {
	file: string;
	dataset: string;
	source: string;
	values: string | null;
	/** The evaporation zones' monthly distribution (zone,oct,…,sep in % of MAE); null = the boundaries file's own `evapZones`. */
	evapZones: string | null;
	/** Write the outlines with their values to this GeoJSON file (gzipped when it ends .gz) instead of loading them. */
	out: string | null;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
	const outText = flag('--out');
	if (outText !== null && !/\.(geo)?json(\.gz)?$/i.test(outText)) return '--out takes a .geojson, .json, .geojson.gz or .json.gz file';
	const out = outText === null ? null : cliPath(outText, env);
	if (positional.length === 0) {
		if (out) return '--out needs a boundaries file: the synthetic fixture is never loaded in production';
		return { file: SYNTHETIC_FILE, dataset: SYNTHETIC_DATASET, source: '', values: null, evapZones: null, out: null };
	}
	const dataset = flag('--dataset');
	if (!dataset) return 'give the dataset a label with --dataset (e.g. WR2012)';
	if (dataset === SYNTHETIC_DATASET) return `"${SYNTHETIC_DATASET}" is the committed fixture's label; pick another`;
	const values = flag('--values');
	const evapZones = flag('--evap-zones');
	if (evapZones === '') return '--evap-zones takes a CSV file (zone,oct,nov,…,sep in % of MAE)';
	return {
		file: cliPath(positional[0]!, env),
		dataset,
		source: flag('--source') ?? '',
		values: values ? cliPath(values, env) : null,
		evapZones: evapZones ? cliPath(evapZones, env) : null,
		out
	};
}

/** The records `args` describes (boundaries, values, evaporation zones, source), with the features and zones skipped. */
function readRecords(args: Args): { records: QuaternaryRecord[]; zones: EvapZone[]; problems: string[] } {
	const csv = args.values ? parseValuesCsv(readFileSync(args.values, 'utf8')) : { values: new Map(), problems: [] };
	const zones = args.evapZones ? parseEvapZonesCsv(readFileSync(args.evapZones, 'utf8')) : null;
	const { records, zones: loaded, problems } = quaternaryRecords(JSON.parse(readFileSync(args.file, 'utf8')), args.source, csv.values, zones?.zones);
	return { records, zones: loaded, problems: [...csv.problems, ...(zones?.problems ?? []), ...problems] };
}

/**
 * Write `args`' outlines with their values to `args.out`, the GeoJSON a
 * production load reads (gzipped for .gz); returns the features written.
 * The production load stores its recorded credit, so with no --source the
 * file carries that one rather than skipping every feature.
 */
export function writeQuaternariesJson(args: Args & { out: string }): { written: number; problems: string[] } {
	const { records, zones, problems } = readRecords({ ...args, source: args.source || QUATERNARY_SOURCE });
	const json = JSON.stringify(quaternaryFeatureCollection(records, zones));
	if (records.length) writeFileSync(args.out, /\.gz$/i.test(args.out) ? gzipSync(json) : json);
	return { written: records.length, problems };
}

/** Load `args` into the database at `url`; returns the rows written and the features skipped. */
export async function importQuaternaries(url: string, args: Args): Promise<{ written: number; problems: string[] }> {
	const { records, zones, problems } = readRecords(args);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const written = records.length ? await replaceDataset(client, args.dataset, { records, zones }) : 0;
		return { written, problems };
	} finally {
		await client.end();
	}
}

/** Load the committed synthetic dataset (its outlines, values and evaporation zones) into the database at `url`. */
export const loadSyntheticQuaternaries = (url: string) => importQuaternaries(url, parseArgs([]) as Args);

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseArgs(process.argv.slice(2));
	if (typeof args === 'string') {
		console.error(`${args}\nusage: pnpm import:quaternaries [<boundaries.geojson> --dataset <label> --source "<study>" [--values <values.csv>] [--evap-zones <zones.csv>] [--out <file.geojson[.gz]>]]`);
		process.exit(2);
	}
	const out = args.out;
	if (out) {
		const { written, problems } = writeQuaternariesJson({ ...args, out });
		for (const p of problems) console.warn(`skipped: ${p}`);
		console.log(written ? `${written} quaternar${written === 1 ? 'y' : 'ies'} written to ${out}` : 'no quaternary to write; nothing written');
		process.exit(written ? 0 : 1);
	}
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
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
