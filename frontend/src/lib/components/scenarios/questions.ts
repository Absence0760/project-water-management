// "Ask the assessors why" (164_applicant_visibility, docs/ui.md
// § Applications): which of an application's problem lines a rule hidden
// from its applicant broke, in words, and whether they have asked about it.
import type { ApplicationQuestion, MaskedRuleRef } from '$lib/api';

/** A rule's kind (the check's `maskedRules[].rules`) in words: what it is about, never which unit. */
export function ruleLabel(kind: string): string {
	switch (kind) {
		case 'shares':
			return 'flow shares';
		case 'area':
			return 'catchment area';
		case 'supplyTrigger':
		case 'supplyRor':
		case 'supplyStop':
			return 'a supply rule on a unit you can’t see';
		case 'bhDrought':
		case 'bhEmergency':
			return 'a borehole rule on a unit you can’t see';
		default:
			return 'a rule about an item you can’t see';
	}
}

/** "flow shares" / "flow shares and catchment area" / "a, b and c". */
export function rulesText(kinds: readonly string[]): string {
	const words = [...new Set(kinds.map(ruleLabel))];
	return words.length <= 1 ? (words[0] ?? ruleLabel('')) : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** "change 3" / "changes 3–5" (1-based, as the problem lines number them). */
export function opsText(ops: readonly number[]): string {
	const n = [...ops].sort((a, b) => a - b).map((i) => i + 1);
	if (n.length === 1) return `change ${n[0]}`;
	const run = n.every((x, i) => i === 0 || x === n[i - 1]! + 1);
	return run ? `changes ${n[0]}–${n.at(-1)}` : `changes ${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
}

export interface Askable {
	problem: number;
	line: string;
	ops: number[];
	rules: string[];
	/** The newest question asked about this very line, if any. */
	asked: ApplicationQuestion | null;
}

/**
 * Each problem line a hidden rule broke, with the newest question already
 * asked about the same words (a question quotes the line as it was read, so
 * a changed line is a new question).
 */
export function askables(problems: readonly string[], masked: readonly MaskedRuleRef[] | undefined, questions: readonly ApplicationQuestion[]): Askable[] {
	return (masked ?? [])
		.filter((m) => problems[m.problem] !== undefined)
		.map((m) => {
			const line = problems[m.problem]!;
			const asked = [...questions].filter((q) => q.problem === line).sort((a, b) => b.askedAt.localeCompare(a.askedAt))[0] ?? null;
			return { problem: m.problem, line, ops: m.ops, rules: m.rules, asked };
		});
}
