// Load an evaporation grid for the evaporation proposals (issue #326 B-evap;
// docs/maps.md § Evaporation from the map):
//
//   pnpm import:evaporation                                   the committed synthetic grid (dev, e2e)
//   pnpm import:evaporation --reduce <dir> <year>_daily_pet.nc … [--bbox w,s,e,n]
//                          each dPET year's calendar-month totals into <dir>/<year>.dpet-monthly.json (no database)
//   pnpm import:evaporation <file> … --dataset <label> [--bbox w,s,e,n] [--source "…"] [--version "…"] [--attribution "…"]
//                          dPET years (.nc, or the .json --reduce wrote) averaged into monthly means, or one fixture-form .json
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like import-land-cover:
// the app role only reads evaporation_dataset and evaporation_cell_reference.
// `pnpm import:evaporation:fetch` (bin/evaporation-fetch.sh) downloads dPET a year at a
// time, reduces it and deletes the 2.4 GB file, then loads the years. A load
// replaces every row of its dataset. Paths resolve from the directory the
// command was typed in.
//
// The repo ships only invented data (backend/fixtures/geo/). dPET is CC BY 4.0
// (docs/maps.md § Sources): the files are the operator's own download, never
// committed.
import { config } from 'dotenv';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SYNTHETIC_EVAPORATION_DATASET } from '../src/geo/evaporation.js';
import {
	climatology,
	DPET,
	evaporationFromJson,
	evaporationMethodFor,
	readDpetYear,
	replaceEvaporationDataset,
	SOUTH_AFRICA_BBOX,
	yearTotalsFromJson,
	type Bbox,
	type Climatology,
	type EvaporationDatasetMeta,
	type YearTotals
} from '../src/geo/loadEvaporation.js';

/** The committed synthetic grid. */
export const SYNTHETIC_EVAPORATION_FILE = fileURLToPath(new URL('../fixtures/geo/evaporation.synthetic.json', import.meta.url));

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export type EvaporationArgs =
	| { mode: 'reduce'; out: string; files: string[]; bbox: Bbox }
	| { mode: 'load'; files: string[]; dataset: string; bbox: Bbox; source: string | null; version: string | null; attribution: string | null };

const FLAGS = ['--dataset', '--bbox', '--source', '--version', '--attribution', '--reduce'];

export function parseEvaporationArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): EvaporationArgs | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const unknown = argv.find((a) => a.startsWith('--') && !FLAGS.includes(a));
	if (unknown) return `unknown option ${unknown}`;
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && FLAGS.includes(argv[i - 1]!)));
	const bboxText = flag('--bbox');
	let bbox = SOUTH_AFRICA_BBOX;
	if (bboxText !== null) {
		const [west, south, east, north] = bboxText.split(',').map(Number);
		if (![west, south, east, north].every((x) => Number.isFinite(x)) || !(west! < east! && south! < north!)) return '--bbox takes west,south,east,north in degrees';
		bbox = { west: west!, south: south!, east: east!, north: north! };
	}
	const reduce = flag('--reduce');
	if (reduce !== null) {
		if (!reduce) return '--reduce takes the directory to write each year’s totals into';
		if (!positional.length || positional.some((p) => extname(p).toLowerCase() !== '.nc')) return '--reduce takes dPET files (<year>_daily_pet.nc)';
		return { mode: 'reduce', out: cliPath(reduce, env), files: positional.map((p) => cliPath(p, env)), bbox };
	}
	const base = { bbox, source: flag('--source'), version: flag('--version'), attribution: flag('--attribution') };
	if (positional.length === 0) return { mode: 'load', ...base, files: [SYNTHETIC_EVAPORATION_FILE], dataset: SYNTHETIC_EVAPORATION_DATASET };
	const bad = positional.find((p) => !['.nc', '.json'].includes(extname(p).toLowerCase()));
	if (bad) return `${bad}: give dPET files (.nc), the years --reduce wrote (.json), or one fixture-form .json`;
	const dataset = flag('--dataset');
	if (!dataset || dataset.length > 50) return 'give the dataset a label of at most 50 characters with --dataset (e.g. dPET-1991-2020)';
	if (dataset === SYNTHETIC_EVAPORATION_DATASET) return `"${SYNTHETIC_EVAPORATION_DATASET}" is the committed fixture's label; pick another`;
	return { mode: 'load', ...base, files: positional.map((p) => cliPath(p, env)), dataset };
}

/** Write each dPET year's totals beside the others in `args.out`; returns the files written. */
export async function reduceDpet(args: Extract<EvaporationArgs, { mode: 'reduce' }>, log: (line: string) => void = () => {}): Promise<string[]> {
	mkdirSync(args.out, { recursive: true });
	const written: string[] = [];
	for (const file of args.files) {
		const y = await readDpetYear(file, args.bbox);
		const out = join(args.out, `${y.year}.dpet-monthly.json`);
		writeFileSync(out, JSON.stringify(y));
		log(`${file}: ${y.cells.length} cells → ${out}`);
		written.push(out);
	}
	return written;
}

