// Pan-coefficient sensitivity report: runs GR4J at a few monthly
// pan-coefficient choices against a project.json (any project — this script
// carries no client data), both with the project's current GR4J parameters
// held fixed and refitted with the engine's calibrate(), and writes a
// Markdown table of MAR, Q95 (of natural flow), EWR non-compliance and
// NSE/KGE against the logger record for each case.
//
// There is no automated sensitivity harness yet (calibration-research.md
// CR-21); this is the manual way to see how much a pan-coefficient choice
// moves a catchment's results, until that harness exists.
//
//   pnpm pan-sensitivity <project.json> [--out <file.md>] [--seed <n>] [--starts <n>] [--budget <n>]
//
// Refuses a project whose GR4J PE is a monthly row (settings.pe.kind
// 'monthly', issue #39): the pan coefficient doesn't reach GR4J there.
//
// Pure engine, no DB and no server: reads the file, runs runModel/calibrate
// in-process, writes the table. On a large catchment record (decades of daily
// series) this can take several minutes and hold a few hundred MB; on a
// memory-constrained machine wrap it, e.g.:
//   systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 -- \
//     pnpm pan-sensitivity data/client-catchment/project.json
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
	calibrate,
	DEFAULT_STARTS,
	defaultProjectSettings,
	MAX_STARTS,
	PAN_COEFFICIENT_PRESETS,
	runModel,
	type CalibrationReport,
	type ModelInput,
	type ModelOutput
} from '@water-management/engine';

interface ImportedProject {
	settings: ModelInput['settings'];
	model: ModelInput['model'];
	series: { kind: string; startDate: string; values: (number | null)[] }[];
}

export interface SensitivityCase {
	/** Label for the report, e.g. "flat 0.70" or "winter preset". */
	label: string;
	panCoefficient: number[];
}

export interface CaseMetrics {
	marMm3: number;
	q95M3s: number;
	ewrDaysNotMet: number;
	ewrFractionDaysNotMet: number;
	nse: number | null;
	kge: number | null;
}

export interface CaseResult {
	label: string;
	fixed: CaseMetrics;
	refit: CaseMetrics & { params: Record<string, number> };
}

/** The four cases the task asks for: flat 0.60, 0.70, 0.85, and the winter-rainfall preset (water-year order). */
export function defaultCases(): SensitivityCase[] {
	const flat = (v: number) => new Array(12).fill(v);
	const winter = PAN_COEFFICIENT_PRESETS.find((p) => p.id === 'winter-rainfall');
	if (!winter) throw new Error('winter-rainfall preset not found in PAN_COEFFICIENT_PRESETS');
	return [
		{ label: 'flat 0.60', panCoefficient: flat(0.6) },
		{ label: 'flat 0.70', panCoefficient: flat(0.7) },
		{ label: 'flat 0.85', panCoefficient: flat(0.85) },
		{ label: 'winter preset', panCoefficient: [...winter.values] }
	];
}

/** A project.json (scripts/wbt-import/extract_project.py output, or any ProjectFile) as a runnable ModelInput. */
export async function loadModelInput(file: string): Promise<ModelInput> {
	const project = JSON.parse(await readFile(file, 'utf8')) as ImportedProject;
	return {
		settings: project.settings,
		model: project.model,
		series: Object.fromEntries(project.series.map((s) => [s.kind, { startDate: s.startDate, values: s.values }])) as ModelInput['series']
	};
}

/** Ascending-sorted quantile (q in 0–1); q95 exceedance = quantile(values, 0.05). */
export function quantile(values: readonly number[], q: number): number {
	if (values.length === 0) return NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
	return sorted[idx]!;
}

/** Mean annual volume (Mm³/year) of a daily m³/day series over a run of `days` days. */
export function meanAnnualMm3(dailyM3: readonly number[], days: number): number {
	const total = dailyM3.reduce((a, b) => a + b, 0);
	return total / (days / 365.25) / 1e6;
}

function naturalFlowM3Day(out: ModelOutput): number[] {
	return (out.series.find((s) => s.nodeId === null && s.key === 'natural_flow')?.values ?? []).map((v) => v ?? 0);
}

