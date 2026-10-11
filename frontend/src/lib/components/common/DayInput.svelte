<script lang="ts">
	// A typed day (ui-playbook § 2 "A typed date is day first too"), in place of <input type="date">, whose
	// order is the browser's own (12/30/2021 in a US browser). A text input read by parseDay: "15 Nov 2021",
	// "15/11/2021" and "2021-11-15" all read, and the field shows the day back as "15 Nov 2021" once typing
	// ends. The value bound (and stored, and sent) stays YYYY-MM-DD, '' for a blank field. `min` and `max`
	// (YYYY-MM-DD) bound it. Text the field can't take is kept, marked aria-invalid, with a message under it
	// that aria-describedby names, and it counts in its owner's invalidFields (the save bar's list and the
	// leave guard), as NumberInput does, until it is fixed, reset() puts it back, or the stored day changes
	// from outside. It is also the input's custom validity, so a form without novalidate refuses to submit it,
	// as it refused a native date out of range. Rules: dayField.svelte.ts.
	import { untrack } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { DayField, dayFieldMessage } from './dayField.svelte';
	import { useInvalidFields } from './invalidFields.svelte';

	let {
		value = $bindable(),
		id,
		label,
		min,
		max,
		readonly = false,
		placeholder = '15 Nov 2021',
		invalidMessage,
		commit = 'input',
		onchange,
		...rest
	}: {
		/** The day, YYYY-MM-DD; '' or null for none. A blank field stores ''. */
		value: string | null | undefined;
		id?: string;
		/** Accessible label (use when there's no visible <label for>). */
		label?: string;
		/** The first day the field takes, YYYY-MM-DD. */
		min?: string | null;
		/** The last day the field takes, YYYY-MM-DD. */
		max?: string | null;
		readonly?: boolean;
		placeholder?: string;
		/** What the field says while its text can't be taken; default from min/max. */
		invalidMessage?: string;
		/** Store on every keystroke that reads as a day, or once typing ends (blur, Enter): for a field whose change does work. */
		commit?: 'input' | 'change';
		/** A day was typed: YYYY-MM-DD, or '' when the field was cleared. */
		onchange?: (v: string) => void;
	} & Omit<HTMLInputAttributes, 'value' | 'onchange' | 'min' | 'max' | 'type' | 'readonly' | 'placeholder'> = $props();
	const invalidFields = useInvalidFields();

	const uid = $props.id();
	const fieldId = $derived(id ?? `${uid}-d`);
	const errId = $derived(`${fieldId}-err`);
	const message = $derived(invalidMessage ?? dayFieldMessage({ min, max }));

	const field = new DayField(
		() => ({ value, min, max, commit }),
		(v) => {
			value = v;
			onchange?.(v);
		}
	);
	let el: HTMLInputElement | undefined = $state();

	// Follow outside changes (load, discard, undo) while the user isn't typing.
	$effect(() => {
		field.display();
		untrack(() => field.follow());
	});

	// invalidFields.reset() (a Discard): back to the stored day.
	let epoch = invalidFields.epoch;
	$effect(() => {
		const e = invalidFields.epoch;
		if (e === epoch) return;
		epoch = e;
		untrack(() => field.reset());
	});

	// Unsaved work for as long as it is invalid (and mounted).
	$effect(() => {
		if (!field.invalid) return;
		const name = label ?? el?.labels?.[0]?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
		invalidFields.set(uid, { id: fieldId, label: name, message });
		return () => invalidFields.delete(uid);
	});

	// A form that validates refuses to submit text that isn't a day in range.
	$effect(() => {
		el?.setCustomValidity(field.invalid ? message : '');
	});

	const describedBy = $derived([rest['aria-describedby'], field.invalid ? errId : undefined].filter(Boolean).join(' ') || undefined);
</script>

<input
	autocomplete="off"
	spellcheck="false"
	{...rest}
	bind:this={el}
	id={fieldId}
	type="text"
	{placeholder}
	{readonly}
	aria-label={label}
	aria-invalid={field.invalid ? true : rest['aria-invalid']}
	aria-describedby={describedBy}
	class="day-input {rest.class ?? ''}"
	class:invalid={field.invalid}
	value={field.text}
	oninput={(e) => field.input(e.currentTarget.value)}
	onkeydown={(e) => {
		rest.onkeydown?.(e);
		if (!e.defaultPrevented && e.key === 'Enter') field.change();
	}}
	onfocus={(e) => {
		field.focus();
		rest.onfocus?.(e);
	}}
	onblur={(e) => {
		field.blur();
		rest.onblur?.(e);
	}}
/>
{#if field.invalid}<span class="num-err" id={errId}>{message}</span>{/if}

<style>
	/* Wide enough for "30 Sep 2021" and the placeholder, as the native date field was. */
	.day-input {
		min-width: min(9.5rem, 100%);
	}
	input.invalid {
		border-color: var(--danger);
		background: var(--danger-soft);
	}
	.num-err {
		display: block;
		margin-top: 0.15rem;
		color: var(--danger);
		font-size: var(--font-xs);
		line-height: 1.3;
		font-weight: 400;
		white-space: normal;
		text-align: start;
	}
</style>
