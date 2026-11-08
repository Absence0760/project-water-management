// Load an evaporation grid for the evaporation proposals (issue #326 B-evap;
// docs/maps.md § Evaporation from the map):
//
//   pnpm import:evaporation                                   the committed synthetic grid (dev, e2e)
//   pnpm import:evaporation --reduce <dir> <year>_daily_pet.nc … [--bbox w,s,e,n]
//                          each dPET year's calendar-month totals into <dir>/<year>.dpet-monthly.json (no database)
//   pnpm import:evaporation <file> … --dataset <label> [--bbox w,s,e,n] [--source "…"] [--version "…"] [--attribution "…"]
//                          dPET years (.nc, or the .json --reduce wrote) averaged into monthly means, or one fixture-form .json
//   pnpm import:evaporation <file> … --dataset <label> --out <grid.json[.gz]> [same options]
//                          the same monthly means written to a file instead of loaded (no database)
//   pnpm import:evaporation --apan-asc <jan.asc> … <dec.asc> --dataset <label> --years <first>-<last> [--bbox w,s,e,n] [--out <grid.json[.gz]>]
//                          12 monthly A-pan grids (ESRI ASCII, WGS84 degrees, calendar order) taken as given:
//                          the WRC Atlas's A-pan equivalent (Schulze and Maharaj 2007) as dataset
//                          Atlas-Apan-2007, stored with its recorded lines (modelled, not measured pans;
//                          production allows this label only), or another source's with --source and --attribution
//   pnpm import:evaporation --span-asc <jan.asc> … <dec.asc> --dataset <label> --years <first>-<last> [same options]
//                          12 monthly Symons-pan (S-pan) grids the same way (issue #738): CCWR's as dataset
//                          Atlas-Span-2007 (production allows this label only), or another source's with
//                          --source and --attribution. Shown as a cross-check against the saved A-pan only,
//                          never proposed or converted to A-pan
//   pnpm import:evaporation <apan.json[.gz]> --dataset <label>
//                          a modelled Class-A pan grid (PenPan) that ingest/apan_grid.py grid wrote
//                          (issue #646 item 7): kind "apan" with its "model", its source always
//                          starting "Modelled Class-A pan (PenPan)"; local only, production refuses it
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like import-land-cover:
// the app role only reads evaporation_dataset and evaporation_cell_reference.
// `pnpm import:evaporation:fetch` (bin/evaporation-fetch.sh) downloads dPET a year at a
// time, reduces it and deletes the 2.4 GB file, then loads the years. A load
// replaces every row of its dataset. Paths resolve from the directory the
// command was typed in.
//
// With --out it loads nothing (no database needed): it writes the grid of
// monthly means, in the fixture's JSON form, to the file (gzipped when it
// ends in .gz). That file is what a production load reads from the private
// reference bucket (docs/deployment.md § Reference datasets): the years are
// read and averaged here, once, and only the means travel.
//
// The repo ships only invented data (backend/fixtures/geo/). dPET is CC BY 4.0
// (docs/maps.md § Sources): the files are the operator's own download, never
// committed.
import { loadDevEnv } from '../src/config/devEnv.js';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { SYNTHETIC_EVAPORATION_DATASET } from '../src/geo/evaporation.js';
import {
	ATLAS_APAN,
	ATLAS_SPAN,
	atlasApanMethodFor,
	atlasSpanMethodFor,
	monthlyFromAsciiGrids,
	climatology,
	DPET,
	evaporationFromJson,
	evaporationMethodFor,
	evaporationToJson,
	modelledApanSource,
	monthlyGridsMethodFor,
	PENPAN,
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
/** 12 invented monthly A-pan grids (ESRI ASCII, 1′ cells, January to December) for `--apan-asc`'s tests: never real evaporation. */
export const SYNTHETIC_APAN_ASC_FILES = Array.from({ length: 12 }, (_, i) =>
	fileURLToPath(new URL(`../fixtures/geo/apan-asc/apan-${String(i + 1).padStart(2, '0')}.synthetic.asc`, import.meta.url))
);
/** 12 invented monthly S-pan grids (ESRI ASCII, 1′ cells, January to December) for `--span-asc`'s tests: never real evaporation. */
export const SYNTHETIC_SPAN_ASC_FILES = Array.from({ length: 12 }, (_, i) =>
	fileURLToPath(new URL(`../fixtures/geo/span-asc/span-${String(i + 1).padStart(2, '0')}.synthetic.asc`, import.meta.url))
);
/** ingest/apan_grid.py's committed synthetic output, a modelled Class-A pan grid (issue #646 item 7; its tests, never loaded by setup). */
export const SYNTHETIC_PENPAN_FILE = fileURLToPath(new URL('../../ingest/fixtures/apan/penpan.synthetic.json', import.meta.url));

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export type EvaporationArgs =
	| { mode: 'reduce'; out: string; files: string[]; bbox: Bbox }
	| {
			mode: 'load';
			files: string[];
			dataset: string;
			bbox: Bbox;
			source: string | null;
			version: string | null;
			attribution: string | null;
			out?: string | null;
			/** `--apan-asc` / `--span-asc`: `files` are 12 monthly A-pan or S-pan grids (ESRI ASCII), January to December, covering first–last. */
			monthlyAsc?: { kind: 'apan' | 'span'; first: number; last: number } | null;
	  };

const isJson = (p: string) => /\.json(\.gz)?$/i.test(p);
const readJsonText = (f: string) => (/\.gz$/i.test(f) ? gunzipSync(readFileSync(f)).toString('utf8') : readFileSync(f, 'utf8'));

const FLAGS = ['--dataset', '--bbox', '--source', '--version', '--attribution', '--reduce', '--out', '--years'];
/** Options that take no value. */
const SWITCHES = ['--apan-asc', '--span-asc'];

export function parseEvaporationArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): EvaporationArgs | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const unknown = argv.find((a) => a.startsWith('--') && !FLAGS.includes(a) && !SWITCHES.includes(a));
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
	const out = flag('--out');
	if (out !== null && !/\.json(\.gz)?$/i.test(out)) return '--out takes a .json or .json.gz file';
	const base = { bbox, source: flag('--source'), version: flag('--version'), attribution: flag('--attribution'), out: out === null ? null : cliPath(out, env) };
	if (argv.includes('--apan-asc') && argv.includes('--span-asc')) return 'give --apan-asc or --span-asc, not both: one grid kind a load';
	if (argv.includes('--apan-asc')) return parseMonthlyAsc('apan', positional, flag, base, env);
	if (argv.includes('--span-asc')) return parseMonthlyAsc('span', positional, flag, base, env);
	if (flag('--years') !== null) return '--years goes with --apan-asc or --span-asc (dPET years come from the files)';
	if (positional.length === 0) return { mode: 'load', ...base, files: [SYNTHETIC_EVAPORATION_FILE], dataset: SYNTHETIC_EVAPORATION_DATASET };
	const bad = positional.find((p) => extname(p).toLowerCase() !== '.nc' && !isJson(p));
	if (bad) return `${bad}: give dPET files (.nc), the years --reduce wrote (.json), or one fixture-form .json or .json.gz`;
	const dataset = flag('--dataset');
	if (!dataset || dataset.length > 50) return 'give the dataset a label of at most 50 characters with --dataset (e.g. dPET-1991-2020)';
	if (dataset === SYNTHETIC_EVAPORATION_DATASET) return `"${SYNTHETIC_EVAPORATION_DATASET}" is the committed fixture's label; pick another`;
	return { mode: 'load', ...base, files: positional.map((p) => cliPath(p, env)), dataset };
}

