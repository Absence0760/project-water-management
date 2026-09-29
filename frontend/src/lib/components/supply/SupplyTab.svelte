<script lang="ts">
	// Units & supply (issue #17, option A · Outcomes): how much of each unit's
	// irrigation demand one run supplied. Three tiles (irrigation supplied with
	// the units below the target and its change from the previous run, as the
	// Summary's card has it; units short this week; the total shortfall), a card per unit, worst supplied first
	// (% supplied in the Summary's and the Network's supply bands, shortfall,
	// days short, this week, the curtailment cut; links to its node on the
	// Network and its planted areas), beside the picked unit's supply against
	// its demand (`unit=<nodeId>`). Below them the panels that moved here from
	// Runs & results, unchanged: the unit results table, the curtailment
	// targets with their reporting window and assurance of supply. The run is
	// `run=` (a picker in the header), else the newest run, as on the Summary.
	// The page flows in the window's one scroll (as the Dams page): the three
	// least supplied cards show, the rest behind "Show all N hydrological
	// units" (no card list scrolls inside itself), and on a wide page the chart
	// sticks beside the cards, under the "On this page" menu, as they are read
	// down. The tables below grow with their rows rather than scrolling in a box.
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { onDestroy, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { DailySeries } from '@water-management/engine';
	import { api, type Run, type RunMeta, type RunSeriesRef } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import Delta from '$lib/components/compare/Delta.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { holdAnchor } from '$lib/help/anchor';
	import { foldList } from '$lib/components/common/fold';
	import { runHref } from '$lib/components/overview/attention';
	import { headlines, historyDays, historyEnd, pickRuns, ranAgo } from '$lib/components/overview/latestRun';
	import { cachedSeries, detailCache } from '$lib/components/runs/cache';
	import ReportWindowPanel from '$lib/components/runs/ReportWindowPanel.svelte';
	import AssurancePanel from '$lib/components/reliability/AssurancePanel.svelte';
	import { runDamCapacity } from '$lib/components/runs/results';
	import { runYears } from '$lib/components/runs/runList';
	import { dataEndOf } from '$lib/format/age';
	import { fmtDate, fmtNum, fmtPct, fmtQty, localIsoDate } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { withParam } from '$lib/workspace/overlays';
	import { supplyAnchor, supplyHref, UNIT_PARAM } from './links';
	import UnitDetail from './UnitDetail.svelte';
	import UnitResultsTable from './UnitResultsTable.svelte';
	import { BAND_WORDS, cardFacts, daysShort, pickUnit, previousRunOf, supplyNav, supplySummary, supplyTotals, unitCards, weekText, weekWindow } from './supply';
	import SectionNav from '$lib/components/common/SectionNav.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { hasHumanImpacts, loadHumanImpacts, usersTableOnSupply } from '$lib/components/runs/humanImpacts';

	let {
		projectId,
		editor,
		runs,
		readonly
	}: {
		projectId: string;
		editor: ModelEditor;
		/** The page's runs list (null if it couldn't be loaded). */
		runs: RunMeta[] | null;
		readonly: boolean;
	} = $props();

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const runName = (r: Pick<RunMeta, 'label'>) => r.label || 'Untitled run';

	// --- which run: `run=`, else the newest (as the Summary) ---
	const latest = $derived(pickRuns(runs)?.latest ?? null);
	const runParam = $derived(page.url.searchParams.get('run'));
	const named = $derived(runParam ? (runs?.find((r) => r.id === runParam) ?? null) : null);
	/** `run=` names a run that isn't in the list (deleted since the link was made): the newest is shown, and said. */
	const gone = $derived(!!runParam && !!runs && !named);
	const meta = $derived(named ?? latest);
	const previousMeta = $derived(previousRunOf(runs, meta?.id ?? null));

	// --- the run's record (summary, model and stored series), through the Runs cache ---
	let run = $state.raw<Run | null>(null);
	let refs = $state.raw<RunSeriesRef[]>([]);
	let runLoading = $state(false);
	let runError = $state<string | null>(null);
	let runAttempt = $state(0);
	let runKey = '';
	$effect(() => {
		const id = meta?.id ?? null;
		const key = id ? `${id}|${runAttempt}` : '';
		untrack(() => {
			if (key === runKey) return;
			runKey = key;
			runError = null;
			const hit = id ? detailCache.get(id) : undefined;
			run = hit?.run ?? null;
			refs = hit?.series ?? [];
			runLoading = !!id && !hit;
			if (!id || hit) return;
			api.runs
				.get(projectId, id)
				.then((d) => {
					detailCache.set(id, d);
					if (runKey === key) {
						run = d.run;
						refs = d.series;
					}
				})
				.catch((e) => {
					if (runKey === key) runError = msg(e);
				})
				.finally(() => {
					if (runKey === key) runLoading = false;
				});
		});
	});

	// --- the run before it, for the change in irrigation supplied (the Summary's figure); a failure only hides the change ---
	let previous = $state.raw<Run | null>(null);
	let prevKey = '';
	$effect(() => {
		const id = previousMeta?.id ?? null;
		untrack(() => {
			if ((id ?? '') === prevKey) return;
			prevKey = id ?? '';
			previous = id ? (detailCache.get(id)?.run ?? null) : null;
			if (!id || previous) return;
			api.runs
				.get(projectId, id)
				.then((d) => {
					detailCache.set(id, d);
					if (prevKey === id) previous = d.run;
				})
				.catch(() => {});
		});
	});

	// --- each unit's daily deficit, a few at a time: the days short this week, and the chart's shading ---
	let deficits = $state.raw<Map<string, DailySeries>>(new Map());
	let weekLoaded = $state(false);
	let weekError = $state<string | null>(null);
	let weekAttempt = $state(0);
	let weekKey = '';
	$effect(() => {
		const r = run;
		const key = r ? `${r.id}|${weekAttempt}` : '';
		untrack(() => {
			if (key === weekKey) return;
			weekKey = key;
			deficits = new Map();
			weekLoaded = false;
			weekError = null;
			if (!r) return;
			const ids = (r.summary.farms ?? []).map((f) => f.nodeId).filter((id) => refs.some((x) => x.key === 'deficit' && x.nodeId === id));
			const got = new Map<string, DailySeries>();
			let next = 0;
			const worker = async () => {
				while (next < ids.length) {
					const nodeId = ids[next++]!;
					got.set(nodeId, await cachedSeries(r.id, 'deficit', nodeId, () => api.runs.series(projectId, r.id, 'deficit', nodeId)));
				}
			};
			Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker))
				.then(() => {
					if (weekKey !== key) return;
					deficits = got;
					weekLoaded = true;
				})
				.catch((e) => {
					if (weekKey === key) weekError = msg(e);
				});
		});
	});

	// --- the cards, the tiles and the header line ---
	const summary = $derived(run?.summary ?? null);
	// The run's other uses of water (issue #137): land cover, boreholes, demand objects, and other
	// users unless the curtailment table lists them already (one copy on the page).
	const otherUsers = $derived(summary ? usersTableOnSupply(summary) : false);
	const otherUses = $derived(summary ? hasHumanImpacts(summary, otherUsers) : false);
	const modelFarmIds = $derived(new Set(editor.model.nodes.filter((n) => n.kind === 'farm').map((n) => n.id)));
	const names = $derived(new Map(editor.model.nodes.map((n) => [n.id, n.name] as [string, string])));
	const nodeOrder = $derived(new Map(editor.model.nodes.map((n, i) => [n.id, i] as [string, number])));
	const week = $derived(run ? weekWindow(run) : null);
	/** The week's last day and its age: "this week" only while that is current. */
	const weekEnd = $derived(week ? dataEndOf(week.reportEnd, localIsoDate()) : null);
	const weekShort = $derived.by(() => {
		if (!week || !weekLoaded) return null;
		const m = new Map<string, number>();
		for (const [id, s] of deficits) m.set(id, daysShort(s.values, week.from, week.to));
		return m;
	});
	const cards = $derived(summary ? unitCards(summary, modelFarmIds, names, weekShort) : []);
	const totals = $derived(summary ? supplyTotals(summary, cards, weekShort !== null) : null);
	/** Irrigation supplied as the Summary's card has it, with its change from the run before. */
	const supplied = $derived(run ? (headlines(run.summary, historyDays(run), previous?.summary ?? null).find((h) => h.id === 'supply') ?? null) : null);
	const unitParam = $derived(page.url.searchParams.get(UNIT_PARAM));
	const picked = $derived(pickUnit(cards, unitParam));
	const pickedFarm = $derived(picked ? (summary?.farms.find((f) => f.nodeId === picked.nodeId) ?? null) : null);
	const damCapacity = $derived(run ? runDamCapacity(run.model as Parameters<typeof runDamCapacity>[0], editor.model.nodes) : new Map<string, number>());
	const modelUnits = $derived(modelFarmIds.size);
	const runText = $derived(meta ? `run “${runName(meta)}”, ran ${ranAgo(meta.createdAt)}` : null);
	const headerLine = $derived(supplySummary(totals, modelUnits, runText, weekEnd));
	const farmNames = $derived(Object.fromEntries(editor.model.nodes.map((n) => [n.id, n.name])));

	// --- picking a unit: a link (`unit=<id>`, so it can be shared and Back returns); stacked, the chart comes into view ---
	let pageW = $state(0);
	// The same width as the container query that sets the two columns (56rem).
	const side = $derived(pageW >= 896);
	let chartEl: HTMLElement | undefined = $state();
	function choose(e: MouseEvent, id: string) {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		void goto(withParam(page.url, UNIT_PARAM, id), { noScroll: true, keepFocus: true }).then(() => {
			if (!side) chartEl?.scrollIntoView({ block: 'start' });
		});
	}
	function pickRun(id: string) {
		const q = new URLSearchParams(page.url.search);
		q.set('run', id);
		void goto(`?${q}`, { noScroll: true, keepFocus: true });
	}

	// --- the fold: the least supplied few cards (and the picked one), the rest behind "Show all N hydrological units" ---
	/** A card is about a third of the chart's height beside it; stacked, three keep the chart near the first screen. */
	const CAP = 3;
	let open = $state(false);
	const fold = $derived(foldList(cards, (c) => c.nodeId, picked?.nodeId ?? null, open, CAP));
	// A fixed plot height: taller beside the cards, where the panel sits level with the first three.
	const chartH = $derived(side ? 420 : 260);

	// The "On this page" menu sticks at the top; the chart sticks just under it, so it needs the menu's height.
	let pageEl: HTMLDivElement | undefined = $state();
	let navH = $state(0);
	// The menu renders with the cards, after the run loads: rerun then (effects run after the DOM updates).
	const hasNav = $derived(cards.length > 0);
	$effect(() => {
		const nav = hasNav ? pageEl?.querySelector<HTMLElement>('nav.sections') : null;
		if (!nav) return;
		const ro = new ResizeObserver(() => (navH = nav.offsetHeight));
		ro.observe(nav);
		return () => ro.disconnect();
	});

	// A link to a panel here (`#res-curtailment`, the portfolio's "units short this week", or an old
	// Runs & results link sent on): the panels render once the run is in, after the browser's own
	// jump, so scroll there then and hold it while the page settles, with focus on its heading.
	// Once, as the Runs tab does.
	let fragmentShown = false;
	let releaseFragment = () => {};
	let destroyed = false;
	$effect(() => {
		if (!run || fragmentShown) return;
		fragmentShown = true;
		const hash = untrack(() => page.url.hash.slice(1));
		if (!supplyAnchor(hash)) return;
		tick().then(() => {
			const el = destroyed ? null : document.getElementById(hash);
			if (!el) return;
			releaseFragment = holdAnchor(el);
			const heading = el.querySelector<HTMLElement>('h2, h3, h4') ?? el;
			if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
			heading.focus({ preventScroll: true });
		});
	});
	onDestroy(() => {
		destroyed = true;
		releaseFragment();
	});

	// The section header (workspace/SectionHeader) carries the title; the tab gives it the summary line, the run picker and Open in Runs.
	$effect(() => fillHeader({ context: headerContext, actions: headerActions }));
