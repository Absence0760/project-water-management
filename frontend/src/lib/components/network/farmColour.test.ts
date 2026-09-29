import { describe, expect, it } from 'vitest';
import type { NetworkNode } from '@water-management/engine';
import type { DamLevel } from '$lib/components/overview/damLevels';
import { damColouring, supplyColouring } from './farmColour';

const node = (id: string, kind: NetworkNode['kind'] = 'farm', damCapacityM3 = 1000) =>
	({ id, name: id, kind, downstreamNodeId: kind === 'gauge' ? null : 'g', damCapacityM3 }) as NetworkNode;
const level = (nodeId: string, endPct: number, minPct = 0) => ({ nodeId, endPct, minPct }) as DamLevel;
const run = { name: 'Baseline', ago: 'today' };

describe('damColouring', () => {
	it('bands each farm by how full its dam ended the run, with words for its label', () => {
		const nodes = [node('full'), node('mid'), node('low'), node('atmin'), node('nodam', 'farm', 0), node('new'), node('g', 'gauge')];
		const c = damColouring(nodes, [level('full', 80), level('mid', 45), level('low', 12), level('atmin', 10, 10)], run, false);
		expect(Object.fromEntries(c.byNode)).toEqual({
			full: { band: 'met', text: '80% full' },
			mid: { band: 'short', text: '45% full' },
			low: { band: 'low', text: '12% full' },
			atmin: { band: 'low', text: '10%, at its minimum' },
			nodam: { band: 'none', text: 'no dam' },
			new: { band: 'absent', text: 'not in this run' }
		});
		expect(c.legend.map((l) => l.label)).toEqual(['60% full or more', '30–60% full', 'Under 30%, or at its minimum', 'No dam', 'Not in this run']);
		expect(c.caption).toBe('Hydrological units coloured by how full their dam was at the end of run “Baseline”, ran today.');
	});

	it('puts a boundary value in the higher band', () => {
		const c = damColouring([node('a'), node('b')], [level('a', 60), level('b', 30)], run, true);
		expect(c.byNode.get('a')!.band).toBe('met');
		expect(c.byNode.get('b')!.band).toBe('short');
		expect(c.unsaved).toBe(true);
	});
});

describe('supplyColouring', () => {
	it('keeps the supply bands, words and caption', () => {
		const c = supplyColouring([node('a')], { farms: [{ nodeId: 'a', avgDemandM3Day: 10, fractionSupplied: 0.5 } as never] }, run, false);
		expect(c.byNode.get('a')).toMatchObject({ band: 'low', text: '50% supplied' });
		expect(c.caption).toBe('Hydrological units coloured by share of irrigation demand supplied in run “Baseline”, ran today.');
	});
});
