import { describe, expect, it } from 'vitest';
import type { ScenarioOp } from '@water-management/engine';
import { cleaned, draftOf, draftProblems, tagOp, wulaPatch, wulaSummary } from './wula';

const STORED = { number: 'WU/2026/0042', works: [{ ref: 'W1', text: 'Raise the dam wall by 2 m' }] };

describe('the WULA reference form', () => {
	it('sends nothing when nothing changed, whitespace aside', () => {
		const d = draftOf(STORED);
		d.number = ' WU/2026/0042 ';
		expect(wulaPatch(d, STORED)).toEqual({});
	});

	it('sends the number and the works only when each changed; a blank number clears it', () => {
		const d = draftOf(STORED);
		d.number = '';
		expect(wulaPatch(d, STORED)).toEqual({ wulaNumber: null });
		d.works.push({ ref: ' W2 ', text: ' A weir\r\n' });
		expect(wulaPatch(d, STORED)).toEqual({ wulaNumber: null, wulaWorks: [...STORED.works, { ref: 'W2', text: 'A weir' }] });
	});

	it('leaves out a blank row, and names a row missing its ref or its words, and a repeated ref', () => {
		expect(cleaned({ number: '', works: [{ ref: ' ', text: '' }] }).works).toEqual([]);
		expect(draftProblems({ number: '', works: [{ ref: '', text: 'x' }, { ref: 'W2', text: '' }] })).toEqual([
			'Works 1 needs a reference (W1, or the WULA’s own item number).',
			'Works W2 needs saying what the works are.'
		]);
		expect(draftProblems({ number: '', works: [{ ref: 'W1', text: 'a' }, { ref: 'W1', text: 'b' }] })).toEqual(['Each works needs its own reference: “W1” is used twice.']);
		expect(draftProblems(draftOf(STORED))).toEqual([]);
	});

	it('sums it up in one line', () => {
		expect(wulaSummary({ number: null, works: [] })).toBe('Not given');
		expect(wulaSummary(STORED)).toBe('WU/2026/0042 · 1 works applied for');
		expect(wulaSummary({ number: null, works: [...STORED.works, { ref: 'W2', text: 'x' }] })).toBe('No number · 2 works applied for');
	});
});

describe('tagOp', () => {
	const ops: ScenarioOp[] = [
		{ op: 'node.set', nodeId: 'f', field: 'damCapacityM3', value: 1 },
		{ op: 'node.set', nodeId: 'g', field: 'damCapacityM3', value: 2, works: 'W1' }
	];

	it('ties one change to a works, and unties it, leaving the others as they were', () => {
		const tagged = tagOp(ops, 0, 'W1');
		expect(tagged[0]).toEqual({ ...ops[0], works: 'W1' });
		expect(tagged[1]).toBe(ops[1]);
		expect(tagOp(ops, 1, null)[1]).toEqual({ op: 'node.set', nodeId: 'g', field: 'damCapacityM3', value: 2 });
		expect(tagOp(ops, 1, null)[1]).not.toHaveProperty('works');
	});
});
