import { describe, expect, it } from 'vitest';
import type { NetworkNode } from '@water-management/engine';
import type { DamLevel } from '#lib/components/overview/damLevels.js';
import { damColouring, supplyColouring, zoneColouring } from './farmColour';
import { zoneGroups } from '#lib/calibration/zoneGroups.js';
import { defaultProjectSettings, newCalibrationZone } from '@water-management/engine';

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

describe('zoneColouring (issue #555; locations, issue #659)', () => {
	const nodes = [
		{ id: 'G', name: 'Outlet', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
		{ id: 'H', name: 'Weir', kind: 'gauge', downstreamNodeId: 'G', areaKm2: 0 },
		{ id: 'A', name: 'Farm A', kind: 'farm', downstreamNodeId: 'H', areaKm2: 40 },
		{ id: 'B', name: 'Farm B', kind: 'farm', downstreamNodeId: 'G', areaKm2: 60 },
		{ id: 'C', name: 'Farm C', kind: 'farm', downstreamNodeId: 'G', areaKm2: 5 },
		{ id: 'U', name: 'Pump', kind: 'farm', downstreamNodeId: 'G', areaKm2: 0 }
	] as NetworkNode[];
	const base = { ...defaultProjectSettings(), calibrationZones: [{ ...newCalibrationZone('H'), enabled: true }] };

	it('colours each unit by its group, with the group’s name as its label line, and a legend entry per group', () => {
		const c = zoneColouring(nodes, zoneGroups(nodes, base)!);
		expect(c.mode).toBe('zone');
		expect(c.unsaved).toBe(false);
		expect(c.byNode.get('A')).toEqual({ band: 'zone', text: 'Weir zone, not fitted yet', swatch: 'var(--series-1)' });
		expect(c.byNode.get('B')).toEqual({ band: 'zone', text: 'Outlet zone (outlet, headline)', swatch: 'var(--series-2)' });
		expect(c.byNode.get('U')).toEqual({ band: 'none', text: 'no land area, in no zone' });
		expect(c.byNode.has('G')).toBe(false);
		expect(c.legend).toEqual([
			{ band: 'zone', label: 'Weir zone, not fitted yet: 1 unit', swatch: 'var(--series-1)' },
			{ band: 'zone', label: 'Outlet zone (outlet, headline): 2 units', swatch: 'var(--series-2)' },
			{ band: 'none', label: 'No land area, in no zone' }
		]);
		expect(c.caption).not.toContain('outlined');
	});

	it('gives a borrowed unit its donor’s colour, an outline marker and "borrowed from" in its label and the key (issue #659)', () => {
		const c = zoneColouring(nodes, zoneGroups(nodes, { ...base, calibrateAtOutlet: true, calibrationRest: 'nearest', unitParamsFrom: { C: 'H' } })!);
		expect(c.byNode.get('C')).toEqual({ band: 'zone', text: 'borrowed from Weir, not fitted yet', swatch: 'var(--series-1)', marker: 'borrowed' });
		expect(c.byNode.get('A')!.marker).toBeUndefined();
		expect(c.legend).toEqual([
			{ band: 'zone', label: 'Weir zone, not fitted yet: 1 unit', swatch: 'var(--series-1)' },
			{ band: 'zone', label: 'Borrowed from Weir, not fitted yet: 1 unit', swatch: 'var(--series-1)', marker: 'borrowed' },
			{ band: 'zone', label: 'Outlet zone (outlet, headline): 1 unit', swatch: 'var(--series-2)' },
			{ band: 'none', label: 'No land area, in no zone' }
		]);
		expect(c.caption).toContain('an outlined unit borrows another location’s');
	});
});
