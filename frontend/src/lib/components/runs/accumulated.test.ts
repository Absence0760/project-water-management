import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { contrast, cssHex, worstDe } from '#lib/a11y/colourVision.js';
import {
	dayAt,
	eachAtOnce,
	FLOW_SHOWN,
	firstDayInView,
	flowLines,
	lastDayInView,
	LINE_TOKENS,
	lineStats,
	OUTLET_LINE_ID,
	ownShare,
	partId,
	runNetwork,
	sumParts,
	unitsUpstream,
	viewDays,
	type FlowLine
} from './accumulated';

const epoch = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

// A synthetic network: A and B drain into a gauge G, G and C into D (a branch), D into the outlet gauge O, and a
// town T (an other water user) off D's reach. Upstream first in the model's order.
const net = [
	{ id: 'O', kind: 'gauge', downstreamNodeId: null },
	{ id: 'A', kind: 'farm', downstreamNodeId: 'G' },
	{ id: 'B', kind: 'farm', downstreamNodeId: 'G' },
	{ id: 'G', kind: 'gauge', downstreamNodeId: 'D' },
	{ id: 'C', kind: 'farm', downstreamNodeId: 'D' },
	{ id: 'T', kind: 'user', downstreamNodeId: 'D' },
	{ id: 'D', kind: 'farm', downstreamNodeId: 'O' }
];
const order = new Map(['A', 'B', 'G', 'C', 'T', 'D', 'O'].map((id, i) => [id, i]));
const names = new Map(['A', 'B', 'C', 'D', 'G', 'T', 'O'].map((id) => [id, `Unit ${id}`]));
const keys = ['runoff', 'inflow_upstream', 'outflow'];
const refs = [
	{ key: 'simulated_outflow', nodeId: null },
	{ key: 'natural_flow', nodeId: null },
	...['A', 'B', 'C', 'D'].flatMap((id) => keys.map((key) => ({ key, nodeId: id }))),
	{ key: 'outflow', nodeId: 'G' },
	{ key: 'inflow_upstream', nodeId: 'G' },
	{ key: 'outflow', nodeId: 'T' }
];
const units = unitsUpstream(refs, net, order, names);
const parts = (l: FlowLine | undefined) => l?.parts.map(partId);

describe('unitsUpstream', () => {
	it('lists each hydrological unit in network order with every unit upstream of it, through gauges and branches', () => {
		expect(units.map((u) => [u.id, u.upstream])).toEqual([
			['A', []],
			['B', []],
			['C', []],
			['D', ['A', 'B', 'C']]
		]);
	});
	it('is not trapped by a loop', () => {
		const loop = [
			{ id: 'A', kind: 'farm', downstreamNodeId: 'B' },
			{ id: 'B', kind: 'farm', downstreamNodeId: 'A' }
		];
		const r = [{ key: 'outflow', nodeId: 'A' }, { key: 'outflow', nodeId: 'B' }];
		expect(unitsUpstream(r, loop, new Map(), new Map()).map((u) => [u.id, u.upstream])).toEqual([
			['A', ['B']],
			['B', ['A']]
		]);
	});
});

describe('runNetwork', () => {
	it('takes the run’s own snapshot when it carries the drains-into links, else today’s model', () => {
		const live = [{ id: 'A', kind: 'farm', downstreamNodeId: 'O' }];
		expect(runNetwork([{ id: 'A', kind: 'farm', downstreamNodeId: null }], live)).toEqual([{ id: 'A', kind: 'farm', downstreamNodeId: null }]);
		expect(runNetwork([{ id: 'A' }], live)).toEqual([{ id: 'A', kind: 'farm', downstreamNodeId: 'O' }]);
		expect(runNetwork(undefined, live)).toEqual([{ id: 'A', kind: 'farm', downstreamNodeId: 'O' }]);
	});
});

