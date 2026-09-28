// Fit-settings sweep: fits GR4J to a project.json once per cell of a grid of
// fit settings (pan preset × bounds × objective × named exclusion set ×
// WR2012 MAR band on/off), each with the split-sample and dry → wet
// validation (and the other observed record when the project has both), then
// runs the fitted model and writes one Markdown table: the fitted parameters,
// the in-sample and validation scores, natural MAR (and its ratio to WR2012)
// and EWR days not met, with the engine version, seed, starts and budget in
// the header (docs/model.md §2.10b, "Fit-settings sweep").
//
// It fits every cell and ranks nothing: which fit to use stays the
// hydrologist's choice, recorded with a reason as exclusions are. It is not
// CR-21 (that perturbs the inputs of one fit; this compares fits).
//
//   pnpm fit-sweep <project.json> --grid <grid.json> [--out <file.md>] [--json <file.json>]
//                  [--seed <n>] [--starts <n>] [--budget <n>] [--max-cells <n>]
//
// The grid file (every axis optional; an omitted axis is one default cell):
//   {
//     "panPresets": ["project", "generic", "winter-rainfall", 0.6, { "label": "mine", "values": [12 numbers, Oct–Sep] }],
//     "bounds": ["wide", "typical"],
//     "objectives": ["kgePrime", "nseLog"],
//     "exclusionSets": { "none": [], "drop-2019": [{ "start": "2019-01-01", "end": "2019-12-31", "reason": "logger silted" }] },
//     "wr2012Band": [false, true],
//     "wr2012Penalty": { "weight": 0.5, "marLowMm3": 1.2, "marHighMm3": 1.8 }
//   }
// Defaults: the project's own pan coefficient, wide bounds, KGE′, no extra
// exclusions (the project's stored ones always apply) and the WR2012 penalty
// as the project has it. `wr2012Penalty` overrides the stored penalty's weight
// and band for the cells with the band on.
//
// Pure engine, no DB and no server. Every cell is a full calibration (1 500
// runs per fit by default, three or four fits per cell), so a grid over a
// decades-long record takes a while: the cell count is capped
// (DEFAULT_MAX_CELLS) unless --max-cells raises it. A report run against the
// client catchment holds real figures: keep it in the gitignored data/.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
	calibrate,
	CALIBRATION_BOUNDS,
	CALIBRATION_FLOW_KINDS,
	DEFAULT_STARTS,
	ENGINE_VERSION,
	exclusionLabel,
	exclusionRanges,
	MAX_STARTS,
	OBJECTIVES,
	PAN_COEFFICIENT_PRESETS,
	runModel,
	WR2012_MAX_PENALTY_WEIGHT,
	wr2012PenaltyIssues,
	type CalibrationBounds,
	type CalibrationExclusion,
	type CalibrationFlowKind,
	type FitScores,
	type ModelInput,
	type ObjectiveId,
	type ParamSet,
	type ProjectSettings
} from '@water-management/engine';
import { z } from 'zod';
import { CalibrationExclusion as CalibrationExclusionSchema } from '../src/projects/settings.js';
import { modelInputOf, type ProjectDocument } from './fit-project.js';
import { cliPath, metricsOf, panSensitivityRefusal, withPanCoefficient } from './pan-sensitivity.js';

/** Most cells a sweep runs unless --max-cells raises it: each is a full calibration with validation. */
export const DEFAULT_MAX_CELLS = 24;

const PRESET_IDS = () => PAN_COEFFICIENT_PRESETS.map((p) => p.id);

const unique = <T>(key: (v: T) => string, what: string) => (list: T[], ctx: z.RefinementCtx) => {
	const seen = new Set<string>();
	for (const v of list) {
		const k = key(v);
		if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `${what} ${k} is listed twice` });
		seen.add(k);
	}
};

const panCoefficientValue = z.number().min(0).max(2);
const PanEntry = z.union([
	z.string().superRefine((s, ctx) => {
		if (s !== 'project' && !PRESET_IDS().includes(s))
			ctx.addIssue({ code: 'custom', message: `unknown pan preset "${s}": use "project", one of ${PRESET_IDS().join(', ')}, a flat coefficient (a number) or { "label", "values" }` });
	}),
	panCoefficientValue,
	z.object({ label: z.string().trim().min(1).max(60), values: z.array(panCoefficientValue).length(12, 'a pan coefficient row has 12 months, Oct–Sep') }).strict()
]);
type PanEntry = z.infer<typeof PanEntry>;

