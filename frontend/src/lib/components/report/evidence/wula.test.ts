import { describe, expect, it } from 'vitest';
import type { EvidenceWula } from '@water-management/engine';
import { opWorksText, wulaPage1 } from './wula';

const W: EvidenceWula = { number: 'WU/2026/0042', refs: ['W1', 'W2'], untiedProposals: [1], unknownRefs: [2], unmodelled: ['W2'] };

describe('the WULA reference on page 1 (evidence-26)', () => {
	it('gives the number, the works’ refs and how the changes meet them', () => {
		expect(wulaPage1(W)).toEqual({
			number: 'WU/2026/0042',
			works: '2 works applied for: W1, W2',
			tie: ['1 proposal models none of the works applied for (A.2)', 'No change models W2 (A.2)']
		});
	});

	it('says so when every proposal models listed works (positive control), and when none are listed', () => {
		expect(wulaPage1({ ...W, untiedProposals: [], unmodelled: [] }).tie).toEqual(['Every proposal models works applied for, and every works is modelled']);
		expect(wulaPage1({ number: null, refs: [], untiedProposals: [0], unknownRefs: [], unmodelled: [] })).toEqual({
			number: null,
			works: 'No works listed',
			tie: ['1 proposal models none of the works applied for (A.2)']
		});
	});
});

describe('A.2’s word on each change', () => {
	it('names the works a change models, a tag the list lacks, and a proposal tied to none; a baseline assumption naming none gets nothing', () => {
		expect(opWorksText(W, 0, 'W1', 'proposal')).toEqual({ text: 'Models W1', tied: true });
		expect(opWorksText(W, 2, 'W9', 'baseline')).toEqual({ text: 'Names “W9”, which the WULA doesn’t list', tied: false });
		expect(opWorksText(W, 1, undefined, 'proposal')).toEqual({ text: 'Models none of the works applied for', tied: false });
		expect(opWorksText(W, 3, undefined, 'baseline')).toBeNull();
	});
});
