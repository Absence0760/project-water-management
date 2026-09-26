<script lang="ts">
	// Gauge vs logger: the two observed flow records compared per water year
	// (engine observedAgreement). Flagged years are marked in text, not only
	// by colour.
	import { OBSERVED_FLOW_LABEL, waterYearLabel, type ObservedAgreement } from '@water-management/engine';
	import { fmtNum } from '$lib/format/number';

	let { agreement, headingLevel = 3 }: { agreement: ObservedAgreement; headingLevel?: 2 | 3 } = $props();

	const uid = $props.id();
	const nameA = $derived(cap(OBSERVED_FLOW_LABEL[agreement.a]));
	const nameB = $derived(cap(OBSERVED_FLOW_LABEL[agreement.b]));
	const flagged = $derived(agreement.years.filter((y) => y.flagged));
	function cap(s: string) {
		return s.charAt(0).toUpperCase() + s.slice(1);
	}
	const ratio = (r: number | null) => (r === null ? '–' : `${fmtNum(r * 100, 0)}%`);
</script>

<div class="agreement">
	<svelte:element this={`h${headingLevel}`} id="{uid}-h">Gauge vs logger agreement</svelte:element>
	<p class="muted small">
		Two instruments on the same river should roughly agree. A year where one reads a small fraction of the other usually means a
		problem at one instrument (damaged or silted weir, rating change, bypass, zero-filled gaps). Calibrate against the record you
		trust — <a href="?tab=settings">choose the calibration flow series</a>.
	</p>
	<p class="verdict" class:bad={flagged.length > 0}>
		{#if flagged.length}
			<strong>{flagged.length} water year{flagged.length === 1 ? '' : 's'} disagree:</strong>
			{flagged.map((y) => `${waterYearLabel(y.waterYear)} (${ratio(y.ratio)})`).join(', ')}.
		{:else}
			The two records agree in every water year compared.
		{/if}
		<span class="muted">
			Flagged when {nameA.toLowerCase()} is below {fmtNum(agreement.minRatio * 100, 0)}% or above {fmtNum(agreement.maxRatio * 100, 0)}% of
			{nameB.toLowerCase()}, on the days both have a reading (years with under {agreement.minDays} shared days are skipped).
		</span>
	</p>
	{#if agreement.years.length}
		<div class="table-wrap scroll">
			<table class="data compact" aria-labelledby="{uid}-h">
				<thead>
					<tr>
						<th scope="col">Water year</th>
						<th scope="col" class="num">Shared<br /><span class="u">days</span></th>
						<th scope="col" class="num">{nameA}<br /><span class="u">Mm³</span></th>
						<th scope="col" class="num">{nameB}<br /><span class="u">Mm³</span></th>
						<th scope="col" class="num">Ratio<br /><span class="u">% of {nameB.toLowerCase()}</span></th>
						<th scope="col">Check</th>
					</tr>
				</thead>
				<tbody>
					{#each agreement.years as y (y.waterYear)}
						<tr class:flag={y.flagged}>
							<th scope="row">{waterYearLabel(y.waterYear)}</th>
							<td class="num">{fmtNum(y.days)}</td>
							<td class="num">{fmtNum(y.volumeAMm3, 2)}</td>
							<td class="num">{fmtNum(y.volumeBMm3, 2)}</td>
							<td class="num">{ratio(y.ratio)}</td>
							<td>{#if y.flagged}<span class="badge badge-warn">disagree</span>{:else}<span class="muted">ok</span>{/if}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<style>
	.small {
		font-size: 0.8rem;
		max-width: 85ch;
	}
	.verdict {
		font-size: 0.875rem;
	}
	.verdict.bad strong {
		color: var(--warning);
	}
	.verdict .muted {
		display: block;
		font-size: 0.8rem;
		margin-top: 0.15rem;
	}
	.scroll {
		max-height: 320px;
		overflow-y: auto;
	}
	.badge {
		text-transform: none;
	}
</style>
