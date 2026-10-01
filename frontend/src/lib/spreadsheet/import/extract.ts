// The b023 workbook → project.json conversion: a TypeScript port of
// scripts/wbt-import/extract_project.py extract() (the project part; the
// expected.json regression fixture stays Python-only, decision D17).
//
// Parity rule: for the same workbook and options, `project` equals the
// Python's project.json key for key and value for value, and `notes` are its
// `note:` / `WARNING:` lines, same text, same order (the parity tests check
// both). `unmapped` is TypeScript-only (plan.md 1b).
import type { CalibrationParams, DemandObject, FlowShareMethod, NetworkNode, ProjectModel, ProjectSettings } from '@water-management/engine';
import type { WorkbookSource } from './source';
import { clean, num } from './cells';
import { extractCalibration, extractCalibrationWindow } from './calibration';
import { cropTableNotes, grossDemandNote, nonCropDemand, nonCropDemandObject, readCropAreas, readCrops, readFarmGross } from './crops';
import { InvalidImportOptionsError, InvalidWorkbookError, NotB023WorkbookError, UnsupportedVersionError } from './errors';
import { type FarmSpec, farmOperatingRules, readFarmSpec, runOfRiverNote } from './farms';
import { type ImportedSeries, readFlowData } from './flowData';
import { duplicateLogger, type GaugeScaling, gaugeAsReference, validateScaling } from './gauge';
import { projectIds } from './ids';
import { downstreamLinks, readNetwork } from './network';
import { type ImportNote, Report, type UnmappedItem } from './report';
import { checkTransferFormulas } from './transferFormulas';
import { modelWindow } from './modelWindow';
import { IMPORTED_OFFTAKE, offtakeNote, readTransfers } from './transfers';
import { B023Workbook } from './workbook';
import { zeroRainNote } from './zeroRain';

/** The settings extract_project.py writes (the rest take the app's defaults on import). */
export type ImportedSettings = Pick<
	ProjectSettings,
	'februaryDays' | 'effectiveRainFraction' | 'simulationStart' | 'simulationEnd' | 'calibrationStart' | 'calibrationEnd' | 'calibrationFlowKind'
> & {
	/** A-pan evaporation, mm per water-year month (12 values). */
	apanMm: number[];
	/** null only in the corner case FarmSpecTable.method describes. */
	flowShareMethod: FlowShareMethod | null;
	hiLoSplit: { hi: number; lo: number };
	calibration: CalibrationParams;
	/** Pragmatic EWR, m³/day per water-year month (one per row of zEWR_Pragmatic, 12 in b023). */
	ewrPragmaticM3PerDay: number[];
};

/**
 * What extract_project.py writes to project.json: the body of
 * `POST /projects/import` (backend/src/projects/document.ts ProjectFile).
 */
export interface ProjectFile {
	name: string;
	description: string;
	settings: ImportedSettings;
	model: ProjectModel;
	series: ImportedSeries[];
}

export interface ImportResult {
	project: ProjectFile;
	notes: ImportNote[];
	unmapped: UnmappedItem[];
}

export interface ExtractOptions {
	/**
	 * The workbook's file name (e.g. File.name). The project is named after its
	 * stem up to "_WBT", its description is "Imported from <file name>", and its
	 * ids derive from the name, as in the Python importer.
	 */
	fileName: string;
	/**
	 * --gauge-as-reference: import the [Flow data] gauge column as
	 * flow_reference_m3s (a gauge on another river) instead of observed flow.
	 * An object also undoes a known scaling of that column
	 * (--gauge-scaling-from / --gauge-scale-factor).
	 */
	gaugeAsReference?: boolean | GaugeScaling;
	/** Called as each part of the workbook is read: (sheet, step, steps). */
	onProgress?: (sheet: string, i: number, n: number) => void;
}

const STEPS = ['Network', 'Farm spec', 'Crop demand', 'Farm demand', 'Transfers', 'Flow Calibration Cfg', 'Flow data'] as const;

/** project_name(): the file stem up to "_WBT" (Python Path.stem). */
export function projectName(fileName: string): string {
	const base = fileName.split('/').pop()!;
	const dot = base.lastIndexOf('.');
	const stem = dot > 0 && dot < base.length - 1 ? base.slice(0, dot) : base;
	return stem.split('_WBT')[0] || stem;
}

