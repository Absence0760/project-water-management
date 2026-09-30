// The values a scenario op can set (docs/scenarios.md § Op catalogue), as
// the override editor shows and reads them: a label and a value spec per
// node field, transfer field and settings path the engine's ScenarioOp union
// allows, plus parsing typed text into the stored value and formatting a
// stored value for people. Fractions are stored 0–1 and shown as %. Pure:
// no Svelte, no API.
import {
	ACCUMULATION_MODES,
	BOREHOLE_RULES,
	CALIBRATION_FLOW_KINDS,
	DAM_RELEASE_RULES,
	CHIRPS_BIAS_MODES,
	NODE_SET_FIELDS,
	SETTINGS_PATHS,
	EWR_CHARGE_SOURCES,
	LOW_FLOW_MEASURES,
	ALLOCATION_MODE_LABEL,
	ALLOCATION_MODES,
	CROP_SET_FIELDS,
	DEMAND_OBJECT_CATEGORIES,
	DEMAND_OBJECT_CATEGORY_LABEL,
	DEMAND_OBJECT_SET_FIELDS,
	LAND_COVER_CLASSES,
	LAND_COVER_SET_FIELDS,
	SUPPLY_RULES,
	SUPPLY_RULE_LABEL,
	TRANSFER_SET_FIELDS,
	USER_PRIORITIES,
	ZERO_RAIN_MODES,
	damCurveProblem,
	isIsoDate,
	type DamCurvePoint,
	type CropSetField,
	type DemandObjectSetField,
	type LandCoverSetField,
	type NodeKind,
	type NodeSetField,
	type PeInput,
	type PeKind,
	type SettingsPath,
	type TransferSetField
} from '@water-management/engine';
import { WATER_YEAR_MONTHS } from '$lib/format/months';
import { fmtNum, parseNum } from '$lib/format/number';
import { kindLabel } from '$lib/series/kinds';
import { peFormError, peOf, peText, withPeKind, type EditablePe } from '$lib/components/settings/peInput';
import { curveText, parseDamCurve } from '$lib/components/network/damCurve';

export interface EnumOption {
	value: string;
	label: string;
}

/** How a value is typed in and shown. `scale` 100 shows a stored fraction as a percentage. */
export type ValueSpec =
	/** Text; `optional`: may be left empty (a note), else it is a name and needs one. */
	| { t: 'text'; optional?: boolean }
	| { t: 'number'; unit: string; scale: number; nullable: boolean; nullLabel?: string; int?: boolean }
	| { t: 'enum'; options: readonly EnumOption[]; nullable?: boolean; nullLabel?: string }
	/** 12 values, one per water-year month (Oct–Sep). */
	| { t: 'monthly'; unit: string; scale: number; nullable: boolean }
	/** A set of calendar months 1–12. */
	| { t: 'months' }
	| { t: 'bool' }
	/** An ISO date; empty is null. */
	| { t: 'date'; nullLabel: string }
	/** A node of the model, by id; with `nullLabel`, empty is null (shown as that). */
	| { t: 'node'; nullLabel?: string }
	/**
	 * GR4J's potential-evaporation input (settings.pe, issue #39): pan
	 * coefficient × A-pan, or a monthly row in mm with a required source.
	 * Typed as a PeDraft (the kind, the 12 values as text, the source).
	 */
	| { t: 'pe' }
	/**
	 * A dam's survey curve (engine ≥ 1.20.0): level, area and volume rows,
	 * pasted as the Network form's survey box reads them (network/damCurve.ts);
	 * empty is none, the power law.
	 */
	| { t: 'curve' }
	/**
	 * A land-cover patch's reductions overriding its class's (engine ≥ 1.35.0,
	 * landCover.set): "MAR %, low-flow %", typed as two numbers; empty is the
	 * class's defaults.
	 */
	| { t: 'reductions' };

/** The "Add a change" form's copy of a PE input: the monthly row stays text until it is parsed. */
export interface PeDraft {
	kind: PeKind;
	/** 12 values in mm, Oct to Sep, as typed (parsed like any monthly field). */
	mm: string;
	source: string;
}

export interface FieldSpec {
	label: string;
	spec: ValueSpec;
}

