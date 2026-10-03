// isScenarioRun, and a guard that nothing else tells a run of the model from a
// scenario run by its scenarioId (issue #381): deleting a scenario clears its
// runs' scenarioId, while each run still holds the scenario's changes on a
// base run (188_scenario_run_flag), so `!run.scenarioId` takes it for a run of
// the model (a default run, a base, a yield run, the preview's start).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isScenarioRun } from './scenarioRun';

describe('isScenarioRun', () => {
	it('is the API’s fromScenario: true for a live or orphaned scenario run, false for a run of the model', () => {
		expect(isScenarioRun({ fromScenario: true, scenarioId: 's', scenarioName: 'Dam' })).toBe(true);
		// The scenario deleted: scenarioId null, the recorded name still there.
		expect(isScenarioRun({ fromScenario: true, scenarioId: null, scenarioName: 'Dam' })).toBe(true);
		// Positive control: a run of the model.
		expect(isScenarioRun({ fromScenario: false, scenarioId: null, scenarioName: null })).toBe(false);
	});

	it('falls back, without fromScenario (an older API), to the scenario the run names or recorded', () => {
		expect(isScenarioRun({ scenarioId: 's' })).toBe(true);
		expect(isScenarioRun({ scenarioId: null, scenarioName: 'Dam' })).toBe(true);
		expect(isScenarioRun({ scenarioId: null, scenarioName: null })).toBe(false);
		expect(isScenarioRun({})).toBe(false);
	});
});

/** A run's scenarioId read off a run-like receiver (`r.`, `run.`, `shownRun.`, `baseRun?.`). */
const RUN_SCENARIO_ID = /\b(?:r|run|[a-zA-Z]+Run)\??\.scenarioId\b/g;
const SRC = fileURLToPath(new URL('../../..', import.meta.url));
const SELF = 'lib/components/runs/scenarioRun.ts';

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (e.isDirectory()) return sourceFiles(join(dir, e.name));
		if (e.name.endsWith('.test.ts')) return [];
		return /\.(svelte|ts)$/.test(e.name) ? [join(dir, e.name)] : [];
	});
}

describe('no run is classified by its scenarioId', () => {
	it('the pattern finds a run’s scenarioId and passes a note’s or a pack’s', () => {
		for (const s of ['!r.scenarioId', 'run.scenarioId ? a : b', 'shownRun.scenarioId', 'baseRun?.scenarioId']) expect(s.match(RUN_SCENARIO_ID), s).toHaveLength(1);
		for (const s of ['n.scenarioId', 'pack?.scenarioId', 'scenarioId: s.id']) expect(s.match(RUN_SCENARIO_ID), s).toBeNull();
	});

	it('reads a run’s scenario only through isScenarioRun', () => {
		const files = sourceFiles(SRC);
		// Positive control: the walk reaches the helper and the components that use it.
		expect(files.map((f) => relative(SRC, f))).toEqual(expect.arrayContaining([SELF, 'lib/components/runs/RunsTab.svelte']));
		const hits = files
			.filter((f) => relative(SRC, f) !== SELF)
			.flatMap((f) =>
				readFileSync(f, 'utf8')
					.split('\n')
					.flatMap((line, i) => (line.match(RUN_SCENARIO_ID) ? [`${relative(SRC, f)}:${i + 1}: ${line.trim()}`] : []))
			);
		expect(hits).toEqual([]);
	});
});
