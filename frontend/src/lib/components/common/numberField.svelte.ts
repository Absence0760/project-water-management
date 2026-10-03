// What NumberInput reads from its text, what it says when it can't take it,
// and the field's state between keystrokes, focus and blur (NumberField).
// Kept out of the component so the rules are tested without a DOM
// (numberField.svelte.test.ts).
//
// Every field reads its text the same way, whatever its mode (%, a month, a
// volume, a cell of the node table): any space, a comma in a valid grouping
// (1,500) as a separator, and otherwise one comma as a decimal comma (12,5 =
// 12.5), through `parseNum`.
import { fmtNum, parseNum } from '$lib/format/number';
import { groupedText, plainText } from './numberText';

export interface NumberBounds {
	/** Lowest value the field takes, in the field's displayed units (after `scale`). */
	min?: number;
	/** Highest value the field takes, in the field's displayed units. */
	max?: number;
	/** A blank field means "none" (null). */
	nullable?: boolean;
}

/**
 * The number typed, or null when the text isn't one. "0,125" is a decimal
 * comma (0.125): no one groups thousands after a leading zero, though
 * `parseNum`'s grouping pattern would read it as 125.
 */
export function readNumber(text: string): number | null {
	const s = text.replace(/\s/g, '');
	if (/^-?0,\d+$/.test(s)) return parseNum(s.replace(',', '.'));
	return parseNum(s);
}

/** What the field holds after `text`: a number, null (a blank nullable field), or `invalid`. */
export type FieldRead = { ok: true; value: number | null } | { ok: false };

export function readField(text: string, bounds: NumberBounds): FieldRead {
	if (text.trim() === '') return bounds.nullable ? { ok: true, value: null } : { ok: false };
	const n = readNumber(text);
	if (n === null) return { ok: false };
	if (bounds.min !== undefined && n < bounds.min) return { ok: false };
	if (bounds.max !== undefined && n > bounds.max) return { ok: false };
	return { ok: true, value: n };
}

const num = (n: number) => fmtNum(n, 9, true);

/**
 * How to fix an invalid field, from its bounds: "Enter a number from 0 to
 * 99.9", "Enter 0 or more", "Enter 100 or less", "Enter a number", each
 * followed by ", or leave it blank for none" on a nullable field.
 */
export function numberFieldMessage({ min, max, nullable }: NumberBounds): string {
	const base =
		min !== undefined && max !== undefined
			? `Enter a number from ${num(min)} to ${num(max)}`
			: min !== undefined
				? `Enter ${num(min)} or more`
				: max !== undefined
					? `Enter ${num(max)} or less`
					: 'Enter a number';
	return nullable ? `${base}, or leave it blank for none` : base;
}

/**
 * The text after ArrowUp (`dir` 1) or ArrowDown (-1): one `step` (1 for
 * 'any') from the number typed, or from `fallback` (the stored value) when
 * the text isn't one, kept within the bounds.
 */
export function stepText(text: string, dir: 1 | -1, step: number | 'any', fallback: number | null, bounds: NumberBounds): string {
	const by = step === 'any' ? 1 : step;
	const from = readNumber(text) ?? fallback ?? bounds.min ?? 0;
	let n = Math.round((from + dir * by) * 1e9) / 1e9;
	if (bounds.min !== undefined) n = Math.max(bounds.min, n);
	if (bounds.max !== undefined) n = Math.min(bounds.max, n);
	return String(n);
}

export interface NumberFieldProps extends NumberBounds {
	/** The stored value. */
	value: number | null;
	/** Displayed = stored × scale (100 shows a fraction as a percentage). */
	scale: number;
	/** Thousands separators at rest. */
	grouped: boolean;
	/** At most this many decimals shown (display only). */
	decimals?: number;
	/** Read-only. */
	disabled: boolean;
	step: number | 'any';
}

const round9 = (n: number) => Math.round(n * 1e9) / 1e9;

/**
 * One number field's text and validity. `props` reads the field's current
 * props; `commit` stores a value the text gives (already divided by scale).
 * Invalid text is kept through blur; only `follow` (the stored value changed
 * from outside) and `reset` (invalidFields.reset()) replace it.
 */
export class NumberField {
	text = $state('');
	focused = $state(false);
	invalid = $state(false);
	#props: () => NumberFieldProps;
	#commit: (v: number | null) => void;

	constructor(props: () => NumberFieldProps, commit: (v: number | null) => void) {
		this.#props = props;
		this.#commit = commit;
		this.text = this.display();
	}

	/** The text at rest: grouped ("300 000") or plain, as the props say. */
	display(): string {
		const p = this.#props();
		return p.grouped ? groupedText(p.value, p.scale) : plainText(p.value, p.scale, p.decimals);
	}

	/** The stored value changed from outside (load, discard, undo): show it, unless the user is typing. */
	follow(): void {
		if (this.focused) return;
		this.text = this.display();
		this.invalid = false;
	}

	/** Back to the stored value, typing or not. */
	reset(): void {
		this.text = this.display();
		this.invalid = false;
	}

	/** The user typed `text`: store it when it is a number in range, else mark the field invalid. */
	input(text: string): void {
		this.text = text;
		const p = this.#props();
		const r = readField(text, p);
		if (!r.ok) {
			this.invalid = true;
			return;
		}
		this.invalid = false;
		this.#commit(r.value === null ? null : round9(r.value / p.scale));
	}

	focus(): void {
		this.focused = true;
		const p = this.#props();
		// Editing starts from the plain number, so the caret never lands in a separator.
		if (p.grouped && !p.disabled && !this.invalid) this.text = plainText(p.value, p.scale, p.decimals);
	}

	blur(): void {
		this.focused = false;
		// Invalid text stays, with its message, until it is fixed or the value changes.
		if (!this.invalid) this.text = this.display();
	}

	/** ArrowUp (1) or ArrowDown (-1) on a plain field; false when the key isn't the field's to handle. */
	step(dir: 1 | -1): boolean {
		const p = this.#props();
		if (p.grouped || p.disabled) return false;
		const stored = p.value == null ? null : round9(p.value * p.scale);
		this.input(stepText(this.text, dir, p.step, stored, p));
		return true;
	}
}