/** `--apan-asc` / `--span-asc`'s arguments: 12 .asc files in calendar order, a label, the years they cover, and the Atlas label's own rules. */
function parseMonthlyAsc(
	kind: 'apan' | 'span',
	positional: string[],
	flag: (name: string) => string | null,
	base: Omit<Extract<EvaporationArgs, { mode: 'load' }>, 'mode' | 'files' | 'dataset'>,
	env: NodeJS.ProcessEnv
): EvaporationArgs | string {
	const opt = `--${kind}-asc`;
	const atlas = kind === 'apan' ? ATLAS_APAN : ATLAS_SPAN;
	const what = kind === 'apan' ? 'A-pan' : 'S-pan';
	if (positional.length !== 12 || positional.some((p) => extname(p).toLowerCase() !== '.asc')) {
		return `${opt} takes 12 ESRI ASCII grids (.asc), January to December in that order`;
	}
	const dataset = flag('--dataset');
	if (!dataset || dataset.length > 50) return `give the dataset a label of at most 50 characters with --dataset (the WRC Atlas's: ${atlas.dataset})`;
	if (dataset === SYNTHETIC_EVAPORATION_DATASET) return `"${SYNTHETIC_EVAPORATION_DATASET}" is the committed fixture's label; pick another`;
	// Each Atlas label names one kind: the other kind's grids under it would be stored as what they aren't.
	const other = kind === 'apan' ? ATLAS_SPAN : ATLAS_APAN;
	if (dataset === other.dataset) return `${other.dataset} is the WRC Atlas's ${kind === 'apan' ? 'S-pan' : 'A-pan'} label: load ${what} grids under another label`;
	const years = /^(\d{4})-(\d{4})$/.exec(flag('--years') ?? '');
	const first = Number(years?.[1]);
	const last = Number(years?.[2]);
	if (!years || first < 1900 || last > 2200 || first > last) return `${opt} needs --years <first>-<last>: the period the grids’ monthly means cover, as their source states it`;
	if (dataset === atlas.dataset) {
		if (base.source !== null || base.version !== null || base.attribution !== null) return `${atlas.dataset} carries the WRC Atlas's recorded source, version and attribution: give no --source, --version or --attribution`;
	} else if (!base.source || !base.attribution) {
		return `an ${what} grid other than the WRC Atlas’s names its source and attribution (--source, --attribution)`;
	}
	return { mode: 'load', ...base, files: positional.map((p) => cliPath(p, env)), dataset, monthlyAsc: { kind, first, last } };
}