const num = (unit: string, opts: { scale?: number; nullable?: boolean; nullLabel?: string; int?: boolean } = {}): ValueSpec => ({
	t: 'number',
	unit,
	scale: opts.scale ?? 1,
	nullable: opts.nullable ?? false,
	nullLabel: opts.nullLabel,
	int: opts.int
});
const pct = (nullable = false, nullLabel?: string): ValueSpec => num('%', { scale: 100, nullable, nullLabel });
const plain = (list: readonly string[], labels: Record<string, string> = {}): readonly EnumOption[] => list.map((v) => ({ value: v, label: labels[v] ?? v }));

// ---------------------------------------------------------------------------
// node.set
// ---------------------------------------------------------------------------

export const NODE_FIELD_SPECS: Record<NodeSetField, FieldSpec> = {
	name: { label: 'Name', spec: { t: 'text' } },
	areaKm2: { label: 'Area', spec: num('km²') },
	areaHiKm2: { label: 'High-MAP area', spec: num('km²') },
	areaLoKm2: { label: 'Low-MAP area', spec: num('km²') },
	flowShareManual: { label: 'Manual flow share', spec: pct(true, 'none') },
	pctUpstreamToDam: { label: 'Upstream inflow to the dam', spec: pct() },
	pctRunoffToDam: { label: 'Own runoff to the dam', spec: pct() },
	damCapacityM3: { label: 'Dam capacity', spec: num('m³') },
	damInitialPct: { label: 'Dam level at the start', spec: pct() },
	damMinPct: { label: 'Dam minimum operating level', spec: pct() },
	damAreaFullM2: { label: 'Dam area when full', spec: num('m²', { nullable: true, nullLabel: 'estimated (capacity ÷ 3 m)' }) },
	damAreaExponent: { label: 'Dam area exponent', spec: num('') },
	damSeepagePerDay: { label: 'Dam seepage per day', spec: pct() },
	divertCapacityM3Day: { label: 'River to dam', spec: num('m³/day') },
	irrigationEfficiency: { label: 'Irrigation efficiency', spec: pct() },
	lossReturnFraction: { label: 'Share of losses returning', spec: pct() },
	damReleaseRule: { label: 'Dam release rule', spec: { t: 'enum', options: plain(DAM_RELEASE_RULES, { none: 'none', passInflow: 'pass inflow', fixed: 'fixed release' }) } },
	damReleaseM3Day: { label: 'Dam release by month', spec: { t: 'monthly', unit: 'm³/day', scale: 1, nullable: true } },
	damOutletCapacityM3Day: { label: 'Dam outlet capacity', spec: num('m³/day', { nullable: true, nullLabel: 'no limit' }) },
	damSeepageReturnPct: { label: 'Share of dam seepage returning', spec: pct() },
	damCurve: { label: 'Dam survey curve', spec: { t: 'curve' } },
	// Development over the run (engine ≥ 1.30.0, issue #67, docs/model.md §2.7g).
	damSurveyDate: { label: 'Dam survey date', spec: { t: 'date', nullLabel: 'not recorded' } },
	damSedimentPctPerYear: { label: 'Dam capacity lost to sediment a year', spec: pct(true, 'none') },
	damInServiceFrom: { label: 'Dam in service from', spec: { t: 'date', nullLabel: 'the whole run' } },
	abstractionFrom: { label: 'Abstraction starts', spec: { t: 'date', nullLabel: 'the whole run' } },
	boreholeCapacityM3Day: { label: 'Borehole capacity', spec: num('m³/day', { nullable: true, nullLabel: 'no boreholes' }) },
	boreholeRule: { label: 'Borehole rule', spec: { t: 'enum', options: plain(BOREHOLE_RULES) } },
	boreholeTriggerPct: { label: 'Borehole drought trigger', spec: pct() },
	streamDepletionFrac: { label: 'Stream depletion share', spec: pct() },
	streamDepletionLagDays: { label: 'Stream depletion lag', spec: num('days') },
	userDemandM3Day: { label: 'Demand by month', spec: { t: 'monthly', unit: 'm³/day', scale: 1, nullable: true } },
	userReturnPct: { label: 'Share returned', spec: pct() },
	userPriority: { label: 'Priority', spec: { t: 'enum', options: plain(USER_PRIORITIES) } },
	// Supply rule and river pump (WP-3.8, docs/model.md §2.7e): the rule's words are run comparison's (engine compare.ts).
	supplyRule: {
		label: 'Supply rule',
		spec: { t: 'enum', options: plain(SUPPLY_RULES, SUPPLY_RULE_LABEL) }
	},
	pumpCapacityM3Day: { label: 'River pump capacity', spec: num('m³/day', { nullable: true, nullLabel: 'no limit' }) },
	supplyTriggerPct: { label: 'Supply switch-to-river level', spec: pct() },
	supplyStopPct: { label: 'Supply switch-back level', spec: pct() },
	// Hands-off flow and River to dam by month (engine ≥ 1.32.0, docs/model.md §2.7h).
	handsOffM3Day: { label: 'Hands-off flow by month', spec: { t: 'monthly', unit: 'm³/day', scale: 1, nullable: true } },
	handsOffEwr: { label: 'Hands-off flow keeps the EWR', spec: { t: 'bool' } },
	divertMonthlyM3Day: { label: 'River to dam by month', spec: { t: 'monthly', unit: 'm³/day', scale: 1, nullable: true } },
	// A gauge's EWR site flag (engine ≥ 1.5.0): a baseline assumption, never a proposal (docs/scenarios.md).
	ewrSite: { label: 'EWR site', spec: { t: 'bool' } }
};

