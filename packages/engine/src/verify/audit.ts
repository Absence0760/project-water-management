// The Excel audit workbook for one farm (issue #68, docs/followups.md §
// Verification): the farm's day-by-day working columns as live Excel formulas
// over its inputs, so a spreadsheet recomputes the water balance on its own
// and a hydrologist or licensing assessor can compare its numbers with the
// model's. This module decides the columns and their formulas, as a small
// expression tree that both renders to Excel text (auditFormula) and
// evaluates here (evaluateAudit), so a test can prove the formulas the file
// carries reproduce runModel's stored numbers (audit.test.ts, over random
// networks). The browser writes the .xlsx (frontend
// lib/spreadsheet/audit/). Pure.
//
// What the workbook recomputes is the b023 FarmTemplate chain from the crop
// water requirement F to the EWR shortfall AA (the formulas of ./columns.ts
// FARM_COLUMNS). Its inputs, as values, are what that chain takes from
// outside the farm or from the demand model: the catchment's rain, the
// open-water evaporation depth, gross demand, the effective rain used, the
// demand factor, upstream inflow H, runoff I, the net transfer J and the
// cumulative EWR Z. A farm with a feature whose rules the formulas don't
// carry yet (boreholes, a release rule, a river pump, off-takes, demand
// objects, priority users downstream, an allocation cap, a storage reset, a
// survey curve, a hands-off flow, River to dam by month, a daily A-pan
// series on a dam, a dam capacity that changes over the run, a drought restriction rule) gets `unsupported` instead, naming each, rather than a
// workbook whose numbers would disagree.
import { cropSharesOf, REMOTE_SERIES } from '../network/cropSupply';
import { upgradeLegacyInput } from '../demand';
import { toEpochDay } from '../calendar';
import { ALLOCATION_SERIES } from '../allocations/mode';
import { resolveDamCurve } from '../network/dam';
import { demandObjectsByNode } from '../network/demandObjects';
import { riverSourcesOf } from '../network/riverSource';
import { onRiverDam, operatingOf } from '../network/supply';
import { runReturnFlow, type ModelInput, type NetworkNode } from '../project';
import { dailyDemandFactor, damWorkings, lakeEvaporationMmDay, onRiverDamForRun, runEfficiency } from './workings';

// ── Expressions ──────────────────────────────────────────────────────────────

/**
 * A formula: a number, a parameter (a fixed cell), a column on the same row
 * (`prev`: the row above, or the column's starting parameter on the first
 * row), a binary operation, or MIN / MAX.
 */
export type AuditExpr =
	| number
	| { param: string }
	| { col: string; prev?: true }
	| { op: '+' | '-' | '*' | '/' | '^'; a: AuditExpr; b: AuditExpr }
	| { fn: 'MIN' | 'MAX'; args: AuditExpr[] };

const P = (param: string): AuditExpr => ({ param });
const C = (col: string): AuditExpr => ({ col });
const prev = (col: string): AuditExpr => ({ col, prev: true });
/** Left to right, as the engine adds: ((a + b) − c) + d … */
const chain = (first: AuditExpr, ...rest: ['+' | '-', AuditExpr][]): AuditExpr => rest.reduce<AuditExpr>((a, [op, b]) => ({ op, a, b }), first);
const add = (a: AuditExpr, b: AuditExpr): AuditExpr => ({ op: '+', a, b });
const sub = (a: AuditExpr, b: AuditExpr): AuditExpr => ({ op: '-', a, b });
const mul = (a: AuditExpr, b: AuditExpr): AuditExpr => ({ op: '*', a, b });
const div = (a: AuditExpr, b: AuditExpr): AuditExpr => ({ op: '/', a, b });
const pow = (a: AuditExpr, b: AuditExpr): AuditExpr => ({ op: '^', a, b });
const min = (...args: AuditExpr[]): AuditExpr => ({ fn: 'MIN', args });
const max = (...args: AuditExpr[]): AuditExpr => ({ fn: 'MAX', args });

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 } as const;

/**
 * Excel formula text (without the leading `=`) for `e`. `ref` gives a
 * column's cell on this row (or the row above, or its starting parameter on
 * the first row), `param` a parameter's cell. Parentheses keep the tree's
 * order exactly: a child of lower precedence, and a right child of equal
 * precedence, is parenthesised, so Excel evaluates the operations in the
 * order evaluateAudit does and rounds the same way.
 */
