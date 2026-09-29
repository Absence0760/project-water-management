import { describe, expect, it } from 'vitest';
import type { FarmSummary } from '@water-management/engine';
import { LOW_SUPPLY } from '$lib/components/network/supplyColour';
import { SUPPLY_TARGET } from '$lib/components/runs/results';
import { supplyBars } from './supplyBars';

const farm = (nodeId: string, fraction: number, demand = 100, name = nodeId): FarmSummary => ({
	nodeId,
	name,
	avgDemandM3Day: demand,
	avgSuppliedM3Day: demand * fraction,
	avgDeficitM3Day: demand * (1 - fraction),
	fractionSupplied: demand > 0 ? fraction : 1,
	avgEwrShortfallM3Day: 0,
	daysEwrNotMet: 0
});

describe('supplyBars', () => {
	it('sorts emptiest first, fullest last, with the Network’s supply bands', () => {
		const rows = supplyBars([farm('b', 0.8), farm('a', 1), farm('c', 0.5), farm('d', 0.8)], new Set(['a', 'b', 'c', 'd']));
		expect(rows.map((r) => [r.nodeId, r.band])).toEqual([
			['c', 'low'],
			['b', 'short'],
			['d', 'short'],
			['a', 'met']
		]);
		expect(rows[0]!.fraction).toBe(0.5);
	});

	it('bands at the target and the low line exactly as the Network does', () => {
		const rows = supplyBars([farm('t', SUPPLY_TARGET), farm('l', LOW_SUPPLY)], new Set());
		expect(rows.map((r) => r.band)).toEqual(['short', 'met']);
	});

	it('puts farms without demand last, and marks the farms no longer in the model', () => {
		const rows = supplyBars([farm('dry', 1, 0), farm('x', 0.2), farm('gone', 0.9, 100, '')], new Set(['dry', 'x']));
		expect(rows.map((r) => [r.nodeId, r.band, r.inModel])).toEqual([
			['x', 'low', true],
			['gone', 'short', false],
			['dry', 'none', true]
		]);
		expect(rows[1]!.name).toBe('Unnamed hydrological unit');
		expect(rows[2]!.fraction).toBeNull();
	});
});