/** The fields node.set may change on a node of this kind, in the engine's order. */
export function nodeFields(kind: NodeKind): { field: NodeSetField; label: string }[] {
	return (NODE_SET_FIELDS[kind] as readonly NodeSetField[]).map((field) => ({ field, label: NODE_FIELD_SPECS[field].label }));
}

// ---------------------------------------------------------------------------
// transfer.set
// ---------------------------------------------------------------------------

export const TRANSFER_FIELD_SPECS: Record<TransferSetField, FieldSpec> = {
	fromNodeId: { label: 'Source', spec: { t: 'node' } },
	toNodeId: { label: 'Destination', spec: { t: 'node' } },
	months: { label: 'Months it runs', spec: { t: 'months' } },
	maxRateM3s: { label: 'Maximum rate', spec: num('m³/s') },
	dailyCapM3: { label: 'Daily cap', spec: num('m³', { nullable: true, nullLabel: 'no cap' }) },
	minStoragePct: { label: 'Source dam minimum level', spec: pct() },
	enabled: { label: 'Enabled', spec: { t: 'bool' } },
	priority: { label: 'Priority (lower moves first)', spec: num('', { int: true }) },
	// Engine ≥ 1.14.0: also sets the months and max rate to match; empty = the one max rate in its months.
	monthlyRateM3s: { label: 'Maximum rate by month', spec: { t: 'monthly', unit: 'm³/s', scale: 1, nullable: true } },
	// A river off-take (engine ≥ 1.14.0).
	source: { label: 'Takes from', spec: { t: 'enum', options: [{ value: 'dam', label: 'The source’s dam' }, { value: 'river', label: 'The river (an off-take)' }] } },
	handsOffM3Day: { label: 'Off-take hands-off flow', spec: num('m³/day', { nullable: true, nullLabel: 'none' }) },
	handsOffEwr: { label: 'Off-take leaves the EWR in the river', spec: { t: 'bool' } },
	lossPct: { label: 'Off-take conveyance losses', spec: pct() },
	sizing: { label: 'Off-take takes', spec: { t: 'enum', options: [{ value: 'demand', label: 'What the destination needs' }, { value: 'capacity', label: 'Up to capacity' }] } },
	topUpDam: { label: 'Off-take tops up the destination’s dam', spec: { t: 'bool' } },
	// Canal seepage back to the river (engine ≥ 1.42.0).
	lossReturnPct: { label: 'Off-take losses seeping back to the river', spec: pct() },
	lossReturnNodeId: { label: 'Off-take seepage rejoins the river below', spec: { t: 'node', nullLabel: 'the source' } }
};

export const TRANSFER_FIELDS = TRANSFER_SET_FIELDS.map((field) => ({ field, label: TRANSFER_FIELD_SPECS[field].label }));

// ---------------------------------------------------------------------------
// crop.set, landCover.set (engine ≥ 1.35.0)
// ---------------------------------------------------------------------------