export function auditFormula(e: AuditExpr, ref: (col: string, prev: boolean) => string, param: (id: string) => string): string {
	const go = (x: AuditExpr): string => {
		if (typeof x === 'number') return numberText(x);
		if ('param' in x) return param(x.param);
		if ('col' in x) return ref(x.col, !!x.prev);
		if ('fn' in x) return `${x.fn}(${x.args.map(go).join(',')})`;
		const wrap = (c: AuditExpr, right: boolean) => {
			const s = go(c);
			if (typeof c === 'number' || !('op' in c)) return s;
			return PREC[c.op] < PREC[x.op] || (right && PREC[c.op] === PREC[x.op]) || (!right && x.op === '^') ? `(${s})` : s;
		};
		return `${wrap(x.a, false)}${x.op}${wrap(x.b, true)}`;
	};
	return go(e);
}

/** A number as Excel reads it back exactly (shortest round-trip text; no exponent Excel can't parse). */
function numberText(x: number): string {
	if (!Number.isFinite(x)) throw new Error(`audit: ${x} has no Excel form`);
	const s = String(x);
	return x < 0 ? `(${s})` : s;
}

/** `e` on one row: `col(key, prev)` gives a column's value (the row above's for `prev`), `param(id)` a parameter's. */
export function evaluateExpr(e: AuditExpr, col: (key: string, prev: boolean) => number, param: (id: string) => number): number {
	if (typeof e === 'number') return e;
	if ('param' in e) return param(e.param);
	if ('col' in e) return col(e.col, !!e.prev);
	if ('fn' in e) {
		const v = e.args.map((a) => evaluateExpr(a, col, param));
		return e.fn === 'MIN' ? Math.min(...v) : Math.max(...v);
	}
	const a = evaluateExpr(e.a, col, param);
	const b = evaluateExpr(e.b, col, param);
	switch (e.op) {
		case '+':
			return a + b;
		case '-':
			return a - b;
		case '*':
			return a * b;
		case '/':
			return a / b;
		case '^':
			return Math.pow(a, b);
	}
}

// ── The plan ─────────────────────────────────────────────────────────────────

/** A fixed input: one cell on the workbook's Parameters sheet. */
export interface AuditParam {
	id: string;
	label: string;
	unit: string | null;
	value: number;
}

/** One column of the audit sheet: an input (values by day) or a formula. */
export interface AuditColumn {
	/** The run_series key (a formula column's model values are that series), or the input's own key. */
	key: string;
	/** FarmTemplate column letter, when it has one (./columns.ts). */
	letter: string | null;
	label: string;
	unit: string;
	/** An input's values by day; null = no value that day (a gap, read as 0). */
	values?: (number | null)[];
	/** A formula column's formula. */
	expr?: AuditExpr;
	/** A formula column's model values by day (the run's stored series), for the comparison. */
	model?: ArrayLike<number>;
}

/** A formula column (its formula may be a bare number: a farm without a dam has area 0). */
export const isFormula = (c: AuditColumn): c is AuditColumn & { expr: AuditExpr; model: ArrayLike<number> } => c.expr !== undefined;

export interface FarmAuditPlan {
	nodeId: string;
	name: string;
	startDate: string;
	days: number;
	params: AuditParam[];
	/** Inputs first, then the formula columns in the order they compute. */
	columns: AuditColumn[];
	/** Starting values of the columns referred to on the row above: column key → parameter id. */
	initial: Record<string, string>;
}

/** What the plan reads of a run: its settings and model snapshot and its stored daily series. */
export interface AuditRun {
	settings: ModelInput['settings'];
	model: ModelInput['model'];
	startDate: string;
	days: number;
	/** Run days whose A-pan came from a daily series (RunSummary.apanDaily.dailyDays); 0 or absent without one. */
	apanDailyDays?: number;
	/** The engine that saved the run (an unknown dam's estimated area changed in 1.63.0); absent = this engine. */
	engineVersion?: string;
	/** The farm's stored series by key. */
	farm: ReadonlyMap<string, ArrayLike<number | null>>;
	/** The catchment's stored series by key (rain_final). */
	catchment: ReadonlyMap<string, ArrayLike<number | null>>;
}

