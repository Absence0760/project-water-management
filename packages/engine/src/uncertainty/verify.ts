// Checking an ensemble someone else ran (docs/model.md §2.10e, docs/security.md
// § Uncertainty bands). The browser runs the ensemble; the server stores it
// only after (1) regenerating the whole sample from the stored seed and
// options and finding the same members, and (2) re-running a few members it
// picks at random and finding the same scores, verdicts and outputs. Bands
// are then summarised on the server from the members, so a stored band can
// only come from the stored sample. "Reproduce" in the app re-runs every
// member the same way.
import type { ModelInput } from '../project';
import { runModelWithoutChecks } from '../run';
import {
	ensembleContext,
	ensembleHeader,
	ensembleMembers,
	memberInput,
	memberMetrics,
	runMember,
	type EnsembleContext,
	type EnsembleHeader,
	type EnsembleMember,
	type MemberMetrics,
	type MemberResult
} from './ensemble';
import { pairedHeader, type PairedMember } from './paired';
import type { ResolvedEnsembleOptions } from './options';

/** Relative tolerance: engine arithmetic is deterministic, but a browser's Math.exp/log may differ in the last place. */
export const VERIFY_TOLERANCE = 1e-6;

const close = (a: number, b: number) => a === b || Math.abs(a - b) <= VERIFY_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));

function diffValue(path: string, a: unknown, b: unknown, out: string[]): void {
	if (out.length >= 20) return;
	if (typeof a === 'number' && typeof b === 'number') {
		if (!close(a, b)) out.push(`${path}: ${a} ≠ ${b}`);
	} else if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) out.push(`${path}: ${a.length} values ≠ ${b.length}`);
		else a.forEach((x, i) => diffValue(`${path}[${i}]`, x, b[i], out));
	} else if (a && b && typeof a === 'object' && typeof b === 'object') {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const k of keys) diffValue(`${path}.${k}`, (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], out);
	} else if (a !== b) out.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
}

/** Differences between two values (numbers within VERIFY_TOLERANCE), as "path: a ≠ b" lines (at most 20). */
export function valueDiffs(path: string, a: unknown, b: unknown): string[] {
	const out: string[] = [];
	diffValue(path, a, b, out);
	return out;
}

/** Does `posted` hold exactly the sample the options and project generate? */
export function sampleMismatches(ctx: EnsembleContext, posted: readonly EnsembleMember[]): string[] {
	const want = ensembleMembers(ctx.options, ctx.startParams);
	if (posted.length !== want.length) return [`${posted.length} members posted, the sample has ${want.length}`];
	const out: string[] = [];
	want.forEach((w, i) => {
		const p = posted[i]!;
		const pick = (m: EnsembleMember) => ({ index: m.index, reference: m.reference, params: m.params, panOffset: m.panOffset, rain: m.rain, record: m.record });
		out.push(...valueDiffs(`member ${i}`, pick(w), pick(p)));
	});
	return out.slice(0, 20);
}

/** A threshold within tolerance of the recomputed score may legitimately flip the verdict across JavaScript engines. */
function verdictMayDiffer(ctx: EnsembleContext, m: MemberResult): boolean {
	const t = ctx.options.thresholds;
	const near = (x: number | null, y: number) => x !== null && Math.abs(x - y) <= VERIFY_TOLERANCE * Math.max(1, Math.abs(y));
	return near(m.scores.skill, t.minSkill) || (t.maxLowFlowBiasPct !== null && m.scores.lowFlowBiasPct !== null && near(Math.abs(m.scores.lowFlowBiasPct), t.maxLowFlowBiasPct));
}

/** Re-run the members at `indices` and compare with what was posted. */
export function memberMismatches(ctx: EnsembleContext, posted: readonly MemberResult[], indices: readonly number[]): string[] {
	const out: string[] = [];
	for (const i of indices) {
		const p = posted[i];
		if (!p) {
			out.push(`member ${i} is missing`);
			continue;
		}
		const { result: r } = runMember(ctx, p);
		out.push(...valueDiffs(`member ${i} scores`, r.scores, p.scores));
		if (r.accepted !== p.accepted && !verdictMayDiffer(ctx, r)) out.push(`member ${i}: kept ${p.accepted}, recomputed ${r.accepted}`);
		if (r.accepted === p.accepted) {
			out.push(...valueDiffs(`member ${i} rejected`, r.rejected, p.rejected));
			out.push(...valueDiffs(`member ${i} metrics`, r.metrics, p.metrics));
		}
	}
	return out.slice(0, 20);
}

