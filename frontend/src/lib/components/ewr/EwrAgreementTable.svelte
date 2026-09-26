<!--
	EWR agreement with the observed record (engine ewrAgreement, issue #4): on
	every day with an observation, is the simulated outflow below the EWR when
	the observed flow was? A 2×2 table with its scores, then the same per
	month and (collapsed) per water year. Used on the Runs page and twice,
	side by side, in run comparison.
	Input: a run summary (catchment.ewrAgreement, engine 0.5.3+).
-->
<script lang="ts">
	import type { RunSummary } from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import { AGREEMENT_HELP, agreementGap, biasVerdict, fmtRatio, monthRows, waterYearRows, type AgreementRow } from './agreement';

	let {
		summary,
		title = 'EWR test: model against observed flow',
		headingLevel = 3
	}: {
		summary: Pick<RunSummary, 'catchment' | 'calibration'>;
		title?: string;
		headingLevel?: 2 | 3 | 4;
	} = $props();

	const uid = $props.id();
	const a = $derived(summary.catchment?.ewrAgreement ?? null);
	const gap = $derived(agreementGap(summary));
	const o = $derived(a?.overall);
	const sub = $derived(`h${Math.min(headingLevel + 1, 6)}`);
</script>

{#snippet breakdown(rows: AgreementRow[], caption: string, first: string)}
	<div class="table-wrap">
		<table class="data compact">
			<caption class="visually-hidden">{caption}</caption>
			<thead>
				<tr>
					<th scope="col">{first}</th>
					<th scope="col" class="num">Days</th>
					<th scope="col" class="num">Both below</th>
					<th scope="col" class="num">False alarm</th>
					<th scope="col" class="num">Miss</th>
					<th scope="col" class="num">Both above</th>
					<th scope="col" class="num" title={AGREEMENT_HELP.hitRate}>Hit rate</th>
					<th scope="col" class="num" title={AGREEMENT_HELP.falseAlarmRatio}>False-alarm ratio</th>
					<th scope="col" class="num" title={AGREEMENT_HELP.frequencyBias}>Bias</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.key)}
					<tr class:empty={r.days === 0}>
						<th scope="row">{r.label}</th>
						<td class="num">{fmtNum(r.days)}</td>
						<td class="num">{r.days ? fmtNum(r.bothBelow) : '–'}</td>
						<td class="num">{r.days ? fmtNum(r.falseAlarm) : '–'}</td>
						<td class="num">{r.days ? fmtNum(r.miss) : '–'}</td>
						<td class="num">{r.days ? fmtNum(r.bothAbove) : '–'}</td>
						<td class="num">{fmtRatio(r.hitRate)}</td>
						<td class="num">{fmtRatio(r.falseAlarmRatio)}</td>
						<td class="num">{fmtRatio(r.frequencyBias)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/snippet}

<section class="ewr-agreement" aria-labelledby="{uid}-h">
	<div class="head">
		<svelte:element this={`h${headingLevel}`} id="{uid}-h">{title}</svelte:element>
		<HelpTip key="catchment.ewrAgreement" />
	</div>

	{#if gap || !a || !o}
		<p class="muted">{gap}</p>
	{:else}
		<p class="muted small intro">
			On each of the {fmtNum(a.days)} days with an observed flow ({a.firstObservedDate} – {a.lastObservedDate}), is the simulated outflow
			below the EWR when the observed flow was? The observed record measures the same river the outlet EWR test uses, so it
			shows whether the model's EWR failures are real. Every observed day counts, including those the parameters were fitted
			to.{#if a.excludedDays} {fmtNum(a.excludedDays)} excluded days are left out.{/if}
		</p>
		<p class="verdict"><strong>{biasVerdict(o)}</strong></p>

		<dl class="scores">
			<div>
				<dt title={AGREEMENT_HELP.hitRate}>Hit rate</dt>
				<dd>{fmtRatio(o.hitRate)}</dd>
				<dd class="sub">of the river's failures, the model had (1 ideal)</dd>
			</div>
			<div>
				<dt title={AGREEMENT_HELP.falseAlarmRatio}>False-alarm ratio</dt>
				<dd>{fmtRatio(o.falseAlarmRatio)}</dd>
				<dd class="sub">of the model's failures, the river didn't have (0 ideal)</dd>
			</div>
			<div>
				<dt title={AGREEMENT_HELP.frequencyBias}>Frequency bias</dt>
				<dd>{fmtRatio(o.frequencyBias)}</dd>
				<dd class="sub">model share of days below ÷ observed share (1 ideal)</dd>
			</div>
		</dl>

		<div class="table-wrap">
			<table class="data compact matrix">
				<caption>Observed days by EWR result, model against observed</caption>
				<thead>
					<tr>
						<td></td>
						<th scope="col" class="num">Observed below EWR</th>
						<th scope="col" class="num">Observed at or above</th>
						<th scope="col" class="num">Total</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row">Model below EWR</th>
						<td class="num">{fmtNum(o.bothBelow)} <span class="tag">both below</span></td>
						<td class="num">{fmtNum(o.falseAlarm)} <span class="tag">false alarm</span></td>
						<td class="num">{fmtNum(o.bothBelow + o.falseAlarm)}</td>
					</tr>
					<tr>
						<th scope="row">Model at or above</th>
						<td class="num">{fmtNum(o.miss)} <span class="tag">miss</span></td>
						<td class="num">{fmtNum(o.bothAbove)} <span class="tag">both above</span></td>
						<td class="num">{fmtNum(o.miss + o.bothAbove)}</td>
					</tr>
					<tr>
						<th scope="row">Total</th>
						<td class="num">{fmtNum(o.bothBelow + o.miss)}</td>
						<td class="num">{fmtNum(o.falseAlarm + o.bothAbove)}</td>
						<td class="num">{fmtNum(o.days)}</td>
					</tr>
				</tbody>
			</table>
		</div>

		<svelte:element this={sub} class="bd-h">By month</svelte:element>
		{@render breakdown(monthRows(a), `${title}: by month`, 'Month')}

		<details>
			<summary>By water year ({a.byWaterYear.length})</summary>
			{@render breakdown(waterYearRows(a), `${title}: by water year`, 'Water year')}
		</details>
	{/if}
</section>

<style>
	.head {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.head > :global(h2),
	.head > :global(h3),
	.head > :global(h4) {
		margin: 0;
	}
	.intro {
		max-width: 85ch;
	}
	.verdict {
		font-size: 0.9rem;
		margin: 0.4rem 0;
	}
	.scores {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 170px), 1fr));
		gap: 0.5rem;
		margin: 0 0 0.75rem;
	}
	.scores div {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.4rem 0.6rem;
	}
	.scores dt {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.scores dd {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 600;
	}
	.scores dd.sub {
		font-size: 0.72rem;
		font-weight: 400;
		color: var(--text-muted);
	}
	.matrix caption {
		text-align: left;
		font-size: 0.8rem;
		color: var(--text-muted);
		padding-bottom: 0.25rem;
	}
	.tag {
		display: block;
		font-size: 0.7rem;
		color: var(--text-muted);
	}
	.bd-h {
		font-size: 0.9rem;
		margin: 0.9rem 0 0.35rem;
	}
	tr.empty {
		color: var(--text-muted);
	}
	details {
		margin-top: 0.6rem;
	}
	summary {
		cursor: pointer;
		font-size: 0.875rem;
	}
</style>