/** Series whose presence on the farm means a feature the formulas don't carry yet, and what to call it. */
export const AUDIT_UNSUPPORTED_SERIES: [key: string, feature: string][] = [
	['groundwater_used', 'boreholes'],
	['dam_release', 'a dam release rule'],
	['river_abstraction', 'a supply rule that pumps from the river'],
	['offtake_in', 'river off-takes into it'],
	['offtake_out', 'river off-takes from it'],
	['offtake_loss_return', 'river off-takes’ seepage returning below it'],
	['dam_storage_set', 'a dam storage reset'],
	// Engine ≥ 1.73.0: a crop supply table's share from another unit's dam, at both ends.
	[REMOTE_SERIES.in.key, 'crops supplied from another unit’s dam'],
	[REMOTE_SERIES.out.key, 'its dam supplying other units’ crops'],
	[ALLOCATION_SERIES.surfaceRoom.key, 'an allocation cap'],
	[ALLOCATION_SERIES.groundwaterRoom.key, 'an allocation cap'],
	[ALLOCATION_SERIES.surfaceLeft.key, 'an allocation cap'],
	[ALLOCATION_SERIES.groundwaterLeft.key, 'an allocation cap'],
	['senior_requirement', 'priority water users downstream'],
	['dam_capacity', 'a dam capacity that changes over the run (sediment or an in-service date)'],
	// Engine ≥ 1.54.0: the day's level cuts what the sources are asked for.
	['restricted_demand', 'a drought restriction rule'],
	// Engine ≥ 1.54.0: a unit's own level under the 'own' basis (always beside its restricted demand).
	['restriction_level', 'a drought restriction rule']
];

/** The farm series the formulas compare against (and the inputs they read). */
export const AUDIT_REQUIRED_SERIES = ['gross_demand', 'effective_rain', 'crop_requirement', 'demand', 'supplied', 'inflow_upstream', 'runoff', 'transfer', 'upstream_to_dam', 'upstream_below_dam', 'runoff_to_dam', 'runoff_below_dam', 'diverted_to_dam', 'dam_area', 'rain_on_dam', 'dam_evaporation', 'dam_seepage', 'interim_storage', 'dam_storage', 'spill', 'below_dam_not_diverted', 'return_flow', 'outflow', 'balance_residual', 'deficit', 'ewr_cumulative', 'ewr_shortfall'];

/**
 * FarmTemplate letters of the columns that have one, as ./columns.ts
 * FARM_COLUMNS gives them (audit.test.ts holds the two together); here so
 * the export worker doesn't load that catalogue's formula texts.
 */
const LETTER: Record<string, string> = {
	crop_requirement: 'F',
	supplied: 'G',
	inflow_upstream: 'H',
	runoff: 'I',
	transfer: 'J',
	upstream_to_dam: 'K',
	upstream_below_dam: 'L',
	runoff_to_dam: 'M',
	runoff_below_dam: 'N',
	diverted_to_dam: 'O',
	interim_storage: 'P',
	dam_storage: 'Q',
	spill: 'R',
	below_dam_not_diverted: 'S',
	return_flow: 'T',
	outflow: 'U',
	balance_residual: 'V',
	deficit: 'W',
	ewr_cumulative: 'Z',
	ewr_shortfall: 'AA'
};

/**
 * The audit plan for farm `nodeId` of a run, or the reasons the workbook
 * can't recompute it (unsupported features, a run saved without a column
 * it needs, a node that isn't a farm).
 */
