<!--
	Reserve compliance from daily data (engine ≥ 1.19.0, calibration research
	CR-29; docs/model.md §2.9c): per month of the year, the % of days below
	that day's requirement and the % of the required volume not delivered,
	beside the monthly verdict. Nothing on a run from before engine 1.19.0.
-->
<script lang="ts">
	import type { EwrAssuranceSite } from '@water-management/engine';
	import { dailyHeadline, dailyRows } from './ewrReporting';

	let { site }: { site: EwrAssuranceSite } = $props();

	const uid = $props.id();
	const rows = $derived(dailyRows(site));
	const headline = $derived(dailyHeadline(site));
</script>

{#if rows}
	<div class="ewr-daily" data-testid="ewr-daily">
		{#if headline}<p class="small">{headline}</p>{/if}
		<div class="table-wrap">
			<table class="data compact" aria-labelledby="{uid}-c">
				<caption id="{uid}-c">By month of the year, from daily data beside the monthly verdict</caption>
				<thead>
					<tr>
						<th scope="col">Month</th>
						<th scope="col" class="num">Months met <span class="u">%</span></th>
						<th scope="col" class="num">Days not met</th>
						<th scope="col" class="num">Time not met <span class="u">%</span></th>
						<th scope="col" class="num">Volume not met <span class="u">%</span></th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.month)}
						<tr>
							<th scope="row">{r.label}{#if r.hiddenByMonthly}<span class="badge badge-warn">short days</span>{/if}</th>
							<td class="num">{r.monthsMet}</td>
							<td class="num">{r.daysNotMet}</td>
							<td class="num">{r.timeNotMet}</td>
							<td class="num">{r.volumeNotMet}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="muted small">
			A day is not met when its flow is below the month’s requirement spread evenly over its days; the volume not met is the
			shortfall on those days ÷ the volume required. A month met on volume can still have short days (marked “short days”): daily
			data shows more non-compliance than monthly. Total flow, day by day, even where the monthly verdict judges low flows on base
			flow.
		</p>
	</div>
{/if}

<style>
	caption {
		text-align: left;
		font-weight: 500;
		padding-bottom: 0.25rem;
	}
	.u {
		font-weight: 400;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.badge {
		margin-left: 0.4rem;
		text-transform: none;
		white-space: nowrap;
	}
</style>
