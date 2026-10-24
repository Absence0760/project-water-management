// What DayInput reads from its text, what it says when it can't take it, and
// the field's state between keystrokes, focus and blur (DayField). Kept out of
// the component so the rules are tested without a DOM (dayField.svelte.test.ts).
//
// A typed day is day first (ui-playbook § 2 "A typed date is day first too"):
// "15 Nov 2021", "15/11/2021" and the ISO "2021-11-15" all read, through
// `parseDay`, and the field shows it back as "15 Nov 2021" (fmtDay). The value
// stored and sent is always YYYY-MM-DD, '' for a blank field. Every step is
// string work, never a Date, so no time zone can move a day.
import { DAY_FIRST_EXAMPLES, fmtDay, parseDay } from '#lib/format/number.js';

export interface DayBounds {
	/** The first day the field takes, YYYY-MM-DD. */
	min?: string | null;
	/** The last day the field takes, YYYY-MM-DD. */
	max?: string | null;
}

/** What the field holds after `text`: a day ('' for blank), or `invalid`. */
export type DayRead = { ok: true; value: string } | { ok: false };

/** The day typed, within the bounds; a blank field is '' (none; `required` is the form's to check). */
export function readDay(text: string, bounds: DayBounds = {}): DayRead {
	if (text.trim() === '') return { ok: true, value: '' };
	const iso = parseDay(text);
	if (!iso) return { ok: false };
	if (bounds.min && iso < bounds.min) return { ok: false };
	if (bounds.max && iso > bounds.max) return { ok: false };
	return { ok: true, value: iso };
}

/**
 * How to fix an invalid day field, from its bounds: "Enter a day from 1 Jan
 * 1981 to 31 Dec 2024, day first: 15 Nov 2021, 15/11/2021 or 2021-11-15",
 * "Enter a day on or after …", "… on or before …", or "Enter a day, day first: …".
 */
export function dayFieldMessage({ min, max }: DayBounds): string {
	const range =
		min && max ? ` from ${fmtDay(min)} to ${fmtDay(max)}` : min ? ` on or after ${fmtDay(min)}` : max ? ` on or before ${fmtDay(max)}` : '';
	return `Enter a day${range}, day first: ${DAY_FIRST_EXAMPLES}`;
}

/** The text a stored day shows at rest: "15 Nov 2021", or '' for none. */
export const dayText = (value: string | null | undefined): string => (value ? fmtDay(value) : '');

export interface DayFieldProps extends DayBounds {
	/** The stored day, YYYY-MM-DD; '' or null for none. */
	value: string | null | undefined;
	/** Store on every keystroke that reads as a day ('input'), or only once typing ends: blur or Enter ('change'). */
	commit: 'input' | 'change';
}

/**
 * One day field's text and validity. `props` reads the field's current props;
 * `store` keeps a day the text gives (YYYY-MM-DD, '' for blank). Invalid text
 * is kept through blur; only `follow` (the stored value changed from outside)
 * and `reset` (invalidFields.reset()) replace it.
 */
export class DayField {
	text = $state('');
	focused = $state(false);
	invalid = $state(false);
	#props: () => DayFieldProps;
	#store: (v: string) => void;

	constructor(props: () => DayFieldProps, store: (v: string) => void) {
		this.#props = props;
		this.#store = store;
		this.text = this.display();
	}

	/** The text at rest. */
	display(): string {
		return dayText(this.#props().value);
	}

	/** The stored day changed from outside (load, discard, undo): show it, unless the user is typing. */
	follow(): void {
		if (this.focused) return;
		this.text = this.display();
		this.invalid = false;
	}

	/** Back to the stored day, typing or not. */
	reset(): void {
		this.text = this.display();
		this.invalid = false;
	}

	/** Read the text; store it when it is a day in range (and differs), else mark the field invalid. */
	#read(store: boolean): void {
		const p = this.#props();
		const r = readDay(this.text, p);
		this.invalid = !r.ok;
		if (r.ok && store && r.value !== (p.value ?? '')) this.#store(r.value);
	}

	/** The user typed `text`. */
	input(text: string): void {
		this.text = text;
		this.#read(this.#props().commit === 'input');
	}

	focus(): void {
		this.focused = true;
	}

	/** Typing ended (blur, or Enter): store a 'change' field's day, and tidy what reads as one. */
	change(): void {
		this.#read(true);
		if (!this.invalid) this.text = dayText(parseDay(this.text));
	}

	blur(): void {
		this.focused = false;
		this.change();
	}
}
