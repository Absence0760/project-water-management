// Model-state snapshots (engine ≥ 1.1.0, issue #53, docs/model.md §2.16):
// the complete state of a run at the start of a day, as plain versioned
// data, so another run can start there instead of re-running the history.
// ../run.ts captures one (runModelCapturing, captureModelState) and resumes
// from one (runModelFrom); this module holds the shape, the fingerprints
// that refuse a snapshot from another input, and the JSON-safe encoding.
//
// What a snapshot holds, per part of the model:
//   - the runoff model's stores: GR4J's production and routing stores and
//     both unit-hydrograph queues (no warm-up on resume: the state is it);
//   - per node: the dam storage the day before (before any storage reset on
//     the day), the soil-water store (m³ over the cropped area), the
//     stream-depletion lag store, whether the river pump was on, each
//     pumping unit's volume so far this water year and, under an allocation
//     cap, the unit's surface and groundwater use so far this water year,
//     and under a full allocation, the demand factor of the water year in
//     progress;
//   - per Reserve rule table, the month in progress (its natural and
//     impacted flow so far) and, when low flows are judged on base flow,
//     the impacted flow its base-flow windows reach back into (engine ≥
//     1.6.0), and the columns the capture run carried;
//   - the record-wide quantities, pinned from the run it was captured from
//     (the decision in model.md §2.16): the land-cover low-flow threshold,
//     each Reserve rule table's natural duration curves (in 'run' mode), the
//     CHIRPS bias factors and the rain-source periods' factors.
//
// Pure: no I/O. A snapshot is JSON-round-trippable (encodePlain turns NaN,
// ±Infinity and −0 into tokens), so a backend can store one per base run.
import { fromEpochDay, toEpochDay, isIsoDate as isRealDate } from '../calendar';
import type { ModelInput } from '../project';
import type { GapFillKind } from '../flowGapFill';
import type { OutletEwrInfo } from '../reserve/dailySource';
import type { PreparedFits } from '../prepare';
import { ENGINE_VERSION } from '../version';
import { damCapacityOn } from '../network/development';
import { decodePlain, encodePlain, Hasher, hashText, stableStringify, type Encoded } from './plain';

/** The snapshot's kind tag. */
export const MODEL_STATE_KIND = 'water-management/model-state';
/** Bumped when the snapshot's shape changes (a reader refuses another format). 2: engine ≥ 1.6.0, reserveMonths[].history. */
export const MODEL_STATE_FORMAT = 2;

/** One node's state at the start of the snapshot's day. */
export interface ModelNodeState {
	id: string;
	/** Dam storage at the end of the day before (m³); 0 without a dam. */
	storageM3: number;
	/** Soil-water store (m³ over the cropped area); 0 without crops. */
	soilStoreM3: number;
	/** Stream depletion still to come (m³). */
	depletionStoreM3: number;
	/** Stream depletion owed to the river, carried over from days it had no flow (m³, engine ≥ 1.10.0); absent = 0. */
	depletionDeficitM3?: number;
	/** The river pump was on the day before (a trigger-rule farm). */
	onRiver: boolean;
	/** Each river abstraction's pool storage the day before (m³, engine ≥ 1.65.0), in the plan's order; absent without a pool. */
	poolStorageM3?: number[];
	/** Each pumping unit's volume so far this water year (m³), in the plan's unit order; null without boreholes. */
	boreholeUsedM3: number[] | null;
	/** Surface and groundwater use so far this water year under an allocation cap (m³, engine ≥ 1.18.0); absent without a cap. */
	allocationUsedM3?: [number, number];
	/** A full allocation's demand factor for the water year in progress (engine ≥ 1.18.0); absent without one. */
	allocationFactor?: number;
	/**
	 * A full allocation's factor for the water year in progress fitted on its
	 * days before the snapshot's only (engine ≥ 1.69.0); absent on the year's
	 * first day or without one. withAllocationKnownBefore puts it in place of
	 * allocationFactor for an outlook, whose members know nothing after the
	 * decision date (docs/model.md §2.15).
	 */
	allocationFactorBefore?: number;
	/**
	 * The storage the day before left, when withDamStorage set another: only
	 * sizes the float noise the EWR attribution ignores on the first day, as
	 * a storage reset's day does (the day before's storage, not the set one).
	 */
	setFromM3?: number;
}

