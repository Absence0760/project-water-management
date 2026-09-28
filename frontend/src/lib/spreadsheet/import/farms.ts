// [Farm spec]: each farm's areas, flow share, dam and irrigation parameters,
// and the fragmentation method (extract_project.py read_farm_spec and
// farm_operating_rules).
import { DAM_AREA_EXPONENT, irrigationFromReturnFlow, type FlowShareMethod } from '@water-management/engine';
import { cellAddress, clean, num, pyFormatG, pyRepr } from './cells';
import type { Report } from './report';
import type { B023Workbook } from './workbook';

/** A [Farm spec] row, every value num()'d as the Python does. */
export interface FarmSpec {
	areaKm2: number;
	areaHiKm2: number;
	areaLoKm2: number;
	flowShareManual: number;
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
	areaHiKm2: 'Hi area',
	areaLoKm2: 'Lo area',
	flowShareManual: 'External fragmentation',
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
	/** null only when the method matches a fourth or later entry of rFarmSpec_Methods (the Python's dict lookup gives None). */
	method: FlowShareMethod | null;
	hiLoSplit: { hi: number; lo: number };
	/** Share-sum tolerance (expected.json only in the Python; kept for completeness). */
	tolerance: number;
}

const METHODS: FlowShareMethod[] = ['area', 'hiLo', 'manual'];

/** read_farm_spec(). */
export function readFarmSpec(wb: B023Workbook, report: Report): FarmSpecTable {
	const { sheet, rows, names } = wb.tableRows('zFarmSpec_FarmNameLst');
	const col = (n: string) => wb.ref(n).c1;
	const { c1: cHi, c2: cLo } = wb.ref('rFarmSpec_DataAreas');
	const cSel = col('zFarmSpec_PercFragmLst');
	const cols: Record<keyof FarmSpec, number> = {
		areaKm2: col('rFarmSpec_AreaTotal'),
		areaHiKm2: cHi,
		areaLoKm2: cLo,
		// "External fragmentation copied (%)" sits just left of "Selected".
		flowShareManual: cSel - 1,
		selectedShare: cSel,
		pctUpstreamToDam: col('zFarmSpec_PercUpstrInflowToDamLst'),
		pctRunoffToDam: col('zFarmSpec_PercFarmRunoffToDamList'),
		damCapacityM3: col('zFarmSpec_CompositeDamVol'),
		damInitialPct: col('zFarmSpec_StartStoragePercLst'),
		damMinPct: col('zFarmSpec_CompositeDamMinPerc'),
		divertCapacityM3Day: col('zFarmSpec_DiversionToDam'),
		returnFlowPct: col('zFarmSpec_PercIrrReturnFlow')
	};
	const farms = new Map<string, FarmSpec>();
	const blankShares: { name: string; row: number }[] = [];
	rows.forEach((r, i) => {
		const name = names[i]!;
		const spec = {} as FarmSpec;
		for (const key of Object.keys(cols) as (keyof FarmSpec)[]) {
			const v = wb.cell(sheet, cols[key], r);
			spec[key] = report.num(v, { sheet, col: cols[key], row: r, what: LABELS[key], element: name });
			if (key === 'flowShareManual' && (v === null || v === '')) blankShares.push({ name, row: r });
		}
		farms.set(name, spec);
	});

	const methodRaw = clean(wb.cellNamed('rFarmSpec_SelectedMethod'));
	const methods = wb.named('rFarmSpec_Methods').map((row) => clean(row[0]!)); // Area, Hi/Lo, Specific
	const idx = methods.indexOf(methodRaw);
	const method = idx >= 0 ? (METHODS[idx] ?? null) : 'area';
	if (idx < 0) report.note('unknown-flow-share-method', `unknown fragmentation method ${pyRepr(methodRaw)}; using area`, { sheet });
	// Specific (manual) shares with a blank share: the Python reads it as 0 without a word.
	if (method === 'manual') {
		for (const { name, row } of blankShares) {
			report.unmap({
				code: 'flow-share-missing',
				message: `[Farm spec] the Specific fragmentation method is selected but ${name} has no External fragmentation value (${cellAddress(cols.flowShareManual, row)}); its flow share is imported as 0`,
				sheet,
				cell: cellAddress(cols.flowShareManual, row),
				element: name
			});
		}
	}
	const sel = wb.ref('rFarmSpec_SelectedMethod');
	const hi = wb.cell(sel.sheet, cHi, sel.r1);
	const lo = wb.cell(sel.sheet, cLo, sel.r1);
	return {
		farms,
		method,
		hiLoSplit: { hi: num(hi, 0.5), lo: num(lo, 0.5) },
		tolerance: num(wb.cellNamed('rFarmSpec_FragmentationTolerance'), 0.0002)
	};
}

export interface OperatingRules {
	damMinPct: number;
	irrigationEfficiency: number;
	lossReturnFraction: number;
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
 * loss return fraction, as migration 006 maps it. N2: the workbook has no dam
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
// surveyed capacity that happens to be a multiple of 86,400 m³). The importer
// only warns: the modeller confirms, and run-of-river supply waits for pump
// capacity (#54, 2c).
const RUN_OF_RIVER_PCT_UPSTREAM = 0.9999; // 100 %, allowing for float rounding
const RUN_OF_RIVER_POOL_SHARE_OF_DIVERSION = 0.01;
const RUN_OF_RIVER_POOL_MAX_M3 = 1;
const SECONDS_PER_DAY = 86400;

/** run_of_river_note(): a WARNING when a farm's dam looks like b023's dummy dam for a unit that pumps from the river. */
/** The WARNING for a farm with no dam that takes 100 % of the upstream inflow (no_dam_note; same text). */
export function noDamNote(name: string): string {
	return (
		`WARNING: farm ${name}: probable run-of-river, for the modeller to confirm: it has no dam but takes 100 % of the ` +
		'upstream inflow, and a farm without a dam irrigates straight from the river routed to it, with no pump limit. ' +
		'Set its supply rule to run of river with a pump capacity to cap it (issue #54, 2d)'
	);
}

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
		`inflow and ${why}. b023 has no river abstraction, so a unit that pumps from the river is entered as a dummy dam; ` +
		'the app imports it as a farm dam, so its dam results (storage, spill, level) mean nothing (issue #54, 2d)'
	);
}
