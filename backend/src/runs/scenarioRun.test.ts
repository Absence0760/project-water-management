// No backend query tells a run of the model from a scenario run by
// `scenario_id IS NULL` (issue #381). Deleting a scenario clears its runs'
// scenario_id (024: ON DELETE SET NULL) while each run's inputs.scenario
// stays, so the bare test takes such a run for a run of the model. The one
// test is model_run.from_scenario (188_scenario_run_flag), a stored generated
// column true for a live or an orphaned scenario run. The same rule for the
// SQL functions, policies and triggers is in src/db/catalogue.db.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The bare test (with its table alias, if any), and the inline form of from_scenario it replaced. */
const BARE = /\b(?:(\w+)\.)?scenario_id\s+IS\s+(?:NOT\s+)?NULL\b|\binputs\s*\?\s*'scenario'/gi;
const SRC = fileURLToPath(new URL('..', import.meta.url));

/**
 * `file|alias` → why that alias's `scenario_id IS [NOT] NULL` is another
 * table's column. A model_run alias never belongs here: use from_scenario.
 */
const OTHER_TABLES = new Map<string, string>([
	['notes/routes.ts|n', 'note.scenario_id: a note on a scenario'],
	['projects/document.ts|n', 'note.scenario_id: the project document leaves out notes on scenarios'],
	['evidence/report.ts|m', 'assessment_member.scenario_id: a member copied from a team scenario since deleted']
]);

/** The hits in one file that no OTHER_TABLES entry explains. */
function unexplained(file: string, text: string): string[] {
	return text.split('\n').flatMap((line, i) =>
		[...line.matchAll(BARE)].filter((m) => !OTHER_TABLES.has(`${file}|${m[1] ?? ''}`)).map(() => `${file}:${i + 1}: ${line.trim()}`)
	);
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (e.isDirectory()) return sourceFiles(join(dir, e.name));
		if (e.name.endsWith('.test.ts')) return [];
		return e.name.endsWith('.ts') ? [join(dir, e.name)] : [];
	});
}

describe('scenario runs are told by model_run.from_scenario', () => {
	it('the pattern finds the bare test and the inline form, and passes from_scenario and a join', () => {
		for (const s of ['r.scenario_id IS NULL', 'scenario_id is not null', "(scenario_id IS NOT NULL OR inputs ? 'scenario')"]) expect(s.match(BARE), s).not.toBeNull();
		for (const s of ['NOT r.from_scenario', 'JOIN scenario s ON s.id = r.scenario_id', 'r.scenario_id AS "scenarioId"']) expect(s.match(BARE), s).toBeNull();
	});

	it('no backend source tests a run’s scenario_id for null, bar the listed other tables', () => {
		const files = sourceFiles(SRC);
		// Positive control: the walk reaches the routes that classify runs.
		expect(files.map((f) => relative(SRC, f))).toEqual(expect.arrayContaining(['signoffs/routes.ts', 'publish/publish.ts', 'notes/routes.ts']));
		expect(files.flatMap((f) => unexplained(relative(SRC, f), readFileSync(f, 'utf8')))).toEqual([]);
		// Each entry still explains a hit (else drop it), and an unlisted alias in a listed file is still caught.
		for (const key of OTHER_TABLES.keys()) {
			const [file, alias] = key.split('|') as [string, string];
			expect([...readFileSync(join(SRC, file), 'utf8').matchAll(BARE)].some((m) => m[1] === alias), key).toBe(true);
		}
		expect(unexplained('notes/routes.ts', 'WHERE r.scenario_id IS NULL')).toHaveLength(1);
	});
});
