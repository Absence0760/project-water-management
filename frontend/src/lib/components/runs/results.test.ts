import type { FarmSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { RunSeriesRef } from '$lib/api/types';
import { m3DayToMm3a, runDamCapacity, seriesGroups, sortFarms, storagePct, supplyBarFraction, toDisplayUnit, outletEwrLine } from './results';

const farm = (nodeId: string, name: string, fractionSupplied: number, avgDeficitM3Day: number): FarmSummary => ({
	nodeId,
	name,
	avgDemandM3Day: 100,
	avgSuppliedM3Day: 100 * fractionSupplied,
	avgDeficitM3Day,
	fractionSupplied,
	avgEwrShortfallM3Day: 0,
	daysEwrNotMet: 0
});

describe('sortFarms', () => {
	const farms = [farm('b', 'Bravo', 0.9, 10), farm('a', 'Alpha', 1, 0), farm('c', 'Charlie', 0.5, 50)];
	const names = (fs: FarmSummary[]) => fs.map((f) => f.name);

	it('defaults to the network order', () => {
		const order = new Map([
			['c', 0],
			['a', 1],
			['b', 2]
		]);
		expect(names(sortFarms(farms, 'network', 'asc', order))).toEqual(['Charlie', 'Alpha', 'Bravo']);
	});

	it('keeps the run order for farms the network no longer has', () => {
		expect(names(sortFarms(farms, 'network', 'asc', new Map([['c', 0]])))).toEqual(['Charlie', 'Bravo', 'Alpha']);
	});

	it('sorts numerically and by name in either direction', () => {
		expect(names(sortFarms(farms, 'fractionSupplied', 'asc'))).toEqual(['Charlie', 'Bravo', 'Alpha']);
		expect(names(sortFarms(farms, 'avgDeficitM3Day', 'desc'))).toEqual(['Charlie', 'Bravo', 'Alpha']);
		expect(names(sortFarms(farms, 'name', 'asc'))).toEqual(['Alpha', 'Bravo', 'Charlie']);
	});
});

describe('seriesGroups', () => {
	const ref = (nodeId: string | null, key: string): RunSeriesRef => ({ nodeId, key, label: key, unit: 'm³/day' });
	it('puts the catchment first and nodes in network order', () => {
		const g = seriesGroups(
			[ref('n2', 'outflow'), ref(null, 'natural_flow'), ref('n1', 'demand'), ref('n1', 'supplied')],
			new Map([
				['n1', 0],
				['n2', 1]
			]),
			new Map([
				['n1', 'Upper'],
				['n2', 'Lower']
			])
		);
		expect(g.map((x) => x.label)).toEqual(['Catchment (outflow gauge)', 'Upper', 'Lower']);
		expect(g[1]!.options.map((o) => o.key)).toEqual(['demand', 'supplied']);
	});
});

describe('units', () => {
	it('converts m³/day flows to m³/s and keeps gaps', () => {
		expect(toDisplayUnit([86_400, null, Number.NaN], 'm³/day', 'm³/s')).toEqual({ unit: 'm³/s', values: [1, null, null] });
		expect(toDisplayUnit([5], 'mm', 'm³/s')).toEqual({ unit: 'mm', values: [5] });
		expect(toDisplayUnit([5], 'm³/day', 'm³/day')).toEqual({ unit: 'm³/day', values: [5] });
	});

	it('gives Mm³/a from a mean m³/day', () => {
		expect(m3DayToMm3a(1_000_000 / 365.25)).toBeCloseTo(1, 10);
	});

	it('expresses dam storage as % of capacity', () => {
		expect(storagePct([500, null, 1000], 1000)).toEqual([50, null, 100]);
		expect(storagePct([1], 0.15)).toBeNull();
	});
});

describe('supplyBarFraction', () => {
	it('is the fraction supplied, clamped to 0–1, and 0 when not a number', () => {
		expect(supplyBarFraction(0.62)).toBe(0.62);
		expect(supplyBarFraction(1.2)).toBe(1);
		expect(supplyBarFraction(-0.1)).toBe(0);
		expect(supplyBarFraction(Number.NaN)).toBe(0);
	});
});

describe('runDamCapacity', () => {
	const live = [{ id: 'a', damCapacityM3: 50_000 }, { id: 'new', damCapacityM3: 9 }];
	it('takes each dam as the run had it, so a dam halved since then does not chart the old run at 200 %', () => {
		const cap = runDamCapacity({ nodes: [{ id: 'a', damCapacityM3: 100_000 }, { id: 'g' }] }, live);
		expect(cap.get('a')).toBe(100_000);
		expect(storagePct([100_000], cap.get('a')!)).toEqual([100]);
		// A node the run had without a dam; a node added since the run is not in it.
		expect(cap.get('g')).toBe(0);
		expect(cap.has('new')).toBe(false);
	});

	it('falls back to the live model for a run without a model snapshot', () => {
		expect(runDamCapacity(undefined, live).get('a')).toBe(50_000);
		expect(runDamCapacity({ nodes: [] }, live).get('a')).toBe(50_000);
	});
});

describe('outletEwrLine (engine ≥ 1.77.0)', () => {
	it('names the pragmatic EWR when the run has no daily source, else the table, the factor and its inputs', () => {
		expect(outletEwrLine(undefined)).toBe('EWR: the pragmatic EWR');
		expect(outletEwrLine({ method: 'tab', scaling: 'mar', scale: 0.41234, modelMarMm3: 31.6, tableMarMm3: 92.415 })).toBe('EWR: the DRM TAB file × 0.4123 (natural MAR 31.6 ÷ 92.42 Mm³/a)');
		expect(outletEwrLine({ method: 'percentile', scaling: 'area', scale: 0.25, modelAreaKm2: 4, tableAreaKm2: 16, pinned: true })).toBe('EWR: the DRM percentile tables × 0.25 (area 4 ÷ 16 km², the factor of the run it continues from)');
	});
});
