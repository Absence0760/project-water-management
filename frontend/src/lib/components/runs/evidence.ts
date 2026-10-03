// Helpers for the nominated evidence run (010_run_nomination, docs/ui.md §
// Evidence nomination). Pure: dates are formatted by the caller's `fmt`.
import type { Nomination, RunEvidence, RunMeta } from '$lib/api';
import { FORMER_MEMBER } from '$lib/format/maker';

/** A runoff model id as people read it. */
export function runoffModelName(id: string | undefined | null): string {
	if (!id || id === 'legacy') return 'legacy (b023 workbook)';
	if (id === 'gr4j') return 'GR4J';
	return id;
}

const quoted = (label: string | null | undefined) => `“${label || 'Untitled run'}”`;
/** Who did it; a deleted account's nomination stays with the name gone (138). */
const by = (who: string | null) => ` by ${who ?? FORMER_MEMBER}`;

/** A withdrawal row (098): no run, only who, when and why. */
export const isWithdrawal = (n: Pick<Nomination, 'withdrawn' | 'runId'>): boolean => !!n.withdrawn || n.runId === null;

/** A nomination of a run (not a withdrawal), with its run fields known. */
export type RunNomination = Nomination & { runId: string; runLabel: string; runCreatedAt: string };

/** The current nomination: the newest entry of a history (oldest first), or null when there is none or it is a withdrawal. */
export const currentNomination = (history: readonly Nomination[]): RunNomination | null => {
	const last = history.at(-1);
	return last && !isWithdrawal(last) ? (last as RunNomination) : null;
};

export interface HistoryEntry {
	id: string;
	/** Null for a withdrawal. */
	runId: string | null;
	/** "Nominated “A” on 2026-09-20 by Ann" for the first (and the first after a withdrawal), "Replaced by “B” on … by …" after it, "Withdrawn on … by …" for a withdrawal. */
	text: string;
	reason: string;
	/** GR4J, legacy … and the engine version the nominated run used; '' for a withdrawal. */
	model: string;
	current: boolean;
}

/**
 * The history as it reads aloud, oldest first: the first nomination, then
 * each replacement, with its reason. Nothing in it can be edited or removed,
 * so this is the whole story of which run the project stood behind.
 */
export function historyEntries(history: readonly Nomination[], fmt: (iso: string) => string): HistoryEntry[] {
	return history.map((n, i) => {
		const when = ` on ${fmt(n.nominatedAt)}${by(n.nominatedBy)}`;
		if (isWithdrawal(n)) return { id: n.id, runId: null, text: `Withdrawn${when}`, reason: n.reason, model: '', current: false };
		// A run nominated with nothing standing before it (first, or after a withdrawal) is nominated, not a replacement.
		const fresh = i === 0 || isWithdrawal(history[i - 1]!);
		return {
			id: n.id,
			runId: n.runId,
			text: `${fresh ? 'Nominated' : 'Replaced by'} ${quoted(n.runLabel)}${when}`,
			reason: n.reason,
			model: `${runoffModelName(n.runoffModel)}, engine ${n.engineVersion}`,
			current: i === history.length - 1
		};
	});
}

/**
 * Runs made after the nominated run with a different runoff model: the case
 * an assessor worries about (an applicant switching to whichever model is
 * kindest). Null when there are none, or nothing is nominated. Runs from an
 * older API without `runoffModel` are left out rather than guessed.
 */
export function modelDriftWarning(runs: readonly RunMeta[], history: readonly Nomination[]): string | null {
	const cur = currentNomination(history);
	if (!cur) return null;
	const after = Date.parse(cur.runCreatedAt);
	const newer = runs.filter((r) => r.id !== cur.runId && r.runoffModel && r.runoffModel !== cur.runoffModel && Date.parse(r.createdAt) > after);
	if (!newer.length) return null;
	const models = [...new Set(newer.map((r) => runoffModelName(r.runoffModel)))].join(', ');
	const n = newer.length;
	return (
		`${n} run${n === 1 ? '' : 's'} made after the nominated evidence run ${quoted(cur.runLabel)} ` +
		`use${n === 1 ? 's' : ''} a different runoff model (${models}, not ${runoffModelName(cur.runoffModel)}). ` +
		'The nomination still stands: results from those runs are not the evidence unless one is nominated, with a reason.'
	);
}

/** What a run's evidence status says in the run header, or null for a run never nominated. */
export function evidenceLine(runId: string, history: readonly Nomination[], fmt: (iso: string) => string): string | null {
	let i = -1;
	for (let k = history.length - 1; k >= 0; k--)
		if (history[k]!.runId === runId) {
			i = k;
			break;
		}
	if (i < 0) return null;
	const own = history[i]!;
	const next = history[i + 1];
	const nominated = `Nominated as evidence on ${fmt(own.nominatedAt)}${by(own.nominatedBy)}`;
	if (!next) return `${nominated}.`;
	if (isWithdrawal(next)) return `${nominated}; withdrawn on ${fmt(next.nominatedAt)}${by(next.nominatedBy)}.`;
	return `${nominated}; replaced by ${quoted(next.runLabel)} on ${fmt(next.nominatedAt)}.`;
}

/**
 * The comparison's note on one side: whether run A or B is (or was) the
 * nominated evidence, with the reasons, so a reader comparing runs can't
 * miss that one of them is the one the project stands behind.
 */
export function compareEvidenceNote(side: 'A' | 'B', e: RunEvidence | null | undefined, fmt: (iso: string) => string): string | null {
	if (!e) return null;
	const nominated = `nominated on ${fmt(e.nominatedAt)}${by(e.nominatedBy)} (“${e.reason}”)`;
	if (e.status === 'current' || !e.replacedBy) return `Run ${side} is the nominated evidence run, ${nominated}.`;
	const r = e.replacedBy;
	if (isWithdrawal(r)) return `Run ${side} was the evidence run, ${nominated}, then the nomination was withdrawn on ${fmt(r.nominatedAt)}${by(r.nominatedBy)} because “${r.reason}”.`;
	return `Run ${side} was the evidence run, ${nominated}, then replaced by ${quoted(r.runLabel)} on ${fmt(r.nominatedAt)}${by(r.nominatedBy)} because “${r.reason}”.`;
}

/**
 * Why the nominate action is unavailable for a run, or null when it can be
 * nominated. The server refuses each case too (409).
 */
export function nominateBlocker(run: Pick<RunMeta, 'id' | 'legacy' | 'scenarioName' | 'trigger'>, history: readonly Nomination[]): string | null {
	if (run.legacy) return 'A run of the legacy runoff model (removed in engine 1.0.0) is workbook comparison only, so it can’t be nominated as evidence.';
	// scenarioName stays set once the scenario is deleted (the run records it).
	if (run.scenarioName != null) return 'A scenario run is its scenario’s changes on a base run, not the catchment as it is, so it can’t be nominated as evidence. Nominate a run of the model.';
	if (run.trigger === 'forecast') return 'A forecast run’s last days are modelled on forecast rain, so it can’t be nominated as evidence: evidence is judged on the record.';
	if (currentNomination(history)?.runId === run.id) return 'This run is the nominated evidence run.';
	return null;
}