export const CROP_FIELD_SPECS: Record<CropSetField, FieldSpec> = {
	name: { label: 'Name', spec: { t: 'text' } },
	cropFactor: { label: 'Crop factors', spec: { t: 'monthly', unit: '', scale: 1, nullable: false } },
	irrigationEfficiency: { label: 'Irrigation efficiency', spec: pct(true, "the hydrological unit's") }
};

export const CROP_FIELDS = CROP_SET_FIELDS.map((field) => ({ field, label: CROP_FIELD_SPECS[field].label }));

export const LAND_COVER_FIELD_SPECS: Record<LandCoverSetField, FieldSpec> = {
	coverClass: { label: 'Land cover', spec: { t: 'enum', options: LAND_COVER_CLASSES.map((c) => ({ value: c.id, label: c.label })) } },
	areaKm2: { label: 'Area', spec: num('km²') },
	densityPct: { label: 'Condensed cover', spec: pct() },
	factors: { label: 'Reductions (MAR, low flow)', spec: { t: 'reductions' } }
};

export const LAND_COVER_FIELDS = LAND_COVER_SET_FIELDS.map((field) => ({ field, label: LAND_COVER_FIELD_SPECS[field].label }));

// ---------------------------------------------------------------------------
// demandObject.set (engine ≥ 1.45.0)
// ---------------------------------------------------------------------------

/**
 * The demand-object fields "Add a change" sets one at a time with a typed
 * value. The schedule (a list of date windows) has its own editor there, the
 * Network form's (DemandScheduleFields), so it has no value spec.
 */
export type DemandObjectFormField = Exclude<DemandObjectSetField, 'schedule'>;
export const DEMAND_OBJECT_FIELD_SPECS: Record<DemandObjectFormField, FieldSpec> = {
	name: { label: 'Name', spec: { t: 'text' } },
	category: { label: 'Category', spec: { t: 'enum', options: plain(DEMAND_OBJECT_CATEGORIES, DEMAND_OBJECT_CATEGORY_LABEL) } },
	sizing: { label: 'Demand given as', spec: { t: 'enum', options: [{ value: 'monthly', label: 'm³/day by month' }, { value: 'perUnit', label: 'a count × litres a day' }] } },
	monthlyM3Day: { label: 'Demand by month', spec: { t: 'monthly', unit: 'm³/day', scale: 1, nullable: true } },
	count: { label: 'Count (people, head or units)', spec: num('', { nullable: true }) },
	litresPerUnitDay: { label: 'Litres per unit a day', spec: num('l', { nullable: true }) },
	lossPct: { label: 'Distribution losses', spec: pct() },
	monthlyFactor: { label: 'Monthly profile (× the daily use)', spec: { t: 'monthly', unit: '', scale: 1, nullable: true } },
	returnPct: { label: 'Share returned', spec: pct() },
	priority: {
		label: 'Priority',
		spec: { t: 'enum', options: [{ value: 'first', label: 'First: before the hydrological unit’s crops' }, { value: 'shared', label: 'Shared: pro rata with the crops' }, { value: 'last', label: 'Last: after the crops' }] }
	},
	destination: { label: 'Destination', spec: { t: 'enum', options: [{ value: 'internal', label: 'Used in the catchment' }, { value: 'external', label: 'Piped out of the catchment (nothing returns)' }] } },
	enabled: { label: 'Modelled', spec: { t: 'bool' } },
	// The basic-needs floor's people (engine ≥ 1.44.0): a domestic or municipal object is never cut below 25 l each a day.
	population: { label: 'People served', spec: num('', { nullable: true, nullLabel: 'its count (per person), else none' }) },
	note: { label: 'Where the number comes from', spec: { t: 'text', optional: true } }
};
/** The schedule field's label, as the Network form heads it. */
export const SCHEDULE_LABEL = 'On/off schedule';
export const DEMAND_OBJECT_FIELDS = DEMAND_OBJECT_SET_FIELDS.map((field) => ({ field, label: field === 'schedule' ? SCHEDULE_LABEL : DEMAND_OBJECT_FIELD_SPECS[field].label }));


/**
 * demand.scale's parts (engine ≥ 1.45.0, issue #123): a unit's whole demand
 * (no part), its crops, or its demand objects of one category.
 */
export const DEMAND_PART_OPTIONS: readonly EnumOption[] = [
	{ value: 'crops', label: 'Crops (irrigation of the crop areas)' },
	...DEMAND_OBJECT_CATEGORIES.map((c) => ({ value: c, label: `${DEMAND_OBJECT_CATEGORY_LABEL[c]} demand objects` }))
];

