// River off-takes (engine ≥ 1.14.0, issue #54, docs/model.md §2.6a): a
// transfer rule with `source: 'river'` takes water from the river's flow as it
// leaves the source unit today (after that unit's own use, returns and spill),
// not from the source's dam, and carries it to the destination unit. There it
// meets the unit's demand first, then (with `topUpDam`) fills its dam, and the
// rest flows on down the destination's river. It is limited by its capacity
// (MIN(max rate × 86 400, daily cap), and the month's own capacity when one is
// set), by the flow there, and by what must stay in the river: the senior
// users' requirement passing the source, the target of a pass-inflow
// release on the source's dam (engine ≥ 1.70.0), a hands-off flow and, when
// asked, the EWR at the source. A share of what it takes (conveyance losses) never
// arrives; a share of those losses may seep back to the river the same day
// below the source or a farm downstream of it (engine ≥ 1.42.0). Pure; the plan (../run.ts), the simulation (./simulate.ts) and the
// self-checks (../verify/checks.ts) read a rule through these functions, so a
// stored rule means the same thing to each.
import { cmpStr } from '../order';
import { DIVERSION_FLOW_BASES, DIVERSION_FLOW_UNIT_M3_DAY, DIVERSION_FLOW_UNITS, type DiversionFlowUnit, type MonthDiversion, type NetworkNode, type Transfer } from '../project';
import { transferDailyLimit, WATER_YEAR_MONTHS } from './transferRates';
import type { TransferPiece } from './transferSplits';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The run series a river off-take leaves (engine ≥ 1.14.0): on the source,
 * what the off-takes took from the flow leaving it (and each rule's own
 * volume under `transfer_rule@<rule id>`, ./transferSeries.ts); on the
 * destination, what arrived, and of it what met the demand directly and what
 * went into the dam (the rest flowed on).
 */
export const OFFTAKE_SERIES = {
	out: { key: 'offtake_out', label: 'Taken by river off-takes from the flow leaving this unit (before conveyance losses)' },
	in: { key: 'offtake_in', label: 'Delivered by river off-takes into this unit (after conveyance losses)' },
	used: { key: 'offtake_used', label: 'River off-take water that met the demand directly (part of supplied)' },
	toDam: { key: 'offtake_to_dam', label: 'River off-take water that went into the dam' },
	/** On the unit the returned seepage rejoins below (engine ≥ 1.42.0): part of its outflow. */
	returned: { key: 'offtake_loss_return', label: 'River off-takes’ conveyance losses seeping back to the river below this unit (part of the outflow)' },
	rule: (toName: string) => `Taken from the river for ${toName} by one off-take (before conveyance losses)`
} as const;

/** A river off-take as the simulation runs it. */
export interface PlanOfftake {
	/** The rule's id. */
	id: string;
	/** The run series key of the volume it takes (`transfer_rule@<rule id>`, ./transferSeries.ts); absent for a rule that can never take water. */
	seriesKey?: string;
	/** Source and destination node indices (both farms). */
	from: number;
	to: number;
	/** Capacity today by calendar month (index 1–12, m³/day); 0 in a month the rule doesn't run. */
	capM3Day: Float64Array;
	/** Hands-off flow left below the source (m³/day), 0 = none. */
	handsOffM3Day: number;
	/** Also leave the EWR at the source (its cumulative requirement Z). */
	handsOffEwr: boolean;
	/** Conveyance loss share, 0 ≤ l < 1. */
	loss: number;
	/** Share of the losses that seeps back to the river the same day, 0 ≤ r ≤ 1 (engine ≥ 1.42.0); 0 = all lost. */
	lossReturn: number;
	/** Node index of the farm whose outflow the returned seepage joins: the source or one downstream of it along the river. */
	returnAt: number;
	/** 0 = sized to the destination's need, 1 = up to capacity, 2 = a share of the river's flow (engine ≥ 1.113.0). */
	sizing: 0 | 1 | 2;
	/**
	 * sizing 2: the curve that sets the share in each calendar month (index
	 * 1–12; engine ≥ 1.114.0 a month may have its own, or none: null, a month
	 * that takes up to capacity as sizing 1). null on any other sizing, or when
	 * a curve is incomplete (the rule then takes nothing).
	 */
	curves: (DiversionCurve | null)[] | null;
	/**
	 * A piece of a split rule (engine ≥ 1.114.0, ./transferSplits.ts): the
	 * rule's id and this destination's share. Sized to the need, the pieces of
	 * one rule ask their share of the sum of their destinations' needs, so the
	 * split holds; null for a rule with one destination.
	 */
	split: { of: string; pct: number } | null;
	topUpDam: boolean;
	/** Lower takes first at its source; equal priorities share the flow pro rata to their limits. */
	priority: number;
}

