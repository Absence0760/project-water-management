<script lang="ts">
	// Twelve water-year month fields for one monthly value in the one-node form
	// (the dam release, a demand object's demand or profile, an other water
	// user's demand, the hands-off flow and River to dam by month; issue #204).
	// A grid that wraps by the room it has (docs/design/ui-playbook.md § 2:
	// stack, don't scroll sideways): all twelve in a row only where each field
	// still holds 12 345.5 or 0.0129 whole, six to a row in the node sheet, four
	// or three on a phone. Each field shows its month above it; its accessible
	// name comes from `label`. The caption names the group, and the fill button
	// copies October's value into every month (./monthFields.ts).
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { fillFromFirst, withMonth } from './monthFields';

	let {
		values,
		label,
		caption,
		help,
		fillLabel,
		readonly,
		blank = 0,
		grouped = true,
		testid,
		onchange
	}: {
		/** The row in water-year order (Oct first); a missing month shows `blank`. */
		values: readonly number[] | null | undefined;
		/** A field's accessible name, e.g. (m) => `Demand of Town in ${m}, m³/day`. */
		label: (month: string) => string;
		/** The group's visible name: "Demand, m³/day, per month". */
		caption: string;
		/** A help tip key shown beside the caption (outside the group's name). */
		help?: string;
		/** The fill button's text ("Use October’s demand for every month"); no button without it or when read-only. */
		fillLabel?: string;
		readonly: boolean;
		/** What an empty field means (0, or 1 for a profile). */
		blank?: number;
		/** Thousands separators on read-only fields (off for a profile factor). */
		grouped?: boolean;
		testid?: string;
		onchange: (next: number[]) => void;
	} = $props();

	const uid = $props.id();
	const capId = `mf-${uid}`;
</script>

<div class="mf" role="group" aria-labelledby={capId} data-testid={testid}>
	<div class="head">
		<span class="cap"><span id={capId}>{caption}</span>{#if help}<HelpTip key={help} />{/if}</span>
		{#if fillLabel && !readonly}
			<button type="button" class="btn btn-sm" onclick={() => onchange(fillFromFirst(values, blank))}>{fillLabel}</button>
		{/if}
	</div>
	<div class="cells">
		{#each WATER_YEAR_MONTHS as m, i (m)}
			<div class="cell">
				<span class="m" aria-hidden="true">{m}</span>
				<NumberInput
					label={label(m)}
					min={0}
					grouped={grouped && readonly}
					disabled={readonly}
					value={values?.[i] ?? blank}
					onchange={(v) => onchange(withMonth(values, i, v, blank))}
				/>
			</div>
		{/each}
	</div>
</div>

<style>
	.mf {
		container: months / inline-size;
		margin: 0.5rem 0;
		min-width: 0;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.25rem 0.75rem;
		margin-bottom: 0.3rem;
	}
	.cap {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-2);
	}
	.cells {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: 0.35rem 0.4rem;
	}
	/* A phone: four to a row, three on the narrowest, so 12 345.5 shows whole. */
	@container months (max-width: 30rem) {
		.cells {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
	@container months (max-width: 21rem) {
		.cells {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
	/* All twelve in one row only where each field still holds 12 345.5 whole (~5.5rem each). */
	@container months (min-width: 70rem) {
		.cells {
			grid-template-columns: repeat(12, minmax(0, 1fr));
		}
	}
	.cell {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1px;
		min-width: 0;
	}
	.m {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-2);
	}
	/* Tabular figures so the values line up down the columns; no spin buttons, which took the room a value needs (the arrow keys still step it). */
	.mf .cells .cell :global(input) {
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		padding-inline: 0.4rem;
		text-align: right;
		font-variant-numeric: tabular-nums;
		appearance: textfield;
		-moz-appearance: textfield;
	}
	.mf .cells .cell :global(input::-webkit-inner-spin-button),
	.mf .cells .cell :global(input::-webkit-outer-spin-button) {
		-webkit-appearance: none;
		margin: 0;
	}
	@media (max-width: 640px) {
		.mf .cells .cell :global(input),
		.head .btn {
			min-height: 44px;
		}
	}
</style>
