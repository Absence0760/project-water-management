// Load DE Africa Waterbodies polygons for the dam observations' match (issue
// #604 R5; docs/maps.md § Waterbodies):
//
//   pnpm import:waterbodies                                              the committed synthetic set (dev, e2e; pnpm setup runs it)
//   pnpm import:waterbodies <file.geojson> --dataset <label> [--bbox w,s,e,n] [--source "<product, version>"]
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like the other reference
// imports: the app role only reads waterbody_reference. A load replaces every
// row of its dataset. Paths resolve from the directory the command was typed
// in. The file is the operator's own extract of the v0.0.3 historical extent
// (CC BY 4.0), clipped to their region with ogr2ogr (docs/maps.md); the repo
// ships only the invented set round the Sandspruit example's dams.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadDevEnv } from '../src/config/devEnv.js';
import { replaceWaterbodies, SYNTHETIC_WATERBODIES, WATERBODIES_SOURCE, waterbodyRecords } from '../src/dams/observed/loadWaterbodies.js';
import { POLYGONS_FILE } from './waterbodies-fixture.js';

export interface Args {
	file: string;
	dataset: string;
	source: string;
	bbox: [number, number, number, number] | null;
}

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
	if (positional.length === 0) {
		if (argv.length) return 'the synthetic set takes no options; name a file to load your own';
		return { file: POLYGONS_FILE, dataset: SYNTHETIC_WATERBODIES, source: 'Synthetic waterbodies (invented, backend/fixtures/waterbodies/)', bbox: null };
	}
	const dataset = flag('--dataset');
	if (!dataset || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$/.test(dataset)) return 'give the dataset a label with --dataset (e.g. waterbodies-v0.0.3)';
	if (dataset === SYNTHETIC_WATERBODIES) return `"${SYNTHETIC_WATERBODIES}" is the committed fixture's label; pick another`;
	let bbox: Args['bbox'] = null;
	const b = flag('--bbox');
	if (b !== null) {
		const n = b.split(',').map(Number);
		if (n.length !== 4 || n.some((v) => !Number.isFinite(v)) || n[0]! >= n[2]! || n[1]! >= n[3]!) return '--bbox is w,s,e,n in degrees (west < east, south < north)';
		bbox = n as [number, number, number, number];
	}
	return { file: cliPath(positional[0]!, env), dataset, source: flag('--source') || WATERBODIES_SOURCE, bbox };
}

/** Load `args` into the database at `url`. */
export async function importWaterbodies(url: string, args: Args): Promise<{ written: number; problems: string[]; outside: number }> {
	const { records, problems, outside } = waterbodyRecords(JSON.parse(readFileSync(args.file, 'utf8')), args.bbox);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const written = records.length ? await replaceWaterbodies(client, args.dataset, records, args.source) : 0;
		return { written, problems, outside };
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
		console.error(`${args}\nusage: pnpm import:waterbodies [<file.geojson> --dataset <label> [--bbox w,s,e,n] [--source "<product, version>"]]`);
		process.exit(2);
	}
	importWaterbodies(url, args)
		.then(({ written, problems, outside }) => {
			for (const p of problems.slice(0, 50)) console.warn(`skipped: ${p}`);
			if (problems.length > 50) console.warn(`… and ${problems.length - 50} more skipped`);
			if (outside) console.log(`${outside} outside the box left out`);
			console.log(`${written} waterbod${written === 1 ? 'y' : 'ies'} loaded as "${args.dataset}"`);
			process.exit(written ? 0 : 1);
		})
		.catch((err) => {
			console.error((err as Error).message);
			process.exit(1);
		});
}
