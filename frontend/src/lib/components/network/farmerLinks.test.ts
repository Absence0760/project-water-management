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
	const base = { isFarm: true, areas: 0, transfers: 0, cover: 0, farmers: 0 };

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

	it('lists only the parts the node has, with real plurals, and never repeats the title', () => {
		expect(removeMessage({ ...base, areas: 2, transfers: 1, cover: 3 })).toBe(
			'Its 2 crop areas, 1 transfer and 3 land-cover patches go with it. Until you save, Discard brings it back.'
		);
		expect(removeMessage({ ...base, areas: 1 })).toBe('Its 1 crop area goes with it. Until you save, Discard brings it back.');
		expect(removeMessage({ ...base, isFarm: false, farmers: null, boreholes: 2 })).toBe('Its 2 boreholes go with it. Until you save, Discard brings it back.');
		expect(removeMessage({ ...base, isFarm: false, farmers: null, demandObjects: 1 })).toMatch(/^Its 1 demand object goes with it\./);
		expect(removeMessage({ ...base, areas: 2 })).not.toMatch(/Remove|\(s\)|\b0 /);
	});

	it('asks when nodes drain into it, saying where they will drain', () => {
		expect(removeMessage({ ...base, upstream: 2, into: 'Outflow gauge' })).toBe(
			'The 2 hydrological units that drain into it will drain into “Outflow gauge”. Until you save, Discard brings it back.'
		);
		expect(removeMessage({ ...base, upstream: 1, into: null })).toMatch(/^The hydrological unit that drains into it will have nowhere to drain/);
	});
});
