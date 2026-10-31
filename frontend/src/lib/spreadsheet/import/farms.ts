// [Farm spec]: each farm's area, dam and irrigation parameters, and the
// workbook's selected fragmentation, for the note (extract_project.py
// read_farm_spec and farm_operating_rules).
import { DAM_AREA_EXPONENT, irrigationFromReturnFlow, type NetworkNode } from '@water-management/engine';
import { clean, num, pyFormatG, pyRepr } from './cells';
import type { Report } from './report';
import type { B023Workbook } from './workbook';

/** A [Farm spec] row, every value num()'d as the Python does. */
export interface FarmSpec {
	areaKm2: number;
	/** "Selected fragmentation": expected.json's farmShares in the Python; not imported (issue #616). */
	selectedShare: number;
	pctUpstreamToDam: number;
	pctRunoffToDam: number;
	damCapacityM3: number;
	damInitialPct: number;
	damMinPct: number;
	divertCapacityM3Day: number;
	returnFlowPct: number;
}

const LABELS: Record<keyof FarmSpec, string> = {
	areaKm2: 'Total area',
	selectedShare: 'Selected fragmentation',
	pctUpstreamToDam: 'Upstream inflow to dam %',
	pctRunoffToDam: 'Farm runoff to dam %',
	damCapacityM3: 'Dam capacity',
	damInitialPct: 'Start storage %',
	damMinPct: 'Min dam %',
	divertCapacityM3Day: 'Diversion to dam (m³/day)',
	returnFlowPct: 'Irrigation return flow %'
};

export interface FarmSpecTable {
	/** By farm name, in table order (a repeated name keeps its first position and its last row's values). */
	farms: Map<string, FarmSpec>;
	/** Share-sum tolerance (expected.json only in the Python; kept for completeness). */
	tolerance: number;
}

/**
 * b023's fragmentation methods are retired (issue #616), and the app's
 * Fragmentation with them (issue #658): each unit makes its own runoff (Per
 * unit, the only method; an imported project stores no unitRain and runs Per
 * unit's defaults), and the EWR is split by each unit's natural MAR, so the workbook's
 * method, its Hi/Lo split and the High-/Low-MAP area and External
 * fragmentation columns aren't read (a workbook that still has them imports
 * as before). A method other than Area (Hi/Lo, Specific, or one the list
 * doesn't have) gets this note (flow_share_method_note; same text).
 */
export function flowShareMethodNote(methodRaw: string): string {
	return `[Farm spec] the workbook's fragmentation method ${pyRepr(methodRaw)} is not used: each unit makes its own runoff on its own rain (docs/model.md §2.4h)`;
}

/**
 * The defined name a workbook whose "Upstream inflow above dam %" formula has
 * been fixed carries (the fixed workbooks' `upstream` fix): its values already
 * mean the share into the dam.
 */
export const UPSTREAM_INTO_DAM_MARKER = 'zFarmSpec_UpstrInflowIntoDam';

/**
 * convert_upstream_pct(): b023 applied "Upstream inflow above dam %" to the
 * water passing below the dam (docs/model.md §3 Q1), and its values were
 * entered against that formula, so the import stores 1 − the value: the share
 * into the dam, as the engine reads it, keeping what the workbook ran (100 %
 * there was an off-channel dam). A workbook carrying UPSTREAM_INTO_DAM_MARKER
 * has the fixed formula, and its values import as they are.
 */
function convertUpstreamPct(wb: B023Workbook, farms: Map<string, FarmSpec>, report: Report, sheet: string): void {
	if (!farms.size) return;
	if (wb.has(UPSTREAM_INTO_DAM_MARKER)) {
		report.note(
			'upstream-pct-as-entered',
			"[Farm spec] Upstream inflow above dam %: this workbook's formula is the fixed one (the share into the dam), so its values are imported as they are (docs/model.md §3 Q1)",
			{ sheet }
		);
		return;
	}
	for (const f of farms.values()) f.pctUpstreamToDam = 1 - f.pctUpstreamToDam;
	report.note(
		'upstream-pct-converted',
		"[Farm spec] Upstream inflow above dam %: the workbook's formula sends that share past the dam, not into it, so the import " +
			"stores 100 % − the workbook's value, which keeps what the workbook ran: 100 % there is an off-channel dam (0 % " +
			'here), 0 % a dam on the river (100 % here). Check each dam (docs/model.md §3 Q1)',
		{ sheet }
	);
}

