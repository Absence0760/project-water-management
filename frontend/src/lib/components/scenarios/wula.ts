// The WULA reference on a scenario (WulaReference.svelte, OpList's works
// select; 294_wula_reference, docs/scenarios.md § The WULA reference): the
// water-use licence application's number and the works as applied for, and
// each change's `works` tag. Pure helpers, so the draft's dirtiness, the PATCH
// it sends and the tag a change gets are tested without the components.
import type { ScenarioOp, WulaReference, WulaWork } from '@water-management/engine';

/** A works row as the form edits it. */
export interface WorksDraft {
	ref: string;
	text: string;
}

/** What the form edits: the number as text ('' = not given) and the works rows. */
export interface WulaDraft {
	number: string;
	works: WorksDraft[];
}

export const draftOf = (w: WulaReference): WulaDraft => ({ number: w.number ?? '', works: w.works.map((x) => ({ ...x })) });

/** The draft as the server would store it: trimmed, blank rows (no ref and no text) left out. */
export function cleaned(d: WulaDraft): WulaReference {
	return {
		number: d.number.trim() || null,
		works: d.works.map((w) => ({ ref: w.ref.trim(), text: w.text.replace(/\r\n?/g, '\n').trim() })).filter((w) => w.ref !== '' || w.text !== '')
	};
}

/** What's wrong with a draft before it is sent, one line each; empty when it may be saved. */
export function draftProblems(d: WulaDraft): string[] {
	const w = cleaned(d).works;
	const out: string[] = [];
	w.forEach((x, i) => {
		if (!x.ref) out.push(`Works ${i + 1} needs a reference (W1, or the WULA’s own item number).`);
		if (!x.text) out.push(`Works ${x.ref || i + 1} needs saying what the works are.`);
	});
	const refs = w.map((x) => x.ref).filter(Boolean);
	const dup = refs.filter((r, i) => refs.indexOf(r) !== i);
	if (dup.length) out.push(`Each works needs its own reference: ${[...new Set(dup)].map((r) => `“${r}”`).join(', ')} is used twice.`);
	return out;
}

/** What a Save sends: the number and the works, each only when it differs from the stored one. Empty when nothing changed. */
export function wulaPatch(d: WulaDraft, stored: WulaReference): { wulaNumber?: string | null; wulaWorks?: WulaWork[] } {
	const next = cleaned(d);
	const out: { wulaNumber?: string | null; wulaWorks?: WulaWork[] } = {};
	if (next.number !== stored.number) out.wulaNumber = next.number;
	if (JSON.stringify(next.works) !== JSON.stringify(stored.works)) out.wulaWorks = next.works;
	return out;
}

/** The one-line summary the fold shows closed. */
export function wulaSummary(w: WulaReference): string {
	const works = w.works.length === 1 ? '1 works applied for' : `${w.works.length} works applied for`;
	if (w.number === null && !w.works.length) return 'Not given';
	return `${w.number ?? 'No number'} · ${works}`;
}

/** The ops with change `i` tied to the works `ref` (null: to none). The rest are the same objects. */
export function tagOp(ops: readonly ScenarioOp[], i: number, ref: string | null): ScenarioOp[] {
	return ops.map((op, k) => {
		if (k !== i) return op;
		const { works: _was, ...rest } = op;
		void _was;
		return (ref === null ? rest : { ...rest, works: ref }) as ScenarioOp;
	});
}
