<script lang="ts">
	// Numeric input bound to a number (or null when `nullable`). `scale`
	// displays a stored fraction as a percentage (scale = 100) while keeping
	// the stored value unchanged. Invalid text is shown but not committed.
	import type { HTMLInputAttributes } from 'svelte/elements';

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
		placeholder,
		onchange,
		...rest
	}: {
		value: number | null;
		nullable?: boolean;
		scale?: number;
		/** Read-only (kept focusable, unlike a disabled input). */
		disabled?: boolean;
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
	const display = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '' : String(round(v * scale)));

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

	function commit(raw: string) {
		const s = raw.trim();
		if (s === '') {
			if (nullable) {
				value = null;
				invalid = false;
				onchange?.(null);
			} else invalid = true;
			return;
		}
		const n = Number(s);
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
	type="number"
	inputmode="decimal"
	{min}
	{max}
	{step}
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
	onfocus={() => (focused = true)}
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
