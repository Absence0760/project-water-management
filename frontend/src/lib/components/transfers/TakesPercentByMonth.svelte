<script lang="ts">
	// A river off-take that takes a percentage of the available flow, month by month (Transfers → Takes →
	// "Percentage of available flow", percentOfFlow.ts; docs/ui.md § Transfers): a row per water-year month, Oct to
	// Sep, with the share of the river leaving the source it diverts and the canal's capacity that month (its rate).
	// The rest stays in the river for the units below. A blank or 0 % share, or a blank capacity, is a month off.
	// Stored as the engine's curve by month with b = 0 (docs/model.md §2.6a), so it runs as a formula would, with the
	// hands-off flow, the EWR when kept and the rules of its priority still applying after it. Above the table, on
	// the group's title line: the months in words and "Apply … to every month".
	import type { Snippet } from 'svelte';
	import { transferRatesM3s, withMonthlyRates, type Transfer } from '@water-management/engine';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import { fmtNum } from '#lib/format/number.js';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import { transferUnit } from '#lib/components/network/flowUnit.svelte.js';
	import { percentsOf, setPercent, withPercents } from './percentOfFlow';

	let {
		rule,
		label,
		disabled = false,
		title
	}: { rule: Transfer; /** "transfer 1": names the fields. */ label: string; disabled?: boolean; /** The group's title, at the head line's start. */ title?: Snippet } = $props();

	const rates = $derived(transferRatesM3s(rule));
	const pcts = $derived(percentsOf(rule));
	const k = $derived(transferUnit.scaleFromM3s);
	let copyFrom = $state(0);
	const summary = $derived.by(() => {
		const on = pcts.filter((p, i) => p !== null && rates[i]! > 0) as number[];
		if (!on.length) return 'No month takes water';
		const lo = Math.min(...on);
		const hi = Math.max(...on);
		const share = lo === hi ? `${fmtNum(lo, 1, true)} %` : `${fmtNum(lo, 1, true)}–${fmtNum(hi, 1, true)} %`;
		return `${share} of the flow${on.length === 12 ? ', all year' : `, ${on.length} month${on.length === 1 ? '' : 's'}`}; the rest stays in the river`;
	});

	function setRate(i: number, v: number | null) {
		const next = transferRatesM3s(rule);
		next[i] = v !== null && v > 0 ? v : 0;
		Object.assign(rule, withMonthlyRates(next));
	}
	/** Every month takes what `from` takes: its share and its capacity. */
	function applyToAll(from: number) {
		Object.assign(rule, withMonthlyRates(new Array(12).fill(transferRatesM3s(rule)[from] ?? 0)));
		Object.assign(rule, withPercents(new Array(12).fill(percentsOf(rule)[from] ?? null)));
	}
</script>

<fieldset class="pct" data-testid="takes-percent-by-month">
	<legend class="visually-hidden">What {label} takes in each month: a percentage of the available flow, up to the canal's capacity</legend>
	<div class="head">
		{@render title?.()}
		<div class="sum">
			<span class="summary muted">{summary}</span>
			{#if !disabled}
				<span class="apply">
					<select aria-label="Month to apply to every month, {label}" bind:value={copyFrom}>
						{#each WATER_YEAR_MONTHS as m, i (m)}<option value={i}>{m}</option>{/each}
					</select>
					<button type="button" class="btn btn-sm btn-ghost" onclick={() => applyToAll(copyFrom)}>Apply to every month</button>
				</span>
			{/if}
		</div>
	</div>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="table-wrap" tabindex="0" role="region" aria-label="What {label} takes, month by month">
		<table class="data">
			<thead>
				<tr>
					<th scope="col">Month</th>
					<th scope="col">Share of the flow, %</th>
					<th scope="col">Canal capacity, {transferUnit.label}</th>
				</tr>
			</thead>
			<tbody>
				{#each WATER_YEAR_MONTHS as m, i (m)}
					{@const on = rates[i]! > 0}
					<tr class:off={!on} data-month={m}>
						<th scope="row">{m}</th>
						<td>
							<NumberInput
								label="Share of the flow {label} takes in {m}, %"
								min={0}
								max={100}
								nullable
								placeholder="off"
								{disabled}
								value={on ? pcts[i] : null}
								onchange={(v) => Object.assign(rule, setPercent(rule, i, v))}
							/>
						</td>
						<td data-paste-col={i}>
							<NumberInput
								label="Canal capacity of {label} in {m}, {transferUnit.label}"
								min={0}
								step={transferUnit.id === 'm3s' ? 0.001 : 1}
								scale={k}
								nullable
								placeholder="off"
								{disabled}
								value={on ? rates[i]! : null}
								onchange={(v) => setRate(i, v)}
							/>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</fieldset>

<style>
	.pct {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
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
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		margin-left: auto;
		min-height: 24px;
	}
	.summary {
		font-size: var(--font-sm);
	}
	.apply {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.apply select,
	.apply .btn {
		min-height: 24px;
		font-size: var(--font-xs);
	}
	.table-wrap:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	table {
		width: 100%;
	}
	th[scope='row'] {
		font-weight: 600;
		white-space: nowrap;
	}
	tr.off th[scope='row'] {
		color: var(--text-muted);
		font-weight: 400;
	}
	td {
		padding-block: 0.15rem;
	}
	td :global(input[type='number']) {
		box-sizing: border-box;
		width: 100%;
		min-width: 4.5rem;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
</style>
