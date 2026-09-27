<!--
	The seasonal outlook (issue #53 R5, docs/ui.md § Seasonal outlook,
	docs/model.md §2.15): from a saved run's state on the season's decision
	date, every analogue water year of the record run through the season at a
	few demand levels (demand.scale, 100 / 85 / 70 % by default, and
	optionally a monthly plan in R1's `months` form), in the background (the
	`outlook` job, docs/api.md § Seasonal outlooks). Per level: season-end
	storage, the share of demand met and the river's requirement as the
	median with the 10–90 % range, the years met, and the planning figure in
	the engine's words. Its own chunk: River & reserve (river/RiverTab.svelte) loads it lazily.

	It reports what the analogue years did at each level; it never picks one.
	The pending state follows the outlook's own status and its job's (polled),
	and the panel's data-state attribute says which, for the e2e spec.
-->
<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { DISCLAIMER, DISCLAIMER_DRAFT_NOTE } from '@water-management/engine';
	import { api, type Outlook, type OutlookSettings, type RunMeta } from '$lib/api';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { fmtDate } from '$lib/format/number';
	import { monthName } from '$lib/format/months';
	import { resolveOutlook } from './settings';
	import {
		buildOutlookView,
		DEFAULT_OUTLOOK_LEVELS,
		monthlyPlanOps,
		OUTLOOK_LEVELS_MAX,
		outlookRequest,
		outlookState,
		parseLevels,
		seasonMonths,
		type OutlookView
	} from './view';

	let {
		projectId,
		run,
		outlook: outlookSettings,
		canEdit
	}: {
		projectId: string;
		/** The shown run: the outlook's base. */
		run: Pick<RunMeta, 'id' | 'scenarioId' | 'forecastFrom'>;
		/** settings.outlook (the season and the planning share); an older API sends none. */
		outlook: OutlookSettings | undefined;
		canEdit: boolean;
	} = $props();

	const settings = $derived(resolveOutlook({ outlook: outlookSettings }));
	const ordinary = $derived(!run.scenarioId && !run.forecastFrom);
	const months = $derived(seasonMonths(settings.season));
	let outlook = $state<Outlook | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let submitError = $state<string | null>(null);
	let submitting = $state(false);
	let levelsText = $state(DEFAULT_OUTLOOK_LEVELS.join(', '));
	let withPlan = $state(false);
	let planLabel = $state('Monthly plan');
	let planPct = $state<Record<number, number>>(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 100])));
	let timer: ReturnType<typeof setTimeout> | undefined;
	let live = true;

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const parsed = $derived(parseLevels(levelsText, withPlan ? OUTLOOK_LEVELS_MAX - 1 : OUTLOOK_LEVELS_MAX));
	const plan = $derived(withPlan ? monthlyPlanOps(planPct, months) : null);
	const planError = $derived.by(() => {
		if (!withPlan) return null;
		const label = planLabel.trim();
		if (!label) return 'Give the monthly plan a name.';
		if (parsed.levels?.some((p) => `${p} %` === label || `${p}` === label)) return 'The monthly plan needs a name of its own.';
		return plan?.error ?? null;
	});
	const shown = $derived(outlook ? outlookState(outlook) : null);
	const view = $derived.by((): OutlookView | null => {
		if (!outlook || shown?.kind !== 'complete' || !outlook.result) return null;
		return buildOutlookView({ ...outlook, result: outlook.result }, settings);
	});
	const dataState = $derived(loading ? 'loading' : !outlook ? 'empty' : (shown?.kind ?? 'loading'));

	/** Follow a pending outlook on its own status until it completes or its job stops. */
	async function poll(id: string) {
		clearTimeout(timer);
		try {
			const o = await api.outlooks.get(projectId, id);
			if (!live || outlook?.id !== id) return;
			outlook = o;
			if (outlookState(o).kind === 'pending') timer = setTimeout(() => poll(id), 1500);
		} catch (e) {
			if (live) loadError = msg(e);
		}
	}

	async function load() {
		loading = true;
		loadError = null;
		try {
			const [newest] = await api.outlooks.list(projectId, { baseRunId: run.id });
			if (!live) return;
			outlook = newest ?? null;
			if (newest?.status === 'complete') outlook = await api.outlooks.get(projectId, newest.id);
			else if (newest && outlookState(newest).kind === 'pending') timer = setTimeout(() => poll(newest.id), 1500);
		} catch (e) {
			if (live) loadError = msg(e);
		} finally {
			if (live) loading = false;
		}
	}

	$effect(() => {
		if (!untrack(() => ordinary)) {
			loading = false;
			return;
		}
		untrack(load);
	});

	async function start(e: SubmitEvent) {
		e.preventDefault();
		if (!parsed.levels || planError) return;
		submitting = true;
		submitError = null;
		try {
			const body = outlookRequest(run.id, parsed.levels, plan ? { label: planLabel.trim(), ops: plan.ops } : null);
			const res = await api.outlooks.create(projectId, body);
			outlook = res.outlook;
			await poll(res.outlook.id);
		} catch (err) {
			submitError = msg(err);
		} finally {
			submitting = false;
		}
	}

	onDestroy(() => {
		live = false;
		clearTimeout(timer);
	});

	const busy = $derived(submitting || shown?.kind === 'pending');
