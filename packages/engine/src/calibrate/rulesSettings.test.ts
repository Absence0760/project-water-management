import { describe, expect, it } from 'vitest';
import { defaultProjectSettings } from '../project';
import {
	calibrationRulesChanges,
	calibrationRulesError,
	defaultCalibrationRules,
	resolveCalibrationRules,
	RULE_CASES_MAX,
	ruleCaseCount,
	rulePanValues,
	rulesLines,
	sameRules,
	type CalibrationRules
} from './rulesSettings';

const rules = (over: Partial<CalibrationRules> = {}): CalibrationRules => ({ ...defaultCalibrationRules(), ...over });

describe('the default calibration rules', () => {
	it('are valid drafts: revision 1, not signed off, two fits', () => {
		const d = defaultCalibrationRules();
		expect(calibrationRulesError(d)).toBeNull();
		expect(d.revision).toBe(1);
		expect(d.signedOff).toBeNull();
		expect(ruleCaseCount(d)).toBe(2);
		// Selection is on a held-out test, never in-sample.
		expect(d.selection.test).toBe('dryWet');
	});

	it('are every project’s until it stores its own', () => {
		expect(defaultProjectSettings().calibrationRules).toEqual(defaultCalibrationRules());
	});
});

describe('calibrationRulesError', () => {
	it.each([
		[{ exclusions: { maxFlaggedShare: 0 } }, 'flagged-day share'],
		[{ exclusions: { maxFlaggedShare: 1 } }, 'flagged-day share'],
		[{ forcing: { pan: [] } }, 'at least one pan'],
		[{ forcing: { pan: ['nowhere'] } }, 'unknown pan coefficient "nowhere"'],
		[{ forcing: { pan: ['project', 'project'] } }, 'listed twice'],
		[{ cases: { bounds: [], objectives: ['kgePrime'] } }, 'at least one set of bounds'],
		[{ cases: { bounds: ['wide'], objectives: [] } }, 'at least one objective'],
		[{ signedOff: { by: ' ', on: '2026-09-29' } }, 'needs a name'],
		[{ signedOff: { by: 'A. Hydrologist', on: '29/09/2026' } }, 'YYYY-MM-DD'],
		[{ run: { seed: -1, starts: 5, budget: 1500 } }, 'the seed'],
		[{ run: { seed: 1, starts: 11, budget: 1500 } }, 'the starts'],
		[{ run: { seed: 1, starts: 5, budget: 20 } }, 'model runs per fit']
	] as [Partial<CalibrationRules>, string][])('refuses %j', (over, msg) => {
		expect(calibrationRulesError(rules(over))).toContain(msg);
	});

	it('caps the fits a rule set can ask for', () => {
		const many = rules({
			forcing: { pan: ['project', 'generic', 'winter-rainfall'] },
			cases: { bounds: ['wide', 'typical'], objectives: ['kgePrime', 'nseLog'] }
		});
		expect(ruleCaseCount(many)).toBe(12);
		expect(12).toBeGreaterThan(RULE_CASES_MAX);
		expect(calibrationRulesError(many)).toContain('12 fits');
	});

	it('takes no exclusions by rule (null) and a sign-off with a name and date', () => {
		expect(calibrationRulesError(rules({ exclusions: { maxFlaggedShare: null }, signedOff: { by: 'A. Hydrologist', on: '2026-09-29' } }))).toBeNull();
	});
});

describe('resolveCalibrationRules', () => {
	it('fills missing groups from the defaults and keeps the stored revision', () => {
		const r = resolveCalibrationRules({ revision: 4, exclusions: { maxFlaggedShare: 0.3 } });
		expect(r.revision).toBe(4);
		expect(r.exclusions.maxFlaggedShare).toBe(0.3);
		expect(r.cases).toEqual(defaultCalibrationRules().cases);
	});

	it('falls back to the defaults, with a warning, on an invalid set', () => {
		const warnings: string[] = [];
		const r = resolveCalibrationRules({ revision: 3, forcing: { pan: ['nowhere'] } }, warnings);
		expect(r.forcing.pan).toEqual(['project']);
		expect(r.revision).toBe(3);
		expect(warnings[0]).toContain('unknown pan coefficient');
	});

	it('copies rules handed in as a proxy (the Settings form’s reactive state), which structuredClone refuses', () => {
		const deep = <T extends object>(o: T): T =>
			new Proxy(o, { get: (t, k) => (typeof (t as Record<PropertyKey, unknown>)[k] === 'object' && (t as Record<PropertyKey, unknown>)[k] !== null ? deep((t as Record<PropertyKey, object>)[k]!) : (t as Record<PropertyKey, unknown>)[k]) });
		const proxied = deep({ ...defaultCalibrationRules(), revision: 2 });
		expect(() => structuredClone(proxied)).toThrow();
		expect(resolveCalibrationRules(proxied)).toEqual({ ...defaultCalibrationRules(), revision: 2 });
	});

	it('reads absent rules as the defaults', () => {
		expect(resolveCalibrationRules(undefined)).toEqual(defaultCalibrationRules());
	});
});

describe('sameRules and the change lines', () => {
	it('ignores the revision and the sign-off: they don’t change which fit is picked', () => {
		const a = defaultCalibrationRules();
		expect(sameRules(a, { ...a, revision: 7, signedOff: { by: 'A. Hydrologist', on: '2026-09-29' } })).toBe(true);
		expect(sameRules(a, { ...a, selection: { test: 'split', score: 'kgePrime' } })).toBe(false);
		// Another seed is another rule set: it can't be tried after a result is seen.
		expect(sameRules(a, { ...a, run: { ...a.run, seed: 2 } })).toBe(false);
	});

	it('names each changed rule, and the sign-off, for run comparison', () => {
		const a = defaultCalibrationRules();
		const b = { ...a, exclusions: { maxFlaggedShare: 0.1 }, signedOff: { by: 'A. Hydrologist', on: '2026-09-29' } };
		expect(calibrationRulesChanges(a, b)).toEqual([
			{
				subject: 'Calibration rules: exclusions',
				text: 'Calibration rules, exclusions: a water year with more than 20 % of its observed days flagged → a water year with more than 10 % of its observed days flagged'
			},
			{ subject: 'Calibration rules: sign-off', text: 'Calibration rules: draft (not signed off) → signed off by A. Hydrologist on 2026-09-29' }
		]);
		expect(calibrationRulesChanges(a, a)).toEqual([]);
	});

	it('describes the defaults in one line per rule', () => {
		expect(rulesLines(defaultCalibrationRules()).map((l) => l.text)).toEqual([
			'a water year with more than 20 % of its observed days flagged',
			'The project’s pan coefficient',
			expect.stringContaining('wide and typical bounds'),
			expect.stringContaining('dry → wet test'),
			'seed 1, 5 starts per fit, 1500 model runs per optimisation',
			'MAR inside the WR2012 band; parameters in the typical range'
		]);
	});

	it('gives a preset’s 12 values, and none for the project’s own row', () => {
		expect(rulePanValues('project')).toBeNull();
		expect(rulePanValues('generic')).toHaveLength(12);
	});
});