describe('flowLines', () => {
	it('natural, accumulated: each unit’s own runoff plus every unit’s upstream; the outlet adds up every unit', () => {
		const lines = flowLines('natural', units, refs);
		expect(lines.map((l) => l.id)).toEqual([OUTLET_LINE_ID, 'A', 'B', 'C', 'D']);
		expect(parts(lines[0])).toEqual(['A|runoff', 'B|runoff', 'C|runoff', 'D|runoff']);
		expect(parts(lines.find((l) => l.id === 'D'))).toEqual(['D|runoff', 'A|runoff', 'B|runoff', 'C|runoff']);
		expect(lines.find((l) => l.id === 'D')!.own).toEqual({ key: 'runoff', nodeId: 'D' });
	});
	it('the operator’s example: 20 from the unit above and 25 of the unit’s own is 45 at the unit', () => {
		const two = unitsUpstream(
			[{ key: 'outflow', nodeId: 'u1' }, { key: 'outflow', nodeId: 'u2' }, { key: 'runoff', nodeId: 'u1' }, { key: 'runoff', nodeId: 'u2' }],
			[
				{ id: 'u1', kind: 'farm', downstreamNodeId: 'u2' },
				{ id: 'u2', kind: 'farm', downstreamNodeId: null }
			],
			new Map([['u1', 0], ['u2', 1]]),
			new Map()
		);
		const at2 = flowLines('natural', two, [{ key: 'runoff', nodeId: 'u1' }, { key: 'runoff', nodeId: 'u2' }]).find((l) => l.id === 'u2')!;
		const series = new Map([['u1|runoff', [20]], ['u2|runoff', [25]]]);
		expect(sumParts(at2.parts.map((p) => series.get(partId(p))!)).values).toEqual([45]);
	});
	it('modelled arriving is the flow from upstream plus the unit’s runoff, leaving its outflow; the outlet is the simulated outflow', () => {
		const arriving = flowLines('arriving', units, refs);
		expect(parts(arriving[0])).toEqual(['|simulated_outflow']);
		expect(parts(arriving.find((l) => l.id === 'D'))).toEqual(['D|inflow_upstream', 'D|runoff']);
		const leaving = flowLines('leaving', units, refs);
		expect(parts(leaving[0])).toEqual(['|simulated_outflow']);
		expect(parts(leaving.find((l) => l.id === 'D'))).toEqual(['D|outflow']);
		expect(leaving.every((l) => !l.own)).toBe(true);
	});
	it('incremental only is each unit’s runoff, with no outlet line; a unit keeps its colour across the choices', () => {
		const inc = flowLines('incremental', units, refs);
		expect(inc.map((l) => l.id)).toEqual(['A', 'B', 'C', 'D']);
		expect(parts(inc.find((l) => l.id === 'C'))).toEqual(['C|runoff']);
		const nat = flowLines('natural', units, refs);
		for (const l of inc) expect(l.color).toBe(nat.find((n) => n.id === l.id)!.color);
	});
	it('leaves out a line whose series the run didn’t store', () => {
		const noRunoff = refs.filter((r) => !(r.key === 'runoff' && r.nodeId === 'A'));
		const lines = flowLines('natural', units, noRunoff);
		// A's own line, D's (it adds A's) and the outlet's go; B and C stay.
		expect(lines.map((l) => l.id)).toEqual(['B', 'C']);
	});
	it('gives each line the line palette in order, then repeats it dashed past the seventh', () => {
		const many = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, kind: 'farm', downstreamNodeId: null }));
		const r = many.flatMap((n) => [{ key: 'outflow', nodeId: n.id }, { key: 'runoff', nodeId: n.id }]);
		const lines = flowLines('natural', unitsUpstream(r, many, new Map(many.map((n, i) => [n.id, i])), new Map()), r);
		expect(lines).toHaveLength(10);
		expect(lines.map((l) => l.color)).toEqual([...LINE_TOKENS, ...LINE_TOKENS.slice(0, 3)]);
		expect(lines.map((l) => l.style)).toEqual([...Array(7).fill('line'), 'dashed', 'dashed', 'dashed']);
	});
	it('names every choice and says what its lines are', () => {
		expect(FLOW_SHOWN.map((c) => c.label)).toEqual(['Natural, accumulated', 'Modelled, arriving at the unit', 'Modelled, leaving the unit', 'Incremental only']);
	});
});

describe('sumParts', () => {
	it('adds the series day by day', () => {
		expect(sumParts([[1, 2, 3], [10, 20, 30]])).toEqual({ values: [11, 22, 33], gapDays: 0 });
	});
	it('has no value on a day any series is missing, and counts those days: a gap never shrinks the sum', () => {
		expect(sumParts([[1, null, 3, 4], [10, 20, NaN, 40], [1, 1, 1, Infinity]])).toEqual({ values: [12, null, null, null], gapDays: 3 });
	});
	it('is empty for no series', () => {
		expect(sumParts([])).toEqual({ values: [], gapDays: 0 });
	});
	it('summed down a 3-unit chain, the outlet’s natural flow is the units’ runoff added up (no abstraction)', () => {
		// u1 → u2 → u3 → outlet; each unit's runoff is its share of the catchment's natural flow.
		const natural = [100, 80, 60, 300];
		const shares = [0.2, 0.3, 0.5];
		const runoff = shares.map((s) => natural.map((q) => q * s));
		const chain = [
			{ id: 'u1', kind: 'farm', downstreamNodeId: 'u2' },
			{ id: 'u2', kind: 'farm', downstreamNodeId: 'u3' },
			{ id: 'u3', kind: 'farm', downstreamNodeId: 'out' },
			{ id: 'out', kind: 'gauge', downstreamNodeId: null }
		];
		const r = ['u1', 'u2', 'u3'].flatMap((id) => [{ key: 'outflow', nodeId: id }, { key: 'runoff', nodeId: id }]);
		const lines = flowLines('natural', unitsUpstream(r, chain, new Map(chain.map((n, i) => [n.id, i])), new Map()), r);
		const byPart = new Map(['u1', 'u2', 'u3'].map((id, i) => [`${id}|runoff`, runoff[i]!]));
		const sum = (id: string) => sumParts(lines.find((l) => l.id === id)!.parts.map((p) => byPart.get(partId(p))!)).values;
		expect(sum('u2')).toEqual(natural.map((q) => q * 0.5));
		const u3 = sum('u3');
		natural.forEach((q, t) => expect(u3[t]).toBeCloseTo(q, 9));
		expect(sum(OUTLET_LINE_ID)).toEqual(u3);
	});
});

