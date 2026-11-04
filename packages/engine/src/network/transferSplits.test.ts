// A transfer split between destinations (engine 1.114.0, ./transferSplits.ts),
// and a curve by month (./offtake.ts): the pieces a split rule runs as, the
// fields the editors write, the save's reasons, and the scenario op.
import { describe, expect, it } from 'vitest';
import { applyScenario } from '../scenario/overrides';
import type { ModelInput, Transfer } from '../project';
import { diversionMonthsOf, withMonthlyDiversion } from './offtake';
import { destinationsProblem, expandTransferSplits, splitPieceOf, transferDestinations, withDestinations } from './transferSplits';
import { externalRuleKeys, parseTransferRuleKey } from './transferSeries';

const rule = (over: Partial<Transfer> = {}): Transfer => ({
	id: 'r',
	fromNodeId: 'S',
	toNodeId: 'A',
	months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
	maxRateM3s: 1,
	dailyCapM3: 50_000,
	minStoragePct: 0.2,
	enabled: true,
	priority: 3,
	source: 'river',
	sizing: 'capacity',
	lossPct: 0.1,
	...over
});

describe('expandTransferSplits', () => {
	it('returns a list without a split rule as it is, and a one-row list as the rule', () => {
		const list = [rule(), rule({ id: 'q', destinations: [{ nodeId: 'A', pct: 1 }] })];
		expect(expandTransferSplits(list)).toBe(list);
	});

	it('runs a 40/60 split as two pieces, each with its share of the rates, the cap and a curve’s share', () => {
		const t = rule({
			toNodeId: 'A',
			destinations: [
				{ nodeId: 'A', pct: 0.4 },
				{ nodeId: 'B', pct: 0.6 }
			],
			monthlyRateM3s: new Array(12).fill(2),
			sizing: 'diversionCurve',
			diversionFlowUnit: 'L/s',
			monthlyDiversion: [{ coefficient: 50, exponent: -0.5, maxPct: null }, ...new Array(11).fill(null)]
		});
		const [a, b] = expandTransferSplits([t]);
		expect(a).toMatchObject({ id: 'r#0', toNodeId: 'A', destinations: null, maxRateM3s: 0.4, dailyCapM3: 20_000, splitOf: 'r', splitPct: 0.4, priority: 3, lossPct: 0.1, minStoragePct: 0.2 });
		expect(a!.monthlyRateM3s).toEqual(new Array(12).fill(0.8));
		expect(a!.monthlyDiversion![0]).toEqual({ coefficient: 20, exponent: -0.5, maxPct: 0.4 });
		expect(b).toMatchObject({ id: 'r#1', toNodeId: 'B', dailyCapM3: 30_000, splitPct: 0.6 });
		expect(b!.monthlyDiversion![0]).toEqual({ coefficient: 30, exponent: -0.5, maxPct: 0.6 });
		expect(b!.monthlyDiversion!.slice(1).every((m) => m === null)).toBe(true);
		// Idempotent: pieces have no destinations.
		expect(expandTransferSplits([a!, b!])).toEqual([a, b]);
	});

	it('scales a one-curve rule’s coefficient and largest share (absent = 100 %)', () => {
		const [a] = expandTransferSplits([rule({ sizing: 'diversionCurve', diversionCoefficient: 2000, diversionExponent: -0.9, diversionMaxPct: null, diversionFlowUnit: 'm3/s', destinations: [{ nodeId: 'A', pct: 0.25 }, { nodeId: 'B', pct: 0.75 }] })]);
		expect(a).toMatchObject({ diversionCoefficient: 500, diversionExponent: -0.9, diversionMaxPct: 0.25 });
	});

	it('runs a split it can’t use as all of it to the first destination, with a warning', () => {
		const w: string[] = [];
		const out = expandTransferSplits([rule({ destinations: [{ nodeId: 'A', pct: 0.5 }, { nodeId: 'B', pct: 0.4 }] })], w);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ id: 'r', toNodeId: 'A', destinations: null, maxRateM3s: 1 });
		expect(w).toEqual(['transfer r: its destinations’ shares must add up to 100 % (they add up to 90 %); it runs as all of it to its first destination']);
	});
});

describe('the split fields', () => {
	it('keeps toNodeId the first destination, and a one-row list as toNodeId alone', () => {
		expect(withDestinations([{ nodeId: 'B', pct: 0.3 }, { nodeId: null, pct: 0.7 }])).toEqual({ toNodeId: 'B', destinations: [{ nodeId: 'B', pct: 0.3 }, { nodeId: null, pct: 0.7 }] });
		expect(withDestinations([{ nodeId: 'C', pct: 1 }])).toEqual({ toNodeId: 'C', destinations: null });
		expect(transferDestinations(rule())).toEqual([{ nodeId: 'A', pct: 1 }]);
		expect(destinationsProblem(rule())).toBeNull();
	});

	it('reads a piece’s id and series key back to its rule', () => {
		expect(splitPieceOf('r#2')).toEqual({ ruleId: 'r', k: 2 });
		expect(splitPieceOf('r')).toBeNull();
		expect(splitPieceOf('r#x')).toBeNull();
		expect(parseTransferRuleKey('transfer_rule@r#1')).toBe('r');
		// A dam rule's piece out of the catchment is the unit's external use (allocations, engine ≥ 1.88.0).
		const t = rule({ source: 'dam', destinations: [{ nodeId: 'A', pct: 0.5 }, { nodeId: null, pct: 0.5 }] });
		expect(externalRuleKeys([t], 'S')).toEqual(['transfer_rule@r#1']);
		expect(externalRuleKeys([rule({ source: 'dam', toNodeId: null })], 'S')).toEqual(['transfer_rule@r']);
	});
});

