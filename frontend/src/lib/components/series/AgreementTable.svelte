<script lang="ts">
	// Gauge vs logger: the two observed flow records compared per water year
	// (engine observedAgreement). Flagged years are marked in text, not only
	// by colour. On the Data page (`fold`) the table flows with the page: the
	// flagged years and the latest few, the rest behind "Show all N water
	// years". Elsewhere (Runs) it scrolls in a box, a focusable named region.
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { OBSERVED_FLOW_LABEL, waterYearLabel, type ObservedAgreement } from '@water-management/engine';
	import { fmtNum } from '$lib/format/number';
	import { agreementFold } from './agreementFold';

	let { agreement, headingLevel = 3, fold = false }: { agreement: ObservedAgreement; headingLevel?: 2 | 3; fold?: boolean } = $props();

	const uid = $props.id();
	const nameA = $derived(cap(OBSERVED_FLOW_LABEL[agreement.a]));
	const nameB = $derived(cap(OBSERVED_FLOW_LABEL[agreement.b]));
	const flagged = $derived(agreement.years.filter((y) => y.flagged));
	function cap(s: string) {
		return s.charAt(0).toUpperCase() + s.slice(1);
	}
	const ratio = (r: number | null) => (r === null ? '–' : `${fmtNum(r * 100, 0)}%`);
	let open = $state(false);
	const folded = $derived(fold ? agreementFold(agreement.years, open) : { shown: agreement.years, hidden: 0 });
</script>

<div class="agreement">
	<svelte:element this={`h${headingLevel}`} id="{uid}-h">Gauge vs logger agreement <HelpTip key="gauge-logger-agreement" /></svelte:element>
	<p class="muted small">
		Two instruments on the same river should roughly agree. A year where one reads a small fraction of the other usually means a
		problem at one instrument (damaged or silted weir, rating change, bypass, zero-filled gaps). Calibrate against the record you
		trust — <a href="?tab=settings#set-record">choose the calibration flow series</a>.
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
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			class="table-wrap"
			class:scroll={!fold}
			tabindex={fold ? undefined : 0}
			role={fold ? undefined : 'region'}
			aria-label={fold ? undefined : 'Gauge vs logger agreement by water year'}
		>
			<table class="data compact" id="{uid}-t" aria-labelledby="{uid}-h">
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
					{#each folded.shown as y (y.waterYear)}
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
		{#if fold && (open || folded.hidden)}
			<button type="button" class="btn btn-sm more" aria-expanded={open} aria-controls="{uid}-t" onclick={() => (open = !open)}>
				{open ? 'Show only the flagged and latest years' : `Show all ${agreement.years.length} water years`}
			</button>
		{/if}
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
	/* On the Data page the table grows with the page, not inside the global table cap. */
	.table-wrap:not(.scroll) {
		max-height: none;
	}
	.more {
		margin-top: 0.5rem;
	}
	.badge {
		text-transform: none;
	}
</style>