// ---------------------------------------------------------------------------
// settings.set
// ---------------------------------------------------------------------------

const MONTH_MM: ValueSpec = { t: 'monthly', unit: 'mm', scale: 1, nullable: false };

export const SETTINGS_SPECS: Record<SettingsPath, FieldSpec> = {
	februaryDays: { label: 'Days in February', spec: num('days', { int: true }) },
	effectiveRainFraction: { label: 'Effective rain fraction', spec: pct() },
	effectiveRainFractionMonthly: { label: 'Monthly effective rain fractions', spec: { t: 'monthly', unit: '', scale: 1, nullable: true } },
	effectiveRainStoreMm: { label: 'Soil-water store (effective rain carry-over)', spec: num('mm') },
	lakeEvapFactor: { label: 'Dam evaporation factor (× A-pan)', spec: num('') },
	lakeEvapFactorMonthly: { label: 'Monthly dam evaporation factors (× A-pan)', spec: { t: 'monthly', unit: '', scale: 1, nullable: true } },
	apanMm: { label: 'A-pan evaporation by month', spec: MONTH_MM },
	panCoefficient: { label: 'Pan coefficient by month', spec: { t: 'monthly', unit: '', scale: 1, nullable: false } },
	ewrPragmaticM3PerDay: { label: 'Pragmatic EWR by month', spec: { t: 'monthly', unit: 'm³/day', scale: 1, nullable: false } },
	flowShareMethod: {
		label: 'Flow-share method',
		spec: { t: 'enum', options: plain(['area', 'hiLo', 'manual'], { area: 'By area', hiLo: 'High/low MAP', manual: 'Manual' }) }
	},
	'hiLoSplit.hi': { label: 'High-MAP share of runoff', spec: pct() },
	'hiLoSplit.lo': { label: 'Low-MAP share of runoff', spec: pct() },
	'gr4j.x1': { label: 'GR4J production store X1', spec: num('mm') },
	'gr4j.x2': { label: 'GR4J groundwater exchange X2', spec: num('mm/day') },
	'gr4j.x3': { label: 'GR4J routing store X3', spec: num('mm') },
	'gr4j.x4': { label: 'GR4J unit hydrograph time base X4', spec: num('days') },
	'gr4j.warmupDays': { label: 'GR4J warm-up', spec: num('days', { int: true }) },
	chirpsBiasCorrection: { label: 'CHIRPS bias correction', spec: { t: 'enum', options: plain(CHIRPS_BIAS_MODES, { monthly: 'Monthly factors', none: 'None' }) } },
	'zeroRainRuns.mode': { label: 'Zero-rain runs', spec: { t: 'enum', options: plain(ZERO_RAIN_MODES, { missing: 'Treat as missing', asRecorded: 'As recorded' }) } },
	'zeroRainRuns.accumulationMode': {
		label: 'Rain accumulations',
		spec: { t: 'enum', options: plain(ACCUMULATION_MODES, { spread: 'Spread over the days', asRecorded: 'As recorded' }) }
	},
	'calibration.rainThresholdMm': { label: 'Calibration rain threshold', spec: num('mm') },
	'calibration.catchmentAreaKm2': { label: 'Calibration catchment area', spec: num('km²', { nullable: true, nullLabel: 'sum of hydrological unit areas' }) },
	simulationStart: { label: 'Simulation start', spec: { t: 'date', nullLabel: 'first day with rain' } },
	simulationEnd: { label: 'Simulation end', spec: { t: 'date', nullLabel: 'last day with rain' } },
	reportStart: { label: 'Curtailment report start', spec: { t: 'date', nullLabel: 'start of run' } },
	reportEnd: { label: 'Curtailment report end', spec: { t: 'date', nullLabel: 'end of run' } },
	calibrationStart: { label: 'Calibration window start', spec: { t: 'date', nullLabel: 'start of record' } },
	calibrationEnd: { label: 'Calibration window end', spec: { t: 'date', nullLabel: 'end of record' } },
	pe: { label: 'GR4J potential evaporation', spec: { t: 'pe' } },
	calibrationFlowKind: {
		label: 'Calibration flow series',
		spec: { t: 'enum', options: CALIBRATION_FLOW_KINDS.map((k) => ({ value: k, label: kindLabel(k) })), nullable: true, nullLabel: 'default (observed, else logger)' }
	},
	// Reserve method choices (engine ≥ 1.3.0, issue #64), pending the hydrologist.
	ewrChargeSource: { label: 'EWR charge follows', spec: { t: 'enum', options: plain(EWR_CHARGE_SOURCES, { pragmatic: 'The pragmatic EWR', ruleTable: 'The rule tables' }) } },
	lowFlowMeasure: { label: 'Low flows judged on', spec: { t: 'enum', options: plain(LOW_FLOW_MEASURES, { total: 'The month’s total flow', baseflow: 'The month’s base flow' }) } },
	// Registered volumes (engine ≥ 1.18.0, issue #72): a full-allocation scenario is the cumulative-impact background.
	allocationMode: { label: 'Allocation mode', spec: { t: 'enum', options: plain(ALLOCATION_MODES, ALLOCATION_MODE_LABEL) } }
};

