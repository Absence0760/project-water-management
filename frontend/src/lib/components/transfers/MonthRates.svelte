<script lang="ts">
	// A transfer rule's maximum rate month by month (engine ≥ 1.14.0, docs/model.md
	// §2.6): twelve m³/s fields in water-year order, a blank month off. A rule
	// with one max rate in its ticked months shows that rate in each of them;
	// the first edit writes the rule's own monthly list, with its months and
	// max rate kept in step (engine withMonthlyRates), which runs the same until
	// a month is changed. Above the fields, on the group's title line (the
	// caller's `title`): the months in words and a button that puts the largest
	// rate in every month. One line, not a line of its own under the fields,
	// so thirty rules don't cost thirty extra lines.
	import type { Snippet } from 'svelte';
	import { transferRatesM3s, withMonthlyRates, type Transfer } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { describeMonths, WATER_YEAR_MONTHS } from '$lib/format/months';
	import { fmtNum } from '$lib/format/number';
	import { transferUnit } from '$lib/components/network/flowUnit.svelte';

	let {
		rule,
		label,
		disabled = false,
		title
	}: { rule: Transfer; /** "transfer 1": names the fields. */ label: string; disabled?: boolean; /** The group's title, at the head line's start. */ title?: Snippet } = $props();

	const rates = $derived(transferRatesM3s(rule));
	const top = $derived(Math.max(0, ...rates));
	// Shown in the unit picked on the group's title (m³/s, l/s or m³/day); the rule keeps m³/s.
	const k = $derived(transferUnit.scaleFromM3s);
	const dp = $derived(transferUnit.id === 'm3s' ? 4 : transferUnit.id === 'ls' ? 2 : 0);
	const summary = $derived(rule.months.length ? `${describeMonths(rule.months)}, up to ${fmtNum(top * k, dp, true)} ${transferUnit.label}` : 'Off every month');

	function set(k: number, v: number | null) {
		const next = transferRatesM3s(rule);
		next[k] = v !== null && v > 0 ? v : 0;
		Object.assign(rule, withMonthlyRates(next));
	}
</script>

<fieldset class="rates" data-testid="month-rates">
	<legend class="visually-hidden">Max rate of {label} by month, {transferUnit.label} (blank = off)</legend>
	<div class="head">
		{@render title?.()}
		<div class="sum">
			<span class="summary muted">{summary}</span>
			{#if !disabled && top > 0 && rates.some((r) => r !== top)}
				<button type="button" class="btn btn-sm btn-ghost all" onclick={() => Object.assign(rule, withMonthlyRates(new Array(12).fill(top)))}>
					{fmtNum(top * k, dp, true)} in every month
				</button>
			{/if}
		</div>
	</div>
	<div class="cells">
		{#each WATER_YEAR_MONTHS as m, i (m)}
			<div class="cell" class:on={rates[i]! > 0}>
				<span class="m" aria-hidden="true">{m}</span>
				<NumberInput
					label="Max rate of {label} in {m}, {transferUnit.label}"
					min={0}
					step={transferUnit.id === 'm3s' ? 0.001 : 1}
					scale={k}
					nullable
					placeholder="off"
					{disabled}
					value={rates[i]! > 0 ? rates[i]! : null}
					onchange={(v) => set(i, v)}
				/>
			</div>
		{/each}
	</div>
</fieldset>

<style>
	.rates {
		container: rates / inline-size;
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.cells {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: 0.3rem 0.25rem;
	}
	/* A phone's card: four to a row, so 0.0129 and 12.345 show whole. */
	@container rates (max-width: 26rem) {
		.cells {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
	/* All twelve in one row only where each field still holds 12.345 or 0.0129 whole (~4.5rem each). */
	@container rates (min-width: 58rem) {
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
		font-size: 0.72rem;
		color: var(--text-muted);
		text-align: center;
	}
	.cell.on .m {
		color: var(--text-2);
		font-weight: 600;
	}
	/* Six fit a phone's card; tabular figures so the rates line up down the columns. */
	.rates .cells .cell :global(input[type='number']) {
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		padding-inline: 0.3rem;
		text-align: right;
		font-variant-numeric: tabular-nums;
		/* No spin buttons: they took the room a rate like 0.005 needs, and the arrow keys still step it. */
		appearance: textfield;
		-moz-appearance: textfield;
	}
	.rates .cells .cell :global(input[type='number']::-webkit-inner-spin-button),
	.rates .cells .cell :global(input[type='number']::-webkit-outer-spin-button) {
		-webkit-appearance: none;
		margin: 0;
	}
	/* The title and the summary share a line, wrapping to two only where the group is too narrow for both. */
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.1rem 0.75rem;
		margin-bottom: 0.3rem;
	}
	.sum {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-left: auto;
		min-height: 24px;
	}
	.summary {
		font-size: 0.78rem;
		overflow-wrap: anywhere;
	}
	.all {
		font-size: 0.75rem;
		min-height: 24px;
		padding: 0 0.4rem;
		white-space: nowrap;
	}
</style>
