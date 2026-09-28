<script lang="ts">
	// Modelled use against the registered volume, one row per unit, water
	// source and water year (WP-3.10, docs/ui.md § Allocations): the picked
	// unit's years beside the list, and every unit's under it. Every modelled
	// number is labelled "modelled, not metered", and the words describe the
	// arithmetic, never a finding of lawfulness. In a narrow container each row
	// is a card of label–value lines.
	import { fmtNum } from '$lib/format/number';
	import { SOURCE_LABEL, STATUS_LABEL, statusSentence, waterYearLabel, type ComparisonRow } from './allocations';

	let {
		rows,
		tolerance,
		caption,
		showName = true,
		testid
	}: { rows: ComparisonRow[]; tolerance: number; caption: string; /** The unit column (off for one unit's years). */ showName?: boolean; testid?: string } = $props();
</script>

<div class="years">
	<div class="table-wrap">
		<table class="data cards" data-testid={testid}>
			<caption class="visually-hidden">{caption}</caption>
			<thead>
				<tr>
					{#if showName}<th scope="col">Hydrological unit or user</th>{/if}
					<th scope="col">Source</th>
					<th scope="col">Water year</th>
					<th scope="col" class="num">Registered (m³)</th>
					<th scope="col" class="num">Modelled use (m³)<span class="sub">modelled, not metered</span></th>
					<th scope="col" class="num">Modelled ÷ registered</th>
					<th scope="col">Comparison</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.key)}
					<tr class:flag={r.year.status === 'over'}>
						{#if showName}<th scope="row">{r.name}</th>{/if}
						<svelte:element this={showName ? 'td' : 'th'} scope={showName ? undefined : 'row'} class="nowrap" data-label="Source">{SOURCE_LABEL[r.source]}</svelte:element>
						<td class="nowrap" data-label="Water year">
							{waterYearLabel(r.year.waterYear)}
							{#if r.year.partial}<span class="part" title="The run covers {r.year.days} of the year's {r.year.yearDays} days; the registered volume is prorated to them.">part ({r.year.days} d)</span>{/if}
						</td>
						<td class="num" data-label="Registered (m³)">{fmtNum(r.year.registeredM3)}</td>
						<td class="num" data-label="Modelled use (m³, not metered)">{fmtNum(r.year.modelledM3)}</td>
						<td class="num" data-label="Modelled ÷ registered">{r.year.ratio === null ? '–' : `${fmtNum(r.year.ratio * 100, 0)} %`}</td>
						<td data-label="Comparison"><span class="status status-{r.year.status}" title={statusSentence(r.year, tolerance)}>{STATUS_LABEL[r.year.status]}</span></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.years {
		container: alloc-years / inline-size;
		min-width: 0;
	}
	.sub {
		display: block;
		font-weight: 400;
		font-size: 0.7rem;
	}
	.part {
		margin-left: 0.3rem;
		font-size: 0.75rem;
		color: var(--text-2);
	}
	.nowrap {
		white-space: nowrap;
	}
	/* Narrow (a phone, a narrow column): each row is a card, its values two to a line under their labels, instead of a wide table. */
	@container alloc-years (max-width: 34rem) {
		.table-wrap {
			border: 0;
			background: none;
		}
		.cards,
		.cards tbody {
			display: block;
		}
		.cards thead {
			display: none;
		}
		.cards tr {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.3rem 0.75rem;
			padding: 0.5rem;
			border-bottom: 1px solid var(--border);
		}
		.cards th,
		.cards td {
			display: block;
			padding: 0;
			border-bottom: none;
			text-align: left;
			white-space: normal;
			min-width: 0;
		}
		.cards th:not([data-label]) {
			grid-column: 1 / -1;
			font-weight: 600;
		}
		.cards td::before,
		.cards th[data-label]::before {
			content: attr(data-label);
			display: block;
			font-size: 0.75rem;
			font-weight: 400;
			color: var(--text-2);
		}
	}
</style>