</script>

<section aria-labelledby="outlook-h" data-testid="seasonal-outlook" data-state={dataState}>
	<h3 id="outlook-h">Seasonal outlook</h3>
	<p class="muted small lead">
		From this run’s state on the season’s decision date, the season run with the weather of each past water year, at a few demand levels: how
		the dams, the units and the river fared in those years. Historical analogues, not a forecast; the choice of level is the WUA’s.
	</p>

	{#if !ordinary}
		<p class="muted">An outlook is based on an ordinary run of the model, not a scenario or forecast run.</p>
	{:else}
		{#if canEdit}
			<form class="start" onsubmit={start} novalidate>
				<div class="field">
					<label for="outlook-levels">Demand levels <span class="u">(% of today’s unit demand)</span></label>
					<input id="outlook-levels" type="text" bind:value={levelsText} disabled={busy} aria-describedby="outlook-levels-h" aria-invalid={!!parsed.error} />
					<span class="hint" id="outlook-levels-h">Up to {OUTLOOK_LEVELS_MAX}, separated by commas. Each scales every unit’s irrigation demand from the decision date.</span>
				</div>
				<label class="check">
					<input type="checkbox" bind:checked={withPlan} disabled={busy} />
					Add a monthly plan
				</label>
				{#if withPlan}
					<fieldset class="plan">
						<legend>Monthly plan <span class="u">(% of today’s unit demand, by month of the season)</span></legend>
						<div class="field">
							<label for="outlook-plan-label">Name</label>
							<input id="outlook-plan-label" type="text" maxlength="100" bind:value={planLabel} disabled={busy} />
						</div>
						<div class="months">
							{#each months as m (m)}
								<div class="field month">
									<label for="outlook-plan-{m}">{monthName(m)} <span class="u">(%)</span></label>
									<NumberInput id="outlook-plan-{m}" min={0} max={200} disabled={busy} bind:value={planPct[m]!} />
								</div>
							{/each}
						</div>
					</fieldset>
				{/if}
				<button type="submit" class="btn btn-primary" disabled={busy || !!parsed.error || !!planError}>{outlook ? 'Run a new outlook' : 'Run seasonal outlook'}</button>
			</form>
			{#if parsed.error}<p class="err" role="alert">{parsed.error}</p>{/if}
			{#if planError}<p class="err" role="alert">{planError}</p>{/if}
		{/if}
		{#if submitError}<div class="alert alert-error" role="alert">{submitError}</div>{/if}

		<div role="status" aria-live="polite" class="status">
			{#if loading}
				<span class="muted">Loading…</span>
			{:else if shown?.kind === 'pending'}
				<span data-testid="outlook-status">{shown.text}</span>
				{#if shown.progress != null}<progress max="100" value={shown.progress} aria-label="Seasonal outlook progress">{shown.progress} %</progress>{/if}
			{:else if shown?.kind === 'stuck'}
				<span class="err" data-testid="outlook-status">{shown.text}</span>
			{/if}
		</div>
		{#if loadError}<div class="alert alert-error" role="alert">{loadError}</div>{/if}

		{#if !loading && !outlook && !loadError}
			<p class="muted" data-testid="outlook-empty">No seasonal outlook on this run yet.{canEdit ? '' : ' An editor can run one.'}</p>
		{/if}

		{#if view && outlook}
			<p class="small meta">
				{outlook.name} · run {fmtDate(outlook.completedAt ?? outlook.createdAt, true)}{outlook.createdBy ? ` by ${outlook.createdBy}` : ''}
				{#if outlook.engineVersion}· engine {outlook.engineVersion}{/if}
			</p>
			<div class="badges">
				<span class="badge" data-testid="outlook-season">Season: {view.season}</span>
				{#if view.seasonPending}<span class="badge badge-warn" data-testid="outlook-season-pending">Season pending the client</span>{/if}
				<span class="badge" data-testid="outlook-share">Planning share: {view.share}</span>
				{#if view.sharePending}<span class="badge badge-warn" data-testid="outlook-share-pending">Planning share pending the client</span>{/if}
				<span class="badge" data-testid="outlook-metric">Measure: {view.metricLabel}</span>
				<span class="badge" data-testid="outlook-years">{view.nYears} analogue {view.nYears === 1 ? 'year' : 'years'}</span>
			</div>
			{#if view.start}<p class="small">{view.start}</p>{/if}
			{#if view.tooFewYears}<div class="alert alert-warning" data-testid="outlook-too-few">{view.tooFewYears}</div>{/if}

			<div class="scroll">
				<table class="levels" data-testid="outlook-table">
					<caption class="visually-hidden">Season outcome by demand level: medians with the 10–90 % range across analogue years</caption>
					<thead>
						<tr>
							<th scope="col">Demand level</th>
							<th scope="col">Dam storage at season end</th>
							<th scope="col">Unit demand met</th>
							<th scope="col">{view.ewrHeading}</th>
							<th scope="col">Years met in full</th>
						</tr>
					</thead>
					<tbody>
						{#each view.rows as r (r.id)}
							<tr data-level={r.id}>
								<th scope="row">
									{r.label}
									{#if r.planning}<span class="badge small" data-testid="planning-level">Planning figure</span>{/if}
								</th>
								{#if r.kind === 'ran'}
									{#each [r.storage, r.demandMet, r.ewr] as st, i (i)}
										<td class="stat"><strong>{st.median}</strong>{#if st.band}<span class="band">10–90 %: {st.band}</span>{/if}</td>
									{/each}
									<td class="stat">{r.yearsMet}</td>
								{:else}
									<td colspan="4" class="not-run"><strong>Could not be run:</strong> {r.problems.join(' ')}</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="hint" data-testid="return-flow-note">
				Lower demand does not always mean fewer {view.metric === 'reserveMonthsMet' ? 'months short of the Reserve' : 'days below the EWR'}: part of the
				water irrigated from a dam drains back to the river, so taking less from the dam can leave the river lower on dry days.
			</p>

			<h4>Planning figure</h4>
			<p data-testid="outlook-planning">{view.planning}</p>
			<p class="hint">
				This counts past years; it is not a decision. The WUA decides the season’s level and publishes it as the restriction notice.
			</p>

			{#if view.years.length}
				<details class="years">
					<summary>Every analogue year</summary>
					<div class="scroll">
						<table class="levels" data-testid="outlook-years-table">
							<thead>
								<tr>
									<th scope="col">Water year</th>
									{#each view.yearColumns as c (c)}<th scope="col">{c}</th>{/each}
								</tr>
							</thead>
							<tbody>
								{#each view.years as y (y.label)}
									<tr>
										<th scope="row">{y.label}</th>
										{#each y.cells as c, i (i)}
											<td class="stat" data-met={c.met}>{c.ewr}<span class="band">{c.storage} at the end</span></td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</details>
			{/if}
			{#if view.excluded.length}
				<p class="hint" data-testid="outlook-excluded">Not used: {view.excluded.join(', ')}.</p>
			{/if}
			{#if view.failures.length}
				<ul class="warnings" data-testid="outlook-failures">
					{#each view.failures as f (f)}<li>{f}</li>{/each}
				</ul>
			{/if}
			{#if view.warnings.length}
				<ul class="warnings" data-testid="outlook-warnings">
					{#each view.warnings as w (w)}<li>{w}</li>{/each}
				</ul>
			{/if}
			<p class="hint disclaimer" data-testid="outlook-disclaimer">
				{DISCLAIMER.paragraphs[0]}
				{DISCLAIMER.paragraphs[2]}
				{#if DISCLAIMER.status === 'draft'}<em>{DISCLAIMER_DRAFT_NOTE}</em>{/if}
			</p>
		{/if}
	{/if}
</section>

<style>
	.lead {
		max-width: 80ch;
		margin: 0 0 0.75rem;
	}
	.start {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 1rem;
	}
	.start input[type='text'] {
		min-width: 14rem;
	}
	.check {
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}
	.plan {
		flex-basis: 100%;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.75rem;
		margin: 0;
	}
	.months {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
		margin-top: 0.5rem;
	}
	.month :global(input) {
		width: 5rem;
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
		max-width: 80ch;
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
	}
	.status {
		margin: 0.5rem 0;
		display: flex;
		gap: 0.75rem;
		align-items: center;
	}
	.meta {
		color: var(--text-muted);
		margin: 0.25rem 0;
	}
	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0.25rem 0 0.5rem;
	}
	.scroll {
		overflow-x: auto;
	}
	.levels {
		border-collapse: collapse;
		min-width: 100%;
	}
	.levels th,
	.levels td {
		border: 1px solid var(--border);
		padding: 0.45rem 0.6rem;
		vertical-align: top;
		text-align: left;
	}
	.stat {
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}
	.stat strong {
		display: block;
	}
	.band {
		display: block;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.not-run {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.years {
		margin: 0.5rem 0;
	}
	.warnings {
		font-size: 0.8rem;
		margin: 0.5rem 0 0;
		padding-left: 1.2rem;
	}
	.disclaimer {
		margin-top: 0.75rem;
	}
	h4 {
		margin: 0.75rem 0 0.25rem;
	}
</style>