const exclusionSetName = z.string().trim().min(1).max(40);

/** The grid file, as `--grid` reads it. Every axis is optional. */
export const FitGrid = z
	.object({
		panPresets: z.array(PanEntry).min(1).superRefine(unique((p) => panLabel(p), 'pan preset')).optional(),
		bounds: z.array(z.enum(CALIBRATION_BOUNDS)).min(1).superRefine(unique((b) => b, 'bounds')).optional(),
		objectives: z.array(z.enum(OBJECTIVES)).min(1).superRefine(unique((o) => o, 'objective')).optional(),
		exclusionSets: z
			.record(exclusionSetName, z.array(CalibrationExclusionSchema).max(100))
			.refine((r) => Object.keys(r).length > 0, 'exclusionSets needs at least one named set (use { "none": [] } for no extra exclusions)')
			.optional(),
		wr2012Band: z.array(z.boolean()).min(1).superRefine(unique((b) => String(b), 'wr2012Band')).optional(),
		wr2012Penalty: z
			.object({
				weight: z.number().gt(0).max(WR2012_MAX_PENALTY_WEIGHT).optional(),
				marLowMm3: z.number().nonnegative().nullable().optional(),
				marHighMm3: z.number().nonnegative().nullable().optional()
			})
			.strict()
			.optional()
	})
	.strict();
export type FitGrid = z.infer<typeof FitGrid>;

/** The grid file checked, or an Error naming every problem by its path. */
export function parseGrid(raw: unknown): FitGrid {
	const r = FitGrid.safeParse(raw);
	if (r.success) return r.data;
	const lines = r.error.issues.map((i) => `  ${i.path.length ? i.path.join('.') : '(grid)'}: ${i.message}`);
	throw new Error(`the grid file is not valid:\n${lines.join('\n')}`);
}

function panLabel(p: PanEntry): string {
	if (typeof p === 'number') return `flat ${p.toFixed(2)}`;
	if (typeof p === 'string') return p;
	return p.label;
}

/** One cell of the grid: the fit settings a calibration runs with. */
export interface SweepCell {
	/** "project" (the project's own row), a preset id, "flat 0.60", or a label from the grid. */
	pan: { label: string; values: number[] | null };
	bounds: CalibrationBounds;
	objective: ObjectiveId;
	exclusionSet: string;
	/** On top of the project's stored settings.calibrationExclusions, which always apply. */
	exclusions: CalibrationExclusion[];
	wr2012Band: boolean;
}

/**
 * Every cell of the grid, in axis order (pan preset, then bounds, objective,
 * exclusion set, WR2012 band), each omitted axis at its default. `bandDefault`
 * is the project's own settings.wr2012.calibrationPenalty.enabled.
 */
export function expandGrid(grid: FitGrid, bandDefault: boolean): SweepCell[] {
	const pans = (grid.panPresets ?? ['project']).map((p) => ({
		label: panLabel(p),
		values: typeof p === 'number' ? new Array(12).fill(p) : typeof p === 'string' ? (p === 'project' ? null : [...PAN_COEFFICIENT_PRESETS.find((x) => x.id === p)!.values]) : [...p.values]
	}));
	const bounds = grid.bounds ?? ['wide'];
	const objectives = grid.objectives ?? ['kgePrime'];
	const sets = Object.entries(grid.exclusionSets ?? { none: [] });
	const bands = grid.wr2012Band ?? [bandDefault];
	const cells: SweepCell[] = [];
	for (const pan of pans)
		for (const b of bounds)
			for (const objective of objectives)
				for (const [exclusionSet, exclusions] of sets)
					for (const wr2012Band of bands) cells.push({ pan, bounds: b, objective, exclusionSet, exclusions: exclusions as CalibrationExclusion[], wr2012Band });
	return cells;
}

/** The WR2012 penalty a cell fits with: the stored one, the grid's overrides, and the cell's on/off. */
function cellPenalty(settings: ProjectSettings, grid: FitGrid, on: boolean) {
	const stored = settings.wr2012.calibrationPenalty;
	return { ...stored, ...(on ? grid.wr2012Penalty : {}), enabled: on };
}