/** Re-run paired members at `positions` (into `posted`) on the other run's inputs and compare. */
export function pairedMismatches(ctx: EnsembleContext, baselineKept: readonly EnsembleMember[], posted: readonly PairedMember[], positions: readonly number[]): string[] {
	const out: string[] = [];
	if (posted.length !== baselineKept.length) return [`${posted.length} pairs posted, the baseline kept ${baselineKept.length}`];
	posted.forEach((p, i) => {
		if (p.index !== baselineKept[i]!.index) out.push(`pair ${i} is member ${p.index}, expected ${baselineKept[i]!.index}`);
	});
	for (const i of positions) {
		const m = baselineKept[i]!;
		const metrics: MemberMetrics = memberMetrics(ctx, runModelWithoutChecks(memberInput(ctx, m)));
		out.push(...valueDiffs(`pair ${i} metrics`, metrics, posted[i]!.metrics));
	}
	return out.slice(0, 20);
}

/**
 * Up to `k` distinct member positions picked by `random` (0 ≤ r < 1): kept
 * members first (they set the bands), then any. The server passes a
 * cryptographic source, so a client can't know which members will be checked.
 */
export function pickCheckedMembers(members: readonly Pick<MemberResult, 'accepted'>[], k: number, random: () => number): number[] {
	const kept = members.map((m, i) => (m.accepted ? i : -1)).filter((i) => i >= 0);
	const rest = members.map((_, i) => i).filter((i) => !members[i]!.accepted);
	const draw = (pool: number[], n: number) => {
		const p = [...pool];
		const out: number[] = [];
		while (out.length < n && p.length) out.push(p.splice(Math.floor(random() * p.length), 1)[0]!);
		return out;
	};
	const a = draw(kept, Math.min(rest.length ? k - 1 : k, kept.length));
	return [...a, ...draw(rest, k - a.length)].sort((x, y) => x - y);
}

/**
 * Check a posted ensemble: the whole sample, member 0 (whose run also gives
 * the header, so the server never takes the client's) and `k` random members.
 * `mismatches` empty = verified.
 */
export function verifyEnsemble(
	input: ModelInput,
	options: ResolvedEnsembleOptions,
	posted: readonly MemberResult[],
	k: number,
	random: () => number
): { mismatches: string[]; header: EnsembleHeader | null } {
	const ctx = ensembleContext(input, options);
	const sample = sampleMismatches(ctx, posted);
	if (sample.length) return { mismatches: sample, header: null };
	const { output } = runMember(ctx, posted[0]!);
	const header = ensembleHeader(ctx, output);
	const rest = pickCheckedMembers(posted.slice(1), k, random).map((i) => i + 1);
	return { mismatches: memberMismatches(ctx, posted, [0, ...rest]), header };
}

/** Check a posted paired ensemble: the pairing, the first pair (which gives the header) and `k` random pairs. */
export function verifyPaired(
	other: ModelInput,
	options: ResolvedEnsembleOptions,
	baselineHeader: EnsembleHeader,
	baselineKept: readonly EnsembleMember[],
	posted: readonly PairedMember[],
	k: number,
	random: () => number
): { mismatches: string[]; header: EnsembleHeader | null } {
	if (!baselineKept.length) return { mismatches: ['the baseline kept no members'], header: null };
	const ctx = ensembleContext(other, options, false);
	const header = pairedHeader(baselineHeader, runModelWithoutChecks(memberInput(ctx, baselineKept[0]!)));
	const rest = pickCheckedMembers(
		posted.slice(1).map(() => ({ accepted: true })),
		k,
		random
	).map((i) => i + 1);
	return { mismatches: pairedMismatches(ctx, baselineKept, posted, [0, ...rest]), header };
}
