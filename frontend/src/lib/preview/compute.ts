// What the preview worker (./engine.worker.ts) computes, apart from the
// worker plumbing so the unit tests call it directly. Imports the engine's
// run code: only the worker may import this module (a page importing it would
// ship the model in a page chunk; the bundle guard's worker checks and
// src/lib/preview/compute.test.ts's import scan say so).
import { applyScenario, firmYield, prepareYield, runModelWithoutChecks, validateScenarioOps, type CalibrationStats, type FarmSummary, type MetricDelta, type ModelInput, type ModelOutput, type YieldPattern, type YieldPoint } from '@water-management/engine';
import type { EffectPreviewRequest, FromWorker, PreviewEffect, ToWorker, YieldPreviewRequest } from './messages';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi;
const isId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 100;
const NODE_KINDS: readonly unknown[] = ['farm', 'gauge', 'user'];
const MESSAGE_KEYS = ['type', 'id', 'request'];
const REQUEST_KEYS = ['input', 'ops', 'nodeId', 'pattern', 'assurance', 'tolerance'];
const EFFECT_KEYS = ['baseKey', 'base', 'edited'];
const onlyKeys = (o: Obj, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));

/** A draft shape as the backend's YieldParams takes it (backend/src/yield/store.ts). */
function pattern(v: unknown): YieldPattern | null {
	if (v === 'constant' || v === 'demand') return v;
	return Array.isArray(v) && v.length === 12 && v.every((x) => inRange(x, 0, 1e6)) ? [...(v as number[])] : null;
}

/** The input's outline: the parts the engine indexes by, each of the kind it expects. The engine checks the rest. */
function inputShapeError(v: unknown): string | null {
	if (!isObj(v) || !isObj(v.settings) || !isObj(v.model) || !isObj(v.series)) return 'input must be a run input { settings, model, series }';
	const m = v.model;
	for (const k of ['nodes', 'crops', 'cropAreas', 'transfers']) if (!Array.isArray(m[k])) return `input.model.${k} must be a list`;
	for (const n of m.nodes as unknown[]) {
		if (!isObj(n) || !isId(n.id) || !NODE_KINDS.includes(n.kind)) return 'input.model.nodes must each have an id and a kind (farm, gauge or user)';
	}
	return null;
}

/**
 * The worker's message, checked at the boundary as the backend checks a
 * request body (YieldParams, validateScenarioOps): the known keys only, each
 * of its kind and range, and a scenario's ops rebuilt from their allowlisted
 * fields. A message is untrusted data even from the page that made the
 * worker. `id` is the request's when it has a usable one, so the error can
 * go back to it; null means the message isn't a preview request at all.
 */
export function parseMessage(data: unknown): { ok: true; msg: ToWorker } | { ok: false; id: number | null; message: string } {
	if (!isObj(data) || (data.type !== 'yield' && data.type !== 'effect')) return { ok: false, id: null, message: 'not a preview request' };
	if (!Number.isSafeInteger(data.id) || (data.id as number) < 1) return { ok: false, id: null, message: 'a preview request needs a positive whole id' };
	const id = data.id as number;
	const bad = (message: string) => ({ ok: false as const, id, message: `the preview request is malformed: ${message}` });
	if (!onlyKeys(data, MESSAGE_KEYS)) return bad('unknown message field');
	const r = data.request;
	if (!isObj(r)) return bad('request must be an object');
	if (data.type === 'effect') {
		if (!onlyKeys(r, EFFECT_KEYS)) return bad('unknown request field');
		if (typeof r.baseKey !== 'string' || r.baseKey.length < 1 || r.baseKey.length > 200) return bad('baseKey must be a key of 1–200 characters');
		const baseErr = inputShapeError(r.base);
		if (baseErr) return bad(baseErr.replace(/^input/, 'base'));
		const editedErr = inputShapeError(r.edited);
		if (editedErr) return bad(editedErr.replace(/^input/, 'edited'));
		return { ok: true, msg: { type: 'effect', id, request: { baseKey: r.baseKey, base: r.base as unknown as ModelInput, edited: r.edited as unknown as ModelInput } } };
	}
	if (!onlyKeys(r, REQUEST_KEYS)) return bad('unknown request field');
	const inputErr = inputShapeError(r.input);
	if (inputErr) return bad(inputErr);
	if (!isId(r.nodeId)) return bad('nodeId must be an id');
	const p = pattern(r.pattern);
	if (!p) return bad('pattern must be constant, demand or 12 factors 0–1 000 000');
	if (!inRange(r.assurance, 0.5, 1)) return bad('assurance must be 0.5–1');
	if (!inRange(r.tolerance, 1e-5, 0.05)) return bad('tolerance must be 0.00001–0.05');
	const request: YieldPreviewRequest = { input: r.input as unknown as ModelInput, nodeId: r.nodeId, pattern: p, assurance: r.assurance, tolerance: r.tolerance };
	if (r.ops !== undefined) {
		const { ops, errors } = validateScenarioOps(r.ops);
		if (errors.length) return bad(`the scenario's ops: ${errors.join('; ')}`);
		request.ops = ops;
	}
	return { ok: true, msg: { type: 'yield', id, request } };
}