/** read_farm_spec(). */
export function readFarmSpec(wb: B023Workbook, report: Report): FarmSpecTable {
	const { sheet, rows, names } = wb.tableRows('zFarmSpec_FarmNameLst');
	const col = (n: string) => wb.ref(n).c1;
	const cols: Record<keyof FarmSpec, number> = {
		areaKm2: col('rFarmSpec_AreaTotal'),
		selectedShare: col('zFarmSpec_PercFragmLst'),
		pctUpstreamToDam: col('zFarmSpec_PercUpstrInflowToDamLst'),
		pctRunoffToDam: col('zFarmSpec_PercFarmRunoffToDamList'),
		damCapacityM3: col('zFarmSpec_CompositeDamVol'),
		damInitialPct: col('zFarmSpec_StartStoragePercLst'),
		damMinPct: col('zFarmSpec_CompositeDamMinPerc'),
		divertCapacityM3Day: col('zFarmSpec_DiversionToDam'),
		returnFlowPct: col('zFarmSpec_PercIrrReturnFlow')
	};
	const farms = new Map<string, FarmSpec>();
	rows.forEach((r, i) => {
		const name = names[i]!;
		const spec = {} as FarmSpec;
		for (const key of Object.keys(cols) as (keyof FarmSpec)[]) {
			spec[key] = report.num(wb.cell(sheet, cols[key], r), { sheet, col: cols[key], row: r, what: LABELS[key], element: name });
		}
		farms.set(name, spec);
	});

	convertUpstreamPct(wb, farms, report, sheet);
	if (wb.has('rFarmSpec_SelectedMethod')) {
		const methodRaw = clean(wb.cellNamed('rFarmSpec_SelectedMethod'));
		const methods = wb.has('rFarmSpec_Methods') ? wb.named('rFarmSpec_Methods').map((row) => clean(row[0]!)) : []; // Area, Hi/Lo, Specific
		const area = methods[0] ?? 'Area';
		if (methodRaw && methodRaw !== area) report.note('unused-flow-share-method', flowShareMethodNote(methodRaw), { sheet });
	}
	return { farms, tolerance: num(wb.cellNamed('rFarmSpec_FragmentationTolerance'), 0.0002) };
}

export interface OperatingRules {
	damMinPct: number;
	irrigationEfficiency: number;
	returnFlowFraction: number;
	damAreaFullM2: null;
	damAreaExponent: number;
	damSeepagePerDay: number;
}

/**
 * farm_operating_rules(): the node's operating-rule fields (engine ≥ 0.16.0).
 *
 * Q5: the workbook's "min %" is the transfer minimum, which each transfer
 * rule carries, so the dam's minimum operating level is 0, with a note when
 * the workbook had one. N1: the return flow % r becomes an efficiency and a
 * return flow (all the losses), as migration 006 maps it. N2: the workbook has no dam
 * surface areas (the caller notes the dams once).
 */
export function farmOperatingRules(name: string, spec: Partial<FarmSpec>, report: Report): OperatingRules {
	const wbMin = num(spec.damMinPct ?? null);
	if (wbMin) {
		report.note(
			'dam-min-is-transfer-minimum',
			`farm ${name}: [Farm spec] min dam % ${pyFormatG(wbMin)} is the workbook's transfer minimum (each transfer rule ` +
				"keeps its own); the dam's minimum operating level is left at 0 (docs/engine-audit.md Q5)",
			{ sheet: 'Farm spec', element: name }
		);
	}
	const r = num(spec.returnFlowPct ?? null);
	return { damMinPct: 0, ...irrigationFromReturnFlow(r), damAreaFullM2: null, damAreaExponent: DAM_AREA_EXPONENT, damSeepagePerDay: 0 };
}

// A probable run-of-river unit (issue #54, 2d): extract_project.py
// run_of_river_note, whose comment has the full reasoning. b023 has no river
// abstraction, so a unit that pumps straight from the river is entered as a
// "dummy dam" that takes 100 % of the upstream inflow and either is a pool
// (under 1 % of a day of its diversion capacity, or under 1 m³: the diversion
// refills it within 15 minutes, so it stores nothing across a daily step,
// where a real farm dam holds days to months of its diversion) or holds
// exactly a whole number of m³/s for one day and takes none of the farm's own
// runoff (a real on-channel dam catches that runoff too, which rules out a
// surveyed capacity that happens to be a multiple of 86,400 m³). By default the
// importer only warns, for the modeller to confirm; the run-of-river option
// converts the flagged units (asRunOfRiver, below).
const RUN_OF_RIVER_PCT_UPSTREAM = 0.9999; // 100 %, allowing for float rounding
const RUN_OF_RIVER_POOL_SHARE_OF_DIVERSION = 0.01;
const RUN_OF_RIVER_POOL_MAX_M3 = 1;
const SECONDS_PER_DAY = 86400;

/** The WARNING for a farm with no dam that takes 100 % of the upstream inflow (no_dam_note; same text). */
export function noDamNote(name: string): string {
	return (
		`WARNING: farm ${name}: probable run-of-river, for the modeller to confirm: it has no dam but takes 100 % of the ` +
		'upstream inflow, and a farm without a dam irrigates straight from the river routed to it, with no pump limit. ' +
		'Set its supply rule to run of river with a pump capacity to cap it (issue #54, 2d)'
	);
}