/** Why the sweep can't run these cells on this project (or run this many), or null. */
export function sweepRefusal(cells: SweepCell[], settings: ProjectSettings, grid: FitGrid, maxCells: number): string | null {
	if (cells.length > maxCells)
		return `the grid has ${cells.length} cells, more than ${maxCells}: each is a full calibration with validation, so raise --max-cells if you mean it`;
	if (cells.some((c) => c.pan.values !== null)) {
		const pan = panSensitivityRefusal(settings);
		if (pan) return `a pan preset other than "project" is in the grid, but ${pan}`;
	}
	if (cells.some((c) => c.wr2012Band)) {
		if (!settings.wr2012.reference) return 'wr2012Band true needs a WR2012 reference in the project (settings.wr2012.reference); there is none, so the penalty would do nothing';
		const issues = wr2012PenaltyIssues(cellPenalty(settings, grid, true));
		if (issues.length) return `the WR2012 penalty the band cells would use is not valid: ${issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`;
	}
	return null;
}

export interface CalibrateSettings {
	seed: number;
	starts: number;
	budget?: number;
	/** The other observed record to validate against, when the project has both. */
	validationRecord?: CalibrationFlowKind;
}

export interface CellResult {
	cell: SweepCell;
	params: ParamSet;
	free: string[];
	flowKind: string;
	budget: number;
	/** In-sample over the whole calibration window. */
	fit: FitScores;
	/** Scores on the held-out part of each validation test; null when the record didn't allow it. */
	splitValidation: FitScores | null;
	dryWetValidation: FitScores | null;
	independentValidation: FitScores | null;
	/** Mean annual simulated natural flow with the fitted parameters, whole run (Mm³/a). */
	naturalMarMm3: number;
	/** Simulated natural MAR ÷ scaled WR2012 MAR, on the basis the run's WR2012 flag uses; null without a reference. */
	wr2012MarRatio: number | null;
	ewrDaysNotMet: number;
	ewrFractionDaysNotMet: number;
	notes: string[];
}

/** The project's fitted record and the other one to validate against, as fit-project.ts picks them. */
export function validationRecordOf(doc: ProjectDocument, settings: ProjectSettings): CalibrationFlowKind | undefined {
	const kinds = new Set((doc.series ?? []).map((s) => s.kind));
	const fitted = settings.calibrationFlowKind ?? (kinds.has('flow_observed_m3s') ? 'flow_observed_m3s' : 'flow_logger_m3s');
	return CALIBRATION_FLOW_KINDS.find((k) => k !== fitted && kinds.has(k));
}

/** A project's engine input with every setting filled in, as the sweep reads it. */
export type SweepInput = ModelInput & { settings: ProjectSettings };

/** The document's engine input: its settings merged over the defaults (fit-project.ts modelInputOf, so they are complete). */
export const sweepInputOf = (doc: ProjectDocument): SweepInput => modelInputOf(doc) as SweepInput;

/** Fit one cell with validation, then run the fitted model for MAR and EWR. */
export function runCell(base: SweepInput, cell: SweepCell, grid: FitGrid, cal: CalibrateSettings): CellResult {
	const panned = withPanCoefficient(base.settings, cell.pan.values ?? (base.settings.panCoefficient as unknown as number[]));
	const settings = { ...panned, wr2012: { ...panned.wr2012, calibrationPenalty: cellPenalty(base.settings, grid, cell.wr2012Band) } };
	const input: ModelInput = { ...base, settings };
	const report = calibrate(input, {
		model: 'gr4j',
		objective: cell.objective,
		bounds: cell.bounds,
		seed: cal.seed,
		starts: cal.starts,
		...(cal.budget !== undefined ? { budget: cal.budget } : {}),
		validate: true,
		exclusions: exclusionRanges(cell.exclusions),
		...(cal.validationRecord ? { validationRecord: cal.validationRecord } : {})
	});
	const out = runModel({ ...input, settings: { ...settings, gr4j: { ...settings.gr4j, ...report.params } } });
	const m = metricsOf(out);
	const w = out.summary.wr2012;
	return {
		cell,
		params: report.params,
		free: report.free,
		flowKind: report.flowKind,
		budget: report.budget,
		fit: report.fit.scores,
		splitValidation: report.splitSample?.validation.scores ?? null,
		dryWetValidation: report.differential?.validation.scores ?? null,
		independentValidation: report.independentRecord?.validation.scores ?? null,
		naturalMarMm3: m.marMm3,
		wr2012MarRatio: w ? ((w.flag.basis === 'overlap' ? w.overlap?.ratio : w.whole.ratio) ?? null) : null,
		ewrDaysNotMet: m.ewrDaysNotMet,
		ewrFractionDaysNotMet: m.ewrFractionDaysNotMet,
		notes: report.notes
	};
}

