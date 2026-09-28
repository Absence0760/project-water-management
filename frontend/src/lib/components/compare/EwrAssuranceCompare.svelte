<script lang="ts">
	// Reserve compliance by month in both runs (engine ≥ 0.21.0, docs/model.md
	// §2.9c; RunComparison.ewrAssurance): per EWR site, the months met, the
	// deficit, the longest run not met and the FDC check with the change B − A,
	// then the share of months met per month of the year.
	import type { EwrAssuranceDelta, MetricDelta } from '@water-management/engine';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import Delta from './Delta.svelte';
	import { fmtMetric, type MetricSpec } from './delta';

	let { sites }: { sites: EwrAssuranceDelta[] } = $props();

	const uid = $props.id();
	const mm3 = (m: MetricDelta): MetricDelta => ({ a: m.a === null ? null : m.a / 1e6, b: m.b === null ? null : m.b / 1e6, delta: m.delta === null ? null : m.delta / 1e6 });
	const rows = (s: EwrAssuranceDelta): { label: string; m: MetricDelta; spec: MetricSpec }[] => [
		{ label: 'Months met', m: s.rate, spec: { format: 'fraction', better: 'higher' } },
		{ label: 'Months not met', m: s.monthsNotMet, spec: { format: 'count', better: 'lower' } },
		{ label: 'Complete months assessed', m: s.months, spec: { format: 'count', better: 'neutral' } },
		{ label: 'Deficit (Mm³)', m: mm3(s.deficitM3), spec: { format: 'ratio', better: 'lower', digits: 3 } },
		{ label: 'Longest run not met (months)', m: s.longestNotMetRun, spec: { format: 'count', better: 'lower' } },
		{ label: 'FDC check: points met', m: s.fdcRate, spec: { format: 'fraction', better: 'higher', digits: 0 } },
		// Engine ≥ 0.33.0, shown only when either run has them.
		...(present(s.lowFlowRate) ? [{ label: 'Low flows: months met', m: s.lowFlowRate!, spec: { format: 'fraction', better: 'higher' } as MetricSpec }] : []),
		...(present(s.highFlowRate) ? [{ label: 'High flows: years met', m: s.highFlowRate!, spec: { format: 'fraction', better: 'higher', digits: 0 } as MetricSpec }] : []),
		// Engine ≥ 1.18.0 (CR-29), shown only when either run has them.
		...(present(s.timeNotMet) ? [{ label: 'Days not met (daily)', m: s.timeNotMet!, spec: { format: 'fraction', better: 'lower' } as MetricSpec }] : []),
		...(present(s.volumeNotMet) ? [{ label: 'Volume not met (daily)', m: s.volumeNotMet!, spec: { format: 'fraction', better: 'lower' } as MetricSpec }] : []),
		...(present(s.ewrPctNmar) ? [{ label: 'EWR as % of natural MAR', m: s.ewrPctNmar!, spec: { format: 'percent', better: 'neutral', digits: 1 } as MetricSpec }] : [])
	];
	const present = (m: MetricDelta | undefined) => !!m && (m.a !== null || m.b !== null);
	const monthSpec: MetricSpec = { format: 'fraction', better: 'higher', digits: 0 };
	const siteName = (s: EwrAssuranceDelta) => (s.isOutlet ? `Outlet (${s.name})` : s.name);
</script>

<p class="muted small intro">
	Each month is judged against the requirement its natural flow selects from the site’s Reserve rule table; more months met is better.
	Compare runs over the same period, and with the same table, for a like-for-like change.
</p>

{#each sites as s, i (`${s.name}-${i}`)}
	<h3 id="{uid}-{i}">{siteName(s)}</h3>
	{#if s.onlyIn}
		<p class="note small" role="note">Only run {s.onlyIn.toUpperCase()} has a rule table at this site.</p>
	{:else if s.tableChanged}
		<p class="note small" role="note">The two runs used different rule tables here, so the rates measure against different rules.</p>
	{/if}
	<div class="cols">
		<div class="table-wrap">
			<table class="data">
				<caption class="visually-hidden">Reserve compliance at {siteName(s)} for both runs</caption>
				<thead>
					<tr>
						<th scope="col">Measure</th>
						<th scope="col" class="num">Run A</th>
						<th scope="col" class="num">Run B</th>
						<th scope="col" class="num">Change (B − A)</th>
					</tr>
				</thead>
				<tbody>
					{#each rows(s) as r (r.label)}
						<tr>
							<th scope="row">{r.label}</th>
							<td class="num">{fmtMetric(r.m.a, r.spec)}</td>
							<td class="num">{fmtMetric(r.m.b, r.spec)}</td>
							<td class="num"><Delta m={r.m} spec={r.spec} /></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<div class="table-wrap">
			<table class="data compact">
				<caption class="visually-hidden">Share of months met per month of the year at {siteName(s)} for both runs</caption>
				<thead>
					<tr>
						<th scope="col">Months met</th>
						<th scope="col" class="num">Run A</th>
						<th scope="col" class="num">Run B</th>
						<th scope="col" class="num">Change</th>
					</tr>
				</thead>
				<tbody>
					{#each s.byMonth as m, k (k)}
						<tr>
							<th scope="row">{WATER_YEAR_MONTHS[k]}</th>
							<td class="num">{fmtMetric(m.a, monthSpec)}</td>
							<td class="num">{fmtMetric(m.b, monthSpec)}</td>
							<td class="num"><Delta {m} spec={monthSpec} /></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
{/each}

<style>
	.intro {
		margin: 0 0 0.5rem;
	}
	.note {
		color: var(--warning);
		margin: 0 0 0.5rem;
	}
	h3 {
		margin: 0.75rem 0 0.35rem;
	}
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 900px) {
		.cols {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