/** What `args`' files describe: the dataset row and its monthly means. A file that can't be read throws, naming it. */
export async function readEvaporationFiles(
	args: Extract<EvaporationArgs, { mode: 'load' }>,
	log: (line: string) => void = () => {}
): Promise<{ meta: EvaporationDatasetMeta; climatology: Climatology; problems: string[] }> {
	const docs = args.files.map((f) => ({ f, doc: extname(f).toLowerCase() === '.json' ? (JSON.parse(readFileSync(f, 'utf8')) as { product?: unknown; kind?: unknown }) : null }));
	const fixtures = docs.filter((d) => d.doc && d.doc.product === undefined);
	if (fixtures.length) {
		if (docs.length > 1) throw new Error('give one fixture-form .json on its own');
		const { f, doc } = fixtures[0]!;
		const got = evaporationFromJson(doc);
		if (typeof got === 'string') throw new Error(`${f}: ${got}`);
		const c = got.climatology;
		return {
			meta: {
				dataset: args.dataset,
				kind: got.kind,
				source: args.source ?? got.meta.source ?? DPET.source,
				version: args.version ?? got.meta.version ?? DPET.version,
				attribution: args.attribution ?? got.meta.attribution ?? DPET.attribution,
				method: evaporationMethodFor(c.cellDeg, c.firstYear, c.lastYear, got.kind)
			},
			climatology: c,
			problems: got.problems.map((p) => `${f}: ${p}`)
		};
	}
	const years: YearTotals[] = [];
	for (const { f, doc } of docs) {
		if (doc) {
			const y = yearTotalsFromJson(doc);
			if (typeof y === 'string') throw new Error(`${f}: ${y}`);
			years.push(y);
		} else {
			const y = await readDpetYear(f, args.bbox);
			log(`${f}: ${y.cells.length} cells`);
			years.push(y);
		}
	}
	const c = climatology(years);
	if (typeof c === 'string') throw new Error(c);
	return {
		meta: {
			dataset: args.dataset,
			kind: 'et0',
			source: args.source ?? DPET.source,
			version: args.version ?? DPET.version,
			attribution: args.attribution ?? DPET.attribution,
			method: evaporationMethodFor(c.cellDeg, c.firstYear, c.lastYear, 'et0')
		},
		climatology: c,
		problems: c.partial ? [`${c.partial} cells left out: not every year has them`] : []
	};
}

/** Load `args` into the database at `url`; returns the cells written and what was skipped. */
export async function importEvaporation(url: string, args: Extract<EvaporationArgs, { mode: 'load' }>, log?: (line: string) => void): Promise<{ written: number; problems: string[] }> {
	const read = await readEvaporationFiles(args, log);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const written = await replaceEvaporationDataset(client, read.meta, read.climatology);
		return { written, problems: read.problems };
	} finally {
		await client.end();
	}
}

/** Load the committed synthetic grid into the database at `url` (the DB tests' and e2e's setup; idempotent). */
export const loadSyntheticEvaporation = (url: string) => {
	const args = parseEvaporationArgs([]);
	if (typeof args === 'string' || args.mode !== 'load') throw new Error(String(args));
	return importEvaporation(url, args);
};

const USAGE =
	'usage: pnpm import:evaporation [--reduce <dir> <year>_daily_pet.nc … [--bbox w,s,e,n]] | [<file> … --dataset <label> [--bbox w,s,e,n] [--source "…"] [--version "…"] [--attribution "…"]]';

if (import.meta.url === `file://${process.argv[1]}`) {
	config({ path: ['.env.development.local', '.env.development'] });
	const args = parseEvaporationArgs(process.argv.slice(2));
	if (typeof args === 'string') {
		console.error(`${args}\n${USAGE}`);
		process.exit(2);
	}
	const fail = (err: Error) => {
		console.error(err.message);
		process.exit(1);
	};
	if (args.mode === 'reduce') {
		reduceDpet(args, (line) => console.log(line))
			.then(() => process.exit(0))
			.catch(fail);
	} else {
		const url = process.env.MIGRATION_DATABASE_URL;
		if (!url) {
			console.error('MIGRATION_DATABASE_URL is not set');
			process.exit(1);
		}
		importEvaporation(url, args, (line) => console.log(line))
			.then(({ written, problems }) => {
				for (const p of problems) console.warn(`skipped: ${p}`);
				console.log(`${written} cell${written === 1 ? '' : 's'} loaded as "${args.dataset}"`);
				process.exit(written ? 0 : 1);
			})
			.catch(fail);
	}
}
