// Load a gauging-station dataset for the map's nearest-gauge proposal (issue
// #326 Part B "B-gauge"; docs/maps.md § Gauging stations):
//
//   pnpm import:gauge-stations                                        the committed synthetic dataset (dev, e2e)
//   pnpm import:gauge-stations <stations.geojson|.csv> … --dataset "DWS 2026-10" --source "<catalogue, URL, date downloaded>"
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like migrate.ts: the app
// role only reads gauge_station_reference. A load replaces every row of its
// dataset. Paths resolve from the directory the command was typed in.
//
// The repo ships only invented stations (region Z, backend/fixtures/geo/).
// The DWS station catalogue's terms for commercial reuse are unconfirmed
// (docs/maps.md § Sources): load it only once they are, and never commit it.
import { loadDevEnv } from '../src/config/devEnv.js';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { replaceStations, stationRecords } from '../src/geo/loadGaugeStations.js';
import { SYNTHETIC_STATIONS } from '../src/geo/stations.js';

/** The committed synthetic dataset. */
export const SYNTHETIC_STATIONS_FILE = fileURLToPath(new URL('../fixtures/geo/gauge-stations.synthetic.geojson', import.meta.url));

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export interface Args {
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
	if (positional.length === 0) return { files: [SYNTHETIC_STATIONS_FILE], dataset: SYNTHETIC_STATIONS, source: '' };
	const dataset = flag('--dataset');
	if (!dataset) return 'give the dataset a label with --dataset (e.g. "DWS 2026-10")';
	if (dataset === SYNTHETIC_STATIONS) return `"${SYNTHETIC_STATIONS}" is the committed fixture's label; pick another`;
	if (dataset.length > 50) return 'the dataset label is at most 50 characters';
	return { files: positional.map((p) => cliPath(p, env)), dataset, source: flag('--source') ?? '' };
}

/** Load `args` into the database at `url`; returns the rows written and the stations skipped. */
export async function importGaugeStations(url: string, args: Args): Promise<{ written: number; problems: string[] }> {
	const { records, problems } = stationRecords(
		args.files.map((f) => ({ name: basename(f), text: readFileSync(f, 'utf8') })),
		args.source
	);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const written = records.length ? await replaceStations(client, args.dataset, records) : 0;
		return { written, problems };
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
		console.error(`${args}\nusage: pnpm import:gauge-stations [<stations.geojson|.csv> … --dataset <label> --source "<catalogue, URL, date>"]`);
		process.exit(2);
	}
	importGaugeStations(url, args)
		.then(({ written, problems }) => {
			for (const p of problems) console.warn(`skipped: ${p}`);
			console.log(`${written} gauging station${written === 1 ? '' : 's'} loaded as "${args.dataset}"`);
			process.exit(written ? 0 : 1);
		})
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