/** Record-wide quantities pinned from the capture run. */
export interface PinnedStatistics {
	/** The land-cover low-flow threshold (the natural flow's Q75 over the capture run, m³/day); null without land cover. */
	lowFlowThresholdM3Day: number | null;
	/** Per Reserve rule table in 'run' mode (keyed by its siteNodeId, '' = the outlet): the natural curve of each water-year month. */
	reserveNatural: { site: string; curves: (number[] | null)[] }[];
	/** The rain handling's fits from the stored record. */
	fits: PreparedFits;
	/**
	 * The daily outlet EWR's scale factor and its inputs (engine ≥ 1.77.0,
	 * settings.ewrDailySource, ../reserve/dailySource.ts): the capture run's,
	 * so a resumed run's EWR is the uninterrupted run's. Absent with the
	 * pragmatic EWR.
	 */
	outletEwr?: OutletEwrInfo;
}

/** The decoded state (plain numbers). */
export interface ModelState {
	runoff: { model: 'gr4j'; state: number[] };
	nodes: ModelNodeState[];
	pinned: PinnedStatistics;
	/**
	 * Per Reserve rule table (keyed as reserveNatural): the natural and
	 * impacted flow of the calendar month the day falls in, from its first
	 * day to the day before, so a resumed run still assesses that month
	 * whole; null on a month's first day. `history` (format 2, engine ≥
	 * 1.6.0), when low flows are judged on base flow
	 * (settings.lowFlowMeasure 'baseflow'): the impacted daily flow (m³/day,
	 * oldest first) of the BASEFLOW_HISTORY_DAYS days before that month and
	 * its days before the snapshot's, or as many as the record held, so a
	 * resumed run filters each month's base flow over the same days as the
	 * uninterrupted run, to the bit (../reserve/assurance.ts
	 * baseflowHistoryAt). Format 1 carried the part month's base flow as a
	 * sum instead, and a resumed run's base flow only approximated the
	 * uninterrupted run's.
	 */
	reserveMonths: { site: string; carry: { days: number; natural: number; impacted: number } | null; history?: number[] }[];
	/**
	 * Columns the capture run carried because some of its days needed them
	 * (a zero-run or accumulation mask, a storage reset's step, the senior
	 * users' requirement), with the
	 * column before each, so a resumed run has the same columns.
	 */
	columns: { nodeId: string | null; key: string; label: string; unit: string; after: { nodeId: string | null; key: string } | null }[];
	/**
	 * The drought restriction level each node held the day before (engine ≥
	 * 1.54.0, settings.droughtRestriction; model order, 0 = none), so a
	 * resumed run keeps the levels decided at the last review, and whether the
	 * rule's EWR trigger site failed the day before (absent = no). Absent
	 * without the rule.
	 */
	restrictionLevels?: number[];
	restrictionEwrFailed?: boolean;
	/**
	 * The dams still filling (engine ≥ 1.70.0, docs/model.md §2.7i): 1 per node
	 * (model order) for a dam still filling, so a resumed run goes on reading
	 * its reviews both ways until it fills, as the uninterrupted run does.
	 * Absent when none is.
	 */
	restrictionFilling?: number[];
	/**
	 * The scored flow record had readings before the snapshot's day (engine ≥ 1.48.0): its per-day quality flags'
	 * suspect class reads the whole record, so a resumed input without that history can't reproduce them
	 * (../run.ts leaves the class out and warns). Absent = no such history.
	 */
	flowRecordHistory?: true;
	/**
	 * The gap-filled records whose fill read readings, the record's or its donor's, before the snapshot's day
	 * (engine ≥ 1.48.0): a resumed input without that history leaves their fill out, with a warning (../prepare.ts).
	 */
	flowFillHistory?: GapFillKind[];
}

/**
 * A model-state snapshot: the state at the start of `date`, as JSON-safe
 * plain data. Don't edit one by hand; withDamStorage sets its dams.
 */
export interface ModelStateSnapshot {
	kind: typeof MODEL_STATE_KIND;
	format: typeof MODEL_STATE_FORMAT;
	/** The engine that captured it; another engine refuses it (its state may mean something else). */
	engineVersion: string;
	/** The first day a run resumed from it simulates (ISO): the state is the end of the day before. */
	date: string;
	/** The capture run's first day (ISO); `date` = `runStart` means nothing had run yet. */
	runStart: string;
	/** Fingerprint of the model and the settings that shape the history (modelStateFingerprint). */
	inputFingerprint: string;
	/** Fingerprint of every input series' values before `date`; null when the capture input had none. */
	historyFingerprint: string | null;
	/** The state, every number JSON-safe. */
	state: Encoded<ModelState>;
}

