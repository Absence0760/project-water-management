// Deep end-to-end pass on river off-takes (docs/model.md §2.6a, engine 1.69.0's
// band sharing within one priority, with §2.6 monthly rates, §2.7c senior
// users, §2.7h keeps). Hand-worked cases first, then a differential check: a
// small re-implementation of the documented sharing, written from model.md
// (not from network/simulate.ts), replayed over a few hundred seeded random
// networks (several rules per priority with distinct and tied keeps, rules
// wanting nothing, monthly rates switching on 1 October, losses and their
// seepage back, demand and capacity sizing, top-ups, sources with and without
// a dam, senior users and the EWR; engine ≥ 1.70.0: a source's pass-inflow
// release target among the keeps and a destination's fixed release floor in
// a top-up's room, issue #90 Q26/Q27), plus metamorphic properties and order
// invariance to the bit. Synthetic names and values only.
import { describe, expect, it } from 'vitest';
import { toEpochDay, monthOfEpochDay, type Monthly } from '../calendar';
import type { DemandObject, ModelInput, ModelOutput, NetworkNode, ProjectSettings, RunSeries, Transfer } from '../project';
import { Rng } from '../random';
import { runModelWith, withVerification } from '../run';
import { scrambleOrder } from '../testing/fuzz';
import { withMonthlyRates } from '../network/transferRates';