export const SETTINGS_FIELDS = SETTINGS_PATHS.map((path) => ({ path, label: SETTINGS_SPECS[path].label }));

/** A dotted settings path's current value in a settings object (`gr4j.x1` → settings.gr4j.x1). */
export function settingsValue(settings: Record<string, unknown> | undefined, path: string): unknown {
	const [head, leaf] = path.split('.') as [string, string | undefined];
	const v = settings?.[head];
	if (leaf === undefined) return v;
	return v && typeof v === 'object' ? (v as Record<string, unknown>)[leaf] : undefined;
}

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** [11, 12, 1] → "Jan, Nov, Dec" (calendar order); [] → "no months"; all 12 → "every month". */
export function monthsText(ms: readonly number[]): string {
	const set = [...new Set(ms)].filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b);
	if (!set.length) return 'no months';
	if (set.length === 12) return 'every month';
	return set.map((m) => MONTH_NAMES[m - 1]).join(', ');
}

// ---------------------------------------------------------------------------
// Parsing and formatting
// ---------------------------------------------------------------------------

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

const round = (n: number) => Math.round(n * 1e9) / 1e9;

/**
 * Typed text (or, for months, the ticked months) → the stored value. Empty
 * is null where the field allows it. Percentages are divided by 100. The
 * range checks are the engine's, run on the op afterwards.
 */
