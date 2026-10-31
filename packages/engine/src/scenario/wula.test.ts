// The WULA reference's check (294_wula_reference, docs/scenarios.md § The WULA
// reference): which proposals name no applied-for works, and the op `works`
// tag the validator keeps.
import { describe, expect, it } from 'vitest';
import { validateScenarioOps, type ScenarioOp } from './ops';
import { hasWula, NO_WULA, wulaTie, wulaWarnings, WULA_WORK_REF_MAX, type WulaReference } from './wula';

const raise = (works?: string): ScenarioOp => ({ op: 'node.set', nodeId: 'f1', field: 'damCapacityM3', value: 200_000, ...(works === undefined ? {} : { works }) });
const rain: ScenarioOp = { op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.9 };
const WULA: WulaReference = { number: 'WU/2026/0042', works: [{ ref: 'W1', text: 'Raise the Upper farm dam wall by 2 m' }, { ref: 'W2', text: 'A new weir' }] };

describe('validateScenarioOps: the works tag', () => {
	it('keeps an op’s works tag beside its fields, and leaves an untagged op without one', () => {
		const { ops, errors } = validateScenarioOps([raise('W1'), raise()]);
		expect(errors).toEqual([]);
		expect(ops[0]).toEqual(raise('W1'));
		expect(ops[1]).not.toHaveProperty('works');
	});

	it('reads null as no tag', () => {
		const { ops, errors } = validateScenarioOps([{ ...raise(), works: null }]);
		expect(errors).toEqual([]);
		expect(ops[0]).not.toHaveProperty('works');
	});

	it('refuses a tag that is blank, padded, too long, not text or holds a control character', () => {
		for (const bad of ['', ' W1', 'W1 ', 'x'.repeat(WULA_WORK_REF_MAX + 1), 7, 'W\u00071']) {
			const { errors } = validateScenarioOps([{ ...raise(), works: bad }]);
			expect(errors, String(bad)).toHaveLength(1);
			expect(errors[0]).toMatch(/^ops\[0\]\.works: /);
		}
		// Positive control: the longest tag is fine.
		expect(validateScenarioOps([raise('x'.repeat(WULA_WORK_REF_MAX))]).errors).toEqual([]);
	});
});

describe('wulaTie', () => {
	it('names the proposals tied to no listed works, the tags the list lacks and the works nothing models', () => {
		const ops = [raise('W1'), raise(), raise('W9'), rain];
		expect(wulaTie(ops, ['proposal', 'proposal', 'baseline', 'baseline'], WULA.works)).toEqual({ untiedProposals: [1], unknownRefs: [2], unmodelled: ['W2'] });
	});

	it('counts an op with no class as a proposal', () => {
		expect(wulaTie([raise()], [], WULA.works).untiedProposals).toEqual([0]);
	});
});

describe('wulaWarnings', () => {
	it('says nothing of a team scenario with no reference', () => {
		expect(wulaWarnings([raise()], ['proposal'], NO_WULA, { application: false })).toEqual([]);
		expect(hasWula(NO_WULA)).toBe(false);
	});

	it('holds an application to it even with no reference: no number, no works', () => {
		expect(wulaWarnings([raise()], ['proposal'], NO_WULA, { application: true })).toEqual([
			'No WULA application number is given: add it under Application details, as the authority gave it.',
			'The WULA reference lists no works: list the works as applied for, then tie each proposal to the works it models.'
		]);
	});

	it('warns of each untied proposal and unknown tag, not of a baseline assumption, and of works nothing models', () => {
		const lines = wulaWarnings([raise('W1'), raise(), raise('W9'), rain], ['proposal', 'proposal', 'proposal', 'baseline'], WULA, { application: true });
		expect(lines).toEqual([
			'op 3 (node.set): names works “W9”, which the WULA reference doesn\'t list.',
			'op 2 (node.set): a proposal tied to none of the works the WULA applies for: name the works it models.',
			'Works “W2” is applied for, but no change models it.'
		]);
	});

	it('is silent when every proposal is tied and every works modelled (positive control)', () => {
		expect(wulaWarnings([raise('W1'), raise('W2'), rain], ['proposal', 'proposal', 'baseline'], WULA, { application: true })).toEqual([]);
	});

	it('holds a team scenario that records a reference to it', () => {
		expect(wulaWarnings([raise()], ['proposal'], { number: 'WU/1', works: [] }, { application: false })).toEqual([
			'The WULA reference lists no works: list the works as applied for, then tie each proposal to the works it models.'
		]);
	});
});
