<script lang="ts">
	// Numeric input bound to a number (or null when `nullable`). `scale`
	// displays a stored fraction as a percentage (scale = 100) while keeping
	// the stored value unchanged; `min` and `max` are in the displayed units.
	// Every field is a text input read with `readNumber` (numberField.svelte.ts),
	// so a decimal comma (12,5) and typed separators (1 500, 1,500) are taken
	// the same way in every mode. Text the field can't take is kept, even after
	// blur, marked `aria-invalid`, with a message under it (from the bounds, or
	// `invalidMessage`) that `aria-describedby` names; the field counts in
	// its owner's `invalidFields` (the nearest `provideInvalidFields()`) until it is fixed, `reset()` puts it back,
	// or the stored value changes from outside (load, discard, undo).
	// `grouped` shows thousands separators (300 000, narrow no-break spaces) whenever the field isn't
	// being edited; it is then a plain text box (role textbox). Otherwise the field is a
	// spinbutton, and ArrowUp/ArrowDown step it by `step` (1 for 'any') as type="number" did.
	// `decimals` caps how many decimals a plain field shows (display only).
	import { untrack } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { NumberField, numberFieldMessage } from './numberField.svelte';
	import { useInvalidFields } from './invalidFields.svelte';

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
		invalidMessage,
		onchange,
		...rest
	}: {
		value: number | null;
		/** A blank field stores null (none); without it a blank field is invalid and the value stays. */
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
		/** What the field says while its text can't be taken; default from min/max/nullable ("Enter a number from 0 to 99.9"). */
		invalidMessage?: string;
		onchange?: (v: number | null) => void;
	} & Omit<HTMLInputAttributes, 'value' | 'onchange' | 'min' | 'max' | 'step' | 'type'> = $props();
	// The nearest owner's registry of invalid fields (the workspace page, or a scenario's override mode).
	const invalidFields = useInvalidFields();

	const uid = $props.id();
	const fieldId = $derived(id ?? `${uid}-n`);
	const errId = $derived(`${fieldId}-err`);
	const message = $derived(invalidMessage ?? numberFieldMessage({ min, max, nullable }));

	const field = new NumberField(
		() => ({ value, scale, grouped, decimals, disabled, step, min, max, nullable }),
		(v) => {
			value = v;
			onchange?.(v);
		}
	);
	let el: HTMLInputElement | undefined = $state();

	// Follow external changes (load, discard, undo) while the user isn't typing,
	// even over invalid text: the stored value moved, so the typed text is stale.
	// Only the displayed value is tracked, so a blur alone keeps invalid text.
	$effect(() => {
		field.display();
		untrack(() => field.follow());
	});

	// invalidFields.reset() (a Discard that restores the same value): back to the stored value.
	let epoch = invalidFields.epoch;
	$effect(() => {
		const e = invalidFields.epoch;
		if (e === epoch) return;
		epoch = e;
		untrack(() => field.reset());
	});

	// Count this field as unsaved work for as long as it is invalid (and mounted).
	$effect(() => {
		if (!field.invalid) return;
		const name = label ?? el?.labels?.[0]?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
		invalidFields.set(uid, { id: fieldId, label: name, message });
		return () => invalidFields.delete(uid);
	});

	const describedBy = $derived(
		[rest['aria-describedby'], field.invalid ? errId : undefined].filter(Boolean).join(' ') || undefined
	);
	// The number the spinbutton holds, for assistive tech; none while the text isn't one.
	const valueNow = $derived(field.invalid || value == null ? undefined : Math.round(value * scale * 1e9) / 1e9);
</script>

<input
	autocomplete="off"
	{...rest}
	bind:this={el}
	id={fieldId}
	type="text"
	inputmode="decimal"
	role={grouped ? undefined : 'spinbutton'}
	aria-valuemin={grouped ? undefined : min}
	aria-valuemax={grouped ? undefined : max}
	aria-valuenow={grouped ? undefined : valueNow}
	{placeholder}
	readonly={disabled}
	aria-label={label}
	aria-invalid={field.invalid ? true : rest['aria-invalid']}
	aria-describedby={describedBy}
	class:invalid={field.invalid}
	value={field.text}
	oninput={(e) => field.input(e.currentTarget.value)}
	onkeydown={(e) => {
		rest.onkeydown?.(e);
		if (e.defaultPrevented || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
		if (field.step(e.key === 'ArrowUp' ? 1 : -1)) e.preventDefault();
	}}
	onfocus={() => field.focus()}
	onblur={() => field.blur()}
/>
{#if field.invalid}<span class="num-err" id={errId}>{message}</span>{/if}

<style>
	input.invalid {
		border-color: var(--danger);
		background: var(--danger-soft);
	}
	.num-err {
		display: block;
		margin-top: 0.15rem;
		color: var(--danger);
		font-size: 0.75rem;
		line-height: 1.3;
		font-weight: 400;
		white-space: normal;
		text-align: start;
	}
</style>
