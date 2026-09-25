import type { FarmSummary, NetworkNode } from '@water-management/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { newNode } from '$lib/model/editor.svelte';
import { SUPPLY_TARGET } from '$lib/components/runs/results';
import { BAND_LABEL, bandsPresent, farmSupply, LOW_SUPPLY, ranAgo, supplyBand, supplyByNode } from './supplyColour';

const farm = (nodeId: string, fractionSupplied: number, avgDemandM3Day = 100): FarmSummary => ({
	nodeId,
	name: nodeId,
	avgDemandM3Day,
	avgSuppliedM3Day: avgDemandM3Day * fractionSupplied,
	avgDeficitM3Day: avgDemandM3Day * (1 - fractionSupplied),
	fractionSupplied,
	avgEwrShortfallM3Day: 0,
	daysEwrNotMet: 0
});

let seq = 0;
const node = (id: string, kind: NetworkNode['kind'], down: string | null = 'Out'): NetworkNode => ({
	...newNode(++seq, down),
	id,
	name: id,
	kind
});

describe('supplyBand', () => {
	it('uses the farm table target for the top band and 70 % below the middle one', () => {
		expect(SUPPLY_TARGET).toBeGreaterThan(LOW_SUPPLY);
		expect(supplyBand(farm('a', 1))).toBe('met');
		expect(supplyBand(farm('a', 0.5))).toBe('low');
		expect(supplyBand(farm('a', 0))).toBe('low');
	});

	it('puts a farm exactly on a boundary in the higher band', () => {
		expect(supplyBand(farm('a', SUPPLY_TARGET))).toBe('met');
		expect(supplyBand(farm('a', SUPPLY_TARGET - 1e-9))).toBe('short');
		expect(supplyBand(farm('a', 0.8))).toBe('short');
		expect(supplyBand(farm('a', 0.7))).toBe('short');
		expect(supplyBand(farm('a', 0.7 - 1e-9))).toBe('low');
	});

	it('marks a farm missing from the run as absent', () => {
		expect(supplyBand(undefined)).toBe('absent');
	});

	it('does not colour a zero-demand farm as fully supplied', () => {
		// The engine reports fractionSupplied = 1 when the mean demand is 0.
		expect(supplyBand(farm('a', 1, 0))).toBe('none');
		expect(farmSupply(farm('a', 1, 0))).toEqual({ band: 'none', fraction: null, text: 'no demand' });
	});

	it('treats a non-finite share as no demand rather than a band', () => {
		expect(supplyBand(farm('a', Number.NaN))).toBe('none');
	});
});

describe('farmSupply', () => {
	it('words each band so the drawing is not colour-only', () => {
		expect(farmSupply(farm('a', 0.823))).toEqual({ band: 'short', fraction: 0.823, text: '82% supplied' });
		expect(farmSupply(undefined)).toEqual({ band: 'absent', fraction: null, text: 'not in this run' });
	});
});

describe('supplyByNode', () => {
	it('maps every farm node, leaves gauges and other users out, and flags farms added since the run', () => {
		const nodes = [node('Out', 'gauge', null), node('A', 'farm'), node('B', 'farm'), node('New', 'farm'), node('Town', 'user')];
		const m = supplyByNode(nodes, { farms: [farm('A', 0.99), farm('B', 0.4), farm('Gone', 0.9)] });
		expect([...m.keys()]).toEqual(['A', 'B', 'New']);
		expect(m.get('A')!.band).toBe('met');
		expect(m.get('B')!.band).toBe('low');
		expect(m.get('New')!.band).toBe('absent');
		expect(bandsPresent(m)).toEqual(['met', 'low', 'absent']);
	});

	it('flags a node that was a gauge in the run and is a farm now', () => {
		const m = supplyByNode([node('G', 'farm')], { farms: [] });
		expect(m.get('G')!.band).toBe('absent');
	});
});

describe('BAND_LABEL', () => {
	it('names the thresholds', () => {
		expect(BAND_LABEL.met).toBe('95% or more supplied');
		expect(BAND_LABEL.short).toBe('70% to 95% supplied');
		expect(BAND_LABEL.low).toBe('Under 70% supplied');
	});
});

describe('ranAgo', () => {
	const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);
	it('counts calendar days', () => {
		expect(ranAgo(at(2026, 9, 25, 9).toISOString(), at(2026, 9, 25, 18))).toBe('today');
		expect(ranAgo(at(2026, 9, 24, 23).toISOString(), at(2026, 9, 25, 1))).toBe('yesterday');
		expect(ranAgo(at(2026, 9, 23).toISOString(), at(2026, 9, 25))).toBe('2 days ago');
		expect(ranAgo('not a date', at(2026, 9, 25))).toBe('');
	});

	describe('under a skewed time zone', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		it('uses the viewer’s calendar, not the UTC one', () => {
			process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
			// 2026-09-24T11:00Z is 01:00 on the 25th in Kiritimati: today, not yesterday.
			expect(ranAgo('2026-09-24T11:00:00Z', new Date('2026-09-25T08:00:00Z'))).toBe('today');
			process.env.TZ = 'Pacific/Pago_Pago'; // UTC−11
			// 2026-09-25T09:00Z is still the 24th there; 2026-09-26T09:00Z is the 25th.
			expect(ranAgo('2026-09-25T09:00:00Z', new Date('2026-09-26T09:00:00Z'))).toBe('yesterday');
		});
	});
});
