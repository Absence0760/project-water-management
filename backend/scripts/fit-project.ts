// What `pnpm import:project --settings <patch.json> --fit` does to a project
// document before it is imported (docs/model.md §2.10b, "Fit at import"):
// apply a settings patch, then fit GR4J with the engine's calibrate() and
// write the fitted parameters and their fit record into the settings, as the
// app's Settings → Fit automatically → Apply does. Pure (no database), so the
// seed's calibrated project is reproducible from the files alone and the
// steps are unit-tested (fit-project.test.ts).
import {
	calibrate,
	CALIBRATION_FLOW_KINDS,
	DEFAULT_STARTS,
	ENGINE_VERSION,
	fitRecordFromReport,
	type CalibrationFlowKind,
	type CalibrationReport,
	type ModelInput,
	type ProjectSettings
} from '@water-management/engine';
import { patchSettings, SettingsPatch } from '../src/projects/settings.js';

/** A project document as the importer reads it (scripts/wbt-import output, or an export). */
export interface ProjectDocument {
	name?: string;
	settings?: Record<string, unknown>;
	model: ModelInput['model'];
	series?: { kind: string; startDate: string; values: (number | null)[]; product?: string | null; productVersion?: string | null }[];
	[k: string]: unknown;
}

/**
 * The document with `patch` applied over its settings, exactly as a PATCH of
 * the project's settings would apply it (validated by the same schema; top-level
 * keys replace, groups merge one level deep, a PE input, an areal rainfall
 * correction and a fit record replace whole). Throws on a patch the API refuses.
 */
export function withSettingsPatch<D extends ProjectDocument>(doc: D, patch: unknown): D {
	const parsed = SettingsPatch.parse(patch);
	return { ...doc, settings: patchSettings(doc.settings ?? {}, parsed) as unknown as Record<string, unknown> };
}

export interface FitOptions {
	/** Default 1: the same seed, engine and inputs give the same fit. */
	seed?: number;
	/** Independent searches of the whole record; default DEFAULT_STARTS (5, what the app asks for). */
	starts?: number;
	/** Model runs per optimisation; default the engine's (1 500). */
	budget?: number;
	/** Now, for the fit record's time (tests pin it). */
	now?: Date;
}

/** The engine input for a document: its merged settings, its model and its series by kind. */
export function modelInputOf(doc: ProjectDocument): ModelInput {
	const settings = patchSettings(doc.settings ?? {}, {});
	return {
		settings: settings as unknown as ModelInput['settings'],
		model: doc.model,
		series: Object.fromEntries((doc.series ?? []).map((s) => [s.kind, { startDate: s.startDate, values: s.values }])) as ModelInput['series']
	};
}

/**
 * Fit GR4J to the document's calibration record (the settings' window,
 * exclusions and flow series; X1, X3 and X4, X2 as set), with the split-sample
 * and dry → wet validation, and against the other observed record when the
 * document has both a gauge and a logger. Returns the document with the
 * fitted parameters and their fit record in its settings, and the report.
 * The CHIRPS series' product and version go into the fit record when the
 * document records them.
 */
export function fitDocument<D extends ProjectDocument>(doc: D, opts: FitOptions = {}): { doc: D; report: CalibrationReport } {
	const input = modelInputOf(doc);
	const settings = input.settings as unknown as ProjectSettings;
	const kinds = new Set((doc.series ?? []).map((s) => s.kind));
	const fitted: CalibrationFlowKind = settings.calibrationFlowKind ?? (kinds.has('flow_observed_m3s') ? 'flow_observed_m3s' : 'flow_logger_m3s');
	const other = CALIBRATION_FLOW_KINDS.find((k) => k !== fitted && kinds.has(k));
	const report = calibrate(input, {
		seed: opts.seed ?? 1,
		starts: opts.starts ?? DEFAULT_STARTS,
		...(opts.budget !== undefined ? { budget: opts.budget } : {}),
		validate: true,
		...(other ? { validationRecord: other } : {})
	});
	const chirps = (doc.series ?? []).find((s) => s.kind === 'rain_chirps_mm');
	const chirpsSource = chirps?.product && chirps.productVersion ? { product: chirps.product, version: chirps.productVersion } : undefined;
	const record = fitRecordFromReport(report, {
		settings,
		validate: true,
		validationRecord: other ?? null,
		engineVersion: ENGINE_VERSION,
		fittedAt: (opts.now ?? new Date()).toISOString(),
		...(chirpsSource ? { chirpsSource } : {})
	});
	const params = Object.fromEntries(report.free.map((k) => [k, report.params[k]!]));
	const next = patchSettings(doc.settings ?? {}, { gr4j: params, fitRecord: record });
	return { doc: { ...doc, settings: next as unknown as Record<string, unknown> }, report };
}

/** One line per scored period for the CLI: KGE′, NSE and the volume error. */
export function fitSummary(r: CalibrationReport): string[] {
	const line = (label: string, s: { kgePrime: number | null; nse: number | null; volumeErrorPct: number | null } | undefined) =>
		s ? `  ${label}: KGE′ ${s.kgePrime?.toFixed(3) ?? '–'}, NSE ${s.nse?.toFixed(3) ?? '–'}, volume error ${s.volumeErrorPct?.toFixed(1) ?? '–'} %` : null;
	const params = r.free.map((k) => `${k.toUpperCase()} ${r.params[k]!.toFixed(3)}`).join(', ');
	return [
		`fitted ${params} against ${r.flowKind} (${r.fit.start} … ${r.fit.end})`,
		line('fit', r.fit.scores),
		line('split-sample, other half', r.splitSample?.validation.scores),
		line('dry → wet, wet years', r.differential?.validation.scores),
		line(`independent record ${r.independentRecord?.flowKind ?? ''}`, r.independentRecord?.validation.scores),
		...r.notes.map((n) => `  note: ${n}`)
	].filter((x): x is string => x !== null);
}
