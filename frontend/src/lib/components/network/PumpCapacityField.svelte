<script lang="ts">
	// A river pump's capacity in m³/day with its calculator (WP-3.8): the
	// number of pumps × m³/h per pump × 24 fills the capacity, and typing a
	// capacity clears the calculator, since only the m³/day is stored (one
	// number can't disagree with itself). Shared by a unit's own pump
	// (SupplyFields), an other water user's (UserFields) and each river
	// abstraction's (WaterSourceFields, engine ≥ 1.65.0). Its fields sit in the
	// caller's grid (display: contents).
	import type { Snippet } from 'svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import { pumpM3Day } from './supply';

	let {
		idBase,
		label,
		forWhom = '',
		helpKey,
		value,
		readonly,
		note,
		noteTestId,
		history,
		onchange
	}: {
		/** Unique within the page; the fields' ids are `<idBase>-pumps`, `-rate`, `-cap`. */
		idBase: string;
		/** The capacity's label, e.g. "River pump capacity". */
		label: string;
		/** Appended to every label (" for the crops") when one group holds two pumps. */
		forWhom?: string;
		helpKey?: string;
		value: number | null;
		readonly: boolean;
		/** The line under the capacity when the calculator is empty. */
		note: string;
		noteTestId?: string;
		/** The field's history line, when it has one. */
		history?: Snippet;
		onchange: (v: number | null) => void;
	} = $props();

	const id = (k: string) => `${idBase}-${k}`;
	let pumps = $state<number | null>(null);
	let rate = $state<number | null>(null);
	function calc(p: number | null, r: number | null) {
		pumps = p;
		rate = r;
		const v = pumpM3Day(p, r);
		if (v !== null) onchange(v);
	}
</script>

<div class="pump-field">
	{#if !readonly}
		<div class="field">
			<label for={id('pumps')}>Number of pumps{forWhom}</label>
			<NumberInput id={id('pumps')} min={0} value={pumps} nullable placeholder="–" onchange={(v) => calc(v, rate)} />
		</div>
		<div class="field">
			<label for={id('rate')}>m³/h per pump{forWhom}</label>
			<NumberInput id={id('rate')} min={0} value={rate} nullable placeholder="–" onchange={(v) => calc(pumps, v)} />
		</div>
	{/if}
	<div class="field">
		<span class="lbl"><label for={id('cap')}>{label}{forWhom} <span class="u">(m³/day)</span></label>{#if helpKey}<HelpTip key={helpKey} />{/if}</span>
		<NumberInput
			id={id('cap')}
			min={0}
			grouped
			nullable
			placeholder="no limit"
			disabled={readonly}
			aria-describedby="{id('cap')}-h"
			{value}
			onchange={(v) => {
				onchange(v);
				if (v !== pumpM3Day(pumps, rate)) {
					pumps = null;
					rate = null;
				}
			}}
		/>
		<span class="hint" id="{id('cap')}-h" data-testid={noteTestId}>
			{#if pumpM3Day(pumps, rate) !== null}
				{fmtNum(pumps, 0, true)} × {fmtNum(rate, 2, true)} m³/h × 24 h = {fmtNum(pumpM3Day(pumps, rate), 0)} m³/day.
			{:else}
				{note}
			{/if}
		</span>
		{@render history?.()}
	</div>
</div>

<style>
	.pump-field {
		display: contents;
	}
	.field :global(input) {
		width: 100%;
	}
	.field label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.lbl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	@media (max-width: 640px) {
		.field :global(input) {
			min-height: 44px;
		}
	}
</style>