export function farmAuditPlan(run: AuditRun, nodeId: string): { plan: FarmAuditPlan } | { unsupported: string[] } {
	const model = upgradeLegacyInput(run.model, run.settings?.apanMm);
	const n = model.nodes.find((x) => x.id === nodeId) as NetworkNode | undefined;
	if (!n) return { unsupported: ['the run has no such unit'] };
	if (n.kind !== 'farm') return { unsupported: [`it is a ${n.kind === 'gauge' ? 'gauge' : 'water user'}, not a farm`] };
	const why = new Set<string>();
	for (const [key, feature] of AUDIT_UNSUPPORTED_SERIES) if (run.farm.has(key)) why.add(feature);
	if (demandObjectsByNode(model, []).get(n.id)) why.add('demand objects');
	// River abstractions beside the dam (engine ≥ 1.65.0): they take from the flow past the dam, and the dam side no longer supplies their demands.
	if (riverSourcesOf(n, demandObjectsByNode(model, []).get(n.id), []).river) why.add('river abstractions beside the dam');
	// A crop supply table that splits the crops (engine ≥ 1.73.0): the dam side is asked for its share only.
	if (cropSharesOf(n, []).shares) why.add('a crop supply table that splits the crops between sources');
	// Operating rules (engine ≥ 1.32.0): they change O by month and by the day's flow.
	const ops = operatingOf(n, []);
	// A dam on the river takes no River to dam (engine ≥ 1.68.0); an older run's took it as entered.
	const onRiver = onRiverDamForRun(n, run.engineVersion);
	if (ops.handsOff) why.add('a hands-off flow');
	if (ops.divertM3DayByMonth || (!onRiver && onRiverDam(n) && Array.isArray(n.divertMonthlyM3Day))) why.add('River to dam by month');
	const cap = n.damCapacityM3 > 0 ? n.damCapacityM3 : 0;
	if (cap > 0 && resolveDamCurve(n)) why.add('a dam survey curve');
	if (cap > 0 && (run.apanDailyDays ?? 0) > 0) why.add("a daily A-pan series (the dam's evaporation)");
	for (const k of AUDIT_REQUIRED_SERIES) if (!run.farm.has(k)) why.add(`no ${k} column (a run saved by an older engine)`);
	if (damWorkings(n).seepReturn < 1 && !run.farm.has('dam_seepage_lost')) why.add('no dam_seepage_lost column (a run saved by an older engine)');
	if (!run.catchment.has('rain_final')) why.add('no catchment rain column (a run saved by an older engine)');
	if (why.size) return { unsupported: [...why] };

	const days = run.days;
	const series = (k: string) => run.farm.get(k)!;
	const day0 = toEpochDay(run.startDate);
	const { areaFull, b, seep, seepReturn } = damWorkings(n, run.engineVersion);
	const e = runEfficiency({ settings: run.settings, model }, n);
	const lostShare = seepReturn < 1;

	// The demand factor on each day, as runModel applies it to F: the demand.scale factor from
	// settings.demandFactorFrom on, × a full allocation's factor (engine ≥ 1.18.0); 0 before the
	// unit's abstraction date (engine ≥ 1.30.0).
	// × the crops' own factor (engine ≥ 1.45.0, demand.scale with part 'crops').
	const df = Array.from(dailyDemandFactor(run.settings, n, day0, days, run.farm.get(ALLOCATION_SERIES.demandFactor.key), 'crops').perDay);
	const evap = lakeEvaporationMmDay({ settings: run.settings }, run.startDate, days);
	const cell = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
	const values = (xs: ArrayLike<number | null>) => Array.from({ length: days }, (_, t) => cell(xs[t]));

	const params: AuditParam[] = [
		{ id: 'capacity', label: 'Dam capacity', unit: 'm³', value: cap },
		{ id: 'initial', label: 'Dam storage at the start (initial % × capacity)', unit: 'm³', value: n.damInitialPct * cap },
		{ id: 'dead', label: 'Dead storage (minimum operating level × capacity)', unit: 'm³', value: n.damMinPct * cap },
		{ id: 'area_full', label: 'Full-supply area A_full', unit: 'm²', value: areaFull },
		{ id: 'b', label: 'Area exponent b (A = A_full × (Q ÷ capacity)^b)', unit: null, value: b },
		{ id: 'seepage', label: 'Seepage per day (share of Q[t−1])', unit: null, value: seep },
		...(lostShare ? [{ id: 'seepage_return', label: 'Share of the seepage returning below the dam', unit: null, value: seepReturn }] : []),
		{ id: 'pct_upstream', label: '% of upstream inflow to the dam', unit: null, value: n.pctUpstreamToDam },
		{ id: 'pct_runoff', label: '% of runoff to the dam', unit: null, value: n.pctRunoffToDam },
		...(onRiver ? [{ id: 'divert', label: 'Diversion capacity (0: the dam is on the river)', unit: 'm³/day', value: 0 }] : Number.isFinite(n.divertCapacityM3Day) ? [{ id: 'divert', label: 'Diversion capacity', unit: 'm³/day', value: n.divertCapacityM3Day }] : []),
		{ id: 'efficiency', label: 'Irrigation efficiency e', unit: null, value: e },
		{ id: 'return', label: 'Return flow r (share of the water supplied G reaching the river, at most 1 − e)', unit: null, value: runReturnFlow(n.returnFlowFraction, e) }
	];

	const input = (key: string, label: string, unit: string, vs: (number | null)[]): AuditColumn => ({ key, letter: LETTER[key] ?? null, label, unit, values: vs });
	const formula = (key: string, label: string, unit: string, expr: AuditExpr): AuditColumn => ({ key, letter: LETTER[key] ?? null, label, unit, expr, model: series(key) as ArrayLike<number> });

	// What is in the dam once today's transfer has landed: evaporation, then seepage, take at most this.
	const there = max(chain(prev('dam_storage'), ['+', C('rain_on_dam')], ['+', C('transfer')]), 0);
	const evRaw = div(mul(C('lake_evaporation'), C('dam_area')), 1000);
	const evLimited = b > 1 ? min(evRaw, div(mul(sub(1, P('seepage')), max(prev('dam_storage'), 0)), P('b'))) : evRaw;
	// Q[t−1] + rain on dam − evaporation − seepage + M + O + K + J: what the dam could give today.
	const avail = chain(prev('dam_storage'), ['+', C('rain_on_dam')], ['-', C('dam_evaporation')], ['-', C('dam_seepage')], ['+', C('runoff_to_dam')], ['+', C('diverted_to_dam')], ['+', C('upstream_to_dam')], ['+', C('transfer')]);
	const seepReturned = lostShare ? mul(C('dam_seepage'), P('seepage_return')) : C('dam_seepage');

	const columns: AuditColumn[] = [
		input('rain', 'Rain on the catchment (rain on the dam; blank = no value, 0)', 'mm', values(run.catchment.get('rain_final')!)),
		input('lake_evaporation', 'Open-water evaporation depth, as the run used it', 'mm', Array.from(evap)),
		input('gross_demand', 'Gross irrigation demand', 'm³/day', values(series('gross_demand'))),
		input('effective_rain', 'Effective rain used', 'm³/day', values(series('effective_rain'))),
		input('demand_factor', 'Demand factor (1 = none)', '', df),
		input('inflow_upstream', 'Inflow from upstream', 'm³/day', values(series('inflow_upstream'))),
		input('runoff', 'Runoff', 'm³/day', values(series('runoff'))),
		input('transfer', 'Net transfer', 'm³/day', values(series('transfer'))),
		input('ewr_cumulative', 'EWR required here', 'm³/day', values(series('ewr_cumulative'))),
		formula('crop_requirement', 'Crop water requirement', 'm³/day', mul(C('demand_factor'), sub(max(0, C('gross_demand')), C('effective_rain')))),
		formula('demand', 'Irrigation demand (abstraction)', 'm³/day', div(C('crop_requirement'), P('efficiency'))),
		formula('upstream_to_dam', 'Upstream inflow to the dam', 'm³/day', min(mul(C('inflow_upstream'), P('pct_upstream')), C('inflow_upstream'))),
		formula('upstream_below_dam', 'Upstream inflow below the dam', 'm³/day', sub(C('inflow_upstream'), C('upstream_to_dam'))),
		formula('runoff_to_dam', 'Runoff to the dam', 'm³/day', min(mul(C('runoff'), P('pct_runoff')), C('runoff'))),
		formula('runoff_below_dam', 'Runoff below the dam', 'm³/day', sub(C('runoff'), C('runoff_to_dam'))),
		formula(
			'diverted_to_dam',
			'Diverted to the dam',
			'm³/day',
			onRiver || Number.isFinite(n.divertCapacityM3Day) ? min(P('divert'), add(C('upstream_below_dam'), C('runoff_below_dam'))) : add(C('upstream_below_dam'), C('runoff_below_dam'))
		),
		formula('dam_area', 'Dam surface area', 'm²', cap > 0 ? mul(P('area_full'), pow(min(div(max(prev('dam_storage'), 0), P('capacity')), 1), P('b'))) : 0),
		formula('rain_on_dam', 'Rain on the dam', 'm³/day', div(mul(max(C('rain'), 0), C('dam_area')), 1000)),
		formula('dam_evaporation', 'Evaporation from the dam', 'm³/day', min(evLimited, there)),
		formula('dam_seepage', 'Seepage from the dam', 'm³/day', min(mul(P('seepage'), max(prev('dam_storage'), 0)), sub(there, C('dam_evaporation')))),
		...(lostShare ? [formula('dam_seepage_lost', 'Seepage lost from the catchment', 'm³/day', sub(C('dam_seepage'), seepReturned))] : []),
		formula('supplied', 'Irrigation supplied', 'm³/day', min(max(sub(avail, P('dead')), 0), C('demand'))),
		formula('interim_storage', 'Interim storage', 'm³', sub(avail, C('supplied'))),
		formula('dam_storage', 'Dam storage', 'm³', min(C('interim_storage'), P('capacity'))),
		formula('spill', 'Spill', 'm³/day', max(sub(C('interim_storage'), P('capacity')), 0)),
		formula('below_dam_not_diverted', 'Flow below the dam, not diverted', 'm³/day', sub(add(C('upstream_below_dam'), C('runoff_below_dam')), C('diverted_to_dam'))),
		formula('return_flow', 'Return flow', 'm³/day', mul(P('return'), C('supplied'))),
		formula('outflow', 'Outflow', 'm³/day', chain(C('spill'), ['+', C('below_dam_not_diverted')], ['+', C('return_flow')], ['+', seepReturned])),
		formula(
			'balance_residual',
			'Water balance residual (0 up to float noise)',
			'm³/day',
			chain(
				C('inflow_upstream'),
				['+', C('runoff')],
				['+', C('transfer')],
				['+', C('rain_on_dam')],
				['-', sub(C('supplied'), C('return_flow'))],
				['-', C('dam_evaporation')],
				['-', sub(C('dam_storage'), prev('dam_storage'))],
				['-', C('outflow')],
				...(lostShare ? [['-', C('dam_seepage_lost')] as ['-', AuditExpr]] : [])
			)
		),
		formula('deficit', 'Irrigation deficit', 'm³/day', sub(C('demand'), C('supplied'))),
		formula('ewr_shortfall', 'EWR not met (negative = shortfall)', 'm³/day', min(sub(C('outflow'), C('ewr_cumulative')), 0))
	];
	return { plan: { nodeId: n.id, name: n.name, startDate: run.startDate, days, params, columns, initial: { dam_storage: 'initial' } } };
}

