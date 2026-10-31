import { describe, expect, it } from 'vitest';
import { ALTERNATIVES_MAX } from '@water-management/engine';
import type { ScenarioAlternative } from '#lib/api/index.js';
import { alternativesSummary, cleaned, draftChanged, draftOf, draftProblems, runName } from './alternatives';

const alt = (runId: string, label: string, position = 0): ScenarioAlternative => ({
	position,
	label,
	runId,
	scenarioId: `s-${runId}`,
	scenarioName: `Scenario ${runId}`,
	runLabel: '',
	engineVersion: '1.0.0',
	runCreatedAt: '2026-10-30T12:05:00.000Z'
});

describe('the mitigation alternatives’ draft (298)', () => {
	it('starts from the stored list, and sends the labels trimmed', () => {
		const d = draftOf([alt('r1', 'Smaller dam')]);
		expect(d).toEqual([{ runId: 'r1', label: 'Smaller dam' }]);
		expect(cleaned([{ runId: 'r1', label: '  Smaller dam ' }])).toEqual(d);
		expect(draftChanged([{ runId: 'r1', label: ' Smaller dam' }], [alt('r1', 'Smaller dam')])).toBe(false);
		expect(draftChanged([{ runId: 'r1', label: 'Smaller' }], [alt('r1', 'Smaller dam')])).toBe(true);
		// The order is page 1's columns: a swap is a change.
		expect(draftChanged(draftOf([alt('r2', 'B'), alt('r1', 'A')]), [alt('r1', 'A'), alt('r2', 'B', 1)])).toBe(true);
	});

	it('says what stops a save: no run, no label, a run twice, too many; nothing for a good list', () => {
		expect(draftProblems([{ runId: 'r1', label: 'Smaller dam' }])).toEqual([]);
		expect(draftProblems([{ runId: '', label: ' ' }])).toEqual(['Alternative 1 needs a run picked.', 'Alternative 1 needs a label (“smaller dam”, “winter abstraction only”).']);
		expect(draftProblems([{ runId: 'r1', label: 'x'.repeat(81) }])).toEqual(['Alternative 1’s label is longer than 80 characters.']);
		expect(draftProblems([{ runId: 'r1', label: 'A' }, { runId: 'r1', label: 'B' }])).toEqual(['Each alternative is another run: one is picked twice.']);
		const many = Array.from({ length: ALTERNATIVES_MAX + 1 }, (_, i) => ({ runId: `r${i}`, label: `L${i}` }));
		expect(draftProblems(many)).toEqual([`Cite at most ${ALTERNATIVES_MAX} alternatives, so page 1 stays readable.`]);
	});

	it('names a run by its scenario and label, or when it ran; sums the list in one line', () => {
		expect(runName({ scenarioName: 'Smaller', runLabel: 'Final', runCreatedAt: '2026-10-30T12:05:00.000Z' })).toBe('Smaller — Final');
		expect(runName({ scenarioName: 'Smaller', runLabel: '', runCreatedAt: '2026-10-30T12:05:00.000Z' })).toMatch(/^Smaller — run of \d+ Oct 2026/);
		expect(alternativesSummary([])).toBe('None cited');
		expect(alternativesSummary([alt('r1', 'Smaller dam'), alt('r2', 'Winter only', 1)])).toBe('Smaller dam · Winter only');
	});
});