describe('the days in view', () => {
	const start = '2021-10-01';
	it('takes the first day whose point is at or after the left edge, and the last at or before the right', () => {
		expect(firstDayInView(start, 120, epoch('2021-10-11'))).toBe(10);
		expect(firstDayInView(start, 120, epoch('2021-10-11') + 3600)).toBe(11);
		expect(lastDayInView(start, 120, epoch('2021-10-20') + 3600)).toBe(19);
		expect(viewDays(start, 120, { min: epoch('2021-10-11'), max: epoch('2021-10-20') })).toEqual({ from: 10, to: 19 });
		expect(viewDays(start, 120, null)).toEqual({ from: 0, to: 119 });
	});
	it('stays within the record', () => {
		expect(firstDayInView(start, 120, epoch('2020-01-01'))).toBe(0);
		expect(lastDayInView(start, 120, epoch('2030-01-01'))).toBe(119);
		expect(firstDayInView(start, 0, 0)).toBe(0);
	});
	describe('under a skewed time zone', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		it('never moves a day, east or west of UTC, across a leap day', () => {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Africa/Johannesburg']) {
				process.env.TZ = zone;
				expect(firstDayInView('2024-02-27', 10, epoch('2024-03-01')), zone).toBe(3);
				expect(lastDayInView('2024-02-27', 10, epoch('2024-02-29')), zone).toBe(2);
				expect(dayAt('2024-02-27', 3), zone).toBe('2024-03-01');
			}
		});
	});
});

describe('lineStats and ownShare', () => {
	it('gives the mean, lowest and highest of the days in view that have a value', () => {
		expect(lineStats([1, null, 3, 8, 2], 0, 2)).toEqual({ mean: 2, min: 1, max: 3, days: 2 });
		expect(lineStats([1, null, 3, 8, 2], 3, 4)).toEqual({ mean: 5, min: 2, max: 8, days: 2 });
		expect(lineStats([null, null], 0, 1)).toEqual({ mean: null, min: null, max: null, days: 0 });
	});
	it('gives the unit’s own runoff as a share of its line over the days the line has', () => {
		expect(ownShare([25, 25], [45, 45], 0, 1)).toBeCloseTo(25 / 45, 12);
		expect(ownShare([25, 25], [45, null], 0, 1)).toBeCloseTo(25 / 45, 12);
		expect(ownShare([0], [0], 0, 0)).toBeNull();
	});
});

describe('LINE_TOKENS', () => {
	const css = readFileSync(new URL('../../../app.css', import.meta.url), 'utf8');
	for (const theme of ['light', 'dark'] as const) {
		it(`each line holds 3:1 on the card, and neighbours stay apart for every reader (${theme})`, () => {
			const card = cssHex(css, theme, '--surface');
			for (const t of LINE_TOKENS) expect(contrast(cssHex(css, theme, t), card), t).toBeGreaterThanOrEqual(3);
			for (let i = 0; i + 1 < LINE_TOKENS.length; i++) {
				const [a, b] = [LINE_TOKENS[i]!, LINE_TOKENS[i + 1]!];
				expect(worstDe(cssHex(css, theme, a), cssHex(css, theme, b)), `${a} ${b}`).toBeGreaterThanOrEqual(12);
			}
		});
	}
});

describe('eachAtOnce', () => {
	it('runs at most N at a time and keeps the items’ order', async () => {
		let running = 0;
		let peak = 0;
		const done: number[] = [];
		const out = await eachAtOnce(
			[5, 1, 4, 2, 3, 6],
			async (n) => {
				running++;
				peak = Math.max(peak, running);
				await new Promise((r) => setTimeout(r, n));
				running--;
				return n * 10;
			},
			4,
			(d) => done.push(d)
		);
		expect(out).toEqual([50, 10, 40, 20, 30, 60]);
		expect(peak).toBe(4);
		expect(done).toEqual([1, 2, 3, 4, 5, 6]);
	});
	it('rejects on the first failure', async () => {
		await expect(eachAtOnce([1, 2], async (n) => (n === 2 ? Promise.reject(new Error('no')) : n))).rejects.toThrow('no');
	});
});
