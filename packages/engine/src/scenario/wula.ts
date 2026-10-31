// The water-use licence application (WULA) a scenario models
// (294_wula_reference; docs/scenarios.md § Applications, "The WULA
// reference"): its number and the works as applied for, and the check that
// ties the scenario's changes to them. Each op may name the works it models
// (ScenarioOp's `works` tag, the `ref` of one listed works). Every line here
// is a warning: it never stops a scenario from running or being submitted,
// since a change can model applied-for works without the tag, and the
// assessor reads the tie on the evidence report's page 1 and Appendix A.2.
// Pure: no I/O.
import type { OpClass } from './overrides';
import type { ScenarioOp } from './ops';

/** One works as the WULA applies for it: the label ops name it by, and the works in words. */
export interface WulaWork {
	/** Short label, unique in the list ("W1", or the WULA's own item number). */
	ref: string;
	/** The works as applied for, in words. */
	text: string;
}

/** A scenario's WULA reference (scenario.wula_number, scenario.wula_works). */
export interface WulaReference {
	/** The application's number as the authority gave it; null = not given. */
	number: string | null;
	works: WulaWork[];
}

export const WULA_NUMBER_MAX = 100;
export const WULA_WORK_REF_MAX = 20;
export const WULA_WORK_TEXT_MAX = 1000;
export const WULA_WORKS_MAX = 50;

export const NO_WULA: WulaReference = Object.freeze({ number: null, works: Object.freeze([]) as unknown as WulaWork[] });

/** Whether the scenario records any of a WULA reference. */
export const hasWula = (w: WulaReference | null | undefined): boolean => !!w && (w.number !== null || w.works.length > 0);

/** How the ops meet the listed works: which proposals name none, which ops name a works not listed, and which works no op models. */
export interface WulaTie {
	/** 0-based indices of proposal ops that name no listed works (no tag, or a tag the list lacks). */
	untiedProposals: number[];
	/** 0-based indices of ops (any class) whose tag names a works the list lacks. */
	unknownRefs: number[];
	/** Refs of listed works that no op names. */
	unmodelled: string[];
}

/** Tie the ops to the works (wulaTie): `classified` one class per op; an op without a class counts as a proposal. */
export function wulaTie(ops: readonly ScenarioOp[], classified: readonly (OpClass | null | undefined)[], works: readonly WulaWork[]): WulaTie {
	const refs = new Set(works.map((w) => w.ref));
	const named = new Set<string>();
	const untiedProposals: number[] = [];
	const unknownRefs: number[] = [];
	ops.forEach((op, i) => {
		const tag = op.works;
		const listed = tag !== undefined && refs.has(tag);
		if (listed) named.add(tag);
		if (tag !== undefined && !listed) unknownRefs.push(i);
		if (!listed && (classified[i] ?? 'proposal') === 'proposal') untiedProposals.push(i);
	});
	return { untiedProposals, unknownRefs, unmodelled: works.filter((w) => !named.has(w.ref)).map((w) => w.ref) };
}

/** Whether a scenario's changes are held to a WULA: every application, and a team scenario that records a reference. */
export const wulaApplies = (application: boolean, wula: WulaReference | null | undefined): boolean => application || hasWula(wula);

const opLabel = (op: ScenarioOp, i: number) => `op ${i + 1} (${op.op})`;

/**
 * The check's WULA warnings, one line each (docs/scenarios.md § The WULA
 * reference): none unless `wulaApplies`. Op lines start "op N (kind): ", as
 * the check's problem lines do, so the editor files them under their op.
 * With no works listed, one line says so instead of one per proposal.
 */
export function wulaWarnings(
	ops: readonly ScenarioOp[],
	classified: readonly (OpClass | null | undefined)[],
	wula: WulaReference | null | undefined,
	opts: { application: boolean }
): string[] {
	if (!wulaApplies(opts.application, wula)) return [];
	const w = wula ?? NO_WULA;
	const out: string[] = [];
	if (w.number === null) out.push('No WULA application number is given: add it under Application details, as the authority gave it.');
	const proposals = ops.filter((_, i) => (classified[i] ?? 'proposal') === 'proposal').length;
	if (!w.works.length) {
		if (proposals) out.push('The WULA reference lists no works: list the works as applied for, then tie each proposal to the works it models.');
		return out;
	}
	const tie = wulaTie(ops, classified, w.works);
	const unknown = new Set(tie.unknownRefs);
	for (const i of unknown) out.push(`${opLabel(ops[i]!, i)}: names works “${ops[i]!.works}”, which the WULA reference doesn't list.`);
	for (const i of tie.untiedProposals)
		if (!unknown.has(i)) out.push(`${opLabel(ops[i]!, i)}: a proposal tied to none of the works the WULA applies for: name the works it models.`);
	for (const ref of tie.unmodelled) out.push(`Works “${ref}” is applied for, but no change models it.`);
	return out;
}
