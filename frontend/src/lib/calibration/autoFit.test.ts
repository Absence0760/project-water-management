import { defaultCalibrationRules } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { AutoCalibration, AutoCalibrationCase } from '$lib/api/types';
import { applyBlocker, autoCaseRows, autoRunsTotal, autoState, rulesUnsaved, selectionText, triggerText } from './autoFit';

const kase = (over: Partial<AutoCalibrationCase> = {}): AutoCalibrationCase => ({
	label: 'x',
	pan: { id: 'project', label: 'The project’s pan coefficient', values: null },
	bounds: 'wide',
	objective: 'kgePrime',
	score: 0.61,
	naturalMarMm3: 12.345,
	eligible: true,
	reasons: [],
	filters: [
		{ id: 'wr2012Mar', status: 'notApplicable', detail: '' },
		{ id: 'typicalParams', status: 'pass', detail: '' }
	],
	error: null,
	params: { x1: 400, x3: 70, x4: 2.1 },
	...over
});

const run = (over: Partial<AutoCalibration> = {}): AutoCalibration => ({
	id: 'c1',
	trigger: 'manual',
	status: 'complete',
	rulesRevision: 2,
	rules: defaultCalibrationRules(),
	plan: { flowKind: 'flow_observed_m3s', validationRecord: null, years: [], ruleExclusions: [], notes: [], cases: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
	cases: [
		kase(),
		kase({ bounds: 'typical', score: 0.72 }),
		kase({ bounds: 'typical', objective: 'nseLog', score: 0.9, eligible: false, reasons: ['Parameters in the typical range: X1 2000 is outside 100–1200 mm'], filters: [{ id: 'typicalParams', status: 'fail', detail: '' }] })
	],
	report: { chosen: 1, notes: [] },
	chosen: 1,
	error: null,
	engineVersion: '1.25.0',
	job: null,
	createdBy: 'A. User',
	createdAt: '2026-09-29T10:00:00.000Z',
	completedAt: '2026-09-29T10:03:00.000Z',
	appliedBy: null,
	appliedAt: null,
	appliedRunId: null,
	uncertaintyId: null,
	...over
});

describe('a server run of the calibration rules, in the page', () => {
	it('lists each fit with whether it was kept, its held-out score and why it wasn’t kept', () => {
		expect(autoCaseRows(run())).toEqual([
			{ label: 'The project’s pan coefficient, wide bounds, KGE′', verdict: 'Passed', score: '0.61', mar: '12.35', filters: 'MAR inside the WR2012 band: not applied; Parameters in the typical range: passed', reasons: [] },
			{ label: 'The project’s pan coefficient, typical bounds, KGE′', verdict: 'Kept', score: '0.72', mar: '12.35', filters: expect.any(String), reasons: [] },
			{
				label: expect.stringContaining('typical bounds, NSE on log Q'),
				verdict: 'Not kept',
				score: '0.90',
				mar: '12.35',
				filters: 'Parameters in the typical range: failed',
				reasons: ['Parameters in the typical range: X1 2000 is outside 100–1200 mm']
			}
		]);
		// A failed fit says why; a running run passes no verdict yet.
		expect(autoCaseRows(run({ cases: [kase({ error: 'the fit failed: too short', eligible: false })], chosen: null }))[0]!.reasons).toEqual(['the fit failed: too short']);
		expect(autoCaseRows(run({ status: 'running', chosen: null, cases: [kase({ eligible: false })] }))[0]!.verdict).toBe('Not kept');
	});

	it('counts every fit’s runs from the rules’ own search, both validation tests always included', () => {
		// 2 fits × 1 500 × (5 starts + 2 validation fits).
		expect(autoRunsTotal(defaultCalibrationRules(), false)).toBe(21_000);
		expect(autoRunsTotal(defaultCalibrationRules(), true)).toBe(24_000);
	});

	it('says where a run stands: fitting i of n, stopped with its job, failed, or complete', () => {
		expect(autoState(run({ status: 'running', cases: [kase()] }))).toEqual({ kind: 'running', text: 'Fitting 2 of 3 on the server…', progress: 33 });
		expect(autoState(run({ status: 'running', cases: [], job: { id: 'j', status: 'dead', error: 'the model can’t run', progress: null } }))).toEqual({
			kind: 'stopped',
			text: 'The run stopped: the model can’t run'
		});
		expect(autoState(run({ status: 'failed', error: 'the data changed' }))).toEqual({ kind: 'failed', text: 'the data changed' });
		expect(autoState(run())).toEqual({ kind: 'complete' });
	});

	it('holds Apply back while the rules or the rest of the form have unsaved edits, and for a viewer', () => {
		const ok = { rulesUnsaved: false, formDirty: false, readonly: false };
		expect(applyBlocker(run(), ok)).toBeNull();
		expect(applyBlocker(run(), { ...ok, rulesUnsaved: true })).toBe('Save the calibration rules first.');
		expect(applyBlocker(run(), { ...ok, formDirty: true })).toMatch(/^Save or discard the other changes/);
		expect(applyBlocker(run(), { ...ok, readonly: true })).toBe('Only an editor can apply a fit.');
	});

	it('compares the saved and form rules whatever order their keys are in', () => {
		const saved = defaultCalibrationRules();
		const reordered = Object.fromEntries(Object.entries(saved).reverse()) as typeof saved;
		expect(rulesUnsaved(saved, reordered)).toBe(false);
		expect(rulesUnsaved(saved, { ...saved, exclusions: { maxFlaggedShare: 0.3 } })).toBe(true);
	});

	it('says what keeps a fit and who started the run', () => {
		expect(selectionText(defaultCalibrationRules())).toBe('the best KGE′ on the dry → wet test (wet years)');
		expect(triggerText(run())).toBe('Started by A. User');
		expect(triggerText(run({ trigger: 'new_data' }))).toBe('Queued by new data');
	});
});