const flat = (v: number) => new Array(12).fill(v) as number[];
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function farm(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Unit ${id}`,
		kind: 'farm',
		downstreamNodeId: 'G',
		sortOrder: 0,
		areaKm2: 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}
const gauge = (): NetworkNode => farm('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 99 });
const seniorUser = (id: string, down: string, m3Day: number): NetworkNode =>
	farm(id, { kind: 'user', downstreamNodeId: down, damAreaFullM2: null, userDemandM3Day: flat(m3Day), userReturnPct: 0, userPriority: 'senior' });
const town = (nodeId: string, monthly: number[], id = `town-${nodeId}`): DemandObject => ({
	id,
	nodeId,
	name: `Town at ${nodeId}`,
	category: 'municipal',
	sizing: 'monthly',
	monthlyM3Day: monthly,
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: ''
});
/** A river off-take sized to capacity unless said, up to `cap` m³/day. */
const ot = (id: string, from: string, to: string, cap: number, over: Partial<Transfer> = {}): Transfer => ({
	id,
	fromNodeId: from,
	toNodeId: to,
	months: ALL,
	maxRateM3s: 1,
	dailyCapM3: cap,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	source: 'river',
	sizing: 'capacity',
	lossPct: 0,
	handsOffM3Day: null,
	handsOffEwr: false,
	topUpDam: false,
	...over
});

interface Build {
	nodes: NetworkNode[];
	transfers: Transfer[];
	objects?: DemandObject[];
	ewr?: number;
	start?: string;
	days: number;
}
function build(b: Build): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(b.ewr ?? 0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly } as ModelInput['settings'],
		model: { nodes: b.nodes, crops: [], cropAreas: [], transfers: b.transfers, demandObjects: b.objects ?? [] },
		series: { rain_catchment_mm: { startDate: b.start ?? '2021-01-01', values: new Array(b.days).fill(0) } }
	};
}
const run = (input: ModelInput, natural: number[]) => withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: natural })));
const raw = (input: ModelInput, natural: number[]) => runModelWith(input, () => ({ naturalFlowM3Day: natural }));

function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}
const opt = (out: { series: RunSeries[] }, nodeId: string, key: string, days: number): number[] => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values ?? new Array(days).fill(0);
const near = (a: number[], b: number[], digits = 9) => {
	expect(a.length).toBe(b.length);
	a.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(b[t]!, digits));
};
function passes(out: ModelOutput) {
	expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
}
const one = (out: ModelOutput, id: string, from = 'S') => get(out, from, `transfer_rule@${id}`);

// ---------------------------------------------------------------------------
// The documented sharing (§2.6a "Each day"), re-derived from model.md.
// ---------------------------------------------------------------------------

interface RefRule {
	id: string;
	priority: number;
	/** Capacity today, m³/day (the month's rate × 86 400, capped by the daily cap). */
	cap: number;
	keep: number;
	/** Limit before the flow: cap, or MIN(cap, need ÷ (1 − l)) when sized to demand. */
	limit: number;
}
/**
 * Off-take volumes at one source on one day. By priority, lowest first; within
 * one, each active rule asks w = limit_k = MIN(capacity, need share ÷ (1 − l))
 * (engine ≥ 1.70.0, issue #90 Q25: never capped at the flow above its keep;
 * `freeCap` re-derives the rule before 1.70.0, w = MIN(free_k, limit_k), for
 * the sensitivity count below); the flow between successive keeps, highest
 * first (the top band starts at U₀ − taken so far), goes pro rata to what
 * each rule keeping that much or less still wants.
 */
function refShare(rules: readonly RefRule[], U0: number, freeCap = false): Map<string, number> {
	const got = new Map<string, number>(rules.map((r) => [r.id, 0]));
	let taken = 0;
	for (const p of [...new Set(rules.map((r) => r.priority))].sort((a, b) => a - b)) {
		const act = rules
			.filter((r) => r.priority === p && r.cap > 0)
			.map((r) => ({ r, left: freeCap ? Math.max(0, Math.min(Math.max(0, U0 - taken - r.keep), r.limit)) : Math.max(0, r.limit) }))
			.filter((a) => a.left > 0);
		let top = U0 - taken;
		let level = 0;
		for (const f of [...new Set(act.map((a) => a.r.keep))].sort((a, b) => b - a)) {
			const band = Math.max(0, top - f);
			const elig = act.filter((a) => a.r.keep <= f && a.left > 0);
			const want = elig.reduce((s, a) => s + a.left, 0);
			const scale = want > band ? band / want : 1;
			for (const a of elig) {
				const g = a.left * scale;
				got.set(a.r.id, got.get(a.r.id)! + g);
				a.left -= g;
				level += g;
			}
			top = Math.min(top, f);
		}
		taken += level;
	}
	return got;
}

describe('deep: hand-worked band sharing at one priority (§2.6a, engine 1.69.0; asks uncapped, engine 1.70.0)', () => {
	const dests = ['D1', 'D2', 'D3', 'D4'].map((id) => farm(id));
	const net = (tr: Transfer[], days = 1, extra: Partial<Build> = {}) =>
		build({ nodes: [gauge(), farm('S', { areaKm2: 1 }), ...dests, ...(extra.nodes ?? [])], transfers: tr, days, ...(extra.objects ? { objects: extra.objects } : {}), ...(extra.ewr !== undefined ? { ewr: extra.ewr } : {}), ...(extra.start ? { start: extra.start } : {}) });

	it('three distinct keeps (0, 600, 800), capacity 300 each, on 1 000: 300, 166.7 and 66.7', () => {
		// Each asks its 300 (engine ≥ 1.70.0: not capped at the flow above its keep, issue #90 Q25). Band 1000–800:
		// 900 asked, 200 there → 66.7 each. Band 800–600 for a and b: 466.7 still asked, 200 there → 100 each.
		// Band 600–0: a's last 133.3. (Before 1.70.0 c asked MIN(200, 300) = 200: 300, 175 and 50.)
		const input = net([ot('a', 'S', 'D1', 300), ot('b', 'S', 'D2', 300, { handsOffM3Day: 600 }), ot('c', 'S', 'D3', 300, { handsOffM3Day: 800 })]);
		const out = run(input, [1000]);
		near(one(out, 'a'), [300]);
		near(one(out, 'b'), [500 / 3]);
		near(one(out, 'c'), [200 / 3]);
		near(get(out, 'S', 'outflow'), [1400 / 3]);
		passes(out);
	});

	it('the result is the same to the bit whichever way the rules and nodes are listed', () => {
		const tr = [ot('a', 'S', 'D1', 300), ot('b', 'S', 'D2', 300, { handsOffM3Day: 600 }), ot('c', 'S', 'D3', 300, { handsOffM3Day: 800 }), ot('d', 'S', 'D4', 77.7, { handsOffM3Day: 600, lossPct: 0.3 })];
		const input = net(tr, 3);
		const nat = [1000, 731.3, 1e4 / 3];
		const base = raw(input, nat);
		for (let s = 1; s <= 6; s++) {
			const other = raw(scrambleOrder(input, s), nat);
			const m = new Map(other.series.map((x) => [`${x.nodeId}/${x.key}`, x.values]));
			for (const x of base.series) expect(m.get(`${x.nodeId}/${x.key}`), `${x.nodeId}/${x.key} (scramble ${s})`).toEqual(x.values);
		}
	});

	it('tied keeps share their band as one: 0 / 600 / 600 gives 300, 171.4 and 57.1', () => {
		// w: a 300, b 300, c 100. Band 1000–600: 700 wanted, 400 there → × 4/7. Band 600–0: a's 128.6.
		const out = run(net([ot('a', 'S', 'D1', 300), ot('b', 'S', 'D2', 300, { handsOffM3Day: 600 }), ot('c', 'S', 'D3', 100, { handsOffM3Day: 600 })]), [1000]);
		near(one(out, 'a'), [300]);
		near(one(out, 'b'), [1200 / 7]);
		near(one(out, 'c'), [400 / 7]);
		passes(out);
	});

	it('a rule that wants nothing (sized to a destination with no demand, or a month at rate 0) sets no band: the others are unchanged to the bit', () => {
		const base = [ot('b', 'S', 'D2', 300, { handsOffM3Day: 600 }), ot('c', 'S', 'D3', 300, { handsOffM3Day: 800 })];
		const off = flat(0);
		off[3] = 0.01; // January only
		const withIdle = [...base, ot('a', 'S', 'D1', 500, { sizing: 'demand' }), ot('z', 'S', 'D4', 0, { dailyCapM3: null, ...withMonthlyRates(off) })];
		const nat = [1000, 1234.5];
		const a = raw(net(base, 2, { start: '2021-05-01' }), nat);
		const b = raw(net(withIdle, 2, { start: '2021-05-01' }), nat);
		expect(one(b, 'a')).toEqual([0, 0]);
		expect(one(b, 'z')).toEqual([0, 0]);
		expect(one(b, 'b')).toEqual(one(a, 'b'));
		expect(one(b, 'c')).toEqual(one(a, 'c'));
		expect(get(b, 'S', 'outflow')).toEqual(get(a, 'S', 'outflow'));
	});

	it('a monthly rate switching off on 1 October: a keep-0 rule shares the top band on 30 September, the hands-off rule takes it alone on 1 October', () => {
		const rates = flat(0.001);
		rates[0] = 0; // October off
		const input = net([ot('a', 'S', 'D1', 0, { dailyCapM3: null, ...withMonthlyRates(rates) }), ot('b', 'S', 'D2', 100, { handsOffM3Day: 900 })], 2, { start: '2021-09-30' });
		const out = run(input, [1000, 1000]);
		// 30 Sep: w a 86.4, b 100; band 1000–900: 186.4 wanted → b 100 × 100/186.4; a takes the rest of its 86.4 below.
		near(one(out, 'a'), [86.4, 0]);
		near(one(out, 'b'), [(100 * 100) / 186.4, 100]);
		passes(out);
	});

	it('keeps from the senior users (Zs), a hands-off flow and the EWR: max of the three per rule', () => {
		// Senior user below S asks 700 → Zs = 700; the EWR 800 at S. a: hands-off 500 → keep 700; b: handsOffEwr → 800; c: none → 700.
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1, downstreamNodeId: 'U' }), seniorUser('U', 'G', 700), ...dests],
			transfers: [ot('a', 'S', 'D1', 300, { handsOffM3Day: 500 }), ot('b', 'S', 'D2', 300, { handsOffEwr: true }), ot('c', 'S', 'D3', 300)],
			ewr: 800,
			days: 1
		});
		const out = run(input, [1000]);
		near(get(out, 'S', 'senior_requirement'), [700]);
		near(get(out, 'S', 'ewr_cumulative'), [800]);
		// Band 1000–800: each asks 300 → 66.7 each. Band 800–700: a and c, 466.7 still asked, 100 there → 50 each.
		near(one(out, 'a'), [350 / 3]);
		near(one(out, 'b'), [200 / 3]);
		near(one(out, 'c'), [350 / 3]);
		near(get(out, 'S', 'outflow'), [700]);
		passes(out);
	});

	it('several priorities: a later priority sees the flow the earlier left; a hands-off rule first leaves room for a keep-0 rule after', () => {
		const p = (pa: number, pb: number) => run(net([ot('a', 'S', 'D1', 50, { handsOffM3Day: 900, priority: pa }), ot('b', 'S', 'D2', 2000, { priority: pb })]), [1000]);
		const first = p(0, 1);
		near(one(first, 'a'), [50]);
		near(one(first, 'b'), [950]);
		const second = p(1, 0);
		near(one(second, 'a'), [0]);
		near(one(second, 'b'), [1000]);
		passes(first);
		passes(second);
	});

	it('losses: the rule takes before its losses; seepage back at the source joins after its off-takes, so a later priority can’t take it', () => {
		const out = run(net([ot('a', 'S', 'D1', 500, { lossPct: 0.5, lossReturnPct: 1 }), ot('b', 'S', 'D2', 500, { priority: 1 })]), [600]);
		near(one(out, 'a'), [500]);
		near(one(out, 'b'), [100]);
		near(get(out, 'D1', 'offtake_in'), [250]);
		near(get(out, 'S', 'offtake_loss_return'), [250]);
		near(get(out, 'S', 'outflow'), [250]);
		passes(out);
	});

	it('a source with a dam: the off-takes share its spill; half full then full', () => {
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1, damCapacityM3: 1000, damInitialPct: 0.5, pctRunoffToDam: 1 }), ...dests],
			transfers: [ot('a', 'S', 'D1', 300), ot('b', 'S', 'D2', 300, { handsOffM3Day: 400 })],
			days: 2
		});
		const out = run(input, [1000, 1000]);
		near(get(out, 'S', 'spill'), [500, 1000]);
		// Day 1, U₀ 500: band 500–400: each asks 300 → 50 each; a takes its 250 more below. Day 2, U₀ 1000: both whole.
		near(one(out, 'a'), [300, 300]);
		near(one(out, 'b'), [50, 300]);
		passes(out);
	});

	it('demand-sized rules of distinct keeps into one unit: each up to its share of the need ÷ (1 − l), then the bands', () => {
		// D1 asks 600; caps 300, 200, 100 → shares 300, 200, 100; a loses 25 % → lim MIN(300, 400) = 300.
		const input = net(
			[ot('a', 'S', 'D1', 300, { sizing: 'demand', lossPct: 0.25 }), ot('b', 'S', 'D1', 200, { sizing: 'demand', handsOffM3Day: 500 }), ot('c', 'S', 'D1', 100, { sizing: 'demand', handsOffM3Day: 700 })],
			1,
			{ objects: [town('D1', flat(600))] }
		);
		const out = run(input, [1000]);
		// w a 300, b MIN(500, 200) = 200, c MIN(300, 100) = 100. Band 1000–700: 600 wanted, 300 there → ½: 150, 100, 50.
		// Band 700–500: a 150 + b 100 = 250 > 200 → × 0.8: a 120, b 80. Band 500–0: a's 30.
		near(one(out, 'a'), [300]);
		near(one(out, 'b'), [180]);
		near(one(out, 'c'), [50]);
		near(get(out, 'D1', 'offtake_in'), [300 * 0.75 + 180 + 50]);
		near(get(out, 'D1', 'supplied'), [455]);
		passes(out);
	});
});

// ---------------------------------------------------------------------------
// Random networks: the engine against the re-derivation, every rule, every day.
// ---------------------------------------------------------------------------

interface Case {
	input: ModelInput;
	natural: number[];
}
function randomCase(seed: number): Case {
	const g = new Rng(seed);
	const nodes: NetworkNode[] = [gauge()];
	const senior = g.bool(0.35);
	if (senior) nodes.push(seniorUser('U', 'G', g.pick([0, g.float(0, 900), 5000])));
	const sDam = g.bool(0.4);
	// Engine ≥ 1.70.0 (issue #90 Q26, Q27), from a stream of its own so the cases before keep their draws: a
	// pass-inflow release at a source with a dam (a monthly target or the EWR), fixed releases at destinations.
	const h = new Rng(seed ^ 0x2f6b1c3d);
	const passInflow = sDam && h.bool(0.5) ? { damReleaseRule: 'passInflow' as const, damReleaseM3Day: h.bool(0.6) ? Array.from({ length: 12 }, () => h.pick([0, h.float(0, 3000)])) : null } : {};
	nodes.push(
		farm('S', {
			areaKm2: 1,
			downstreamNodeId: senior ? 'U' : 'G',
			...(sDam ? { damCapacityM3: g.float(50, 3000), damInitialPct: g.frac(), pctUpstreamToDam: g.frac(), pctRunoffToDam: g.frac(), damMinPct: g.frac(0.5, 0.1) * 0.5, ...passInflow } : {})
		})
	);
	const hasT = g.bool(0.4);
	if (hasT) nodes.push(farm('T', { areaKm2: g.float(0.1, 1) }));
	const objects: DemandObject[] = [];
	if (g.bool(0.3)) objects.push(town('S', flat(g.float(0, 400))));
	const nD = g.int(1, 4);
	const dIds: string[] = [];
	for (let k = 0; k < nD; k++) {
		const id = `D${k}`;
		dIds.push(id);
		const dam = g.bool(0.4);
		const fixed = dam && h.bool(0.5) ? { damReleaseRule: 'fixed' as const, damReleaseM3Day: Array.from({ length: 12 }, () => h.pick([0, h.float(0, 800)])), damMinPct: h.pick([0, h.frac()]), damOutletCapacityM3Day: h.pick([null, h.float(0, 500)]) } : {};
		nodes.push(farm(id, dam ? { damCapacityM3: g.float(10, 2000), damInitialPct: g.frac(), ...fixed } : {}));
		if (g.bool(0.6)) objects.push(town(id, Array.from({ length: 12 }, () => (g.bool(0.15) ? 0 : g.float(0, 900)))));
	}
	const shared = g.float(0, 1500);
	const nR = g.int(1, 6);
	const transfers: Transfer[] = [];
	for (let k = 0; k < nR; k++) {
		const from = hasT && g.bool(0.25) ? 'T' : 'S';
		const loss = g.bool(0.5) ? 0 : g.float(0, 0.6);
		const rate = g.bool(0.3)
			? { dailyCapM3: g.bool(0.5) ? null : g.float(0, 2000), ...withMonthlyRates(Array.from({ length: 12 }, () => (g.bool(0.3) ? 0 : g.float(0, 0.03)))) }
			: { dailyCapM3: g.pick([0, g.float(0, 2000), g.float(0, 2000)]) };
		transfers.push(
			ot(`r${String.fromCharCode(97 + ((k * 7 + seed) % 26))}${k}`, from, g.pick(dIds), 0, {
				...rate,
				priority: g.pick([0, 0, 0, 1, 2, -1]),
				handsOffM3Day: g.pick([null, 0, shared, shared, g.float(0, 2000)]),
				handsOffEwr: g.bool(0.3),
				lossPct: loss,
				...(loss > 0 && g.bool(0.5) ? { lossReturnPct: g.frac() } : {}),
				sizing: g.pick(['demand', 'capacity'] as const),
				topUpDam: g.bool(0.4)
			})
		);
	}
	const days = 24;
	const natural = Array.from({ length: days }, () => (g.bool(0.15) ? 0 : g.bool(0.2) ? g.float(0, 300) : g.float(0, 4000)));
	const input = build({ nodes, transfers, objects, ewr: g.pick([0, 0, g.float(0, 1200)]), start: '2021-09-19', days });
	return { input, natural };
}

/** Rule-days the replay met a pass-inflow target as a keep, and a fixed release floor in a top-up's room (engine ≥ 1.70.0). */
const reached = { target: 0, floor: 0, oldCap: 0 };

/** Replay each day of a run with refShare and the §2.6a destination split; returns the first mismatch. */
function replay(input: ModelInput, out: ModelOutput): string | null {
	const days = out.days;
	const d0 = toEpochDay(out.startDate);
	const rules = input.model.transfers.filter((tr) => tr.enabled && tr.source === 'river');
	const nodes = new Map(input.model.nodes.map((n) => [n.id, n]));
	const s = (id: string, key: string) => opt(out, id, key, days);
	const capOf = (tr: Transfer, m: number) => {
		const wi = (m + 2) % 12;
		const rate = tr.monthlyRateM3s ? tr.monthlyRateM3s[wi]! : tr.months.includes(m) ? tr.maxRateM3s : 0;
		const c = rate * 86400;
		return tr.dailyCapM3 === null || tr.dailyCapM3 === undefined ? c : Math.min(c, tr.dailyCapM3);
	};
	for (let t = 0; t < days; t++) {
		const m = monthOfEpochDay(d0 + t);
		// Each demand-sized rule's share of its destination's need (fixed before the day).
		const need = new Map<string, number>();
		const capInto = new Map<string, number>();
		for (const tr of rules) if (tr.sizing === 'demand') capInto.set(tr.toNodeId, (capInto.get(tr.toNodeId) ?? 0) + capOf(tr, m));
		for (const tr of rules) {
			if (tr.sizing !== 'demand') continue;
			const cap = capOf(tr, m);
			if (!(cap > 0)) continue;
			const dst = nodes.get(tr.toNodeId)!;
			let n = s(dst.id, 'demand')[t]!;
			if (tr.topUpDam && dst.damCapacityM3 > 0) {
				// No rain, evaporation, seepage or dam rules here: the dam holds yesterday's storage.
				const q = t === 0 ? dst.damInitialPct * dst.damCapacityM3 : s(dst.id, 'dam_storage')[t - 1]!;
				// Engine ≥ 1.70.0 (Q26): + a fixed release's MIN(amount, outlet), in full.
				const floor = dst.damReleaseRule === 'fixed' ? Math.max(0, Math.min(dst.damReleaseM3Day![(m + 2) % 12]!, dst.damOutletCapacityM3Day ?? Infinity)) : 0;
				if (floor > 0) reached.floor++;
				n += Math.max(0, dst.damCapacityM3 - q + floor);
			}
			need.set(tr.id, (n * cap) / capInto.get(tr.toNodeId)!);
		}
		for (const src of new Set(rules.map((r) => r.fromNodeId))) {
			const mine = rules.filter((r) => r.fromNodeId === src);
			const U0 = s(src, 'outflow')[t]! - s(src, 'offtake_loss_return')[t]! + s(src, 'offtake_out')[t]!;
			const Zs = s(src, 'senior_requirement')[t]!;
			const Z = s(src, 'ewr_cumulative')[t]!;
			// Engine ≥ 1.70.0 (Q27): a pass-inflow release's target at the source is kept too (its amount, or Z without).
			const sn = nodes.get(src)!;
			const target = sn.damReleaseRule === 'passInflow' ? (sn.damReleaseM3Day ? sn.damReleaseM3Day[(m + 2) % 12]! : Z) : 0;
			if (target > Zs && mine.some((tr) => target > (tr.handsOffM3Day ?? 0) && !(tr.handsOffEwr && Z >= target))) reached.target++;
			const spec = mine.map((tr) => {
				const cap = capOf(tr, m);
				const l = tr.lossPct ?? 0;
				return {
					id: tr.id,
					priority: tr.priority,
					cap,
					keep: Math.max(Zs, target, tr.handsOffM3Day ?? 0, tr.handsOffEwr ? Z : 0),
					limit: tr.sizing === 'demand' ? Math.min(cap, (need.get(tr.id) ?? 0) / (1 - l)) : cap
				};
			});
			const ref = refShare(spec, U0);
			const old = refShare(spec, U0, true);
			for (const tr of mine) {
				const v = s(src, `transfer_rule@${tr.id}`)[t]!;
				const want = ref.get(tr.id)!;
				if (Math.abs(old.get(tr.id)! - want) > 1e-6 * Math.max(1, U0)) reached.oldCap++;
				if (Math.abs(v - want) > 1e-9 * Math.max(1, U0)) return `day ${t} ${src} rule ${tr.id}: engine ${v}, documented ${want} (U0 ${U0}, Zs ${Zs}, Z ${Z})`;
			}
		}
		// Destinations: in = Σ v(1 − l) in rule-id order, exactly; used = MIN(in, D); the top-up share into the dam.
		for (const dst of new Set(rules.map((r) => r.toNodeId))) {
			const into = rules.filter((r) => r.toNodeId === dst).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			let xin = 0;
			let xdam = 0;
			for (const tr of into) {
				const got = s(tr.fromNodeId, `transfer_rule@${tr.id}`)[t]! * (1 - (tr.lossPct ?? 0));
				xin += got;
				if (tr.topUpDam) xdam += got;
			}
			const eng = s(dst, 'offtake_in')[t]!;
			if (eng !== xin) return `day ${t} ${dst}: offtake_in ${eng} ≠ Σ v(1 − l) in id order ${xin}`;
			const D = s(dst, 'demand')[t]!;
			const used = Math.min(xin, D);
			const rest = xin - used;
			const toDam = rest > 0 && xdam > 0 ? (rest * xdam) / xin : 0;
			if (Math.abs(s(dst, 'offtake_used')[t]! - used) > 1e-9 * Math.max(1, xin)) return `day ${t} ${dst}: offtake_used ${s(dst, 'offtake_used')[t]} ≠ MIN(in, D) ${used}`;
			if (Math.abs(s(dst, 'offtake_to_dam')[t]! - toDam) > 1e-9 * Math.max(1, xin)) return `day ${t} ${dst}: offtake_to_dam ${s(dst, 'offtake_to_dam')[t]} ≠ ${toDam}`;
		}
	}
	return null;
}

/** A source's pass-inflow release target on day t (§2.7e; kept by its off-takes, engine ≥ 1.70.0); 0 without one. */
function releaseTarget(input: ModelInput, out: ModelOutput, src: string, t: number, Z: number): number {
	const n = input.model.nodes.find((x) => x.id === src)!;
	if (n.damReleaseRule !== 'passInflow') return 0;
	return n.damReleaseM3Day ? n.damReleaseM3Day[(monthOfEpochDay(toEpochDay(out.startDate) + t) + 2) % 12]! : Z;
}

/** Days × sources where two rules of one priority with different keeps both took water. */
function bandDays(input: ModelInput, out: ModelOutput): number {
	const rules = input.model.transfers.filter((tr) => tr.source === 'river');
	let n = 0;
	for (let t = 0; t < out.days; t++)
		for (const src of new Set(rules.map((r) => r.fromNodeId))) {
			const Zs = opt(out, src, 'senior_requirement', out.days)[t]!;
			const Z = opt(out, src, 'ewr_cumulative', out.days)[t]!;
			const on = rules.filter((r) => r.fromNodeId === src && opt(out, src, `transfer_rule@${r.id}`, out.days)[t]! > 0);
			for (const p of new Set(on.map((r) => r.priority))) {
				const rt = releaseTarget(input, out, src, t, Z);
				const keeps = new Set(on.filter((r) => r.priority === p).map((r) => Math.max(Zs, rt, r.handsOffM3Day ?? 0, r.handsOffEwr ? Z : 0)));
				if (keeps.size > 1) n++;
			}
		}
	return n;
}

const SEEDS = Array.from({ length: 300 }, (_, k) => 9100 + k);

describe('deep: random networks against the documented off-take sharing (§2.6a)', () => {
	it('every rule, every day, matches the re-derivation; the run’s self-checks pass', () => {
		const bad: string[] = [];
		let active = 0;
		let multiBand = 0;
		for (const seed of SEEDS) {
			const { input, natural } = randomCase(seed);
			const out = run(input, natural);
			const why = replay(input, out);
			if (why) bad.push(`seed ${seed}: ${why}`);
			if (!out.summary.verification?.passed) bad.push(`seed ${seed}: self-check ${JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed).map((c) => c.detail))}`);
			for (const x of out.series) if (x.key.startsWith('transfer_rule@') && x.values.some((v) => v > 0)) active++;
			multiBand += bandDays(input, out);
			if (bad.length > 5) break;
		}
		expect(bad).toEqual([]);
		// The generator exercises the code: hundreds of rules take water somewhere.
		expect(active).toBeGreaterThan(300);
		// …and days where rules of one priority with different keeps both took water (more than one band).
		expect(multiBand).toBeGreaterThan(200);
		// …and the engine ≥ 1.70.0 terms: a source's pass-inflow target above the senior requirement and some rule's own
		// keep (444 source-days at writing), and a fixed release floor in a top-up's room (55 rule-days).
		expect(reached.target).toBeGreaterThan(100);
		expect(reached.floor).toBeGreaterThan(15);
		// …and the replay would catch the rule before 1.70.0 (each ask capped at the flow above its keep): rule-days
		// where that rule gives another volume.
		expect(reached.oldCap).toBeGreaterThan(50);
	});

	it('no rule takes the river below its own keep: the rules of a priority keeping ≥ k take ≤ U₀ − taken earlier − k', () => {
		for (const seed of SEEDS.slice(0, 150)) {
			const { input, natural } = randomCase(seed);
			const out = raw(input, natural);
			const days = out.days;
			const rules = input.model.transfers.filter((tr) => tr.source === 'river');
			for (let t = 0; t < days; t++) {
				for (const src of new Set(rules.map((r) => r.fromNodeId))) {
					const mine = rules.filter((r) => r.fromNodeId === src);
					const v = (id: string) => opt(out, src, `transfer_rule@${id}`, days)[t]!;
					const U0 = opt(out, src, 'outflow', days)[t]! - opt(out, src, 'offtake_loss_return', days)[t]! + opt(out, src, 'offtake_out', days)[t]!;
					const Zs = opt(out, src, 'senior_requirement', days)[t]!;
					const Z = opt(out, src, 'ewr_cumulative', days)[t]!;
					const rt = releaseTarget(input, out, src, t, Z);
					const keep = (tr: Transfer) => Math.max(Zs, rt, tr.handsOffM3Day ?? 0, tr.handsOffEwr ? Z : 0);
					for (const r of mine) {
						if (!(v(r.id) > 0)) continue;
						const earlier = mine.filter((x) => x.priority < r.priority).reduce((a, x) => a + v(x.id), 0);
						const above = mine.filter((x) => x.priority === r.priority && keep(x) >= keep(r)).reduce((a, x) => a + v(x.id), 0);
						expect(above, `seed ${seed} day ${t} rule ${r.id}`).toBeLessThanOrEqual(Math.max(0, U0 - earlier - keep(r)) + 1e-9 * Math.max(1, U0));
					}
				}
			}
		}
	});

	it('listing order never matters, to the bit (every series)', () => {
		for (const seed of SEEDS.slice(0, 60)) {
			const { input, natural } = randomCase(seed);
			const a = raw(input, natural);
			const b = raw(scrambleOrder(input, seed * 31 + 7), natural);
			const m = new Map(b.series.map((x) => [`${x.nodeId}/${x.key}`, x.values]));
			for (const x of a.series) expect(m.get(`${x.nodeId}/${x.key}`), `seed ${seed}: ${x.nodeId}/${x.key}`).toEqual(x.values);
		}
	});

	it('adding a sibling never raises another rule’s take (more claimants in every band)', () => {
		for (const seed of SEEDS.slice(0, 80)) {
			const { input, natural } = randomCase(seed);
			const g = new Rng(seed ^ 0x5bd1e995);
			const src = input.model.transfers[0]!;
			const sib = ot('zz-sibling', src.fromNodeId, src.toNodeId, g.float(1, 1500), { priority: src.priority, handsOffM3Day: g.pick([null, g.float(0, 1500)]) });
			const withSib: ModelInput = { ...input, model: { ...input.model, transfers: [...input.model.transfers, sib] } };
			// Only capacity-sized rules into other units are free of the need split the sibling would change.
			const a = raw(input, natural);
			const b = raw(withSib, natural);
			for (const tr of input.model.transfers) {
				if (tr.priority !== src.priority || tr.fromNodeId !== src.fromNodeId || tr.sizing === 'demand') continue;
				const va = opt(a, tr.fromNodeId, `transfer_rule@${tr.id}`, a.days);
				const vb = opt(b, tr.fromNodeId, `transfer_rule@${tr.id}`, b.days);
				// Only on days whose lower priorities took the same (the sibling doesn't move them).
				for (let t = 0; t < a.days; t++) {
					const same = input.model.transfers.filter((x) => x.fromNodeId === src.fromNodeId && x.priority < src.priority).every((x) => opt(a, x.fromNodeId, `transfer_rule@${x.id}`, a.days)[t] === opt(b, x.fromNodeId, `transfer_rule@${x.id}`, b.days)[t]);
					if (same && opt(a, src.fromNodeId, 'outflow', a.days)[t]! + opt(a, src.fromNodeId, 'offtake_out', a.days)[t]! - opt(a, src.fromNodeId, 'offtake_loss_return', a.days)[t]! === opt(b, src.fromNodeId, 'outflow', b.days)[t]! + opt(b, src.fromNodeId, 'offtake_out', b.days)[t]! - opt(b, src.fromNodeId, 'offtake_loss_return', b.days)[t]!)
						expect(vb[t]!, `seed ${seed} day ${t} rule ${tr.id}`).toBeLessThanOrEqual(va[t]! + 1e-9 * Math.max(1, va[t]!));
				}
			}
		}
	});

	it('linear in the volumes: doubling every flow, capacity, keep, demand and dam doubles every off-take volume (×2 is exact in binary)', () => {
		const dbl = (v: number | null | undefined) => (typeof v === 'number' ? v * 2 : v);
		let compared = 0;
		for (const seed of SEEDS.slice(0, 120)) {
			const { input, natural } = randomCase(seed);
			const x = JSON.parse(JSON.stringify(input)) as ModelInput;
			x.settings.ewrPragmaticM3PerDay = x.settings.ewrPragmaticM3PerDay!.map((v) => v * 2) as unknown as Monthly;
			for (const n of x.model.nodes) {
				n.damCapacityM3 *= 2;
				// Release amounts and outlets (engine ≥ 1.70.0's Q26/Q27 cases) are volumes too.
				if (n.damReleaseM3Day) n.damReleaseM3Day = n.damReleaseM3Day.map((v) => v * 2);
				n.damOutletCapacityM3Day = dbl(n.damOutletCapacityM3Day) ?? null;
				if (n.userDemandM3Day) n.userDemandM3Day = n.userDemandM3Day.map((v) => v * 2);
			}
			for (const o of x.model.demandObjects ?? []) o.monthlyM3Day = o.monthlyM3Day!.map((v) => v * 2);
			for (const tr of x.model.transfers) {
				tr.dailyCapM3 = dbl(tr.dailyCapM3) ?? null;
				tr.maxRateM3s *= 2;
				if (tr.monthlyRateM3s) tr.monthlyRateM3s = tr.monthlyRateM3s.map((v) => v * 2);
				tr.handsOffM3Day = dbl(tr.handsOffM3Day) ?? null;
			}
			const a = raw(input, natural);
			const b = raw(x, natural.map((v) => v * 2));
			const m = new Map(b.series.map((y) => [`${y.nodeId}/${y.key}`, y.values]));
			for (const y of a.series) {
				if (!/^(transfer_rule@|offtake_)/.test(y.key)) continue;
				const twice = m.get(`${y.nodeId}/${y.key}`)!;
				y.values.forEach((v, t) => expect(twice[t], `seed ${seed} ${y.nodeId}/${y.key} day ${t}`).toBeCloseTo(2 * v, 9));
				compared++;
			}
		}
		expect(compared).toBeGreaterThan(300);
	});
});