export function parseValue(spec: ValueSpec, input: string | readonly number[] | PeDraft): Parsed {
	if (spec.t === 'pe') return parsePe(input);
	if (spec.t === 'months') {
		if (!Array.isArray(input)) return { ok: false, error: 'pick the months' };
		return { ok: true, value: [...new Set(input as number[])].sort((a, b) => a - b) };
	}
	const text = typeof input === 'string' ? input.trim() : '';
	switch (spec.t) {
		case 'text':
			return text || spec.optional ? { ok: true, value: text } : { ok: false, error: 'enter a name' };
		case 'number': {
			if (text === '') return spec.nullable ? { ok: true, value: null } : { ok: false, error: 'enter a number' };
			const n = parseNum(text);
			if (n === null) return { ok: false, error: `“${text}” isn't a number` };
			if (spec.int && !Number.isInteger(n)) return { ok: false, error: 'enter a whole number' };
			return { ok: true, value: round(n / spec.scale) };
		}
		case 'enum':
			if (text === '') return spec.nullable ? { ok: true, value: null } : { ok: false, error: 'pick one' };
			return spec.options.some((o) => o.value === text) ? { ok: true, value: text } : { ok: false, error: 'pick one of the options' };
		case 'monthly': {
			if (text === '') return spec.nullable ? { ok: true, value: null } : { ok: false, error: 'enter 12 monthly values' };
			// Semicolons, whitespace or a comma and a space separate values, so a
			// decimal comma (1,5) still reads as one number; "1,2,…" with eleven
			// bare commas is twelve values.
			let parts = text.split(/\s*;\s*|,\s+|\s+/).filter(Boolean);
			if (parts.length === 1 && (parts[0]!.match(/,/g)?.length ?? 0) === 11) parts = parts[0]!.split(',');
			const one = parts.length === 1 ? parseNum(parts[0]!) : null;
			// One number is the same value every month.
			const values = one !== null ? new Array<number | null>(12).fill(one) : parts.map((p) => parseNum(p));
			if (values.length !== 12) return { ok: false, error: `enter 12 values, Oct to Sep (got ${values.length})` };
			const bad = values.findIndex((v) => v === null);
			if (bad >= 0) return { ok: false, error: `${WATER_YEAR_MONTHS[bad]}: “${parts[bad]}” isn't a number` };
			return { ok: true, value: (values as number[]).map((v) => round(v / spec.scale)) };
		}
		case 'bool':
			return text === 'true' || text === 'false' ? { ok: true, value: text === 'true' } : { ok: false, error: 'pick yes or no' };
		case 'date':
			if (text === '') return { ok: true, value: null };
			return isIsoDate(text) ? { ok: true, value: text } : { ok: false, error: 'enter a date as YYYY-MM-DD' };
		case 'node':
			return text ? { ok: true, value: text } : spec.nullLabel !== undefined ? { ok: true, value: null } : { ok: false, error: 'pick a node' };
		case 'reductions': {
			if (text === '') return { ok: true, value: null };
			const parts = text.replace(/%/g, ' ').split(/\s*;\s*|,\s+|\s+/).filter(Boolean);
			const xs = parts.map((p) => parseNum(p));
			if (xs.length !== 2 || xs.some((x) => x === null)) return { ok: false, error: 'enter two percentages, the MAR reduction and the low-flow reduction (e.g. 20; 30), or leave it empty for the class defaults' };
			return { ok: true, value: { mar: round(xs[0]! / 100), lowFlow: round(xs[1]! / 100) } };
		}
		case 'curve': {
			if (text === '') return { ok: true, value: null };
			// Read and checked as the Network form reads a pasted survey (the engine's damCurveProblem, a model rule applyScenario also runs).
			const c = parseDamCurve(text);
			if (c.error) return { ok: false, error: c.error.charAt(0).toLowerCase() + c.error.slice(1).replace(/\.$/, '') };
			const bad = damCurveProblem(c.rows);
			return bad ? { ok: false, error: bad } : { ok: true, value: c.rows };
		}
	}
	return { ok: false, error: 'unknown field' };
}

const MONTHLY_MM: ValueSpec = { t: 'monthly', unit: 'mm', scale: 1, nullable: false };

/**
 * A PE draft → the stored input. The monthly row is read like any monthly
 * field; the whole input then goes through the Settings form's own check
 * (settings/peInput.ts peFormError: 12 values 0–10 000 mm, a source of 1 to
 * PE_SOURCE_MAX characters), the same rules the engine's settings.set check has.
 */
function parsePe(input: unknown): Parsed {
	const d = input as Partial<PeDraft> | null;
	if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: 'pick where the PE comes from' };
	if (d.kind === 'pan') return { ok: true, value: { kind: 'pan' } satisfies PeInput };
	if (d.kind !== 'monthly') return { ok: false, error: 'pick where the PE comes from' };
	const mm = parseValue(MONTHLY_MM, d.mm ?? '');
	if (!mm.ok) return mm;
	const value: EditablePe = { kind: 'monthly', mm: mm.value as number[], source: (d.source ?? '').trim() };
	const e = peFormError(value);
	return e ? { ok: false, error: e.charAt(0).toLowerCase() + e.slice(1).replace(/\.$/, '') } : { ok: true, value };
}

/**
 * The form's PE draft for a stored input (absent is pan × A-pan, as the engine
 * runs it). Choosing `monthly` over a pan input starts the row from the PE GR4J
 * runs on now (the Settings form's withPeKind), with the source blank.
 */
export function peDraftOf(v: unknown, settings: Record<string, unknown> | undefined, kind?: PeKind): PeDraft {
	const cur = peOf({ pe: (v ?? null) as PeInput | null });
	const arr = (x: unknown) => (Array.isArray(x) ? (x as number[]) : []);
	const pe = kind ? withPeKind({ apanMm: arr(settings?.apanMm), panCoefficient: arr(settings?.panCoefficient), pe: cur }, kind) : cur;
	return pe.kind === 'pan' ? { kind: 'pan', mm: '', source: '' } : { kind: 'monthly', mm: pe.mm.join(' '), source: pe.source };
}