/** A file's lines, opened only when read: the 12 grids are read one after another, and an open stream would run ahead unread. */
const ascLines = (f: string): AsyncIterable<string> => ({ [Symbol.asyncIterator]: () => createInterface({ input: createReadStream(f), crlfDelay: Infinity })[Symbol.asyncIterator]() });

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
	if (args.monthlyAsc) {
		const { kind, first, last } = args.monthlyAsc;
		const c = await monthlyFromAsciiGrids(
			args.files.map((f) => ({ name: f, lines: ascLines(f) })),
			args.bbox,
			first,
			last,
			kind === 'apan' ? 'A-pan' : 'S-pan'
		);
		const recorded = kind === 'apan' ? ATLAS_APAN : ATLAS_SPAN;
		const atlas = args.dataset === recorded.dataset;
		const atlasMethod = kind === 'apan' ? atlasApanMethodFor : atlasSpanMethodFor;
		return {
			meta: {
				dataset: args.dataset,
				kind,
				source: atlas ? recorded.source : args.source!,
				version: atlas ? recorded.version : (args.version ?? 'unstated'),
				attribution: atlas ? recorded.attribution : args.attribution!,
				method: atlas ? atlasMethod(c.cellDeg, c.firstYear, c.lastYear) : monthlyGridsMethodFor(c.cellDeg, c.firstYear, c.lastYear, kind)
			},
			climatology: c,
			problems: c.partial ? [`${c.partial} cells left out: not every month has them`] : []
		};
	}
	const docs = args.files.map((f) => ({ f, doc: isJson(f) ? (JSON.parse(readJsonText(f)) as { product?: unknown; kind?: unknown }) : null }));
	const fixtures = docs.filter((d) => d.doc && d.doc.product === undefined);
	if (fixtures.length) {
		if (docs.length > 1) throw new Error('give one fixture-form .json on its own');
		const { f, doc } = fixtures[0]!;
		const got = evaporationFromJson(doc);
		if (typeof got === 'string') throw new Error(`${f}: ${got}`);
		const c = got.climatology;
		const model = got.meta.model;
		// dPET's lines describe a reference-ET grid only: a PenPan grid has its own, and any other A-pan grid must name its source.
		const defaults = model ? PENPAN : got.kind === 'et0' ? DPET : null;
		const source = args.source ?? got.meta.source ?? defaults?.source;
		if (!source || !defaults && !(args.attribution ?? got.meta.attribution)) {
			throw new Error(`${f}: ${got.kind === 'span' ? 'an S-pan' : 'an A-pan'} grid names its source and attribution (--source, --attribution, or "source" and "attribution" in the file)`);
		}
		return {
			meta: {
				dataset: args.dataset,
				kind: got.kind,
				source: model ? modelledApanSource(source) : source,
				version: args.version ?? got.meta.version ?? defaults?.version ?? 'unstated',
				attribution: (args.attribution ?? got.meta.attribution ?? defaults?.attribution)!,
				method: evaporationMethodFor(c.cellDeg, c.firstYear, c.lastYear, got.kind, model),
				...(model ? { model } : {})
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

/**
 * Write `args`' grid of monthly means to `args.out` in the fixture's JSON form
 * (gzipped for .gz) instead of loading it; returns the cells written. Refuses
 * an empty grid, as the load does.
 */
export async function writeEvaporationJson(
	args: Extract<EvaporationArgs, { mode: 'load' }> & { out: string },
	log?: (line: string) => void
): Promise<{ written: number; problems: string[] }> {
	const read = await readEvaporationFiles(args, log);
	if (!read.climatology.cells.length) throw new Error('no cell has a value for every month of every year: check the files and --bbox');
	const json = evaporationToJson(read.meta, read.climatology);
	writeFileSync(args.out, /\.gz$/i.test(args.out) ? gzipSync(json) : json);
	return { written: read.climatology.cells.length, problems: read.problems };
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
	'usage: pnpm import:evaporation [--reduce <dir> <year>_daily_pet.nc … [--bbox w,s,e,n]] | [<file> … --dataset <label> [--bbox w,s,e,n] [--source "…"] [--version "…"] [--attribution "…"] [--out <grid.json[.gz]>]]' +
	' | [--apan-asc|--span-asc <jan.asc> … <dec.asc> --dataset <label> --years <first>-<last> [--bbox w,s,e,n] [--source "…" --attribution "…"] [--out <grid.json[.gz]>]]';

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
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
	} else if (args.out) {
		const out = args.out;
		writeEvaporationJson({ ...args, out }, (line) => console.log(line))
			.then(({ written, problems }) => {
				for (const p of problems) console.warn(`skipped: ${p}`);
				console.log(`${written} cell${written === 1 ? '' : 's'} written to ${out}`);
				process.exit(0);
			})
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