/** run_of_river_note(): a WARNING when a farm's dam looks like b023's dummy dam for a unit that pumps from the river. */
export function runOfRiverNote(name: string, pctUpstream: number, capacity: number, divert: number, pctRunoff: number): string | null {
	if (pctUpstream < RUN_OF_RIVER_PCT_UPSTREAM) return null;
	// No dam at all: the engine lets a dam-less farm irrigate from the river routed to it, with no limit
	// (docs/model.md §2.7e), where b023's formula gave it nothing (issue #54).
	if (capacity <= 0) return noDamNote(name);
	let why: string;
	if (capacity < RUN_OF_RIVER_POOL_MAX_M3 || capacity < RUN_OF_RIVER_POOL_SHARE_OF_DIVERSION * divert) {
		why = `is a pool of ${pyFormatG(capacity)} m³`;
		if (divert > 0) why += ` against a diversion capacity of ${Math.floor(divert + 0.5)} m³/day`;
	} else {
		const rate = Math.floor(capacity / SECONDS_PER_DAY + 0.5);
		if (rate < 1 || Math.abs(capacity - rate * SECONDS_PER_DAY) > 1 || pctRunoff !== 0) return null;
		why = `holds exactly ${rate} m³/s for one day (${Math.floor(capacity + 0.5)} m³) and takes none of the farm's own runoff`;
	}
	return (
		`WARNING: farm ${name}: probable run-of-river, for the modeller to confirm: its dam takes 100 % of the upstream ` +
		`inflow and ${why}. The workbook has no river abstraction, so a unit that pumps from the river is entered as a dummy dam; ` +
		'the app imports it as a farm dam, so its dam results (storage, spill, level) mean nothing (issue #54, 2d)'
	);
}

// A small pool (issue #90 Q18, answered 2026-10-11): extract_project.py
// small_pool_note, whose comment has the reasoning. A farm dam that takes less
// than 100 % of the upstream inflow (so runOfRiverNote never flags it) and holds
// under 100 m³ or under 1 % of a day of its diversion capacity. A pool's
// capacity is user defined and even a small one stays in the model, so this is
// a neutral note of the capacity, not a warning.
const SMALL_POOL_MAX_M3 = 100;

/** small_pool_note(): a neutral note of a small pool's capacity, for a dam runOfRiverNote leaves alone (same text). */
export function smallPoolNote(name: string, pctUpstream: number, capacity: number, divert: number): string | null {
	if (capacity <= 0 || pctUpstream >= RUN_OF_RIVER_PCT_UPSTREAM) return null;
	if (!(capacity < SMALL_POOL_MAX_M3 || capacity < RUN_OF_RIVER_POOL_SHARE_OF_DIVERSION * divert)) return null;
	return `farm ${name}: a small pool of ${pyFormatG(capacity)} m³, imported as entered (a pool's capacity is user defined, issue #90 Q18)`;
}

/**
 * as_run_of_river(): with the run-of-river option (--run-of-river), turn a
 * unit runOfRiverNote() flags into a run-of-river unit, in place, and say so
 * (same text). b023 has no pump capacity, and nothing in it caps what a dummy
 * dam or a dam-less farm takes from the water routed to it, so the river pump
 * is left uncapped (null), as the workbook had it; the modeller enters the
 * real capacity. A dummy dam's storage is dropped, since run of river has no
 * dam (the model rules refuse one). A unit that is the source of an enabled
 * transfer from its dam keeps the dam, which the transfer draws on, and the
 * note says why nothing changed. New keys go after the existing ones, as
 * Python's dict.update() puts them (the parity test compares key order).
 */
export function asRunOfRiver(
	node: Pick<NetworkNode, 'name' | 'damCapacityM3' | 'damInitialPct' | 'supplyRule' | 'pumpCapacityM3Day'>,
	sourceOfTransfer: boolean
): string {
	const name = node.name;
	if (sourceOfTransfer) {
		return (
			`WARNING: farm ${name}: not imported as run of river (--run-of-river): an enabled transfer draws on its dam, ` +
			'so it stays a farm dam; convert it by hand once the transfer is settled (issue #54, 2d)'
		);
	}
	const dropped = node.damCapacityM3;
	Object.assign(node, { damCapacityM3: 0, damInitialPct: 0, supplyRule: 'runOfRiver', pumpCapacityM3Day: null });
	const what = dropped > 0 ? `its ${Math.floor(dropped + 0.5)} m³ dummy dam is dropped` : 'it has no dam';
	return (
		`WARNING: farm ${name}: imported as run of river (--run-of-river): ${what}, and a river pump takes its demand ` +
		'from the river below it. The workbook gives no pump capacity (it has none, and nothing there capped this ' +
		"unit's take), so the pump is uncapped and each run warns; enter the capacity in the Network tab's Supply " +
		'section (issue #54, 2c/2d)'
	);
}