/** A stored value as editable text: the inverse of parseValue (months are ticked, not typed). */
export function valueText(spec: ValueSpec, v: unknown): string {
	if (v === null || v === undefined) return '';
	switch (spec.t) {
		case 'number':
			return typeof v === 'number' ? String(round(v * spec.scale)) : '';
		case 'monthly':
			return Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? String(round(x * spec.scale)) : '')).join(' ') : '';
		case 'bool':
			return v === true ? 'true' : v === false ? 'false' : '';
		case 'months':
			return Array.isArray(v) ? monthsText(v as number[]) : '';
		case 'pe':
			// The monthly row as typed; the kind and source are the PeDraft's (peDraftOf).
			return peDraftOf(v, undefined).mm;
		case 'curve':
			return Array.isArray(v) ? curveText(v as DamCurvePoint[]) : '';
		case 'reductions': {
			const r = v as { mar?: unknown; lowFlow?: unknown };
			return typeof r.mar === 'number' && typeof r.lowFlow === 'number' ? `${round(r.mar * 100)}; ${round(r.lowFlow * 100)}` : '';
		}
		default:
			return typeof v === 'string' ? v : String(v);
	}
}

/**
 * A stored value for people, with its unit: 150000 m³ → "150,000 m³",
 * 0.8 → "80 %", null → the field's "none" wording. `nodeName` names a node id.
 */
export function formatValue(spec: ValueSpec, v: unknown, nodeName: (id: string) => string = (id) => id): string {
	switch (spec.t) {
		case 'number': {
			if (v === null || v === undefined) return spec.nullLabel ?? 'none';
			if (typeof v !== 'number') return String(v);
			const x = v * spec.scale;
			const s = fmtNum(x, Math.abs(x) >= 1000 ? 0 : 4, true).replace('-', '−');
			return spec.unit === '%' ? `${s} %` : spec.unit ? `${s} ${spec.unit}` : s;
		}
		case 'enum':
			if (v === null || v === undefined) return spec.nullLabel ?? 'none';
			return spec.options.find((o) => o.value === v)?.label ?? String(v);
		case 'monthly': {
			if (!Array.isArray(v)) return 'none';
			const xs = v.map((x) => (typeof x === 'number' ? x * spec.scale : NaN));
			const u = spec.unit ? ` ${spec.unit}` : '';
			if (xs.every((x) => x === xs[0])) return `${fmtNum(xs[0], 4, true)}${u} every month`;
			return `${xs.map((x) => fmtNum(x, 4, true)).join(', ')}${u} (Oct–Sep)`;
		}
		case 'months':
			return Array.isArray(v) ? monthsText(v as number[]) : 'none';
		case 'bool':
			return v === true ? 'yes' : v === false ? 'no' : '–';
		case 'date':
			return typeof v === 'string' && v ? v : spec.nullLabel;
		case 'node':
			return typeof v === 'string' ? nodeName(v) : (spec.nullLabel ?? '–');
		case 'text':
			return typeof v === 'string' ? `“${v}”` : String(v);
		case 'pe':
			return peText(v === null || v === undefined ? null : (v as PeInput));
		case 'curve':
			return curveSummary(v);
		case 'reductions': {
			const r = (v ?? null) as { mar?: unknown; lowFlow?: unknown } | null;
			if (!r || typeof r.mar !== 'number' || typeof r.lowFlow !== 'number') return "the class's";
			return `MAR −${fmtNum(r.mar * 100, 1, true)} %, low flow −${fmtNum(r.lowFlow * 100, 1, true)} %`;
		}
	}
}

/** A survey curve in a few words: "none (power law)", or its rows and the volume at its top. */
function curveSummary(v: unknown): string {
	if (!Array.isArray(v) || v.length === 0) return 'none (power law)';
	const top = Math.max(...(v as DamCurvePoint[]).map((r) => r.volumeM3));
	return `${v.length} survey rows, ${fmtNum(top)} m³ at the top`;
}

/**
 * The engine's range message for a percentage field, in the percent the
 * person typed: "must be at most 1" → "must be at most 100 %".
 */
export function percentMessage(spec: ValueSpec, message: string): string {
	if (!('scale' in spec) || spec.scale !== 100) return message;
	return message.replace(/(at least|at most|above) (-?\d+(?:\.\d+)?)$/, (_, w: string, n: string) => `${w} ${round(Number(n) * 100)} %`);
}