/**
 * The code build in AppSettings zAppVer ("b022" in the b023 workbooks seen so
 * far). The importer reads the b02x builds; the named ranges it needs are the
 * real test, so a workbook without zAppVer (or with an unreadable one) goes
 * on to that check.
 */
export const SUPPORTED_BUILD = /^b02\d$/i;

function checkVersion(wb: B023Workbook): void {
	if (!wb.has('zAppVer') || wb.sheetOf('zAppVer') === null) return;
	const raw = clean(wb.cellNamed('zAppVer'));
	if (raw && !SUPPORTED_BUILD.test(raw)) throw new UnsupportedVersionError(raw);
}

/**
 * Convert a b023 Water Balance Tool workbook (read with readWorkbook()) into
 * a project, with the importer's notes and the unmapped report. Throws a
 * WorkbookImportError subclass when the file can't be imported.
 */
export function extractProject(workbook: WorkbookSource, opts: ExtractOptions): ImportResult {
	const wb = new B023Workbook(workbook);
	const reference = opts.gaugeAsReference ?? false;
	const scaling = typeof reference === 'object' ? validateScaling(reference) : null;
	if (typeof reference === 'object' && !scaling) throw new InvalidImportOptionsError('The gauge scaling needs both a date and a factor.');

	checkVersion(wb);
	const missing = wb.missingNames();
	if (missing.length) throw new NotB023WorkbookError(missing);

	const report = new Report();
	const step = (i: number) => opts.onProgress?.(STEPS[i]!, i + 1, STEPS.length);
	const name = projectName(opts.fileName);
	const uid = projectIds(name);

	step(0);
	const { elements, outflow } = readNetwork(wb, report);
	step(1);
	const spec = readFarmSpec(wb, report);
	step(2);
	const crops = readCrops(wb, report);
	step(3);
	const areas = readCropAreas(wb, report);
	step(4);
	const transfers = readTransfers(wb, report);

	const downstream = downstreamLinks(elements, outflow, report);
	const inNetwork = new Set(elements.map((e) => e.name));
	for (const farm of spec.farms.keys()) {
		if (!inNetwork.has(farm)) {
			report.unmap({ code: 'farm-spec-unknown-farm', message: `[Farm spec] farm ${farm} is not in [Network]; ignored`, sheet: 'Farm spec', element: farm });
		}
	}

	const nodes: NetworkNode[] = elements.map((e, order) => {
		const s: Partial<FarmSpec> = e.kind === 'farm' ? (spec.farms.get(e.name) ?? {}) : {};
		const isFarm = e.kind === 'farm';
		if (isFarm && !spec.farms.has(e.name)) {
			report.note('farm-missing-from-spec', `farm ${e.name} is missing from [Farm spec]; its parameters are 0, except upstream inflow to dam (100 %)`, {
				sheet: 'Farm spec',
				element: e.name
			});
		}
		const down = downstream.get(e.name) ?? null;
		return {
			id: uid(`node:${e.name}`),
			name: e.name,
			kind: e.kind,
			downstreamNodeId: down ? uid(`node:${down}`) : null,
			sortOrder: order,
			areaKm2: s.areaKm2 ?? 0,
			areaHiKm2: s.areaHiKm2 ?? 0,
			areaLoKm2: s.areaLoKm2 ?? 0,
			flowShareManual: isFarm ? (s.flowShareManual ?? null) : null,
			pctUpstreamToDam: s.pctUpstreamToDam ?? 1,
			pctRunoffToDam: s.pctRunoffToDam ?? 0,
			damCapacityM3: s.damCapacityM3 ?? 0,
			damInitialPct: s.damInitialPct ?? 0,
			divertCapacityM3Day: s.divertCapacityM3Day ?? 0,
			...farmOperatingRules(e.name, s, report)
		};
	});
	// A repeated element name maps to its last node, as the Python's dict does.
	const nodeId = new Map(nodes.map((n) => [n.name, n.id]));
	for (const n of nodes) {
		if (n.kind !== 'farm') continue;
		const note = runOfRiverNote(n.name, n.pctUpstreamToDam, n.damCapacityM3, n.divertCapacityM3Day, n.pctRunoffToDam);
		if (note) report.note('probable-run-of-river', note, { sheet: 'Farm spec', element: n.name });
	}
	const dams =nodes.filter((n) => n.kind === 'farm' && n.damCapacityM3 > 0);
	if (dams.length) {
		report.note(
			'dam-area-unknown',
			`${dams.length} dam(s) have no surface area in the workbook; runs estimate it as capacity / 3 m for dam ` +
				'evaporation (docs/engine-audit.md N2). Enter the areas in the app for a better figure',
			{ sheet: 'Farm spec' }
		);
	}

	for (const n of cropTableNotes(crops.crops)) report.note(n.code, n.message, { sheet: 'Crop demand', element: n.crop });
	const cropDefs = crops.crops.map((c) => ({ id: uid(`crop:${c.name}`), name: c.name, cropFactor: c.cropFactor }));
	const cropId = new Map(cropDefs.map((c) => [c.name, c.id]));
	const cropAreas: ProjectModel['cropAreas'] = [];
	for (const [farm, perCrop] of areas) {
		const node = nodeId.get(farm);
		if (node === undefined) {
			report.note('farm-demand-unknown-farm', `[Farm demand] farm ${farm} is not in [Network]; ignored`, { sheet: 'Farm demand', element: farm });
			continue;
		}
		for (const [crop, a] of perCrop) {
			if (a === 0) continue;
			const id = cropId.get(crop);
			if (id === undefined) {
				report.note('farm-demand-unknown-crop', `[Farm demand] crop ${crop} is not in [Crop demand]; ignored`, { sheet: 'Farm demand', element: farm });
				continue;
			}
			cropAreas.push({ nodeId: node, cropId: id, areaM2: a });
		}
	}
	const { gross, days } = readFarmGross(wb);
	const demandObjects: DemandObject[] = [];
	if (days !== null && days.length === 12 && days.every((d) => d > 0)) {
		const factors = new Map(crops.crops.map((c) => [c.name, c.cropFactor]));
		for (const [farm, perCrop] of areas) {
			const g = gross.get(farm);
			if (!nodeId.has(farm) || g === undefined || g.length !== 12) continue;
			const note = grossDemandNote(farm, perCrop, g, factors, crops.apan, days);
			if (note) report.note('farm-demand-gross-mismatch', note, { sheet: 'Farm demand', element: farm });
			// A demand above the crop areas (a town's, typed over the formula) becomes a demand object (issue #54, 2b).
			const extra = nonCropDemand(perCrop, g, factors, crops.apan, days);
			if (extra !== null) {
				const cropped = [...perCrop].some(([c, a]) => a > 0 && factors.has(c));
				demandObjects.push(nonCropDemandObject(uid, farm, nodeId.get(farm)!, extra, cropped, num(spec.farms.get(farm)?.returnFlowPct ?? null)));
			}
		}
	}

	const modelTransfers: ProjectModel['transfers'] = [];
	for (const t of transfers) {
		const fromId = nodeId.get(t.from);
		const toId = nodeId.get(t.to);
		if (fromId === undefined || toId === undefined) {
			report.note('transfer-unknown-element', `transfer ${t.from} -> ${t.to} names an unknown element; skipped`, { sheet: 'Transfers', element: t.from });
			continue;
		}
		modelTransfers.push({
			id: uid(`transfer:${t.from}>${t.to}:${t.column}`),
			fromNodeId: fromId,
			toNodeId: toId,
			months: t.months,
			maxRateM3s: t.maxRateM3s,
			dailyCapM3: null,
			minStoragePct: t.minStoragePct,
			enabled: t.enabled,
			// The workbook's columns ran in order; equal priorities would share a dam (Q18).
			priority: modelTransfers.length
		});
	}
	// A transfer the workbook fakes as a canal off-take (engine >= 1.14.0): into a unit with no dam and no demand,
	// from a probable run-of-river unit, is a river off-take (extract_project.py, same rule and note).
	{
		const byId = new Map(nodes.map((n) => [n.id, n]));
		const demanding = new Set([...cropAreas.filter((a) => a.areaM2 > 0).map((a) => a.nodeId), ...demandObjects.map((o) => o.nodeId)]);
		for (const t of modelTransfers) {
			const src = byId.get(t.fromNodeId)!;
			const dst = byId.get(t.toNodeId)!;
			const flagged = src.kind === 'farm' && runOfRiverNote(src.name, src.pctUpstreamToDam, src.damCapacityM3, src.divertCapacityM3Day, src.pctRunoffToDam) !== null;
			if (!flagged || dst.kind !== 'farm' || dst.damCapacityM3 > 0 || demanding.has(dst.id)) continue;
			Object.assign(t, IMPORTED_OFFTAKE);
			report.note('transfer-river-offtake', offtakeNote(src.name, dst.name, t.maxRateM3s, t.enabled), { sheet: 'Transfers', element: src.name });
		}
	}
	checkTransferFormulas(
		wb,
		transfers.filter((t) => nodeId.has(t.from) && nodeId.has(t.to)),
		report
	);

	step(5);
	const calibration = extractCalibration(wb);

	const ewrRef = wb.ref('zEWR_Pragmatic');
	const ewr = wb
		.named('zEWR_Pragmatic')
		.map((row, i) => report.num(row[0]!, { sheet: ewrRef.sheet, col: ewrRef.c1, row: ewrRef.r1 + i, what: 'Pragmatic EWR' }));
	const window = extractCalibrationWindow(wb);
	// calibrationFlowKind may be 'flow_pitman_m3s' until the checks below; the type is the final one.
	const settings = {
		februaryDays: februaryDays(wb),
		effectiveRainFraction: crops.effectiveRainFraction,
		apanMm: crops.apan,
		flowShareMethod: spec.method,
		hiLoSplit: spec.hiLoSplit,
		calibration,
		ewrPragmaticM3PerDay: ewr,
		simulationStart: null as string | null,
		simulationEnd: null as string | null,
		calibrationStart: window.calibrationStart,
		calibrationEnd: window.calibrationEnd,
		calibrationFlowKind: window.calibrationFlowKind
	};

	step(6);
	const flow = readFlowData(wb, report);
	if (!flow.dates.length) throw new InvalidWorkbookError('[Flow data] has no dated rows below its header', 'Flow data');
	const runWindow = modelWindow(wb, flow.dates);
	if (runWindow) {
		settings.simulationStart = runWindow.simulationStart;
		settings.simulationEnd = runWindow.simulationEnd;
		report.note('model-window', runWindow.note, { sheet: 'Home' });
	}
	const zero = zeroRainNote(flow.series);
	if (zero) report.note('zero-rain-runs', zero, { sheet: 'Flow data' });
	duplicateLogger(flow.series, settings, report);
	if (reference !== false) gaugeAsReference(flow.series, settings, scaling, report);
	if (flow.pitmanDays) {
		report.note(
			'pitman-not-imported',
			`[Flow data] Pitman flow column has ${flow.pitmanDays} days of values; not imported ` +
				'(the app has no Pitman input, so natural flow comes only from the rain model)',
			{ sheet: 'Flow data' }
		);
	}
	const kind = settings.calibrationFlowKind;
	if (kind === 'flow_pitman_m3s') {
		report.note(
			'pitman-calibration-unset',
			"WARNING: [Flow data] rUseFlow calibrates against Pitman flow, which the app doesn't support; " +
				'calibrationFlowKind left unset (runs use the gauge, else the logger)',
			{ sheet: 'Flow data' }
		);
		settings.calibrationFlowKind = null;
	} else if (kind && !flow.series.some((s) => s.kind === kind)) {
		report.note('calibration-flow-missing', `[Flow data] rUseFlow picks ${kind}, which has no values; calibrationFlowKind left unset`, { sheet: 'Flow data' });
		settings.calibrationFlowKind = null;
	}

	const project: ProjectFile = {
		name,
		description: `Imported from ${opts.fileName.split('/').pop()}`,
		settings: settings as ImportedSettings,
		model: { nodes, crops: cropDefs, cropAreas, transfers: modelTransfers, ...(demandObjects.length ? { demandObjects } : {}) },
		series: flow.series
	};
	return { project, notes: report.notes, unmapped: report.unmapped };
}

/** month_days(): February's days from AppSettings (28.25 when there's no "Feb" label). */
function februaryDays(wb: B023Workbook): number {
	const labels = wb.named('rAppSet_MonthLbls').map((r) => clean(r[0]!));
	const days = wb.named('zAppSet_MonthDays').map((r) => num(r[0]!));
	const i = labels.indexOf('Feb');
	if (i < 0) return 28.25;
	if (i >= days.length) throw new InvalidWorkbookError('AppSettings has fewer month days than month labels', 'AppSettings');
	return days[i]!;
}