/**
 * A diversion-curve off-take's curve (engine ≥ 1.113.0, docs/model.md §2.6a): it
 * diverts `a · x^b` percent of the river's flow at the off-take, at most
 * `maxShare` of it, x read in the unit `m3DayPerUnit` m³/day make one of.
 */
export interface DiversionCurve {
	a: number;
	b: number;
	/** The most of the flow it diverts, 0 < m ≤ 1. */
	maxShare: number;
	/** m³/day in one of the curve's flow unit (DIVERSION_FLOW_UNIT_M3_DAY). */
	m3DayPerUnit: number;
	/** x is the natural flow at the off-take (true) or the modelled river there (false, the default). */
	natural: boolean;
}

/**
 * The share 0 ≤ s ≤ maxShare of the river's flow a diversion-curve off-take
 * diverts when the flow its curve reads is `xM3Day`: MIN(maxShare, a · x^b ÷
 * 100), x in the curve's unit. No flow (x ≤ 0, or not a number) diverts
 * nothing; with b < 0 the share grows without bound as x → 0 and the cap
 * holds it (x^b is +∞ at a flow that underflows, still capped). Pure.
 */
export function diversionShareOf(c: DiversionCurve, xM3Day: number): number {
	if (!(xM3Day > 0)) return 0;
	const s = (c.a * Math.pow(xM3Day / c.m3DayPerUnit, c.b)) / 100;
	return s > 0 ? Math.min(c.maxShare, s) : 0;
}

/**
 * What a diversion-curve off-take wants from the river today (m³/day, before its
 * capacity, keeps and losses): its share of the modelled flow `riverM3Day` at
 * the off-take, the share read at `basisM3Day` (the same flow, or the natural
 * flow there). Never more than `riverM3Day`: the share is at most 1. Pure.
 */
export function diversionWant(c: DiversionCurve, riverM3Day: number, basisM3Day: number): number {
	if (!(riverM3Day > 0)) return 0;
	return diversionShareOf(c, basisM3Day) * riverM3Day;
}

/**
 * Why a rule's diversion curve can't run, or null when it can (engine ≥
 * 1.113.0): a > 0, b finite, the cap 0 < m ≤ 1 (absent = 1), a known unit and
 * basis (absent basis = modelled). Shared by the run (./offtake.ts offtakeOf)
 * and the save (../modelRules.ts), so both refuse the same rules.
 */
export function diversionCurveProblem(tr: Pick<Transfer, 'diversionCoefficient' | 'diversionExponent' | 'diversionMaxPct' | 'diversionFlowUnit' | 'diversionFlowBasis'>): string | null {
	const a = tr.diversionCoefficient;
	if (!(finite(a) && a > 0)) return 'its coefficient a must be a number above 0';
	if (!finite(tr.diversionExponent)) return 'its exponent b must be a number';
	const m = tr.diversionMaxPct ?? 1;
	if (!(finite(m) && m > 0 && m <= 1)) return 'its largest share must be above 0 % and at most 100 %';
	if (!(DIVERSION_FLOW_UNITS as readonly unknown[]).includes(tr.diversionFlowUnit)) return `its flow unit must be one of ${DIVERSION_FLOW_UNITS.join(', ')}`;
	if (tr.diversionFlowBasis != null && !(DIVERSION_FLOW_BASES as readonly unknown[]).includes(tr.diversionFlowBasis)) return `the flow it reads must be one of ${DIVERSION_FLOW_BASES.join(', ')}`;
	return null;
}

/** The curve a valid diversion-curve rule runs with (diversionCurveProblem null first). */
export function diversionCurveOf(tr: Pick<Transfer, 'diversionCoefficient' | 'diversionExponent' | 'diversionMaxPct' | 'diversionFlowUnit' | 'diversionFlowBasis'>): DiversionCurve {
	return {
		a: tr.diversionCoefficient!,
		b: tr.diversionExponent!,
		maxShare: tr.diversionMaxPct ?? 1,
		m3DayPerUnit: DIVERSION_FLOW_UNIT_M3_DAY[tr.diversionFlowUnit as DiversionFlowUnit],
		natural: tr.diversionFlowBasis === 'natural'
	};
}

