// The unsaved-edits preview's input (issue #284, roadmap WP-1.17): the last
// run's own input (`GET …/runs/:runId/model-input`, ./inputs.ts) with only
// the edits not yet saved laid over it. The series always come from the
// server's copy of the run, so the preview can't drift from a stored run; the
// settings and the model take the saved → unsaved change, path by path, and
// nothing else. A change saved since the run isn't in the preview: the
// preview answers "what do these unsaved edits do to the last run?".
//
// Page-side and engine-free (types only), so a tab can build the input
// without loading the model's run code; the worker runs it (./compute.ts).
import type { ModelInput, ProjectModel } from '@water-management/engine';

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/**
 * Settings that say when a project runs or how its results are read, not how
 * the model runs: the server leaves them out of a run's input
 * (backend/src/runs/execute.ts loadLiveInput), so the overlay does too.
 */
export const NOT_MODEL_SETTINGS: readonly string[] = ['autoRun', 'outcomes', 'outlook'];
const stripped = (s: Plain): Plain => Object.fromEntries(Object.entries(s).filter(([k]) => !NOT_MODEL_SETTINGS.includes(k)));

/**
 * `base` with the change from `saved` to `draft` applied: where both are
 * objects (and `base` is too), only the keys that differ, recursively; a
 * key the draft dropped is dropped. Anything else that differs (a number, a
 * list, a value that became an object) is the draft's, whole. Unchanged
 * parts are `base`'s, so a run value the editor never touched stays as the
 * run had it.
 */
export function overlayValue(base: unknown, saved: unknown, draft: unknown): unknown {
	if (same(saved, draft)) return copy(base);
	if (!isPlain(base) || !isPlain(saved) || !isPlain(draft)) return copy(draft);
	const out: Plain = copy(base);
	for (const k of new Set([...Object.keys(saved), ...Object.keys(draft)])) {
		if (same(saved[k], draft[k])) continue;
		if (!(k in draft) || draft[k] === undefined) delete out[k];
		else out[k] = overlayValue(base[k], saved[k], draft[k]);
	}
	return out;
}

/** What the unsaved edits did to one list of the model (nodes, crops, …), by key. */
export interface ListChange {
	added: number;
	removed: number;
	changed: number;
}

/** One list of the model, keyed: the lists the editor changes (ProjectModel), with how each item is told apart. */
const LISTS: readonly { key: keyof ProjectModel; label: string; id: (x: Plain) => string }[] = [
	{ key: 'nodes', label: 'node', id: (x) => String(x.id) },
	{ key: 'crops', label: 'crop', id: (x) => String(x.id) },
	// A planted area is one crop on one unit; it has no id of its own.
	{ key: 'cropAreas', label: 'planted area', id: (x) => `${String(x.nodeId)}|${String(x.cropId)}` },
	{ key: 'transfers', label: 'transfer', id: (x) => String(x.id) },
	{ key: 'landCover', label: 'land-cover patch', id: (x) => String(x.id) },
	{ key: 'boreholes', label: 'borehole', id: (x) => String(x.id) },
	{ key: 'demandObjects', label: 'demand object', id: (x) => String(x.id) }
];

/** The name to give an item in a problem: its own, else its kind. */
const named = (label: string, x: Plain) => (typeof x.name === 'string' && x.name.trim() ? `${label} "${x.name.trim()}"` : `a ${label}`);

/**
 * One list overlaid by key: an item the edits removed goes, an item they
 * added comes in (last, or in place of the run's item with its key), and an
 * item they changed takes only the changed fields (overlayValue). An edited
 * item the last run doesn't have (added and saved since the run) can't be
 * changed there: it is left out and named in `problems`.
 */
