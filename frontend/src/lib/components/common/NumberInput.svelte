<script lang="ts">
	// Numeric input bound to a number (or null when `nullable`). `scale`
	// displays a stored fraction as a percentage (scale = 100) while keeping
	// the stored value unchanged. Invalid text is shown but not committed.
	// `grouped` shows thousands separators (300 000, narrow no-break spaces) whenever the field isn't
	// being edited; it is then a text input, since type="number" can't show them.
	// `decimals` caps how many decimals a plain field shows (display only).
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { parseNum } from '$lib/format/number';
	import { groupedText, plainText } from './numberText';

	let {
		value = $bindable(),
		nullable = false,
		scale = 1,
		label,
		id,
		min,
		max,
		step = 'any',
		disabled = false,
		grouped = false,
		decimals,
		placeholder,
		onchange,
		...rest
	}: {
		value: number | null;
		nullable?: boolean;
		scale?: number;
		/** Read-only (kept focusable, unlike a disabled input). */
		disabled?: boolean;
		/** Show thousands separators while not editing (a text input). */
		grouped?: boolean;
		/** Show at most this many decimals (display only; the stored value keeps its precision until edited). */
		decimals?: number;
		/** Accessible label (use when there's no visible <label for>). */
		label?: string;
		id?: string;
		min?: number;
		max?: number;
		step?: number | 'any';
		placeholder?: string;
		onchange?: (v: number | null) => void;
	} & Omit<HTMLInputAttributes, 'value' | 'onchange' | 'min' | 'max' | 'step'> = $props();

	const round = (n: number) => Math.round(n * 1e9) / 1e9;
	const raw = (v: number | null | undefined) => plainText(v, scale, decimals);
	// Grouped fields show "300 000" at rest; read-only ones never switch to raw.
	const display = (v: number | null | undefined) => (grouped ? groupedText(v, scale) : raw(v));

	let text = $state(display(value));
	let focused = $state(false);
	let invalid = $state(false);

	// Follow external changes (revert, load) while the user isn't typing.
	$effect(() => {
		const d = display(value);
		if (!focused) {
			text = d;
			invalid = false;
		}
	});

	function commit(input: string) {
		const s = input.trim();
		if (s === '') {
			if (nullable) {
				value = null;
				invalid = false;
				onchange?.(null);
			} else invalid = true;
			return;
		}
		const n = grouped ? (parseNum(s) ?? NaN) : Number(s);
		if (!Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
			invalid = true;
			return;
		}
		invalid = false;
		value = round(n / scale);
		onchange?.(value);
	}
</script>

<input
	{...rest}
	{id}
	type={grouped ? 'text' : 'number'}
	inputmode="decimal"
	min={grouped ? undefined : min}
	max={grouped ? undefined : max}
	step={grouped ? undefined : step}
	{placeholder}
	readonly={disabled}
	aria-label={label}
	aria-invalid={invalid || undefined}
	class:invalid
	value={text}
	oninput={(e) => {
		const el = e.currentTarget;
		text = el.value;
		if (el.validity.badInput) invalid = true;
		else commit(el.value);
	}}
	onfocus={() => {
		focused = true;
		// Editing starts from the plain number, so the caret never lands in a separator.
		if (grouped && !disabled && !invalid) text = raw(value);
	}}
	onblur={() => {
		focused = false;
		if (!invalid) text = display(value);
	}}
/>

<style>
	input.invalid {
		border-color: var(--danger);
		background: var(--danger-soft);
	}
</style>
