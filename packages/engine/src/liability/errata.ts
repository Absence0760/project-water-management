// Known engine bugs per version (roadmap WP-3.13): docs/engine-errata.md is
// the source, and `pnpm gen:liability` writes errata.generated.ts from it;
// errata.test.ts fails when the two differ. A validation statement, a
// sign-off statement and an evidence pack print the errata that apply to the
// run's engine version, so a result made by a buggy engine says so.
//
// The parser is pure (it takes the Markdown as a string).
import { plainMarkdown } from './limitations';

export interface Erratum {
	/** ER-1, ER-2 …: never reused. */
	id: string;
	/**
	 * Whose engine version decides it: the run's (`run`), or (`fit`) that of
	 * the automatic calibration the run's parameters came from, whichever
	 * engine runs them.
	 */
	keyedOn: 'run' | 'fit';
	/** The first engine version with the bug. */
	firstAffected: string;
	/** The version that fixed it; null while it is open. */
	fixedIn: string | null;
	severity: string;
	/** The conditions under which results change. */
	appliesWhen: string;
	/** What goes wrong. */
	summary: string;
	/** Where it is documented (engine-audit.md id, model.md section). */
	source: string;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Compares two x.y.z versions numerically: negative, 0 or positive. Refuses anything else. */
export function compareEngineVersions(a: string, b: string): number {
	const pa = SEMVER.exec(a);
	const pb = SEMVER.exec(b);
	if (!pa || !pb) throw new Error(`not an engine version: ${!pa ? a : b}`);
	for (let i = 1; i <= 3; i++) {
		const d = Number(pa[i]) - Number(pb[i]);
		if (d !== 0) return d;
	}
	return 0;
}

const affects = (e: Erratum, v: string | null | undefined): boolean =>
	!!v && SEMVER.test(v) && compareEngineVersions(e.firstAffected, v) <= 0 && (e.fixedIn === null || compareEngineVersions(v, e.fixedIn) < 0);

/**
 * The errata that affect a run: a `run` erratum when the run's
 * `engineVersion` is in its range (first affected ≤ it < fixed in), a `fit`
 * erratum when the engine of the fit its parameters came from
 * (`fitEngineVersion`, settings.fitRecord.engineVersion) is; a run with
 * entered parameters has no fit.
 */
export function errataFor(engineVersion: string, errata: readonly Erratum[], fitEngineVersion: string | null = null): Erratum[] {
	return errata.filter((e) => affects(e, e.keyedOn === 'fit' ? fitEngineVersion : engineVersion));
}

function cells(row: string): string[] {
	const inner = row.trim().replace(/^\|/, '').replace(/\|$/, '');
	return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/** The errata table of docs/engine-errata.md. Refuses a malformed row rather than dropping it. */
export function parseErrata(markdown: string): Erratum[] {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((l) => l === '## Errata');
	if (start < 0) throw new Error('engine-errata.md has no "## Errata" section');
	const rows: string[][] = [];
	let inTable = false;
	for (let i = start + 1; i < lines.length; i++) {
		const l = lines[i]!;
		if (l.startsWith('## ')) break;
		if (l.startsWith('|')) {
			inTable = true;
			rows.push(cells(l));
		} else if (inTable) break;
	}
	if (rows.length < 2) throw new Error('engine-errata.md has no errata table');
	const header = rows[0]!.map((c) => c.toLowerCase());
	const want = ['id', 'keyed on', 'first affected', 'fixed in', 'severity', 'applies when', 'what goes wrong', 'source'];
	if (header.join('|') !== want.join('|')) throw new Error(`engine-errata.md's table columns changed: ${header.join(', ')}`);
	const seen = new Set<string>();
	return rows.slice(2).map((r) => {
		if (r.length !== want.length) throw new Error(`engine-errata.md: a row has ${r.length} cells, not ${want.length}: ${r.join(' | ')}`);
		const [id, keyed, first, fixed, severity, appliesWhen, summary, source] = r.map(plainMarkdown) as [string, string, string, string, string, string, string, string];
		if (!/^ER-\d+$/.test(id)) throw new Error(`engine-errata.md: bad id "${id}"`);
		if (seen.has(id)) throw new Error(`engine-errata.md: ${id} is listed twice`);
		seen.add(id);
		if (keyed !== 'run' && keyed !== 'fit') throw new Error(`engine-errata.md ${id}: keyed on "${keyed}", not run or fit`);
		if (!SEMVER.test(first)) throw new Error(`engine-errata.md ${id}: first affected "${first}" is not a version`);
		const fixedIn = fixed.toLowerCase() === 'open' ? null : fixed;
		if (fixedIn !== null) {
			if (!SEMVER.test(fixedIn)) throw new Error(`engine-errata.md ${id}: fixed in "${fixed}" is not a version or "open"`);
			if (compareEngineVersions(first, fixedIn) >= 0) throw new Error(`engine-errata.md ${id}: fixed in ${fixedIn}, not after ${first}`);
		}
		for (const [name, v] of [['severity', severity], ['applies when', appliesWhen], ['what goes wrong', summary], ['source', source]] as const) {
			if (!v) throw new Error(`engine-errata.md ${id}: "${name}" is empty`);
		}
		return { id, keyedOn: keyed, firstAffected: first, fixedIn, severity, appliesWhen, summary, source };
	});
}
