<script lang="ts">
	// An applicant's results (WP-3.3, docs/ui.md § Applications): the newest
	// run of their application against the published baseline, as the server
	// projects it for them (GET …/scenarios/:sid/results, D2's default,
	// pending the client). The EWR at every site; the catchment's flows and
	// the outlet's flow chart at five or more farm holders; their own units in
	// full; every other unit downstream of theirs only as "Farm 3" and a whole
	// percentage; and what ran on their units. A run with a baseline
	// assumption shows the EWR only (the server leaves the rest out). The
	// workspace is English (the Applicant view has no t()).
	import { untrack } from 'svelte';
	import { api, type ApplicantResults, type ApplicantResultsRun, type ApplicantEwrFigures, type ApplicantUnitFigures } from '$lib/api';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fmtDate, fmtNum, fmtPct } from '$lib/format/number';

	const loadChart = () => import('$lib/components/charts/LineChart.svelte');

	let { projectId, scenarioId, lastRunId, opsSha256 }: { projectId: string; scenarioId: string; lastRunId: string | null; opsSha256: string } = $props();

	let run = $state<ApplicantResultsRun | null>(null);
	let results = $state.raw<ApplicantResults | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let wanted = '';

	async function load() {
		const key = `${scenarioId}|${lastRunId}|${opsSha256}`;
		wanted = key;
		loading = true;
		error = null;
		try {
			const d = await api.scenarios.results(projectId, scenarioId);
			if (wanted !== key) return;
			run = d.run;
			results = d.results;
		} catch (e) {
			if (wanted !== key) return;
			run = null;
			results = null;
			error = e instanceof Error ? e.message : String(e);
		} finally {
			if (wanted === key) loading = false;
		}
	}
	$effect(() => {
		// A new run, or changes edited since (the run is then of the older list).
		void scenarioId;
		void lastRunId;
		void opsSha256;
		untrack(load);
	});

	const ha = (m2: number) => `${fmtNum(m2 / 10_000, 1, true)} ha`;
	const months = (f: ApplicantEwrFigures | null) => (f ? `${f.met} of ${f.months}` : '–');
	const rate = (f: ApplicantEwrFigures | null) => (f?.rate == null ? '–' : fmtPct(f.rate, 0));
	const m3 = (v: number | null | undefined) => (v == null ? '–' : fmtNum(v));
	const share = (f: ApplicantUnitFigures | null) => (f ? fmtPct(f.fractionSupplied, 0) : '–');
	/** "−4 %", "+2 %", "0 %". */
	const signedPct = (p: number) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p)} %`;
	const showDeficit = $derived(!!results?.ewrSites.some((s) => s.base?.deficitM3 != null || s.application?.deficitM3 != null));

	/** What ran on each of their units: its crops and boreholes, by the names (and ids) they gave. */
	function ranOn(nodeId: string): string {
		if (!results) return '';
		const crops = new Map(results.model.crops.map((c) => [c.id, c.name]));
		const planted = results.model.cropAreas.filter((a) => a.nodeId === nodeId && a.areaM2 > 0).map((a) => `${crops.get(a.cropId) ?? 'a crop'} ${ha(a.areaM2)}`);
		const holes = (results.model.boreholes ?? []).filter((b) => b.nodeId === nodeId).map((b) => b.name);
		const parts = [planted.length ? planted.join(', ') : 'no crops', holes.length ? `boreholes: ${holes.join(', ')}` : ''];
		return parts.filter(Boolean).join('; ');
	}

	const chartSeries = $derived.by(() => {
		const s = results?.catchment.series;
		if (!s) return null;
		return [
			{ ...s.outflow.base, label: 'Outflow, baseline', color: '--series-1' },
			{ ...s.outflow.application, label: 'Outflow, your application', color: '--series-2' },
			{ ...s.ewr.base, label: 'EWR, baseline', color: '--series-3', style: 'step' as const },
			{ ...s.ewr.application, label: 'EWR, your application', color: '--series-4', style: 'dashed' as const, hidden: true }
		];
	});
</script>

<section class="panel" aria-labelledby="applicant-results-h" data-testid="applicant-results">
	<div class="panel-head">
		<h2 id="applicant-results-h">Your results against the baseline</h2>
	</div>
	{#if !lastRunId}
		<p class="muted" data-testid="applicant-results-empty">Not run yet. Run your application to see its results against the published baseline.</p>
	{:else}
		<LoadState loading={loading && !results} {error} retry={load}>
			{#if run && results}
				<p class="sides" aria-busy={loading}>
					Your run <strong>{run.label || 'Untitled run'}</strong> ({fmtDate(run.createdAt, true)}) against the published baseline.
				</p>
				{#if !run.current}
					<div class="alert alert-info" role="status" data-testid="applicant-results-stale">
						Your changes have been edited since this run. Run it again to see their effect.
					</div>
				{/if}
				{#if !results.allProposals}
					<div class="alert alert-info" role="status" data-testid="applicant-results-withheld">
						A change here is a baseline assumption (on a hydrological unit that isn't yours, or on the catchment). Its effect on your
						units, the catchment and other units isn't shown to you, because it would show other units' own figures; the assessors
						see it in full. The Ecological Reserve at each site is below.
					</div>
				{/if}

				<section aria-labelledby="ar-ewr-h">
					<h3 id="ar-ewr-h">Ecological Reserve (EWR)</h3>
					<p class="muted small">
						Days the EWR at the outlet is not met: {fmtNum(results.catchment.ewrDaysNotMet.base)} in the baseline,
						<strong data-testid="applicant-ewr-days">{fmtNum(results.catchment.ewrDaysNotMet.application)}</strong> with your application.
					</p>
					{#if results.ewrSites.length}
						<div class="table-wrap">
							<table class="data" data-testid="applicant-ewr">
								<caption class="visually-hidden">Months each EWR site's rules are met, baseline and your application</caption>
								<thead>
									<tr>
										<th scope="col">Site</th>
										<th scope="col" class="num">Months met<br /><span class="u">baseline</span></th>
										<th scope="col" class="num">Months met<br /><span class="u">yours</span></th>
										<th scope="col" class="num">Rate<br /><span class="u">baseline → yours</span></th>
										<th scope="col" class="num">Longest run not met<br /><span class="u">months, yours</span></th>
										{#if showDeficit}<th scope="col" class="num">Deficit<br /><span class="u">m³, yours</span></th>{/if}
									</tr>
								</thead>
								<tbody>
									{#each results.ewrSites as s (s.nodeId ?? 'outlet')}
										<tr>
											<th scope="row">{s.isOutlet ? 'Catchment outlet' : s.name}</th>
											<td class="num">{months(s.base)}</td>
											<td class="num">{months(s.application)}</td>
											<td class="num">{rate(s.base)} → {rate(s.application)}</td>
											<td class="num">{s.application ? s.application.longestNotMetRun : '–'}</td>
											{#if showDeficit}<td class="num">{m3(s.application?.deficitM3)}</td>{/if}
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{:else}
						<p class="muted small">The catchment has no EWR rule table, so there are no months to count.</p>
					{/if}
				</section>

				<section aria-labelledby="ar-catchment-h" data-testid="applicant-catchment">
					<h3 id="ar-catchment-h">The catchment</h3>
					{#if results.catchment.figures}
						{@const f = results.catchment.figures}
						<div class="table-wrap">
							<table class="data">
								<caption class="visually-hidden">The catchment's flows, baseline and your application</caption>
								<thead>
									<tr>
										<th scope="col">Mean over the run</th>
										<th scope="col" class="num">Baseline<br /><span class="u">m³/day</span></th>
										<th scope="col" class="num">Yours<br /><span class="u">m³/day</span></th>
									</tr>
								</thead>
								<tbody>
									<tr>
										<th scope="row">Natural flow</th>
										<td class="num">{fmtNum(f.base.meanNaturalFlowM3Day)}</td>
										<td class="num">{fmtNum(f.application.meanNaturalFlowM3Day)}</td>
									</tr>
									<tr>
										<th scope="row">Flow at the outlet</th>
										<td class="num">{fmtNum(f.base.meanSimulatedOutflowM3Day)}</td>
										<td class="num">{fmtNum(f.application.meanSimulatedOutflowM3Day)}</td>
									</tr>
								</tbody>
							</table>
						</div>
						{#if chartSeries}
							<Lazy load={loadChart}>
								{#snippet children(LineChart)}
									<LineChart title="Flow at the outlet and the EWR · baseline vs your application" unit="m³/day" series={chartSeries} logToggle height={260} />
								{/snippet}
							</Lazy>
						{/if}
					{:else if results.catchment.withheld === 'few_farm_holders'}
						<p class="muted small" data-testid="applicant-catchment-withheld">
							The catchment's flows are shown once it has five or more farm holders, so that they can't be traced back to one farm.
						</p>
					{:else}
						<p class="muted small" data-testid="applicant-catchment-withheld">Not shown for a run with a baseline assumption (above).</p>
					{/if}
				</section>

				{#if results.allProposals}
					<section aria-labelledby="ar-units-h">
						<h3 id="ar-units-h">Your hydrological units</h3>
						{#if results.units.length}
							<div class="table-wrap">
								<table class="data" data-testid="applicant-units">
									<caption class="visually-hidden">Your hydrological units, baseline and your application</caption>
									<thead>
										<tr>
											<th scope="col">Unit</th>
											<th scope="col" class="num">Demand<br /><span class="u">m³/day, yours</span></th>
											<th scope="col" class="num">Supplied<br /><span class="u">m³/day, baseline → yours</span></th>
											<th scope="col" class="num">Share of demand met<br /><span class="u">baseline → yours</span></th>
											<th scope="col" class="num">Dam on the last day<br /><span class="u">m³, baseline → yours</span></th>
											<th scope="col">What ran</th>
										</tr>
									</thead>
									<tbody>
										{#each results.units as u (u.nodeId)}
											<tr>
												<th scope="row">{u.name}{u.added ? ' (new)' : ''}</th>
												<td class="num">{m3(u.application?.avgDemandM3Day)}</td>
												<td class="num">{m3(u.base?.avgSuppliedM3Day)} → {m3(u.application?.avgSuppliedM3Day)}</td>
												<td class="num">{share(u.base)} → {share(u.application)}</td>
												<td class="num">{m3(u.base?.damEndM3)} → {m3(u.application?.damEndM3)}</td>
												<td class="ran">{u.application ? ranOn(u.nodeId) : 'removed'}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{:else}
							<p class="muted small">You have no hydrological unit in this application.</p>
						{/if}
					</section>

					<section aria-labelledby="ar-down-h">
						<h3 id="ar-down-h">Downstream of your units</h3>
						{#if results.downstream.length}
							<ul class="down" data-testid="applicant-downstream">
								{#each results.downstream as d (d.nodeId)}
									<li>
										<strong>{d.name}</strong> downstream: {d.supplyChangePct === null ? 'no supply in the baseline' : `supply ${signedPct(d.supplyChangePct)}`}
									</li>
								{/each}
							</ul>
							<p class="muted small">Other units are shown only by an anonymous name, and their change in mean supply only as a whole percentage.</p>
						{:else}
							<p class="muted small" data-testid="applicant-downstream-empty">No other farm or water user lies downstream of your units.</p>
						{/if}
					</section>
				{/if}
			{/if}
		</LoadState>
	{/if}
</section>

<style>
	.sides {
		margin: 0 0 0.75rem;
		overflow-wrap: anywhere;
	}
	h3 {
		font-size: 1rem;
		margin: 1rem 0 0.5rem;
	}
	.small {
		font-size: 0.85rem;
	}
	.down {
		margin: 0 0 0.5rem;
		padding-left: 1.2rem;
	}
	.ran {
		min-width: 12rem;
		overflow-wrap: anywhere;
	}
</style>
