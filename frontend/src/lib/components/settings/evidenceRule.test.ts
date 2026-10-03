import { declaredRuleError, declaredRuleText, ENSEMBLE_DEFAULTS, WR2012_LEVELS } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { defaultEvidenceRule, evidenceRuleFieldsError, RULE_BOUNDS_LABEL, RULE_WR2012_LABEL, withdrawnRule, withEvidenceRule } from './evidenceRule';

describe('defaultEvidenceRule', () => {
	it('is the ensemble’s own defaults, a valid rule the server accepts', () => {
		const r = defaultEvidenceRule();
		expect(r).toEqual({ members: 300, bounds: 'typical', panOffset: 0.1, thresholds: { objective: 'kgePrime', minSkill: 0.5, wr2012MaxLevel: 'query', maxLowFlowBiasPct: 50 } });
		expect(declaredRuleError(r)).toBeNull();
		// No seed: the database draws it (declaredRuleError refuses an unknown field).
		expect(Object.keys(r)).not.toContain('seed');
		expect(declaredRuleText(r)).toBe(
			'skill score KGE′, lowest skill kept 0.5, worst wr2012 flag kept query, largest low-flow bias kept ±50 %, members 300, bounds typical, pan coefficient shift ±0.1'
		);
	});

	it('is a fresh copy each time, so editing the form never changes the defaults', () => {
		const r = defaultEvidenceRule();
		r.thresholds.minSkill = 0.9;
		expect(ENSEMBLE_DEFAULTS.thresholds.minSkill).toBe(0.5);
		expect(defaultEvidenceRule().thresholds.minSkill).toBe(0.5);
	});
});

describe('withdrawnRule', () => {
	it('is null when a rule was saved, so the save withdraws it', () => {
		expect(withdrawnRule(defaultEvidenceRule())).toBeNull();
		expect(withdrawnRule(null)).toBeNull();
	});
	it('is nothing when no rule was ever saved, so switching on and off leaves the form unchanged', () => {
		expect(withdrawnRule(undefined)).toBeUndefined();
	});
});

describe('evidenceRuleFieldsError', () => {
	it('is null for no rule and for a valid one', () => {
		expect(evidenceRuleFieldsError(null)).toBeNull();
		expect(evidenceRuleFieldsError(undefined)).toBeNull();
		expect(evidenceRuleFieldsError(defaultEvidenceRule())).toBeNull();
		expect(evidenceRuleFieldsError({ ...defaultEvidenceRule(), thresholds: { ...defaultEvidenceRule().thresholds, maxLowFlowBiasPct: null } })).toBeNull();
	});
	it('words the engine’s check for the form', () => {
		expect(evidenceRuleFieldsError({ ...defaultEvidenceRule(), members: 10 })).toBe('Evidence uncertainty rule: members must be a whole number from 30 to 1000.');
		expect(evidenceRuleFieldsError({ ...defaultEvidenceRule(), panOffset: 0.5 })).toBe('Evidence uncertainty rule: pan offset must be from 0 to 0.3.');
	});
});

describe('labels', () => {
	it('names every bound and WR2012 level; unusable switches the check off', () => {
		expect(Object.keys(RULE_BOUNDS_LABEL).sort()).toEqual(['typical', 'wide']);
		expect(Object.keys(RULE_WR2012_LABEL)).toEqual([...WR2012_LEVELS]);
		expect(RULE_WR2012_LABEL.unusable).toBe('No check');
	});
});

describe('withEvidenceRule', () => {
	it('on brings back the rule switched off, not the defaults; off withdraws it', () => {
		const declared = { ...defaultEvidenceRule(), members: 300, panOffset: 0.05 };
		expect(withEvidenceRule(false, declared, declared)).toBeNull();
		expect(withEvidenceRule(false, undefined, declared)).toBeUndefined();
		expect(withEvidenceRule(true, declared, null)).toEqual(defaultEvidenceRule());
		const back = withEvidenceRule(true, declared, declared);
		expect(back).toEqual(declared);
		expect(back).not.toBe(declared);
	});
});
