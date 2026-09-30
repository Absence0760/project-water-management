<!--
	The seasonal outlook (issue #53 R5, docs/ui.md § Seasonal outlook,
	docs/model.md §2.15): from a saved run's state on the season's decision
	date, every analogue water year of the record run through the season at a
	few demand levels (demand.scale, 100 / 85 / 70 % by default, and
	optionally a monthly plan in R1's `months` form), in the background (the
	`outlook` job, docs/api.md § Seasonal outlooks). Per level: season-end
	storage, the share of demand met and the river's requirement as the
	median with the 10–90 % range, the years met, and the planning figure in
	the engine's words. Then the review triggers (R6): for each band of dam
	storage on the review date, the highest level that met the rule, in the
	engine's words (./triggers.ts). An editor can publish one level to the
	project's farmers (R5, E3): each farm page then shows its own figures at
	that level until the season ends, or the WUA withdraws it. Its own chunk:
	River & reserve (river/RiverTab.svelte) loads it lazily.

	It reports what the analogue years did at each level; it never picks one.
	The pending state follows the outlook's own status and its job's (polled),
	and the panel's data-state attribute says which, for the e2e spec.
-->
<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { DISCLAIMER, DISCLAIMER_DRAFT_NOTE } from '@water-management/engine';
	import { api, type Outlook, type OutlookPublication, type OutlookSettings, type RunMeta } from '$lib/api';
	import { buildTriggersView, triggerRuleView } from './triggers';
	import type { DroughtRestrictionRule } from '@water-management/engine';
	import type { Project } from '$lib/api';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { fmtDate, fmtDay } from '$lib/format/number';
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
		canEdit,
		droughtRestriction = null,
		onProjectChange
	}: {
		projectId: string;
		/** The shown run: the outlook's base. */
		run: Pick<RunMeta, 'id' | 'scenarioId' | 'forecastFrom'>;
		/** settings.outlook (the season and the planning share); an older API sends none. */
		outlook: OutlookSettings | undefined;
		canEdit: boolean;
		/** settings.droughtRestriction (engine ≥ 1.46.0): the rule the triggers would replace; null = none. */
		droughtRestriction?: DroughtRestrictionRule | null;
		/** Saving the triggers as the drought restriction rule changed the project's settings: the page takes the new project. */
		onProjectChange?: (p: Project) => void;
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
		return buildOutlookView({ ...outlook, result: outlook.result });
	});
	const dataState = $derived(loading ? 'loading' : !outlook ? 'empty' : (shown?.kind ?? 'loading'));
	const triggers = $derived(outlook && shown?.kind === 'complete' ? buildTriggersView(outlook) : null);
	// The trigger table as the drought restriction rule (engine ≥ 1.46.0, WP-3.8): an editor saves it to Settings.
	const triggerRule = $derived(outlook && shown?.kind === 'complete' ? triggerRuleView(outlook) : null);
	let ruleSaving = $state(false);
	let ruleSaved = $state(false);
	let ruleError = $state<string | null>(null);
	async function useTriggersAsRule() {
		if (!triggerRule?.rule) return;
		ruleSaving = true;
		ruleError = null;
		ruleSaved = false;
		try {
			const p = await api.projects.update(projectId, { settings: { droughtRestriction: triggerRule.rule }, reason: 'Drought restrictions from the seasonal outlook’s review triggers' });
			onProjectChange?.(p);
			ruleSaved = true;
		} catch (err) {
			ruleError = msg(err);
		} finally {
			ruleSaving = false;
		}
	}

	// Publishing to farmers (R5, E3): the project's current publication, and the level an editor picks.
	let publication = $state<OutlookPublication | null>(null);
	let publishLevel = $state('');
	let publishing = $state(false);
	let publishError = $state<string | null>(null);
	const runLevels = $derived(view ? view.rows.filter((r) => r.kind === 'ran').map((r) => ({ id: r.id, label: r.label })) : []);
	const publishedHere = $derived(!!publication && !!outlook && publication.outlookId === outlook.id);
	$effect(() => {
		if (runLevels.length && !runLevels.some((l) => l.id === publishLevel)) publishLevel = runLevels[0]!.id;
	});

	async function publishToFarmers() {
		if (!outlook || !publishLevel) return;
		publishing = true;
		publishError = null;
		try {
			publication = await api.outlooks.publish(projectId, outlook.id, publishLevel);
		} catch (err) {
			publishError = msg(err);
		} finally {
			publishing = false;
		}
	}

	async function withdraw() {
		publishing = true;
		publishError = null;
		try {
			await api.outlooks.withdraw(projectId);
			publication = null;
		} catch (err) {
			publishError = msg(err);
		} finally {
			publishing = false;
		}
	}

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
			const [[newest], current] = await Promise.all([api.outlooks.list(projectId, { baseRunId: run.id }), api.outlooks.publication(projectId)]);
			if (!live) return;
			outlook = newest ?? null;
			publication = current;
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
		the dams, the hydrological units and the river fared in those years. Historical analogues, not a forecast; the choice of level is the WUA’s.
	</p>

	{#if !ordinary}
		<p class="muted">An outlook is based on an ordinary run of the model, not a scenario or forecast run.</p>
	{:else}
		{#if canEdit}
			<form class="start" onsubmit={start} novalidate>
				<div class="field">
					<label for="outlook-levels">Demand levels <span class="u">(% of today’s hydrological unit demand)</span></label>
					<input id="outlook-levels" type="text" bind:value={levelsText} disabled={busy} aria-describedby="outlook-levels-h" aria-invalid={!!parsed.error} />
					<span class="hint" id="outlook-levels-h">Up to {OUTLOOK_LEVELS_MAX}, separated by commas. Each scales every hydrological unit’s irrigation demand from the decision date.</span>
				</div>
				<label class="check">
					<input type="checkbox" bind:checked={withPlan} disabled={busy} />
					Add a monthly plan
				</label>
				{#if withPlan}
					<fieldset class="plan">
						<legend>Monthly plan <span class="u">(% of today’s hydrological unit demand, by month of the season)</span></legend>
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
				<span class="badge" data-testid="outlook-share">Planning share: {view.share}</span>
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
							<th scope="col">Hydrological unit demand met</th>
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

			{#if triggers && triggers.kind !== 'none'}
				<h4 id="triggers-h">Review triggers</h4>
				<div data-testid="outlook-triggers">
					{#if triggers.kind === 'notDrawn'}
						<p class="muted" data-testid="triggers-not-drawn">Review on {triggers.reviewDate}: no trigger table. {triggers.problem}</p>
					{:else}
						<p class="small">
							Review on <strong data-testid="triggers-review-date">{triggers.reviewDate}</strong>. For each band of total dam storage on that day, the
							highest demand level that met the river’s requirement for the rest of the season in at least {view.share} of past years. Drawn on
							<span data-testid="triggers-ran-on">{triggers.ranOn}</span>, the latest review date in the run’s record, as a rule for that day of the year.
							{triggers.bandsFrom}
						</p>
						<div class="scroll">
							<table class="levels" data-testid="triggers-table">
								<caption class="visually-hidden">Review triggers: the demand level by dam storage on the review date</caption>
								<thead>
									<tr>
										<th scope="col">Dam storage on the review date</th>
										<th scope="col">Demand level</th>
										<th scope="col">Years met in full</th>
										<th scope="col">Every level</th>
									</tr>
								</thead>
								<tbody>
									{#each triggers.rows as r (r.band)}
										<tr>
											<th scope="row">{r.band}<span class="band">{r.fromShare} of capacity and up</span></th>
											<td class="stat"><strong>{r.level ?? 'No level'}</strong></td>
											<td class="stat">{r.met}</td>
											<td class="stat">
												{#each r.perLevel as l (l.label)}<span class="band">{l.label}: {l.met}{l.meets ? '' : ' (below the share)'}</span>{/each}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
						<ul class="words" data-testid="triggers-words">
							{#each triggers.rows as r (r.band)}<li>{r.words}</li>{/each}
						</ul>
						{#if triggers.notes.length}
							<ul class="warnings" data-testid="triggers-notes">
								{#each triggers.notes as n (n)}<li>{n}</li>{/each}
							</ul>
						{/if}
						{#if triggers.warnings.length || triggers.failures.length}
							<ul class="warnings" data-testid="triggers-warnings">
								{#each [...triggers.warnings, ...triggers.failures] as w (w)}<li>{w}</li>{/each}
							</ul>
						{/if}
						<p class="hint">
							These count past years from each storage. The WUA decides what to do on the review date; it can also make the table the model’s
							drought restriction rule, so runs follow it.
						</p>
						{#if triggerRule}
							<div class="as-rule" data-testid="triggers-as-rule">
								{#if triggerRule.words}
									<p class="small">As a drought restriction rule (Settings → Drought restrictions): <span data-testid="triggers-rule-words">{triggerRule.words}</span>.</p>
								{/if}
								{#if triggerRule.notes.length}
									<ul class="warnings" data-testid="triggers-rule-notes">
										{#each triggerRule.notes as n (n)}<li>{n}</li>{/each}
									</ul>
								{/if}
								{#if triggerRule.rule && canEdit && onProjectChange}
									<button type="button" disabled={ruleSaving} onclick={useTriggersAsRule} data-testid="triggers-use-rule">
										{droughtRestriction ? 'Replace the drought restriction rule with this' : 'Use as the drought restriction rule'}
									</button>
									{#if ruleSaved}<p class="small" role="status" data-testid="triggers-rule-saved">Saved to Settings → Drought restrictions. Runs from now on follow it.</p>{/if}
									{#if ruleError}<p class="err" role="alert">{ruleError}</p>{/if}
								{/if}
							</div>
						{/if}
					{/if}
				</div>
			{/if}

			<h4 id="publish-h">Farmers</h4>
			<div data-testid="outlook-publish">
				{#if publication}
					<p class="small" data-testid="outlook-published" data-here={publishedHere}>
						Published to farmers: <strong>{publication.level.label}</strong> for {fmtDay(publication.decisionDate)} – {fmtDay(publication.seasonEnd)}, on
						{fmtDate(publication.publishedAt, true)}{publication.publishedBy ? ` by ${publication.publishedBy}` : ''}, {publication.farms}
						{publication.farms === 1 ? 'hydrological unit' : 'hydrological units'}{publishedHere ? '' : ' (from another outlook)'}.
					</p>
				{:else}
					<p class="small muted" data-testid="outlook-not-published">No outlook is published to farmers.</p>
				{/if}
				{#if canEdit && runLevels.length}
					<div class="start">
						<div class="field">
							<label for="outlook-publish-level">Level the WUA has set</label>
							<select id="outlook-publish-level" bind:value={publishLevel} disabled={publishing}>
								{#each runLevels as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
							</select>
						</div>
						<button type="button" class="btn btn-primary" onclick={publishToFarmers} disabled={publishing || !publishLevel}>Publish to farmers</button>
						{#if publication}<button type="button" class="btn" onclick={withdraw} disabled={publishing}>Withdraw</button>{/if}
					</div>
					<p class="hint">
						Each linked farmer then sees, on their farm page, what that level gave their own hydrological unit in past years, until the season ends. It
						replaces the outlook published before. Publish the level the WUA decided; the app doesn’t choose one.
					</p>
				{/if}
				{#if publishError}<div class="alert alert-error" role="alert">{publishError}</div>{/if}
			</div>

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
	.words {
		font-size: 0.85rem;
		margin: 0.5rem 0 0;
		padding-left: 1.2rem;
	}
</style>
