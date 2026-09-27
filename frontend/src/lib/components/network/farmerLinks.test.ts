import { describe, expect, it } from 'vitest';
import { countByNode, linkedNote, removeMessage } from './farmerLinks';

describe('countByNode', () => {
	it('counts the farmers linked to each farm', () => {
		expect(countByNode([{ status: 'active', nodeIds: ['a', 'b'] }, { status: 'active', nodeIds: ['a'] }])).toEqual({ a: 2, b: 1 });
		expect(countByNode([])).toEqual({});
	});

	it('leaves out pending and expired invites, which link nobody yet', () => {
		expect(countByNode([{ status: 'active', nodeIds: ['a'] }, { status: 'invited', nodeIds: ['a', 'b'] }, { status: 'expired', nodeIds: ['b'] }])).toEqual({ a: 1 });
	});
});

describe('linkedNote', () => {
	it('says how many farmers are linked, or nothing', () => {
		expect(linkedNote(0)).toBeNull();
		expect(linkedNote(1)).toMatch(/^1 farmer is linked/);
		expect(linkedNote(3)).toMatch(/^3 farmers are linked/);
	});
});

describe('removeMessage', () => {
	const base = { name: 'Farm A', isFarm: true, areas: 0, transfers: 0, cover: 0, farmers: 0 };

	it('asks nothing when nothing goes with the node', () => {
		expect(removeMessage(base)).toBeNull();
		expect(removeMessage({ ...base, isFarm: false, farmers: null })).toBeNull();
	});

	it('names the linked farmers who lose access', () => {
		expect(removeMessage({ ...base, farmers: 2 })).toContain('2 farmers linked to it lose access when you save.');
		expect(removeMessage({ ...base, areas: 1, farmers: 1 })).toContain('1 farmer linked to it loses access');
	});

	it('warns about farmers on a farm when the list could not be loaded', () => {
		expect(removeMessage({ ...base, farmers: null })).toContain('Any farmers linked to it lose access');
	});

	it('keeps the existing crop area, transfer and land-cover wording', () => {
		expect(removeMessage({ ...base, areas: 2, transfers: 1, cover: 3 })).toBe(
			'Remove "Farm A"? Its 2 crop area(s), 1 transfer(s) and 3 land-cover patch(es) are removed too; nodes draining into it are re-routed downstream.'
		);
		expect(removeMessage({ ...base, areas: 1 })).toBe(
			'Remove "Farm A"? Its 1 crop area(s) and 0 transfer(s) are removed too; nodes draining into it are re-routed downstream.'
		);
	});

	it('names the demand objects that go with the unit (engine 1.7.0)', () => {
		expect(removeMessage({ ...base, isFarm: false, farmers: null, demandObjects: 1 })).toMatch(/1 demand object\(s\) are removed too/);
	});

	it('names the boreholes that go with the node (WP-3.9), even on a node with nothing else', () => {
		expect(removeMessage({ ...base, isFarm: false, farmers: null, boreholes: 2 })).toBe(
			'Remove "Farm A"? Its 0 crop area(s), 0 transfer(s) and 2 borehole(s) are removed too; nodes draining into it are re-routed downstream.'
		);
	});
});