/** MAR, Q95 of natural flow, EWR days not met and NSE/KGE of one run (shared with fit-sweep.ts). */
export function metricsOf(out: ModelOutput): CaseMetrics {
	const natural = naturalFlowM3Day(out);
	const cal = out.summary.calibration;
	return {
		marMm3: meanAnnualMm3(natural, out.days),
		q95M3s: quantile(natural, 0.05) / 86_400,
		ewrDaysNotMet: out.summary.catchment.ewrDaysNotMet,
		ewrFractionDaysNotMet: out.summary.catchment.ewrFractionDaysNotMet,
		nse: cal?.nse ?? null,
		kge: cal?.kge ?? null
	};
}

/**
 * Why this report can't run on a project, or null. Under `pe.kind: 'monthly'`
 * (engine ≥ 0.31.0, issue #39) GR4J's PE is the monthly row and the pan
 * coefficient is unused, so every case would give the same numbers. The
 * report refuses rather than quietly switching the project back to pan PE,
 * which would describe a model the project doesn't run.
 */
export function panSensitivityRefusal(settings: { pe?: { kind: string } | null }): string | null {
	if (settings.pe?.kind === 'monthly')
		return "this project's GR4J potential evaporation is a monthly PE row (settings.pe.kind 'monthly'), not pan coefficient × A-pan, so the pan coefficient doesn't reach GR4J and every case would be identical; set settings.pe to { kind: 'pan' } in a copy of the project.json to see the pan-coefficient sensitivity";
	return null;
}

/**
 * The settings with GR4J as the runoff model (its parameters filled from the
 * defaults where the project leaves them out) and `panCoefficient` as the
 * monthly pan coefficient (water-year order). Shared with fit-sweep.ts, whose
 * pan-preset axis sets the coefficient the same way.
 */
export function withPanCoefficient<S extends ModelInput['settings']>(settings: S, panCoefficient: readonly number[]) {
	const gr4j = { ...defaultProjectSettings().gr4j, ...(settings.gr4j as Partial<ModelInput['settings']['gr4j']> | undefined) };
	return {
		...settings,
		runoffModel: 'gr4j' as const,
		panCoefficient: [...panCoefficient] as unknown as ModelInput['settings']['panCoefficient'],
		gr4j
	};
}

export interface CalibrateSettings {
	seed: number;
	starts: number;
	budget?: number;
}

/**
 * Runs one pan-coefficient case: (a) with the base GR4J parameters held
 * fixed, (b) refitted with calibrate() (X1, X3, X4 free by default — X2 stays
 * whatever the project has it fixed to). Both are scored against the logger
 * record, forced via calibrationFlowKind, so cases compare on the same
 * reference regardless of the project's own default.
 */
export function runCase(base: ModelInput, c: SensitivityCase, cal: CalibrateSettings): CaseResult {
	const refusal = panSensitivityRefusal(base.settings);
	if (refusal) throw new Error(refusal);
	const settings = { ...withPanCoefficient(base.settings, c.panCoefficient), calibrationFlowKind: 'flow_logger_m3s' as const };
	const gr4j = settings.gr4j;
	const withPan: ModelInput = { ...base, settings };

	const fixedOut = runModel(withPan);

	const report: CalibrationReport = calibrate(withPan, { model: 'gr4j', seed: cal.seed, starts: cal.starts, budget: cal.budget, validate: false });
	const refitSettings = { ...settings, gr4j: { ...gr4j, ...report.params } };
	const refitOut = runModel({ ...withPan, settings: refitSettings });

	return {
		label: c.label,
		fixed: metricsOf(fixedOut),
		refit: { ...metricsOf(refitOut), params: report.params }
	};
}

const fmt = (v: number | null | undefined, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits));
const pct = (v: number) => `${(v * 100).toFixed(1)} %`;

/**
 * A path given on the command line, resolved against the directory the
 * command was typed in. The root script runs this one through `pnpm -C
 * backend`, which moves the working directory to backend/, so a bare relative
 * path would miss; pnpm keeps the caller's directory in INIT_CWD.
 */
export const cliPath = (p: string, env: NodeJS.ProcessEnv = process.env): string => resolve(env.INIT_CWD ?? process.cwd(), p);

