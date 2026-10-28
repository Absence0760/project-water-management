// Load an evaporation-station dataset for the A-pan proposal (issue #646
// item 6; docs/maps.md § Evaporation stations):
//
//   pnpm import:evaporation-stations                                   the committed synthetic dataset (dev, e2e)
//   pnpm import:evaporation-stations <stations.csv> --records <dir> --dataset "DWS 2026-11" --source "<DWS reply reference, date>"
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like migrate.ts: the app
// role only reads evaporation_station_reference. A load replaces every row of
// its dataset. Paths resolve from the directory the command was typed in.
//
// The repo ships only invented stations (region Z,
// backend/fixtures/evaporation-stations/). DWS's permission recorded on
// 2026-10-28 covers verified daily flow only: load real evaporation records
// only into your own database until it covers them too, and never commit them.
import { loadDevEnv } from '../src/config/devEnv.js';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SYNTHETIC_EVAPORATION_STATIONS } from '../src/geo/evaporationStations.js';
import { evaporationStationRecords, replaceEvaporationStations } from '../src/geo/loadEvaporationStations.js';

/** The committed synthetic dataset: the station list and the directory of its invented replies. */
export const SYNTHETIC_EVAPORATION_STATIONS_DIR = fileURLToPath(new URL('../fixtures/evaporation-stations/', import.meta.url));
export const SYNTHETIC_EVAPORATION_STATIONS_LIST = join(SYNTHETIC_EVAPORATION_STATIONS_DIR, 'stations.synthetic.csv');

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export interface Args {
	list: string;
	records: string;
	dataset: string;
	source: string;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
	if (positional.length === 0) {
		return { list: SYNTHETIC_EVAPORATION_STATIONS_LIST, records: SYNTHETIC_EVAPORATION_STATIONS_DIR, dataset: SYNTHETIC_EVAPORATION_STATIONS, source: 'Invented test stations and records (backend/fixtures/evaporation-stations/)' };
	}
	if (positional.length > 1) return 'give one station list (a CSV)';
	const records = flag('--records');
	if (!records) return 'give the directory of the stations’ DWS records with --records';
	const dataset = flag('--dataset');
	if (!dataset) return 'give the dataset a label with --dataset (e.g. "DWS 2026-11")';
	if (dataset === SYNTHETIC_EVAPORATION_STATIONS) return `"${SYNTHETIC_EVAPORATION_STATIONS}" is the committed fixture's label; pick another`;
	if (dataset.length > 50) return 'the dataset label is at most 50 characters';
	return { list: cliPath(positional[0]!, env), records: cliPath(records, env), dataset, source: flag('--source') ?? '' };
}

/** Load `args` into the database at `url`; returns the rows written and the stations skipped. */
export async function importEvaporationStations(url: string, args: Args): Promise<{ written: number; problems: string[] }> {
	const files = readdirSync(args.records)
		.filter((f) => /\.(txt|html?|aspx)$/i.test(f))
		.sort()
		.map((f) => ({ name: f, text: readFileSync(join(args.records, f), 'utf8') }));
	const { stations, problems } = evaporationStationRecords({ name: basename(args.list), text: readFileSync(args.list, 'utf8') }, files, args.source);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const written = stations.length ? await replaceEvaporationStations(client, args.dataset, stations) : 0;
		return { written, problems };
	} finally {
		await client.end();
	}
}

/** The committed synthetic stations, loaded into the database at `url` (tests, e2e). */
export const loadSyntheticEvaporationStations = (url: string) => importEvaporationStations(url, parseArgs([]) as Args);

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseArgs(process.argv.slice(2));
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	if (typeof args === 'string') {
		console.error(`${args}\nusage: pnpm import:evaporation-stations [<stations.csv> --records <dir> --dataset <label> --source "<reply reference, date>"]`);
		process.exit(2);
	}
	importEvaporationStations(url, args)
		.then(({ written, problems }) => {
			for (const p of problems) console.warn(`skipped: ${p}`);
			console.log(`${written} evaporation station${written === 1 ? '' : 's'} loaded as "${args.dataset}"`);
			process.exit(written ? 0 : 1);
		})
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
