<!--
	Recession diagnostics (RunSummary.plausibility.recession, engine ≥ 1.18.0;
	docs/model.md §2.10d "Recession diagnostics", CR-13): −dQ/dt against Q on
	the calibration record's rain-free recession segments, for the record and
	for the simulated outflow on the same days, each with its fitted power law.
	Part of the Plausibility checks panel. The points are rebuilt from the
	run's stored observed and simulated series (recession.ts).
-->
<script lang="ts">
	import type { DailySeries, RecessionCheck } from '@water-management/engine';
	import { api } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import { cachedSeries } from './cache';
	import { flowTick, recessionChart, recessionRows, recessionVerdict, sig3 } from './recession';

	let { check, projectId, runId }: { check: RecessionCheck; projectId: string; runId: string } = $props();

	const uid = $props.id();
	const verdict = $derived(recessionVerdict(check));
	const rows = $derived(recessionRows(check));
	let flows = $state.raw<{ observed: DailySeries; simulated: DailySeries } | null>(null);
	let error = $state<string | null>(null);
	$effect(() => {
		const id = runId;
		flows = null;
		error = null;
		if (!check.segments.length) return;
		const get = (key: string) => cachedSeries(id, key, null, () => api.runs.series(projectId, id, key, null));
		Promise.all([get('observed_flow'), get('simulated_outflow')])
			.then(([observed, simulated]) => {
				if (id === runId) flows = { observed, simulated };
			})
			.catch((e) => {
				if (id === runId) error = e instanceof Error ? e.message : String(e);
			});
	});
	const chart = $derived(flows ? recessionChart(check, flows.observed, flows.simulated) : null);
	const o = $derived(check.options);
</script>

<h4 id="{uid}-h">Recession diagnostics <HelpTip key="plausibility-recession" /></h4>
<p class="small">
	{fmtNum(check.segments.length)} rain-free recession segment{check.segments.length === 1 ? '' : 's'} in the {check.flowKind === 'flow_logger_m3s'
		? 'logger'
		: 'gauge'} record: flow falling for {o.recessionLength}+ days after the day after the peak, with at most {fmtNum(o.rainThresholdMm, 1)} mm of catchment rain
	on the day and the day before, no missing, zero or excluded day. The simulated outflow is taken on the same days.
</p>
<p class="flag {verdict.ok === null ? 'none' : verdict.ok ? 'good' : 'bad'}" role="status">{verdict.text}</p>
{#if check.segments.length}
	{#if chart}
		<LineChart
			title="Recession rate against flow"
			unit="m³/s per day"
			height={280}
			series={chart.series}
			xy={chart.xy}
			xLabel="Flow Q (m³/s, log scale)"
			xFormat={flowTick}
			log={true}
			caption="−dQ/dt against Q on log–log axes, one point per day of a segment ({o.dQdtMethod === 'ETS'
				? 'exponential time stepping, Roques et al. 2017'
				: o.dQdtMethod === 'BN'
					? 'Brutsaert & Nieber'
					: 'backward difference'}). A steeper line is a more non-linear store (larger b); a higher line drains faster."
		/>
	{:else if error}
		<p class="muted small" role="status">The recession points could not be loaded: {error}</p>
	{:else}
		<p class="muted small" role="status">Loading the recession points…</p>
	{/if}
	<div class="table-wrap">
		<table class="data compact" aria-labelledby="{uid}-t">
			<caption id="{uid}-t" class="visually-hidden">Fitted recession −dQ/dt = a·Q^b, observed and simulated</caption>
			<thead>
				<tr>
					<th scope="col"><span class="visually-hidden">Flow</span></th>
					<th scope="col" class="num">a <span class="u">(m³/s)^(1−b)/day</span></th>
					<th scope="col" class="num">b</th>
					<th scope="col" class="num">−dQ/dt ÷ Q at {sig3(check.referenceFlowM3s)} m³/s <span class="u">/day</span></th>
					<th scope="col" class="num">Points</th>
					<th scope="col" class="num">Segments</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.label)}
					<tr>
						<th scope="row">{r.label}</th>
						<td class="num">{r.a}</td>
						<td class="num">{r.b}</td>
						<td class="num">{r.rate}</td>
						<td class="num">{r.points === null ? '–' : fmtNum(r.points)}</td>
						<td class="num">{r.segments === null ? '–' : fmtNum(r.segments)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	h4 {
		margin: 1.25rem 0 0.35rem;
	}
	.flag {
		padding: 0.4rem 0.65rem;
		border-radius: var(--radius, 6px);
		border-left: 4px solid var(--border-strong);
		background: var(--surface-2);
		font-size: 0.85rem;
	}
	.flag.good {
		border-left-color: var(--success);
	}
	.flag.bad {
		border-left-color: var(--danger);
	}
</style>
