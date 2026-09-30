import { describe, expect, it } from 'vitest';
import {
	declaredRuleError,
	declaredRuleMismatches,
	declaredRuleRequest,
	declaredRuleText,
	ENSEMBLE_MEMBERS_MAX,
	ENSEMBLE_MEMBERS_MIN,
	PAN_OFFSET_MAX,
	type DeclaredUncertaintyRule,
	type ResolvedEnsembleOptions
} from './options';

// Issue #71 (ER3): the project's declared uncertainty rule.

const RULE: DeclaredUncertaintyRule = {
	members: 300,
	bounds: 'typical',
	panOffset: 0.1,
	thresholds: { objective: 'kgePrime', minSkill: 0.5, wr2012MaxLevel: 'query', maxLowFlowBiasPct: 50 }
};

const withRule = (over: Record<string, unknown>) => ({ ...RULE, ...over });
const withThresholds = (over: Record<string, unknown>) => ({ ...RULE, thresholds: { ...RULE.thresholds, ...over } });

describe('declaredRuleError', () => {
	it('accepts a valid rule, null (withdrawn) and the edge values', () => {
		expect(declaredRuleError(RULE)).toBeNull();
		expect(declaredRuleError(null)).toBeNull();
		expect(declaredRuleError(withRule({ members: ENSEMBLE_MEMBERS_MIN, bounds: 'wide', panOffset: 0 }))).toBeNull();
		expect(declaredRuleError(withRule({ members: ENSEMBLE_MEMBERS_MAX, panOffset: PAN_OFFSET_MAX }))).toBeNull();
		expect(declaredRuleError(withThresholds({ maxLowFlowBiasPct: null, wr2012MaxLevel: 'unusable', minSkill: -10 }))).toBeNull();
		expect(declaredRuleError(withThresholds({ maxLowFlowBiasPct: 1000, minSkill: 1 }))).toBeNull();
	});

	it('rejects a non-object', () => {
		for (const v of [undefined, 3, 'rule', [], true]) expect(declaredRuleError(v)).toBe('expected an object or null');
	});

	it('rejects unknown fields', () => {
		expect(declaredRuleError(withRule({ seed: 1 }))).toBe('unknown field seed');
		expect(declaredRuleError(withThresholds({ extra: 1 }))).toBe('unknown threshold extra');
	});

	it('rejects each invalid top-level field', () => {
		const members = `members must be a whole number from ${ENSEMBLE_MEMBERS_MIN} to ${ENSEMBLE_MEMBERS_MAX}`;
		for (const m of [ENSEMBLE_MEMBERS_MIN - 1, ENSEMBLE_MEMBERS_MAX + 1, 300.5, '300', undefined]) expect(declaredRuleError(withRule({ members: m }))).toBe(members);
		for (const b of ['narrow', undefined, 1]) expect(declaredRuleError(withRule({ bounds: b }))).toBe('bounds must be wide or typical');
		const pan = `pan offset must be from 0 to ${PAN_OFFSET_MAX}`;
		for (const p of [-0.01, PAN_OFFSET_MAX + 0.01, Number.NaN, Infinity, '0.1', undefined]) expect(declaredRuleError(withRule({ panOffset: p }))).toBe(pan);
		for (const t of [undefined, null, [], 'x']) expect(declaredRuleError(withRule({ thresholds: t }))).toBe('thresholds are required');
	});

	it('rejects each invalid threshold', () => {
		for (const o of ['rmse', undefined, 3, 'toString']) expect(declaredRuleError(withThresholds({ objective: o }))).toBe('unknown skill score');
		for (const s of [-10.01, 1.01, Number.NaN, '0.5', undefined]) expect(declaredRuleError(withThresholds({ minSkill: s }))).toBe('the lowest skill kept must be from −10 to 1');
		for (const w of ['bad', undefined, null]) expect(declaredRuleError(withThresholds({ wr2012MaxLevel: w }))).toBe('the worst WR2012 flag kept must be ok, note, query or unusable');
		for (const l of [0, -5, 1000.1, Infinity, '50', undefined])
			expect(declaredRuleError(withThresholds({ maxLowFlowBiasPct: l }))).toBe('the largest low-flow bias kept must be above 0 and at most 1000 %, or none');
	});
});

describe('declaredRuleText', () => {
	it('reads a rule in one line, and says when there is none or it is invalid', () => {
		expect(declaredRuleText(RULE)).toBe(
			'skill score KGE′, lowest skill kept 0.5, worst wr2012 flag kept query, largest low-flow bias kept ±50 %, members 300, bounds typical, pan coefficient shift ±0.1'
		);
		expect(declaredRuleText(withThresholds({ wr2012MaxLevel: 'unusable', maxLowFlowBiasPct: null }))).toContain('worst wr2012 flag kept no check, largest low-flow bias kept no check');
		expect(declaredRuleText(withRule({ panOffset: 0 }))).toContain('pan coefficient shift not varied');
		expect(declaredRuleText(null)).toBe('not declared');
		expect(declaredRuleText(undefined)).toBe('not declared');
		expect(declaredRuleText(withRule({ members: 1 }))).toBe('not a valid rule');
	});
});

describe('declaredRuleMismatches', () => {
	// Only the rule's fields are read; the rest of the resolved options are the ensemble's own.
	const resolved = (over: Partial<ResolvedEnsembleOptions> = {}) =>
		({ members: 300, bounds: 'typical', panOffset: 0.1, thresholds: { ...RULE.thresholds }, seed: 987, records: ['flow_logger_m3s'], rainSources: ['chirps'], ...over }) as ResolvedEnsembleOptions;

	it('is empty when the ensemble followed the rule, whatever its seed, records and rain sources', () => {
		expect(declaredRuleMismatches(RULE, resolved())).toEqual([]);
	});

	it('lists each departure as declared → the ensemble’s', () => {
		const o = resolved({ members: 100, bounds: 'wide', panOffset: 0, thresholds: { objective: 'nseLog', minSkill: 0.3, wr2012MaxLevel: 'unusable', maxLowFlowBiasPct: null } });
		expect(declaredRuleMismatches(RULE, o)).toEqual([
			{ label: 'Skill score', a: 'KGE′', b: 'NSE on log Q' },
			{ label: 'Lowest skill kept', a: '0.5', b: '0.3' },
			{ label: 'Worst WR2012 flag kept', a: 'query', b: 'no check' },
			{ label: 'Largest low-flow bias kept', a: '±50 %', b: 'no check' },
			{ label: 'Members', a: '300', b: '100' },
			{ label: 'Bounds', a: 'typical', b: 'wide' },
			{ label: 'Pan coefficient shift', a: '±0.1', b: 'not varied' }
		]);
		expect(declaredRuleMismatches(RULE, resolved({ members: 301 }))).toEqual([{ label: 'Members', a: '300', b: '301' }]);
	});

	it('builds the request that starts the declared ensemble, with its own copy of the thresholds', () => {
		const req = declaredRuleRequest(RULE);
		expect(req).toEqual({ members: 300, bounds: 'typical', panOffset: 0.1, thresholds: RULE.thresholds });
		expect(req.thresholds).not.toBe(RULE.thresholds);
	});
});
