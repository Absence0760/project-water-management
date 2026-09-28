// What `pnpm import:project --settings <patch.json> --transfers <patch.json>
// --fit` does to a project document before it is imported (docs/model.md
// §2.10b, "Fit at import"): apply a settings patch and a transfer patch, then
// fit GR4J with the engine's calibrate() and
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
	modelRuleProblems,
	transferFieldError,
	TRANSFER_SET_FIELDS,
	withMonthlyRates,
	type ModelInput,
	type ProjectSettings,
	type Transfer
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

/**
 * The document with a transfer patch applied: a JSON list of `{ from, to,
 * set }`, each naming one transfer rule by its source and destination node
 * names and the fields to set on it (any field a scenario's transfer.set may
 * set, checked the same way; `monthlyRateM3s` also sets `months` and
 * `maxRateM3s` to match). For settings the workbook doesn't hold, such as
 * switching a workbook's canal off-take on at an agreed capacity (engine ≥
 * 1.14.0, docs/model.md §2.6a). Throws on an entry that matches no rule or
 * several, a field it can't set, or a model the API would refuse.
 */
export function withTransferPatch<D extends ProjectDocument>(doc: D, patch: unknown): D {
	if (!Array.isArray(patch)) throw new Error('a transfer patch is a list of { from, to, set }');
	const byName = new Map(doc.model.nodes.map((n) => [n.name, n.id]));
	const transfers: Transfer[] = doc.model.transfers.map((t) => ({ ...t }));
	for (const [i, raw] of patch.entries()) {
		const e = raw as { from?: unknown; to?: unknown; set?: unknown };
		const where = `transfer patch entry ${i + 1}`;
		if (typeof e?.from !== 'string' || typeof e.to !== 'string' || !e.set || typeof e.set !== 'object' || Array.isArray(e.set)) throw new Error(`${where}: needs from, to (node names) and set (an object)`);
		const from = byName.get(e.from);
		const to = byName.get(e.to);
		const hits = transfers.filter((t) => t.fromNodeId === from && t.toNodeId === to);
		if (hits.length !== 1) throw new Error(`${where}: ${hits.length} transfer rules run from "${e.from}" to "${e.to}"; it must match exactly one`);
		const rule = hits[0]!;
		for (const [field, value] of Object.entries(e.set as Record<string, unknown>)) {
			if (!(TRANSFER_SET_FIELDS as readonly string[]).includes(field)) throw new Error(`${where}: "${field}" is not a transfer field it can set`);
			const bad = transferFieldError(field, value);
			if (bad) throw new Error(`${where}: ${field} ${bad}`);
			if (field === 'monthlyRateM3s' && Array.isArray(value)) Object.assign(rule, withMonthlyRates(value as number[]));
			else (rule as unknown as Record<string, unknown>)[field] = value;
		}
	}
	const model = { ...doc.model, transfers };
	const problems = modelRuleProblems(model);
	if (problems.length) throw new Error(`the transfer patch leaves a model the API refuses: ${problems.join('; ')}`);
	return { ...doc, model };
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
