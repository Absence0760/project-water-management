import { describe, expect, it } from 'vitest';
import type { CurtailmentSummary } from '@water-management/engine';
import { IRRIGATION_SUPPORT_HEADING } from '#lib/components/outcomes/irrigationSupport.js';
import { isOutputAnchor, LICENCE_IMPACT_HEADING, licencePair, OUTPUT_ANCHORS, outputNavGroups, shareState, type PairScenario } from './outputs';

const scenario = (id: string, baseRunId: string, lastRun: { id: string; createdAt: string } | null, name = id): PairScenario => ({
	id,
	name,
	baseRunId,
	lastRun: lastRun ? { ...lastRun, label: '' } : null
});

describe('outputNavGroups', () => {
	it('lists the five outputs in the page’s order, each by its heading, linking to its anchor', () => {
		const [group, ...rest] = outputNavGroups();
		expect(rest).toEqual([]);
		expect(group!.sections.map((s) => s.id)).toEqual(['out-irrigation', 'out-share', 'out-matrix', 'out-outlook', 'out-licence']);
		expect(group!.sections.map((s) => s.label)).toEqual([IRRIGATION_SUPPORT_HEADING, 'Share the pain', 'Outcome matrix', 'Seasonal outlook', LICENCE_IMPACT_HEADING]);
		// The board's own heading (report/LicenceImpactBoard.svelte), so the index and the section say the same.
		expect(LICENCE_IMPACT_HEADING).toBe('Impact by year class');
	});

	it('knows its own anchors and nothing else', () => {
		for (const id of Object.values(OUTPUT_ANCHORS)) expect(isOutputAnchor(id)).toBe(true);
		for (const id of ['', 'res-outcomes', 'out-', 'out-irrigation-h']) expect(isOutputAnchor(id), id).toBe(false);
	});
});

describe('shareState', () => {
	const c = (farms: number) => ({ farms: Array.from({ length: farms }, () => ({})) }) as unknown as CurtailmentSummary;
	it('needs a curtailment report with hydrological units', () => {
		expect(shareState(undefined)).toBe('none');
		expect(shareState(null)).toBe('none');
		expect(shareState(c(0))).toBe('noUnits');
		expect(shareState(c(2))).toBe('ok');
	});
});

describe('licencePair', () => {
	const scenarios = [
		scenario('s-old', 'base', { id: 'run-old', createdAt: '2026-01-01T00:00:00Z' }, 'Older dam'),
		scenario('s-new', 'base', { id: 'run-new', createdAt: '2026-03-01T00:00:00Z' }, 'Newer orchard'),
		scenario('s-unrun', 'base', null, 'Not run'),
		scenario('s-other', 'other-base', { id: 'run-other', createdAt: '2026-02-01T00:00:00Z' }, 'Elsewhere')
	];

	it('pairs a scenario’s run with the base run its scenario names', () => {
		expect(licencePair({ id: 'run-new', fromScenario: true, scenarioId: 's-new' }, scenarios)).toEqual({ kind: 'pair', baseRunId: 'base', scenarioName: 'Newer orchard' });
		// An older API without fromScenario still names its scenario.
		expect(licencePair({ id: 'run-other', scenarioId: 's-other' }, scenarios)).toEqual({ kind: 'pair', baseRunId: 'other-base', scenarioName: 'Elsewhere' });
	});

	it('never guesses a base for a scenario’s run whose scenario is gone or unseen', () => {
		expect(licencePair({ id: 'r', fromScenario: true, scenarioId: null, scenarioName: 'Deleted' }, scenarios)).toEqual({ kind: 'unknown' });
		expect(licencePair({ id: 'r', fromScenario: true, scenarioId: 'hidden' }, scenarios)).toEqual({ kind: 'unknown' });
	});

	it('on a run of the model, offers the newest run of each scenario based on it (positive control), choosing none', () => {
		expect(licencePair({ id: 'base', fromScenario: false }, scenarios)).toEqual({
			kind: 'base',
			proposals: [
				{ runId: 'run-new', scenarioName: 'Newer orchard' },
				{ runId: 'run-old', scenarioName: 'Older dam' }
			]
		});
		expect(licencePair({ id: 'lonely', fromScenario: false }, scenarios)).toEqual({ kind: 'base', proposals: [] });
		expect(licencePair({ id: 'base' }, [])).toEqual({ kind: 'base', proposals: [] });
	});
});