type CurveFields = Pick<Transfer, 'sizing' | 'monthlyDiversion' | 'diversionCoefficient' | 'diversionExponent' | 'diversionMaxPct' | 'diversionFlowUnit' | 'diversionFlowBasis'>;

/** Whether the rule has a curve per month (engine ≥ 1.114.0): a `monthlyDiversion` list. */
export const hasMonthlyDiversion = (tr: Pick<Transfer, 'monthlyDiversion'>): boolean => Array.isArray(tr.monthlyDiversion);

/**
 * A rule's curve in each water-year month (Oct–Sep), or null in a month that
 * takes up to its rate (engine ≥ 1.114.0, docs/model.md §2.6a *A maximum or a
 * formula by month*): its monthly list when it has one; else, sized by a
 * curve, its one curve in every month (engine 1.113.0); else null in every
 * month. What the Transfers tab shows and edits.
 */
export function diversionMonthsOf(tr: CurveFields): (MonthDiversion | null)[] {
	if (Array.isArray(tr.monthlyDiversion)) return WATER_YEAR_MONTHS.map((_, k) => {
		const m = tr.monthlyDiversion![k];
		return m ? { coefficient: m.coefficient, exponent: m.exponent, maxPct: m.maxPct ?? null } : null;
	});
	if (tr.sizing !== 'diversionCurve') return WATER_YEAR_MONTHS.map(() => null);
	const one = tr.diversionCoefficient == null && tr.diversionExponent == null ? null : { coefficient: tr.diversionCoefficient as number, exponent: tr.diversionExponent as number, maxPct: tr.diversionMaxPct ?? null };
	return WATER_YEAR_MONTHS.map(() => (one ? { ...one } : null));
}

/**
 * The fields a river rule taking up to a maximum or by a formula, month by
 * month, stores (engine ≥ 1.114.0): sized by a curve with the monthly list
 * when any month has a formula (the one-curve fields null), else sized to
 * capacity with no list. What the Transfers tab writes.
 */
export function withMonthlyDiversion(list: readonly (MonthDiversion | null)[]): Pick<Transfer, 'sizing' | 'monthlyDiversion' | 'diversionCoefficient' | 'diversionExponent' | 'diversionMaxPct'> {
	if (list.length !== 12) throw new Error('a curve by month needs twelve entries, Oct–Sep');
	const any = list.some((m) => m !== null);
	return {
		sizing: any ? 'diversionCurve' : 'capacity',
		monthlyDiversion: any ? list.map((m) => (m ? { coefficient: m.coefficient, exponent: m.exponent, maxPct: m.maxPct ?? null } : null)) : null,
		diversionCoefficient: null,
		diversionExponent: null,
		diversionMaxPct: null
	};
}

/**
 * Why a rule sized by a curve can't run, or null when it can (engine ≥
 * 1.114.0 checks each month's curve): with a monthly list, twelve entries,
 * at least one a curve, each curve complete (diversionCurveProblem), and the
 * one-curve fields null; without one, its one curve. The unit and basis are
 * the rule's, for every month.
 */
export function diversionMonthsProblem(tr: CurveFields): string | null {
	if (!Array.isArray(tr.monthlyDiversion)) return diversionCurveProblem(tr);
	const list = tr.monthlyDiversion;
	if (list.length !== 12) return 'its curves by month must be twelve entries, Oct–Sep';
	if (!list.some((m) => m)) return 'no month has a formula';
	if (tr.diversionCoefficient != null || tr.diversionExponent != null || tr.diversionMaxPct != null) return 'with a curve by month its one curve (a, b and largest share) must be empty';
	for (const [k, m] of list.entries()) {
		if (m === null) continue;
		if (!m || typeof m !== 'object') return `its curve in month ${k + 1} of the water year must be a, b and a largest share, or none`;
		const p = diversionCurveProblem({ diversionCoefficient: m.coefficient, diversionExponent: m.exponent, diversionMaxPct: m.maxPct, diversionFlowUnit: tr.diversionFlowUnit, diversionFlowBasis: tr.diversionFlowBasis });
		if (p) return `in ${MONTH_NAMES[WATER_YEAR_MONTHS[k]!]!} ${p}`;
	}
	return null;
}

const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The curves a valid curve rule runs with, by calendar month (index 1–12; diversionMonthsProblem null first). */
export function diversionCurvesOf(tr: CurveFields): (DiversionCurve | null)[] {
	const out: (DiversionCurve | null)[] = new Array<DiversionCurve | null>(13).fill(null);
	diversionMonthsOf(tr).forEach((m, k) => {
		if (m) out[WATER_YEAR_MONTHS[k]!] = diversionCurveOf({ diversionCoefficient: m.coefficient, diversionExponent: m.exponent, diversionMaxPct: m.maxPct, diversionFlowUnit: tr.diversionFlowUnit, diversionFlowBasis: tr.diversionFlowBasis });
	});
	return out;
}