export function toMarkdown(results: CaseResult[], meta: { file: string; seed: number; starts: number; generatedAt: string }): string {
	const lines = [
		'# Pan-coefficient sensitivity (client catchment, local only)',
		'',
		'Generated by `backend/scripts/pan-sensitivity.ts`. GR4J natural flow, scored',
		'against the logger record (`calibrationFlowKind` forced to `flow_logger_m3s`',
		'for every case so they compare on the same reference). "Fixed" holds the',
		"project's current GR4J parameters; \"Refit\" recalibrates with calibrate()",
		`(seed ${meta.seed}, ${meta.starts} starts, default bounds/budget, validate off).`,
		'',
		`Source: \`${meta.file}\` — generated ${meta.generatedAt}.`,
		'',
		'This file holds real catchment figures and is gitignored: never commit it',
		'or copy its numbers into a tracked file (docs/model.md §2.4a, docs/STACK.md).',
		'',
		'| Case | Mode | MAR (Mm³) | Q95 (m³/s) | EWR days not met | EWR % | NSE | KGE | X1 | X2 | X3 | X4 |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	];
	for (const r of results) {
		lines.push(
			`| ${r.label} | fixed | ${fmt(r.fixed.marMm3)} | ${fmt(r.fixed.q95M3s)} | ${r.fixed.ewrDaysNotMet} | ${pct(r.fixed.ewrFractionDaysNotMet)} | ${fmt(r.fixed.nse)} | ${fmt(r.fixed.kge)} | – | – | – | – |`
		);
		const p = r.refit.params;
		lines.push(
			`| ${r.label} | refit | ${fmt(r.refit.marMm3)} | ${fmt(r.refit.q95M3s)} | ${r.refit.ewrDaysNotMet} | ${pct(r.refit.ewrFractionDaysNotMet)} | ${fmt(r.refit.nse)} | ${fmt(r.refit.kge)} | ${fmt(p.x1, 1)} | ${fmt(p.x2, 2)} | ${fmt(p.x3, 1)} | ${fmt(p.x4, 2)} |`
		);
	}
	lines.push('');
	return lines.join('\n');
}

/** A whole-number CLI option inside [min, max], or the fallback when absent (pan-sensitivity's and fit-sweep's options). */
export function intOption(name: string, raw: string | undefined, fallback: number | undefined, min: number, max: number): number | undefined {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (raw.trim() === '' || !Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be a whole number from ${min} to ${max}, not "${raw}"`);
	return n;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			out: { type: 'string' },
			seed: { type: 'string' },
			starts: { type: 'string' },
			budget: { type: 'string' }
		}
	});
	const file = positionals[0] ? cliPath(positionals[0]) : undefined;
	if (!file) {
		console.error('usage: pan-sensitivity <project.json> [--out <file.md>] [--seed <n>] [--starts <n>] [--budget <n>]');
		process.exit(1);
	}
	// The same bounds as fit-sweep's: a typo is a usage error, never a NaN fit.
	let seed: number, starts: number, budget: number | undefined;
	try {
		seed = intOption('seed', values.seed, 1, 0, 2 ** 31 - 1)!;
		starts = intOption('starts', values.starts, DEFAULT_STARTS, 1, MAX_STARTS)!;
		budget = intOption('budget', values.budget, undefined, 1, 1_000_000);
	} catch (err) {
		console.error(`pan-sensitivity: ${(err as Error).message}`);
		process.exit(1);
	}
	const out = values.out ? cliPath(values.out) : join(dirname(file), 'pan-sensitivity.md');

	loadModelInput(file)
		.then(async (base) => {
			const refusal = panSensitivityRefusal(base.settings);
			if (refusal) throw new Error(`pan-sensitivity: ${refusal}`);
			const results: CaseResult[] = [];
			for (const c of defaultCases()) {
				console.error(`running ${c.label}…`);
				results.push(runCase(base, c, { seed, starts, budget }));
			}
			const md = toMarkdown(results, { file: positionals[0]!, seed, starts, generatedAt: new Date().toISOString() });
			await writeFile(out, md, 'utf8');
			console.log(`wrote ${out}`);
		})
		.catch((err) => {
			console.error(err.stack ?? err.message);
			process.exitCode = 1;
		});
}