const fmt = (v: number | null | undefined, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits));
/** A score in the cell's own objective (FitScores holds one field per objective id). */
const scoreOf = (s: FitScores | null, objective: ObjectiveId) => (s ? ((s as unknown as Record<string, number | null>)[objective] ?? null) : null);

export interface SweepMeta {
	file: string;
	seed: number;
	starts: number;
	budget: number | undefined;
	validationRecord: CalibrationFlowKind | undefined;
	grid: FitGrid;
	generatedAt: string;
}

export function toMarkdown(results: CellResult[], meta: SweepMeta): string {
	const budget = meta.budget ?? results[0]?.budget;
	const sets = Object.entries(meta.grid.exclusionSets ?? {});
	const lines = [
		'# Fit-settings sweep (local only)',
		'',
		'Generated by `backend/scripts/fit-sweep.ts` (docs/model.md §2.10b). One GR4J',
		'calibration per cell, each with split-sample and dry → wet validation, then a',
		'run with the fitted parameters. Every cell is fitted and nothing is ranked:',
		'the choice of fit is the hydrologist’s, recorded with a reason.',
		'',
		`Engine ${ENGINE_VERSION}; seed ${meta.seed}, ${meta.starts} starts, ${budget ?? 'the default'} runs per fit.`,
		`Fitted to \`${results[0]?.flowKind ?? '–'}\`; independent record: ${meta.validationRecord ? `\`${meta.validationRecord}\`` : 'none'}.`,
		'',
		`Source: \`${meta.file}\` — generated ${meta.generatedAt}.`,
		'',
		'Scores are in each cell’s own objective (Obj.), so they compare only between',
		'cells with the same objective; KGE′ is given for every cell. The project’s',
		'stored calibration exclusions apply to every cell, on top of the named set.',
		'MAR is simulated natural flow over the whole run; MAR ÷ WR2012 is on the basis',
		'the run’s WR2012 check uses.',
		'',
		'This file may hold real catchment figures: keep it in the gitignored data/',
		'and never copy its numbers into a tracked file (docs/security.md).',
		''
	];
	if (sets.some(([, list]) => list.length)) {
		lines.push('Exclusion sets:', '');
		for (const [name, list] of sets)
			lines.push(`- **${name}**: ${list.length ? list.map((x) => `${exclusionLabel(x as CalibrationExclusion)} (${x.reason})`).join('; ') : 'none'}`);
		lines.push('');
	}
	if (meta.grid.wr2012Penalty) lines.push(`WR2012 penalty for band cells: ${JSON.stringify(meta.grid.wr2012Penalty)} over the project’s stored one.`, '');
	lines.push(
		'| # | Pan | Bounds | Objective | Exclusions | WR2012 band | X1 | X2 | X3 | X4 | Obj. fit | KGE′ fit | Obj. split val. | KGE′ split val. | Obj. dry→wet val. | Obj. indep. record | Natural MAR (Mm³/a) | MAR ÷ WR2012 | EWR days not met | EWR % |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	);
	results.forEach((r, i) => {
		const c = r.cell;
		const p = r.params;
		const o = c.objective;
		lines.push(
			`| ${i + 1} | ${c.pan.label} | ${c.bounds} | ${o} | ${c.exclusionSet} | ${c.wr2012Band ? 'on' : 'off'} | ${fmt(p.x1, 1)} | ${fmt(p.x2, 2)} | ${fmt(p.x3, 1)} | ${fmt(p.x4, 2)} | ${fmt(scoreOf(r.fit, o), 3)} | ${fmt(r.fit.kgePrime, 3)} | ${fmt(scoreOf(r.splitValidation, o), 3)} | ${fmt(r.splitValidation?.kgePrime, 3)} | ${fmt(scoreOf(r.dryWetValidation, o), 3)} | ${fmt(scoreOf(r.independentValidation, o), 3)} | ${fmt(r.naturalMarMm3)} | ${fmt(r.wr2012MarRatio)} | ${r.ewrDaysNotMet} | ${(r.ewrFractionDaysNotMet * 100).toFixed(1)} % |`
		);
	});
	const noted = results.map((r, i) => [i + 1, r.notes] as const).filter(([, n]) => n.length);
	if (noted.length) {
		lines.push('', '## Notes from the fits', '');
		for (const [i, notes] of noted) for (const n of notes) lines.push(`- #${i}: ${n}`);
	}
	lines.push('');
	return lines.join('\n');
}

