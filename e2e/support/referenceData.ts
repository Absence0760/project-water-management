// Which e2e tests need reference data loaded (the operator-loaded tables the
// proposal panels and map layers read: land cover, the register of dams,
// evaporation, quaternaries, the river network, gauging stations), and the
// check that each one loads it itself (referenceData.test.ts, run by `pnpm
// test`). The loaders replace the synthetic data and never unload it, so a
// test that reads a panel without calling the loader passes only when another
// spec in the same shard ran first: farm-drawer.spec.ts's phone test did just
// that until PR #362. A test that reads one of these panels calls the loader
// in its own block (the test, its describe, or a beforeAll inside it) or at
// the file's top level (a file-wide beforeAll).

/** A panel's test ids, and the loader that fills it. */
export interface ReferenceFamily {
	what: string;
	testIds: RegExp;
	loader: string;
}

export const REFERENCE_FAMILIES: readonly ReferenceFamily[] = [
	{ what: 'land cover', testIds: /['"]cropland-[a-z-]+['"]/, loader: 'loadSyntheticLandCover' },
	{ what: 'the register of dams', testIds: /['"]dam-proposals?-[a-z-]+['"]/, loader: 'loadSyntheticDamRegister' },
	{ what: 'evaporation', testIds: /['"]evaporation-(rows|accepted|implied|same|problem)['"]/, loader: 'loadSyntheticEvaporation' },
	{ what: 'quaternaries', testIds: /['"](map-quaternar[a-z-]*|quaternary-(code|rows|synthetic|none|proposal|no-dataset))['"]/, loader: 'loadSyntheticQuaternaries' },
	{ what: 'the river network', testIds: /['"]map-rivers[a-z-]*['"]/, loader: 'loadSyntheticRivers' },
	{ what: 'gauging stations', testIds: /['"]nearest-gauges-table['"]/, loader: 'loadSyntheticStations' }
];

/** A top-level `test(…)` or `test.describe(…)` block, with its first line (1-based). */
export interface Block {
	line: number;
	text: string;
}

const BLOCK_START = /^test(\.describe)?(\.(serial|parallel|only|skip|fixme))*\(/;

/**
 * A spec split at its top-level statements (every line that starts in column
 * 0 and doesn't close one): the test and describe blocks, and the rest as the
 * file's own text (imports, helpers, a file-wide beforeAll).
 */
export function splitSpec(source: string): { fileLevel: string; blocks: Block[] } {
	const lines = source.split('\n');
	const blocks: Block[] = [];
	const fileLevel: string[] = [];
	let current: Block | null = null;
	lines.forEach((l, i) => {
		const starts = /^[^\s})\]]/.test(l);
		if (starts) {
			if (current) blocks.push(current);
			current = BLOCK_START.test(l) ? { line: i + 1, text: '' } : null;
		}
		if (current) current.text += `${l}\n`;
		else fileLevel.push(l);
	});
	if (current) blocks.push(current);
	return { fileLevel: fileLevel.join('\n'), blocks };
}

const calls = (text: string, loader: string) => new RegExp(`\\b${loader}\\(`).test(text);

/** Each block that reads a reference panel without loading its data, in words. */
export function missingLoads(file: string, source: string): string[] {
	const { fileLevel, blocks } = splitSpec(source);
	const out: string[] = [];
	for (const b of blocks) {
		for (const f of REFERENCE_FAMILIES) {
			if (f.testIds.test(b.text) && !calls(b.text, f.loader) && !calls(fileLevel, f.loader)) {
				out.push(`${file}:${b.line} reads ${f.what} (${b.text.match(f.testIds)![0]}) without calling ${f.loader}() in the test, its describe or a file-wide beforeAll`);
			}
		}
	}
	return out;
}