/** Is this rule a river off-take? */
export const isRiverOfftake = (tr: Pick<Transfer, 'source'>): boolean => tr.source === 'river';

/**
 * The river off-take a rule runs as, or why it can't run. Its ends must be two
 * different farms (checked by the caller, as for a dam transfer). Values out
 * of range run clamped with a warning: a loss outside [0, 1) as 0, a hands-off
 * flow that isn't a number ≥ 0 as none.
 */
export function offtakeOf(tr: Transfer, from: number, to: number, fromName: string, toName: string, warnings: string[]): Omit<PlanOfftake, 'seriesKey' | 'id'> {
	const who = `river off-take ${fromName} → ${toName}`;
	let loss = tr.lossPct ?? 0;
	if (!(finite(loss) && loss >= 0 && loss < 1)) {
		warnings.push(`${who}: conveyance loss ${String(loss)} is outside [0, 1); using 0`);
		loss = 0;
	}
	let handsOff = tr.handsOffM3Day ?? 0;
	if (!(finite(handsOff) && handsOff >= 0)) {
		warnings.push(`${who}: hands-off flow ${String(handsOff)} m³/day is not a size ≥ 0; none`);
		handsOff = 0;
	}
	let lossReturn = tr.lossReturnPct ?? 0;
	if (!(finite(lossReturn) && lossReturn >= 0 && lossReturn <= 1)) {
		warnings.push(`${who}: share of the conveyance losses returning ${String(lossReturn)} is outside [0, 1]; none returns`);
		lossReturn = 0;
	}
	const sizing = tr.sizing === 'capacity' ? 1 : tr.sizing === 'diversionCurve' ? 2 : 0;
	if (tr.sizing !== undefined && tr.sizing !== 'capacity' && tr.sizing !== 'demand' && tr.sizing !== 'diversionCurve') warnings.push(`${who}: unknown sizing "${String(tr.sizing)}"; sized to the destination's need`);
	// A share of the river's flow (engine ≥ 1.113.0; a curve per month, engine ≥ 1.114.0): a rule whose curve is
	// incomplete takes nothing, with a warning (the API refuses one on save, modelRules).
	let curves: (DiversionCurve | null)[] | null = null;
	if (sizing === 2) {
		const problem = diversionMonthsProblem(tr);
		if (problem) warnings.push(`${who}: sized by a diversion curve, but ${problem}; it takes nothing`);
		else curves = diversionCurvesOf(tr);
	}
	const piece = tr as Partial<TransferPiece>;
	return {
		from,
		to,
		capM3Day: transferDailyLimit(tr),
		handsOffM3Day: handsOff,
		handsOffEwr: tr.handsOffEwr === true,
		loss,
		lossReturn: loss > 0 ? lossReturn : 0,
		returnAt: from,
		sizing,
		curves,
		split: typeof piece.splitOf === 'string' && finite(piece.splitPct) ? { of: piece.splitOf, pct: piece.splitPct } : null,
		topUpDam: tr.topUpDam === true,
		priority: Number.isFinite(tr.priority) ? tr.priority : 0
	};
}

/**
 * Can `target` be reached from `start` going downstream along the river or
 * along an accepted off-take (from → to)? An off-take whose destination
 * reaches its own source this way would need the destination's flow before
 * the source's, which a same-day off-take can't have.
 */
export function reaches(start: number, target: number, downstream: Int32Array, extra: readonly (readonly number[])[]): boolean {
	const seen = new Uint8Array(downstream.length);
	const stack = [start];
	while (stack.length) {
		const i = stack.pop()!;
		if (i === target) return true;
		if (seen[i]) continue;
		seen[i] = 1;
		if (downstream[i]! >= 0) stack.push(downstream[i]!);
		for (const j of extra[i]!) stack.push(j);
	}
	return false;
}

/**
 * Where a river off-take's returned seepage rejoins the river (engine ≥
 * 1.42.0): the node index of `tr.lossReturnNodeId`, or `from` when it is
 * null / absent. Only the source or a farm downstream of it along the river
 * qualifies: the seepage reaches the river below the off-take, and a unit
 * below the source is simulated after it, so the day's losses are known when
 * the return joins its outflow. Otherwise undefined (the caller returns none).
 */