/**
 * A dam's yield worked out as the `yield` job does for kind 'firm'
 * (backend/src/jobs/handlers/yield.ts): a scenario's ops applied to its base
 * run's input (refused if any op doesn't apply, as the job is), then
 * prepareYield and one firmYield search. The same engine calls on the same
 * input give the same point.
 */
export function previewYield(req: YieldPreviewRequest): YieldPoint {
	let input = req.input;
	if (req.ops?.length) {
		const check = applyScenario(input, req.ops);
		if (check.problems.length) throw new Error(`an op of this scenario doesn't apply to its base run: ${check.problems.join('; ')}`);
		input = check.input;
	}
	let problem;
	try {
		problem = prepareYield(input);
	} catch (err) {
		throw new Error(`the model can't run this input: ${(err as Error).message}`);
	}
	return firmYield(problem, req.nodeId, { pattern: req.pattern, assurance: req.assurance, tolerance: req.tolerance });
}

// The last run's output, kept while previews of the same run follow each
// other (each edit asks again; the run's input never changes). One entry: an
// output holds every series of the record.
let lastBase: { key: string; output: ModelOutput } | null = null;

/** For the tests. */
export function forgetBase(): void {
	lastBase = null;
}

/** Changes smaller than these are rounding, not an effect (a fraction 0–1, m³/day). */
const FRACTION_EPS = 1e-9;
const M3_EPS = 1e-6;
/** The engine's SUPPLY_TARGET (compare.ts): "units below 95 % supplied". Not imported, see previewEffect. */
const SUPPLY_TARGET = 0.95;

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** compare.ts metricDelta: b − a, null when either side is missing. */
function delta(a: unknown, b: unknown): MetricDelta {
	const x = finite(a);
	const y = finite(b);
	return { a: x, b: y, delta: x !== null && y !== null ? y - x : null };
}
/** compare.ts farmTotals. */
function totals(farms: readonly FarmSummary[]) {
	const demand = farms.reduce((t, f) => t + f.avgDemandM3Day, 0);
	const supplied = farms.reduce((t, f) => t + f.avgSuppliedM3Day, 0);
	return {
		demand,
		supplied,
		deficit: farms.reduce((t, f) => t + f.avgDeficitM3Day, 0),
		fraction: demand > 0 ? supplied / demand : null,
		below: farms.filter((f) => f.fractionSupplied < SUPPLY_TARGET).length
	};
}

/**
 * What unsaved edits do to the last run (issue #284): the model on the run's
 * input and on the input with the edits (./overlay.ts), on this build's
 * engine both, read as the compare page reads two runs (compareRuns: the
 * same totals, catchment figures and fit scores; compute.test.ts pins them
 * equal). Not compareRuns itself: its module carries every other run
 * comparison, and importing it put a second copy of it in a chunk of its own
 * (+4 KB gzip). Units are matched by id, the editor's identity for a unit.
 * runModelWithoutChecks: every figure here is runModel's to the bit, without
 * the plausibility checks and the assurance of supply nothing here reads.
 * The engine's refusal of the edited input is the preview's answer.
 */