/** A snapshot refused: another engine or format, or another input. `code` is stable for a caller to match on. */
export class ModelStateMismatchError extends Error {
	constructor(
		readonly code: 'format' | 'engineVersion' | 'input' | 'history' | 'window',
		message: string
	) {
		super(message);
		this.name = 'ModelStateMismatchError';
	}
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && isRealDate(v);

/** Settings that never shape the state on a day: the window, the reporting window, provenance, and the two handled below. */
const NOT_HISTORY = new Set(['simulationStart', 'simulationEnd', 'reportStart', 'reportEnd', 'fitRecord', 'demandFactorFrom', 'damStorageReset', 'rainSource']);

/**
 * The fingerprint of what shapes a run's state on `date` besides the
 * series: the model (demand factors apart), the settings but the window,
 * the reporting window and provenance, the rain-source periods clipped to
 * the days before `date`, the demand factors when they apply before `date`
 * (settings.demandFactorFrom unset or earlier), and a storage reset dated
 * before `date`. A factor or reset from `date` on only changes what follows,
 * so it may differ.
 */
export function modelStateFingerprint(input: ModelInput, date: string): string {
	if (!isIso(date)) throw new RangeError(`"${String(date)}" is not an ISO date (YYYY-MM-DD)`);
	const day = toEpochDay(date);
	const settings: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(input.settings ?? {})) if (!NOT_HISTORY.has(k)) settings[k] = v;
	const rs = input.settings?.rainSource;
	if (Array.isArray(rs)) {
		const last = fromEpochDay(day - 1);
		settings.rainSource = rs.flatMap((p) => {
			if (!p || typeof p !== 'object' || typeof p.start !== 'string' || typeof p.end !== 'string') return [p];
			if (p.start > last) return [];
			return [p.end > last ? { ...p, end: last } : p];
		});
	} else if (rs !== undefined) settings.rainSource = rs;
	const from = input.settings?.demandFactorFrom;
	const factorsBefore = !isIso(from) || toEpochDay(from) < day;
	const factors = factorsBefore ? input.model.nodes.flatMap((n) => (n.demandFactor != null ? [[n.id, n.demandFactor]] : [])) : [];
	const reset = input.settings?.damStorageReset as { date?: unknown } | null | undefined;
	const resetBefore = reset && typeof reset === 'object' && isIso(reset.date) && toEpochDay(reset.date) < day ? reset : null;
	const model = { ...input.model, nodes: input.model.nodes.map(({ demandFactor: _f, ...n }) => n) };
	return hashText(stableStringify({ model, settings, factors, reset: resetBefore }), 'wm-model-state-1:');
}

/**
 * The fingerprint of every input series' finite values on days before
 * `date` (day and value, series by kind), or null when there are none: a
 * resumed run's input may leave the history out altogether, or carry it,
 * and then it must be the capture input's.
 */
export function historyFingerprint(input: ModelInput, date: string): string | null {
	const day = toEpochDay(date);
	const h = new Hasher();
	let any = false;
	for (const kind of Object.keys(input.series ?? {}).sort()) {
		const s = input.series[kind as keyof ModelInput['series']];
		if (!s || !Array.isArray(s.values)) continue;
		const d0 = toEpochDay(s.startDate);
		const n = Math.min(s.values.length, day - d0);
		let started = false;
		for (let i = 0; i < n; i++) {
			const v = s.values[i];
			if (typeof v !== 'number' || !Number.isFinite(v)) continue;
			if (!started) {
				h.text(kind);
				started = true;
			}
			h.number(d0 + i).number(v);
			any = true;
		}
	}
	return any ? h.digest() : null;
}

/** Build a snapshot (../run.ts runModelCapturing). */
export function makeSnapshot(input: ModelInput, date: string, runStart: string, state: ModelState): ModelStateSnapshot {
	return {
		kind: MODEL_STATE_KIND,
		format: MODEL_STATE_FORMAT,
		engineVersion: ENGINE_VERSION,
		date,
		runStart,
		inputFingerprint: modelStateFingerprint(input, date),
		historyFingerprint: historyFingerprint(input, date),
		state: encodePlain(state)
	};
}

/**
 * Check a snapshot against this engine and a run's input, and decode its
 * state. Throws ModelStateMismatchError: another kind or format, another
 * engine version, another model or history-shaping setting, or a history
 * (series before the snapshot's day) that differs from the capture input's.
 */