export function offtakeReturnAt(
	tr: Pick<Transfer, 'lossReturnNodeId'>,
	from: number,
	nodes: readonly Pick<NetworkNode, 'id' | 'kind' | 'downstreamNodeId'>[],
	index: ReadonlyMap<string, number> = new Map(nodes.map((n, i) => [n.id, i]))
): number | undefined {
	const id = tr.lossReturnNodeId;
	if (id === null || id === undefined) return from;
	const at = index.get(id);
	if (at === undefined || nodes[at]!.kind !== 'farm') return undefined;
	const seen = new Set<number>();
	for (let i: number | undefined = from; i !== undefined && !seen.has(i); ) {
		if (i === at) return at;
		seen.add(i);
		const down: string | null = nodes[i]!.downstreamNodeId;
		i = down === null ? undefined : index.get(down);
	}
	return undefined;
}

/**
 * The river off-takes a model runs, from its enabled `source: 'river'` rules
 * in id order. Skipped with a warning: an end that doesn't exist or isn't a
 * farm, a rule from a unit to itself, and one whose destination drains into
 * its source (directly, or through the river off-takes accepted before it),
 * since the destination is simulated after its source each day. A return
 * unit that isn't the source or a farm below it returns nothing, with a
 * warning (engine ≥ 1.42.0).
 */
export function planOfftakes(
	transfers: readonly Transfer[],
	nodes: readonly Pick<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId'>[],
	warnings: string[],
	seriesKey: (tr: Transfer) => string | undefined
): PlanOfftake[] {
	const rules = transfers.filter((tr) => tr.enabled && isRiverOfftake(tr)).sort((a, b) => cmpStr(a.id, b.id));
	if (!rules.length) return [];
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const downstream = Int32Array.from(nodes, (n) => (n.downstreamNodeId === null ? -1 : (index.get(n.downstreamNodeId) ?? -1)));
	const extra: number[][] = nodes.map(() => []);
	const out: PlanOfftake[] = [];
	for (const tr of rules) {
		const from = index.get(tr.fromNodeId);
		// A river off-take can't send water out of the catchment (engine ≥ 1.86.0, modelRules refuses one on save).
		if (tr.toNodeId === null) {
			warnings.push(`river off-take ${tr.id} has no unit to deliver to (outside the catchment); skipped. Only a dam transfer can send water out of the catchment`);
			continue;
		}
		const to = index.get(tr.toNodeId);
		if (from === undefined || to === undefined) {
			warnings.push(`river off-take ${tr.id} references a hydrological unit that does not exist; skipped`);
			continue;
		}
		const a = nodes[from]!;
		const b = nodes[to]!;
		if (a.kind !== 'farm' || b.kind !== 'farm' || from === to) {
			warnings.push(`river off-take ${a.name} → ${b.name}: an off-take runs from one unit to another; skipped`);
			continue;
		}
		if (reaches(to, from, downstream, extra)) {
			warnings.push(`river off-take ${a.name} → ${b.name}: its destination drains into its source, so the water would be taken before it arrives; skipped`);
			continue;
		}
		extra[from]!.push(to);
		const key = seriesKey(tr);
		const o = offtakeOf(tr, from, to, a.name, b.name, warnings);
		if (o.lossReturn > 0) {
			const at = offtakeReturnAt(tr, from, nodes, index);
			if (at === undefined) {
				warnings.push(`river off-take ${a.name} → ${b.name}: its seepage return unit is not ${a.name} or a unit below it on the river; no seepage returns`);
				o.lossReturn = 0;
			} else o.returnAt = at;
		}
		out.push({ id: tr.id, ...(key ? { seriesKey: key } : {}), ...o });
	}
	splitLicenceWarnings(out, nodes, warnings);
	return out;
}

/**
 * Warn about rules that may be one licence entered more than once (engine ≥
 * 1.70.0, issue #90 Q25): two or more planned river off-takes with the same
 * source, the same destination and the same priority, of which at least two
 * run in a common calendar month (capacity above 0 in it). Rules of one
 * priority share a short river in proportion to what each asks, MIN(its
 * capacity, its share of the need), so a licence split into several rules
 * gets what it would as one rule; but one licence entered twice at its full
 * size asks, and takes, twice its licence, and the run can't tell that from
 * two licences on one canal. One warning per group, its rules in id order
 * (the order planOfftakes accepted them in). Pure; `offtakes` as
 * planOfftakes returns them.
 */