function overlayList(base: readonly Plain[], saved: readonly Plain[], draft: readonly Plain[], id: (x: Plain) => string, label: string, problems: string[]): { list: Plain[]; change: ListChange } {
	const savedBy = new Map(saved.map((x) => [id(x), x]));
	const draftBy = new Map(draft.map((x) => [id(x), x]));
	const change: ListChange = { added: 0, removed: 0, changed: 0 };
	const out: Plain[] = [];
	const inBase = new Set<string>();
	for (const item of base) {
		const k = id(item);
		inBase.add(k);
		const was = savedBy.get(k);
		const now = draftBy.get(k);
		if (was && !now) {
			change.removed++;
			continue;
		}
		if (!was && now) {
			// Added again under the same key (a planted area put back): the draft's, whole.
			change.added++;
			out.push(copy(now));
			continue;
		}
		if (was && now && !same(was, now)) {
			change.changed++;
			out.push(overlayValue(item, was, now) as Plain);
			continue;
		}
		out.push(copy(item));
	}
	for (const [k, now] of draftBy) {
		if (inBase.has(k)) continue;
		const was = savedBy.get(k);
		if (!was) {
			change.added++;
			out.push(copy(now));
		} else if (!same(was, now)) {
			problems.push(`${named(label, now)} isn't in the last run (it was added after it), so its unsaved changes aren't in the preview`);
		}
	}
	return { list: out, change };
}

/** The editor's state on one side of the unsaved edits: as last saved, and as it is now. */
export interface UnsavedEdits {
	/** The Settings form's values as saved and as edited; absent when the preview leaves settings alone. */
	settings?: { saved: Plain; draft: Plain };
	/** The model as saved and as edited (ModelEditor); absent when the preview leaves the model alone. */
	model?: { saved: ProjectModel; draft: ProjectModel };
}

export interface Overlaid {
	/** The last run's input with the unsaved edits on it. */
	input: ModelInput;
	/** The top-level settings the edits changed (their keys), for the summary line. */
	settings: string[];
	/** Per list of the model, what the edits did. Lists they left alone are absent. */
	model: Partial<Record<keyof ProjectModel, ListChange>>;
	/** Edits that couldn't be laid over the last run, in words. The preview runs without them. */
	problems: string[];
}

/** The last run's input (`base`, never changed) with only the unsaved edits laid over it. */
export function overlayUnsaved(base: ModelInput, edits: UnsavedEdits): Overlaid {
	const problems: string[] = [];
	const input = copy(base);
	const settings: string[] = [];
	if (edits.settings) {
		const saved = stripped(edits.settings.saved);
		const draft = stripped(edits.settings.draft);
		for (const k of new Set([...Object.keys(saved), ...Object.keys(draft)])) if (!same(saved[k], draft[k])) settings.push(k);
		input.settings = overlayValue(base.settings, saved, draft) as ModelInput['settings'];
	}
	const model: Overlaid['model'] = {};
	if (edits.model) {
		const m = input.model as unknown as Record<string, Plain[] | undefined>;
		const saved = edits.model.saved as unknown as Record<string, Plain[] | undefined>;
		const draft = edits.model.draft as unknown as Record<string, Plain[] | undefined>;
		for (const { key, label, id } of LISTS) {
			const was = saved[key] ?? [];
			const now = draft[key] ?? [];
			if (same(was, now)) continue;
			const { list, change } = overlayList((base.model as unknown as Record<string, Plain[] | undefined>)[key] ?? [], was, now, id, label, problems);
			model[key] = change;
			// An optional list the run never had stays absent when the edits leave it empty, as the API sends it.
			if (list.length || m[key] !== undefined) m[key] = list;
		}
	}
	return { input, settings, model, problems };
}

/** Whether there is anything unsaved to preview. */
export function hasUnsaved(edits: UnsavedEdits): boolean {
	return (!!edits.settings && !same(stripped(edits.settings.saved), stripped(edits.settings.draft))) || (!!edits.model && !same(edits.model.saved, edits.model.draft));
}

/** The parts of a run (RunMeta) the preview's choice of base reads. */
export interface BaseRunCandidate {
	id: string;
	createdAt: string;
	legacy?: boolean;
	scenarioId?: string | null;
}

/**
 * The run the preview starts from: the newest run of the catchment's own
 * model (a scenario's run has its overrides in its input, and a legacy run's
 * runoff model is gone from today's engine). null when there is none.
 */
export function previewBaseRun<R extends BaseRunCandidate>(runs: readonly R[] | null | undefined): R | null {
	let best: R | null = null;
	for (const r of runs ?? []) {
		if (r.scenarioId || r.legacy) continue;
		if (!best || Date.parse(r.createdAt) > Date.parse(best.createdAt)) best = r;
	}
	return best;
}