/** The machine-readable form of the same results (`--json`), for CR-1's batch and later tooling. */
export function toJson(results: CellResult[], meta: SweepMeta): string {
	return `${JSON.stringify({ engineVersion: ENGINE_VERSION, ...meta, cells: results }, null, '\t')}\n`;
}

/** A whole-number CLI option inside [min, max], or the fallback when absent. */
export function intOption(name: string, raw: string | undefined, fallback: number | undefined, min: number, max: number): number | undefined {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be a whole number from ${min} to ${max}, not "${raw}"`);
	return n;
}

const USAGE =
	'usage: fit-sweep <project.json> --grid <grid.json> [--out <file.md>] [--json <file.json>] [--seed <n>] [--starts <n>] [--budget <n>] [--max-cells <n>]';

if (import.meta.url === `file://${process.argv[1]}`) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			grid: { type: 'string' },
			out: { type: 'string' },
			json: { type: 'string' },
			seed: { type: 'string' },
			starts: { type: 'string' },
			budget: { type: 'string' },
			'max-cells': { type: 'string' }
		}
	});
	const file = positionals[0] ? cliPath(positionals[0]) : undefined;
	if (!file || !values.grid) {
		console.error(USAGE);
		process.exit(1);
	}
	const gridFile = cliPath(values.grid);
	(async () => {
		const seed = intOption('seed', values.seed, 1, 0, 2 ** 31 - 1)!;
		const starts = intOption('starts', values.starts, DEFAULT_STARTS, 1, MAX_STARTS)!;
		const budget = intOption('budget', values.budget, undefined, 1, 1_000_000);
		const maxCells = intOption('max-cells', values['max-cells'], DEFAULT_MAX_CELLS, 1, 10_000)!;
		const out = values.out ? cliPath(values.out) : join(dirname(file), 'fit-sweep.md');
		const jsonOut = values.json ? cliPath(values.json) : undefined;
		const grid = parseGrid(JSON.parse(await readFile(gridFile, 'utf8')));
		const doc = JSON.parse(await readFile(file, 'utf8')) as ProjectDocument;
		const base = sweepInputOf(doc);
		const cells = expandGrid(grid, base.settings.wr2012.calibrationPenalty.enabled);
		const refusal = sweepRefusal(cells, base.settings, grid, maxCells);
		if (refusal) throw new Error(`fit-sweep: ${refusal}`);
		const validationRecord = validationRecordOf(doc, base.settings);
		const results: CellResult[] = [];
		for (const [i, cell] of cells.entries()) {
			console.error(`cell ${i + 1}/${cells.length}: ${cell.pan.label}, ${cell.bounds}, ${cell.objective}, ${cell.exclusionSet}, band ${cell.wr2012Band ? 'on' : 'off'}…`);
			results.push(runCell(base, cell, grid, { seed, starts, budget, validationRecord }));
		}
		const meta: SweepMeta = { file: positionals[0]!, seed, starts, budget, validationRecord, grid, generatedAt: new Date().toISOString() };
		await writeFile(out, toMarkdown(results, meta), 'utf8');
		console.log(`wrote ${out}`);
		if (jsonOut) {
			await writeFile(jsonOut, toJson(results, meta), 'utf8');
			console.log(`wrote ${jsonOut}`);
		}
	})().catch((err: Error) => {
		console.error(err.stack ?? err.message);
		process.exitCode = 1;
	});
}
