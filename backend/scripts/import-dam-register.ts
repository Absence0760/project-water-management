// Load a register of dams for the dam proposals (issue #326 B-dams;
// docs/maps.md § Dams from the register and the map):
//
//   pnpm import:dam-register                                    the committed synthetic list (dev, e2e)
//   pnpm import:dam-register <list.csv> <doc.kml> [<more.json>] --dataset DSO-2025-07 --source "<list, edition>"
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like import-quaternaries:
// the app role only reads dam_register_reference. Files are read by their
// extension (.csv: the DSO list saved as CSV; .kml: its Google Earth
// overlay, the .kmz unzipped; .json: the fixture's form) and joined by
// register number. A load replaces every row of its dataset. Paths resolve
// from the directory the command was typed in.
//
// The repo ships only invented data (register numbers Z…, backend/fixtures/geo/).
// The real DWS list's licence for commercial reuse is unconfirmed (docs/maps.md
// § Sources), so it is loaded only from the operator's own download, never
// committed.
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { damPartsFromCsv, damPartsFromJson, damPartsFromKml, joinDamParts, replaceDamDataset, type DamPart } from '../src/geo/loadDamRegister.js';
import { SYNTHETIC_DAM_DATASET } from '../src/geo/damProposals.js';

/** The committed synthetic list. */
export const SYNTHETIC_DAM_FILE = fileURLToPath(new URL('../fixtures/geo/dam-register.synthetic.json', import.meta.url));

const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export interface DamArgs {
	files: string[];
	dataset: string;
	source: string;
}

export function parseDamArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): DamArgs | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
	if (positional.length === 0) return { files: [SYNTHETIC_DAM_FILE], dataset: SYNTHETIC_DAM_DATASET, source: '' };
	const bad = positional.find((p) => !['.csv', '.kml', '.json'].includes(extname(p).toLowerCase()));
	if (bad) return `${bad}: give a .csv (the list), a .kml (the overlay, unzipped from its .kmz) or a .json file`;
	const dataset = flag('--dataset');
	if (!dataset) return 'give the dataset a label with --dataset (e.g. DSO-2025-07)';
	if (dataset === SYNTHETIC_DAM_DATASET) return `"${SYNTHETIC_DAM_DATASET}" is the committed fixture's label; pick another`;
	return { files: positional.map((p) => cliPath(p, env)), dataset, source: flag('--source') ?? '' };
}

/** The records `args`' files describe, and what was skipped. */
export function readDamFiles(args: DamArgs): { records: ReturnType<typeof joinDamParts>['records']; problems: string[] } {
	const parts: DamPart[] = [];
	const problems: string[] = [];
	for (const file of args.files) {
		const body = readFileSync(file, 'utf8');
		const ext = extname(file).toLowerCase();
		const got = ext === '.csv' ? damPartsFromCsv(body) : ext === '.kml' ? damPartsFromKml(body) : damPartsFromJson(JSON.parse(body));
		parts.push(...got.parts);
		problems.push(...got.problems.map((p) => `${file}: ${p}`));
	}
	const joined = joinDamParts(parts, args.source);
	return { records: joined.records, problems: [...problems, ...joined.problems] };
}

/** Load `args` into the database at `url`; returns the rows written and the dams skipped. */
export async function importDamRegister(url: string, args: DamArgs): Promise<{ written: number; problems: string[] }> {
	const { records, problems } = readDamFiles(args);
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const written = records.length ? await replaceDamDataset(client, args.dataset, records) : 0;
		return { written, problems };
	} finally {
		await client.end();
	}
}

/** Load the committed synthetic list into the database at `url` (the DB tests' and e2e's setup; idempotent). */
export const loadSyntheticDamRegister = (url: string) => importDamRegister(url, { files: [SYNTHETIC_DAM_FILE], dataset: SYNTHETIC_DAM_DATASET, source: '' });

if (import.meta.url === `file://${process.argv[1]}`) {
	config({ path: ['.env.development.local', '.env.development'] });
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseDamArgs(process.argv.slice(2));
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	if (typeof args === 'string') {
		console.error(`${args}\nusage: pnpm import:dam-register [<list.csv> <overlay.kml> [<dams.json>] --dataset <label> --source "<list, edition>"]`);
		process.exit(2);
	}
	importDamRegister(url, args)
		.then(({ written, problems }) => {
			for (const p of problems) console.warn(`skipped: ${p}`);
			console.log(`${written} dam${written === 1 ? '' : 's'} loaded as "${args.dataset}"`);
			process.exit(written ? 0 : 1);
		})
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
