// Load a river network for the map's River network layer and its proposals
// (issue #345; docs/maps.md § River network):
//
//   pnpm import:rivers                                     the committed synthetic network (dev, e2e)
//   pnpm import:rivers <rivers.geojson> … --dataset HydroRIVERS-v10 --source "<product, version, attribution>" [--min-order <n>]
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like migrate.ts: the app
// role only reads river_reference. A load replaces every row of its dataset.
// Paths resolve from the directory the command was typed in.
//
// The repo ships only an invented network (backend/fixtures/geo/). The real
// one is HydroRIVERS (licence allows commercial use with attribution,
// docs/maps.md § Sources), fetched and converted by `pnpm dev:tiles:rivers`
// (bin/tiles-dev.sh) from the operator's own download; never committed.
import { loadDevEnv } from '../src/config/devEnv.js';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { replaceRivers, riverRecords } from '../src/geo/loadRivers.js';
import { SYNTHETIC_RIVERS } from '../src/geo/rivers.js';

/** The committed synthetic network. */
export const SYNTHETIC_RIVERS_FILE = fileURLToPath(new URL('../fixtures/geo/rivers.synthetic.geojson', import.meta.url));

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export interface Args {
	files: string[];
	dataset: string;
	source: string;
	minOrder: number;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
	const order = flag('--min-order');
	const minOrder = order === null ? 1 : Number(order);
	if (!Number.isInteger(minOrder) || minOrder < 1 || minOrder > 15) return '--min-order is a Strahler order, 1 to 15';
	if (positional.length === 0) return { files: [SYNTHETIC_RIVERS_FILE], dataset: SYNTHETIC_RIVERS, source: '', minOrder };
	const dataset = flag('--dataset');
	if (!dataset) return 'give the dataset a label with --dataset (e.g. "HydroRIVERS-v10")';
	if (dataset === SYNTHETIC_RIVERS) return `"${SYNTHETIC_RIVERS}" is the committed fixture's label; pick another`;
	if (dataset.length > 50) return 'the dataset label is at most 50 characters';
	return { files: positional.map((p) => cliPath(p, env)), dataset, source: flag('--source') ?? '', minOrder };
}

/** Load `args` into the database at `url`; returns the rows written, the reaches skipped and how many were below the order. */
export async function importRivers(url: string, args: Args): Promise<{ written: number; problems: string[]; belowOrder: number }> {
	const { records, problems, belowOrder } = riverRecords(
		args.files.map((f) => ({ name: basename(f), text: readFileSync(f, 'utf8') })),
		args.source,
		args.minOrder
	);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const written = records.length ? await replaceRivers(client, args.dataset, records) : 0;
		return { written, problems, belowOrder };
	} finally {
		await client.end();
	}
}

/** Load the committed synthetic network into the database at `url` (the DB tests' and e2e's setup; idempotent). */
export const loadSyntheticRivers = (url: string) => importRivers(url, { files: [SYNTHETIC_RIVERS_FILE], dataset: SYNTHETIC_RIVERS, source: '', minOrder: 1 });

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseArgs(process.argv.slice(2));
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	if (typeof args === 'string') {
		console.error(`${args}\nusage: pnpm import:rivers [<rivers.geojson> … --dataset <label> --source "<product, version, attribution>" [--min-order <n>]]`);
		process.exit(2);
	}
	importRivers(url, args)
		.then(({ written, problems, belowOrder }) => {
			const shown = problems.slice(0, 50);
			for (const p of shown) console.warn(`skipped: ${p}`);
			if (problems.length > shown.length) console.warn(`… and ${problems.length - shown.length} more skipped`);
			if (belowOrder) console.log(`${belowOrder} reach${belowOrder === 1 ? '' : 'es'} below Strahler order ${args.minOrder} left out`);
			console.log(`${written} river reach${written === 1 ? '' : 'es'} loaded as "${args.dataset}"`);
			process.exit(written ? 0 : 1);
		})
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