export function openSnapshot(snapshot: ModelStateSnapshot, input: ModelInput): ModelState {
	if (!snapshot || typeof snapshot !== 'object' || snapshot.kind !== MODEL_STATE_KIND) throw new ModelStateMismatchError('format', 'not a model-state snapshot');
	if (snapshot.format !== MODEL_STATE_FORMAT) throw new ModelStateMismatchError('format', `model-state snapshot format ${String(snapshot.format)}; this engine reads format ${MODEL_STATE_FORMAT}`);
	if (snapshot.engineVersion !== ENGINE_VERSION)
		throw new ModelStateMismatchError('engineVersion', `the snapshot was captured by engine ${snapshot.engineVersion}, and this is engine ${ENGINE_VERSION}: capture it again from the base run`);
	if (!isIso(snapshot.date) || !isIso(snapshot.runStart)) throw new ModelStateMismatchError('format', 'the snapshot has no valid date');
	if (modelStateFingerprint(input, snapshot.date) !== snapshot.inputFingerprint)
		throw new ModelStateMismatchError('input', `the snapshot (${snapshot.date}) was captured from another model or other settings: capture it again from this input`);
	const history = historyFingerprint(input, snapshot.date);
	if (history !== null && history !== snapshot.historyFingerprint)
		throw new ModelStateMismatchError('history', `the input's series before ${snapshot.date} differ from the ones the snapshot was captured from: leave the history out, or capture the snapshot again`);
	const state = decodePlain<ModelState>(snapshot.state);
	const ids = input.model.nodes.map((n) => n.id);
	if (state.nodes.length !== ids.length || state.nodes.some((n, i) => n.id !== ids[i])) throw new ModelStateMismatchError('input', 'the snapshot’s hydrological units are not the model’s');
	return state;
}

/**
 * The snapshot with the farm dams listed holding these volumes (m³, clamped
 * to 0 … capacity) at the start of its day, the rest of the state as it
 * was: what settings.damStorageReset on the snapshot's day does, without
 * the reset's `dam_storage_set` step in the output (the review triggers,
 * ../outlook/triggers.ts). Throws on a node that isn't a farm with a dam, or
 * a value that isn't a number.
 */
export function withDamStorage(snapshot: ModelStateSnapshot, input: ModelInput, storageM3: Readonly<Record<string, number>>): ModelStateSnapshot {
	const state = openSnapshot(snapshot, input);
	for (const [id, v] of Object.entries(storageM3)) {
		const i = input.model.nodes.findIndex((n) => n.id === id);
		const n = input.model.nodes[i];
		if (!n || n.kind !== 'farm' || !(n.damCapacityM3 > 0)) throw new Error(`withDamStorage: "${id}" is not a unit with a dam`);
		if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`withDamStorage: unit "${n.name}" storage ${String(v)} is not a number`);
		const node = state.nodes[i]!;
		node.setFromM3 ??= node.storageM3;
		// Within the capacity on the snapshot's day (engine ≥ 1.30.0: it can change over the run).
		node.storageM3 = Math.min(Math.max(v, 0), damCapacityOn(n, toEpochDay(snapshot.date)));
	}
	return { ...snapshot, state: encodePlain(state) };
}

/**
 * The snapshot with each full allocation's factor for the water year in
 * progress as the days before its day alone fit it (engine ≥ 1.69.0,
 * docs/model.md §2.15, §2.16): allocationFactorBefore in place of
 * allocationFactor, or none on a water year's first day, so a run resumed
 * from it fits that year on its own days (a part year asks for its prorated
 * volume). What an outlook or a review in a hindcast starts from, so no
 * member's demand reads a day on or after the decision date; a plain resume
 * (runModelFrom) keeps the capture run's factor, and equals the
 * uninterrupted run. Unchanged without a full allocation.
 */
export function withAllocationKnownBefore(snapshot: ModelStateSnapshot, input: ModelInput): ModelStateSnapshot {
	const state = openSnapshot(snapshot, input);
	let changed = false;
	for (const node of state.nodes) {
		if (node.allocationFactor === undefined && node.allocationFactorBefore === undefined) continue;
		if (node.allocationFactor === node.allocationFactorBefore) continue;
		if (node.allocationFactorBefore === undefined) delete node.allocationFactor;
		else node.allocationFactor = node.allocationFactorBefore;
		changed = true;
	}
	return changed ? { ...snapshot, state: encodePlain(state) } : snapshot;
}