/**
 * The plan's formulas computed day by day, as a spreadsheet would: each
 * formula column's values, and on each day the largest |formula − model|
 * over the formula columns (the workbook's comparison column).
 */
export function evaluateAudit(plan: FarmAuditPlan): { values: Map<string, Float64Array>; largestDifference: Float64Array } {
	const param = new Map(plan.params.map((p) => [p.id, p.value]));
	const out = new Map<string, Float64Array>(plan.columns.map((c) => [c.key, new Float64Array(plan.days)]));
	for (const c of plan.columns) if (c.values) out.get(c.key)!.set(c.values.map((v) => v ?? 0));
	const largest = new Float64Array(plan.days);
	const p = (id: string) => {
		const v = param.get(id);
		if (v === undefined) throw new Error(`audit: no parameter ${id}`);
		return v;
	};
	for (let t = 0; t < plan.days; t++) {
		const col = (key: string, before: boolean) => {
			if (before && t === 0) return p(plan.initial[key] ?? '');
			const v = out.get(key);
			if (!v) throw new Error(`audit: no column ${key}`);
			return v[before ? t - 1 : t]!;
		};
		let worst = 0;
		for (const c of plan.columns) {
			if (!isFormula(c)) continue;
			const v = evaluateExpr(c.expr, col, p);
			out.get(c.key)![t] = v;
			worst = Math.max(worst, Math.abs(v - Number(c.model[t])));
		}
		largest[t] = worst;
	}
	return { values: out, largestDifference: largest };
}