describe('a curve by month', () => {
	it('reads a one-curve rule as that curve every month, and any other sizing as none', () => {
		const one = diversionMonthsOf(rule({ sizing: 'diversionCurve', diversionCoefficient: 2, diversionExponent: 0.5, diversionMaxPct: 0.9 }));
		expect(one).toEqual(new Array(12).fill({ coefficient: 2, exponent: 0.5, maxPct: 0.9 }));
		expect(diversionMonthsOf(rule())).toEqual(new Array(12).fill(null));
	});

	it('stores a mix as a curve rule with its list, and no curve at all as a capacity rule', () => {
		const list = [{ coefficient: 1, exponent: 0, maxPct: null }, ...new Array(11).fill(null)];
		expect(withMonthlyDiversion(list)).toEqual({ sizing: 'diversionCurve', monthlyDiversion: list, diversionCoefficient: null, diversionExponent: null, diversionMaxPct: null });
		expect(withMonthlyDiversion(new Array(12).fill(null))).toMatchObject({ sizing: 'capacity', monthlyDiversion: null });
	});
});

describe('the scenario op (transfer.set destinations)', () => {
	const input = (): ModelInput => ({
		settings: {},
		model: { nodes: ['S', 'A', 'B', 'C'].map((id) => ({ id, name: id, kind: 'farm', downstreamNodeId: id === 'S' ? null : 'S' }) as never), crops: [], cropAreas: [], transfers: [rule()] },
		series: {}
	});

	it('sets the destinations and toNodeId with them, and a new toNodeId moves the first destination', () => {
		const d = [
			{ nodeId: 'B', pct: 0.4 },
			{ nodeId: 'A', pct: 0.6 }
		];
		const a = applyScenario(input(), [{ op: 'transfer.set', transferId: 'r', field: 'destinations', value: d }]);
		expect(a.input.model.transfers[0]).toMatchObject({ toNodeId: 'B', destinations: d });
		const b = applyScenario(a.input, [{ op: 'transfer.set', transferId: 'r', field: 'toNodeId', value: 'C' }]);
		expect(b.input.model.transfers[0]).toMatchObject({ toNodeId: 'C', destinations: [{ nodeId: 'C', pct: 0.4 }, { nodeId: 'A', pct: 0.6 }] });
		const said = (r: ReturnType<typeof applyScenario>) => JSON.stringify(r.problems);
		expect(said(applyScenario(input(), [{ op: 'transfer.set', transferId: 'r', field: 'destinations', value: [{ nodeId: 'Z', pct: 1 }] }]))).toMatch(/Z not found/);
		expect(said(applyScenario(input(), [{ op: 'transfer.set', transferId: 'r', field: 'destinations', value: [{ nodeId: 'A', pct: 2 }] as never }]))).toMatch(/share must be above 0 and at most 1/);
	});

	it('setting a curve by month sizes the rule by it; sizing it to capacity drops the list (each op checked alone)', () => {
		const list = [{ coefficient: 50, exponent: 0, maxPct: null }, ...new Array(11).fill(null)];
		const m = input();
		m.model.transfers[0]!.diversionFlowUnit = 'm3/day';
		const a = applyScenario(m, [{ op: 'transfer.set', transferId: 'r', field: 'monthlyDiversion', value: list }]);
		expect(a.problems).toEqual([]);
		expect(a.input.model.transfers[0]).toMatchObject({ sizing: 'diversionCurve', monthlyDiversion: list, diversionCoefficient: null });
		const b = applyScenario(a.input, [{ op: 'transfer.set', transferId: 'r', field: 'sizing', value: 'capacity' }]);
		expect(b.problems).toEqual([]);
		expect(b.input.model.transfers[0]).toMatchObject({ sizing: 'capacity', monthlyDiversion: null });
	});

	it('removing a node drops a rule that sends a share to it', () => {
		const m = input();
		m.model.transfers[0]!.destinations = [
			{ nodeId: 'A', pct: 0.5 },
			{ nodeId: 'B', pct: 0.5 }
		];
		const out = applyScenario(m, [{ op: 'node.remove', nodeId: 'B' }]);
		expect(out.input.model.transfers).toEqual([]);
	});
});