export function previewEffect(req: EffectPreviewRequest): PreviewEffect {
	let base = lastBase?.key === req.baseKey ? lastBase.output : null;
	if (!base) {
		try {
			base = runModelWithoutChecks(req.base);
		} catch (err) {
			throw new Error(`the last run's inputs don't run on this engine: ${(err as Error).message}`);
		}
		lastBase = { key: req.baseKey, output: base };
	}
	let edited: ModelOutput;
	try {
		edited = runModelWithoutChecks(req.edited);
	} catch (err) {
		throw new Error(`the model can't run with these edits: ${(err as Error).message}`);
	}
	const fa = base.summary.farms ?? [];
	const fb = edited.summary.farms ?? [];
	const aById = new Map(fa.map((f) => [f.nodeId, f]));
	const bIds = new Set(fb.map((f) => f.nodeId));
	const moved = (d: MetricDelta, eps: number) => d.delta !== null && Math.abs(d.delta) > eps;
	const units = fb
		.flatMap((y) => {
			const x = aById.get(y.nodeId);
			if (!x) return [];
			const u = { name: y.name, fractionSupplied: delta(x.fractionSupplied, y.fractionSupplied), deficitM3Day: delta(x.avgDeficitM3Day, y.avgDeficitM3Day) };
			return moved(u.fractionSupplied, FRACTION_EPS) || moved(u.deficitM3Day, M3_EPS) ? [u] : [];
		})
		.sort((x, y) => Math.abs(y.fractionSupplied.delta ?? 0) - Math.abs(x.fractionSupplied.delta ?? 0) || Math.abs(y.deficitM3Day.delta ?? 0) - Math.abs(x.deficitM3Day.delta ?? 0));
	const ta = totals(fa);
	const tb = totals(fb);
	const ca = base.summary.catchment;
	const cb = edited.summary.catchment;
	const cal = (s: CalibrationStats | null | undefined) => (s && s.days > 0 ? s : null);
	const ka = cal(base.summary.calibration);
	const kb = cal(edited.summary.calibration);
	return {
		engineVersion: edited.engineVersion,
		startDate: edited.startDate,
		endDate: edited.endDate,
		totals: {
			demandM3Day: delta(ta.demand, tb.demand),
			suppliedM3Day: delta(ta.supplied, tb.supplied),
			deficitM3Day: delta(ta.deficit, tb.deficit),
			fractionSupplied: delta(ta.fraction, tb.fraction),
			farmsBelowTarget: delta(ta.below, tb.below)
		},
		catchment: {
			meanNaturalFlowM3Day: delta(ca?.meanNaturalFlowM3Day, cb?.meanNaturalFlowM3Day),
			meanSimulatedOutflowM3Day: delta(ca?.meanSimulatedOutflowM3Day, cb?.meanSimulatedOutflowM3Day),
			ewrDaysNotMet: delta(ca?.ewrDaysNotMet, cb?.ewrDaysNotMet)
		},
		calibration: ka || kb ? { nse: delta(ka?.nse, kb?.nse), kge: delta(ka?.kge, kb?.kge), pbias: delta(ka?.pbias, kb?.pbias) } : null,
		units,
		removedUnits: fa.filter((f) => !bIds.has(f.nodeId)).map((f) => f.name),
		addedUnits: fb.filter((f) => !aById.has(f.nodeId)).map((f) => f.name)
	};
}

/**
 * The worker's answer to one message: the point, or the engine's words (never
 * a stack). A malformed request is answered with an error and never reaches
 * the engine; null for a message that isn't a preview request (no answer).
 */
export function handle(data: unknown): FromWorker | null {
	const parsed = parseMessage(data);
	if (!parsed.ok) return parsed.id === null ? null : { type: 'error', id: parsed.id, message: parsed.message };
	const msg = parsed.msg;
	try {
		if (msg.type === 'effect') return { type: 'effect-done', id: msg.id, effect: previewEffect(msg.request) };
		return { type: 'yield-done', id: msg.id, point: previewYield(msg.request) };
	} catch (err) {
		return { type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) };
	}
}