</script>

{#snippet headerContext()}<span data-testid="supply-summary">{headerLine}</span>{/snippet}
{#snippet headerActions()}
	{#if runs && runs.length > 1 && meta}
		<label class="run-pick">
			<span class="visually-hidden">Run shown</span>
			<select value={meta.id} onchange={(e) => pickRun(e.currentTarget.value)}>
				{#each runs as r (r.id)}<option value={r.id}>{runName(r)} · {fmtDate(r.createdAt, true)} · {runYears(r.startDate, r.endDate)}</option>{/each}
			</select>
		</label>
	{/if}
	{#if meta}<a class="btn" href={runHref(meta.id)}>Open in Runs</a>{/if}
{/snippet}

<div class="supply-page" bind:clientWidth={pageW} bind:this={pageEl} style:--nav-h="{navH}px">
	{#if gone}
		<p class="alert alert-info" role="note">That run no longer exists, so this shows the newest run.</p>
	{/if}

	{#if !meta}
		<section class="panel" aria-label="No run yet">
			<div class="empty">
				{#if modelUnits === 0}
					<p>No hydrological units in this catchment’s model yet. Add hydrological units on the Network; after a run, each one's supply against its demand shows here.</p>
					<p class="empty-links"><a class="btn btn-sm" href="?tab=network">Open the Network</a></p>
				{:else if readonly}
					<p>No run yet. Once an editor runs the model, how much of each hydrological unit’s demand was supplied shows here.</p>
				{:else}
					<p>No run yet. Run the model to see how much of each of the {fmtNum(modelUnits)} hydrological units’ demand is supplied.</p>
					<p class="empty-links"><a class="btn btn-sm btn-primary" href="?tab=runs">Run the model (Runs &amp; results)</a></p>
				{/if}
			</div>
		</section>
	{:else}
		<LoadState loading={runLoading && !run} error={run ? null : runError} retry={() => runAttempt++}>
			{#if run && summary && totals}
				{#if cards.length === 0}
					<section class="panel" aria-label="No hydrological units in this run">
						<div class="empty">
							<p>
								{modelUnits
									? 'This run has no hydrological units: they were added after it. Run the model again to see their supply.'
									: 'No hydrological units in this catchment’s model, so there is no irrigation supply to show. Add hydrological units on the Network.'}
							</p>
							<p class="empty-links">
								<a class="btn btn-sm" href="?tab=network">Open the Network</a>
								{#if !readonly && modelUnits}<a class="btn btn-sm" href="?tab=runs">Run the model</a>{/if}
							</p>
						</div>
					</section>
				{:else}
					<!-- In-page menu (common/SectionNav, as on Settings and Runs): the run's tables run
					     several screens under the cards and the unit detail. -->
					<SectionNav groups={supplyNav(otherUses)} label="Hydrological units sections" groupNames />
					<h2 class="visually-hidden">Headline figures</h2>
					<dl class="stats kpis">
						<div class="stat" class:flagged={totals.below > 0} data-kpi="supplied">
							<dt>Irrigation supplied <HelpTip key="summary.fractionSupplied" /></dt>
							<dd class="value">{supplied?.value ?? '–'}<small>of demand</small></dd>
							<dd class="sub">over the whole record</dd>
							<!-- The units below the target, in the Summary card's words (it was a tile of its own until issue #175). -->
							{#each supplied?.sub ?? [] as line, i (i)}<dd class="sub" data-testid="supply-below">{line}</dd>{/each}
							{#if supplied?.delta}<dd class="sub change"><Delta m={supplied.delta} spec={supplied.spec} /> vs previous run</dd>{/if}
						</div>
						<div class="stat linked" class:flagged={(totals.weekShort ?? 0) > 0} data-kpi="week">
							<dt><a href={supplyHref(run.id, { window: 'last7', hash: 'res-curtailment' })}>Short {weekText(weekEnd)}</a></dt>
							<dd class="value" class:none={totals.weekShort === null}>{totals.weekShort === null ? (weekError ? '–' : '…') : fmtNum(totals.weekShort)}<small>of {fmtNum(totals.units)}</small></dd>
							<dd class="sub">{week ? `${week.reportStart} to ${week.reportEnd}` : ''}</dd>
						</div>
						<div class="stat" class:flagged={totals.shortfallM3Day > 0.5} data-kpi="shortfall">
							<dt>Total shortfall</dt>
							<dd class="value">{fmtQty(totals.shortfallMm3a, 3)}<small>Mm³/a</small></dd>
							<dd class="sub">{fmtNum(totals.shortfallM3Day)} m³/day of demand not supplied, on average</dd>
						</div>
					</dl>
					{#if weekError}
						<p class="alert alert-error" role="alert">
							The days short {weekText(weekEnd)} couldn’t be worked out: {weekError}
							<button type="button" class="btn btn-sm" onclick={() => weekAttempt++}>Try again</button>
						</p>
					{/if}

					<div class="first">
						<section class="list" aria-labelledby="unit-cards-h">
							<h2 id="unit-cards-h" class="visually-hidden">Each hydrological unit, least supplied first</h2>
							<ul class="cards" id="unit-cards" aria-label="Hydrological units">
								{#each fold.shown as c (c.nodeId)}
									<li class="card {c.band}" class:picked={picked?.nodeId === c.nodeId} data-unit={c.nodeId} data-band={c.band}>
										<div class="card-head">
											<a class="name" href={withParam(page.url, UNIT_PARAM, c.nodeId)} aria-current={picked?.nodeId === c.nodeId ? 'true' : undefined} onclick={(e) => choose(e, c.nodeId)}>{c.name}</a>
										</div>
										<p class="level">
											{#if c.fraction === null}
												<span class="muted">{BAND_WORDS[c.band]}</span>
											{:else}
												<span class="v">{fmtPct(c.fraction, 0)}</span> supplied{#if BAND_WORDS[c.band]}<span class="band {c.band}">{` · ${BAND_WORDS[c.band]}`}</span>{/if}
											{/if}
										</p>
										{#if c.fraction !== null}
											<span class="bar" aria-hidden="true"><span class="fill {c.band}" style:width="{Math.min(1, Math.max(0, c.fraction)) * 100}%"></span></span>
										{/if}
										<ul class="facts small">
											{#each cardFacts(c, week?.days ?? 7, weekEnd) as line, i (i)}<li>{line}</li>{/each}
										</ul>
										{#if c.inModel}
											<p class="links small">
												<a href="?tab=network&node={encodeURIComponent(c.nodeId)}" aria-label="{c.name} on the Network">On the Network</a>
												<a href={withParam(page.url, 'farm', c.nodeId)} aria-label="{c.name}: planted areas">Planted areas</a>
											</p>
										{/if}
									</li>
								{/each}
							</ul>
							{#if open || fold.hidden}
								<button type="button" class="btn btn-sm more" aria-expanded={open} aria-controls="unit-cards" onclick={() => (open = !open)}>
									{open ? `Show the ${CAP} least supplied` : `Show all ${cards.length} hydrological units`}
								</button>
							{/if}
						</section>

						<div class="chart-col" bind:this={chartEl}>
							{#if picked && pickedFarm}
								{#key `${run.id}|${picked.nodeId}`}
									<UnitDetail
										{projectId}
										runId={run.id}
										{refs}
										farm={pickedFarm}
										name={picked.name}
										capacity={damCapacity.get(picked.nodeId) ?? 0}
										deficit={deficits.get(picked.nodeId) ?? null}
										forecastFrom={summary.forecast?.from ?? null}
										height={chartH}
									/>
								{/key}
							{/if}
						</div>
					</div>

					<h2 class="group-h">Tables for this run</h2>
					<section class="panel" id="res-farms" aria-labelledby="res-farms-h">
						<UnitResultsTable farms={summary.farms} days={historyDays(run)} {nodeOrder} startDate={run.startDate} endDate={historyEnd(run)} title="Hydrological unit results" headingId="res-farms-h" />
					</section>
					<section class="panel" id="res-curtailment">
						<!-- The reporting-window picker (issue #44): the table over another window, worked out from the run's series. -->
						<ReportWindowPanel {projectId} {run} {refs} network={editor.model} {farmNames} />
					</section>
					<section class="panel" id="res-assurance">
						<AssurancePanel assurance={summary.supplyAssurance} engineVersion={run.engineVersion} />
					</section>
					{#if otherUses}
						<!-- Land cover, groundwater, demand objects and other users: once under the run Summary with no menu entry (issue #137). -->
						<section class="panel" id="res-other-uses" aria-label="Other uses of water">
							<Lazy load={loadHumanImpacts}>
								{#snippet children(HumanImpactTables)}
									<HumanImpactTables {summary} users={otherUsers} />
								{/snippet}
							</Lazy>
						</section>
					{/if}
				{/if}
			{/if}
		</LoadState>
	{/if}
</div>

<style>
	.supply-page {
		container: supply-page / inline-size;
	}
	.run-pick select {
		max-width: min(22rem, 60vw);
		min-height: 36px;
	}
	.empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
	.empty p {
		margin: 0 0 0.75rem;
	}
	.empty-links {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.5rem;
	}
	/* Three tiles: one row, then two over one (the shortfall across the row). */
	.kpis {
		grid-template-columns: repeat(3, minmax(0, 1fr));
		margin-bottom: 1rem;
	}
	@container supply-page (max-width: 44rem) {
		.kpis {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.5rem;
		}
		.kpis > :last-child {
			grid-column: 1 / -1;
		}
	}
	.stat {
		padding: 0.7rem 0.9rem;
	}
	.stat dt {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.stat dd.value {
		font-size: 1.5rem;
		line-height: 1.2;
		margin: 0.1rem 0;
	}
	.stat dd.none {
		color: var(--text-muted);
	}
	.stat dd.sub {
		font-size: 0.75rem;
		font-weight: 400;
		color: var(--text-muted);
		margin-top: 0.15rem;
	}
	.stat.flagged {
		border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
		box-shadow: inset 3px 0 0 var(--warning);
	}
	/* The tile with a panel behind it: the term's link is stretched over the tile. */
	.stat.linked {
		position: relative;
	}
	.stat.linked:hover {
		border-color: var(--accent);
	}
	.stat.linked dt a {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
	.stat.linked dt a::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: var(--radius);
	}
	.first {
		display: grid;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.list {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(15rem, 100%), 1fr));
		gap: 0.6rem;
		align-content: start;
	}
	.card {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
		padding: 0.55rem 0.75rem 0.5rem 0.9rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: inset 4px 0 0 var(--accent);
	}
	.card.short {
		box-shadow: inset 4px 0 0 var(--warning);
	}
	.card.low {
		box-shadow: inset 4px 0 0 var(--danger);
	}
	.card.none,
	.card.absent {
		box-shadow: inset 4px 0 0 var(--border-strong);
	}
	.card.picked {
		border-color: var(--accent);
		outline: 1px solid var(--accent);
	}
	.card-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0 0.5rem;
	}
	.name {
		font-weight: 600;
		font-size: 1rem;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--text);
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		text-decoration: underline;
		text-decoration-color: var(--border-strong);
		text-underline-offset: 3px;
	}
	/* The whole card picks the unit: the name's link is stretched over it; the other links sit above it. */
	.name::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: var(--radius);
	}
	.name:focus-visible {
		outline: none;
	}
	.card:has(.name:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.level {
		margin: 0;
		font-size: 0.9rem;
		color: var(--text-2);
	}
	.level .v {
		font-size: 1.35rem;
		font-weight: 600;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}
	.band.short {
		color: var(--warning);
	}
	.band.low {
		color: var(--danger);
	}
	.bar {
		display: block;
		height: 0.45rem;
		border-radius: 999px;
		background: var(--surface-2);
		box-shadow: inset 0 0 0 1px var(--border);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--accent);
	}
	.fill.short {
		background: var(--warning);
	}
	.fill.low {
		background: var(--danger);
	}
	.facts {
		list-style: none;
		margin: 0.15rem 0 0;
		padding: 0;
		color: var(--text-muted);
		display: grid;
		gap: 0.05rem;
	}
	.links {
		position: relative;
		z-index: 1;
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.9rem;
		margin: 0.1rem 0 0;
		pointer-events: none;
	}
	.links a {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
	.small {
		font-size: 0.8rem;
	}
	.chart-col {
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.more {
		align-self: flex-start;
		margin-top: 0.6rem;
	}
	/* The page is the one scroll: the run's tables (the unit results, curtailment and assurance of supply) grow
	   with their rows instead of scrolling inside the global 70vh cap; they still scroll sideways on a narrow screen. */
	.supply-page :global(.table-wrap) {
		max-height: none;
	}
	/* Wide enough for the unit results table's seven columns: its box stops being a scroll container, so its
	   header row sticks under the "On this page" menu as the window scrolls down forty or sixty units. Narrower,
	   it keeps its sideways scroll (and its header scrolls away with the page). */
	@container supply-page (min-width: 64rem) {
		#res-farms :global(.table-wrap) {
			overflow: visible;
		}
		#res-farms :global(table.data thead) {
			top: calc(var(--header-h, 0px) + var(--nav-h, 0px));
		}
	}
	/* A group of panels: a quiet label above them, as on Runs & results. */
	.group-h {
		margin: 1.25rem 0 0.6rem;
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
	@media (forced-colors: active) {
		.bar {
			border: 1px solid CanvasText;
		}
		.fill {
			background: CanvasText;
		}
	}
	/* Wide: the cards in a column beside the chart. */
	@container supply-page (min-width: 56rem) {
		.first {
			grid-template-columns: minmax(17rem, 24rem) minmax(0, 1fr);
			align-items: start;
		}
		.cards {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	/* The chart stays in view beside the cards as an opened list is read down (the window scrolls; nothing inside
	   does), just under the sticky "On this page" menu. Only where the window is tall enough to hold it. */
	@media (min-height: 700px) {
		@container supply-page (min-width: 56rem) {
			.chart-col {
				position: sticky;
				top: calc(var(--header-h, 0px) + var(--nav-h, 0px) + 0.75rem);
			}
		}
	}
	@media (max-width: 640px) {
		.run-pick select {
			min-height: 44px;
		}
	}
</style>