export function splitLicenceWarnings(offtakes: readonly PlanOfftake[], nodes: readonly Pick<NetworkNode, 'name'>[], warnings: string[]): void {
	const groups = new Map<string, PlanOfftake[]>();
	for (const o of offtakes) {
		const key = `${o.from}|${o.to}|${o.priority}`;
		const g = groups.get(key);
		if (g) g.push(o);
		else groups.set(key, [o]);
	}
	for (const g of groups.values()) {
		if (g.length < 2) continue;
		// The rules that share a month with another of the group: only they can meet on one day.
		const meet = g.filter((a) => g.some((b) => b !== a && sharesMonth(a.capM3Day, b.capM3Day)));
		if (meet.length < 2) continue;
		const o = meet[0]!;
		warnings.push(
			`river off-take ${nodes[o.from]!.name} → ${nodes[o.to]!.name}: ${meet.length} rules of priority ${o.priority} (${meet.map((x) => (x.split ? `${x.split.of}, its share to ${nodes[x.to]!.name}` : x.id)).join(', ')}) take from the same river for the same unit. ` +
				'If they are one licence entered more than once at its full size, it takes that many times its licence: enter each licence once (a licence split into parts runs the same as one rule)'
		);
	}
}

const sharesMonth = (a: Float64Array, b: Float64Array): boolean => {
	for (let m = 1; m <= 12; m++) if (a[m]! > 0 && b[m]! > 0) return true;
	return false;
};

/** A river off-take's returned seepage as the EWR attribution counts it (engine ≥ 1.42.0, ./attribution.ts). */
export interface OfftakeReturnLeg {
	/** The off-take's source and destination, and the farm whose outflow the seepage joins. */
	source: number;
	destination: number;
	at: number;
	/** What seeped back each day, v × l × r (m³). */
	volume: Float64Array;
}

/** Each off-take that returns seepage, with what it returned each day, from what it took (`volumes`, in `offtakes` order). */
export function offtakeReturns(offtakes: readonly PlanOfftake[], volumes: readonly ArrayLike<number>[]): OfftakeReturnLeg[] {
	const out: OfftakeReturnLeg[] = [];
	offtakes.forEach((o, k) => {
		if (!(o.lossReturn > 0)) return;
		const v = volumes[k]!;
		out.push({ source: o.from, destination: o.to, at: o.returnAt, volume: Float64Array.from(v, (x) => x * o.loss * o.lossReturn) });
	});
	return out;
}

/**
 * The calculation order with every off-take's destination after its source:
 * `order` (every node after its upstream nodes) with the off-take links added,
 * keeping `order`'s own sequence wherever the links allow (a node is placed as
 * soon as all its upstream nodes and off-take sources are). Without off-takes
 * it is `order` itself. planOfftakes has already dropped any off-take that
 * would close a loop. A crop supply table's remote share (engine ≥ 1.73.0,
 * ./cropSupply.ts) is passed in as a link too, from the supplying dam's unit
 * to the receiving unit; planRemoteSupply drops one that would close a loop.
 */
export function offtakeOrder(order: Int32Array, upstream: readonly ArrayLike<number>[], offtakes: readonly Pick<PlanOfftake, 'from' | 'to'>[]): Int32Array {
	if (!offtakes.length) return order;
	const n = order.length;
	const waits = new Int32Array(n);
	const after: number[][] = Array.from({ length: n }, () => []);
	for (let i = 0; i < n; i++) {
		const ups = upstream[i]!;
		for (let k = 0; k < ups.length; k++) {
			waits[i]!++;
			after[ups[k]!]!.push(i);
		}
	}
	for (const o of offtakes) {
		waits[o.to]!++;
		after[o.from]!.push(o.to);
	}
	const pos = new Int32Array(n);
	order.forEach((node, k) => (pos[node] = k));
	const ready: number[] = [];
	for (let i = 0; i < n; i++) if (waits[i] === 0) ready.push(i);
	const out: number[] = [];
	while (ready.length) {
		// The ready node earliest in `order` (networks are small; a linear scan is enough).
		let best = 0;
		for (let k = 1; k < ready.length; k++) if (pos[ready[k]!]! < pos[ready[best]!]!) best = k;
		const i = ready.splice(best, 1)[0]!;
		out.push(i);
		for (const j of after[i]!) if (--waits[j]! === 0) ready.push(j);
	}
	if (out.length !== n) throw new Error('river off-takes form a loop with the network (planOfftakes should have dropped it)');
	return Int32Array.from(out);
}
