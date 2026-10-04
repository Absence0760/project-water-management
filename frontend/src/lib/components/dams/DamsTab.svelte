<script lang="ts">
	// Dams (issue #17, option A · Outcomes): how full each dam was at the end
	// of the latest run. A card per dam (% full, band, change over the run's
	// last 30 days, a storage sparkline of its last year captioned with what
	// it shows, its first and last day and its low, charts/Sparkline.svelte,
	// links to its node on
	// the Network and, for a farm's dam, the farm drawer) beside the picked
	// dam's storage chart (`dam=<nodeId>`, 30 days / 1 year / All, % full or
	// m³). Each card also carries what the Dam levels table (moved here from
	// the Summary, merged into the cards 2026-09-29, issue #175) listed: the
	// lowest level in the run's last year (the sparkline's mark) and the days
	// at the minimum operating level. The page flows in the window's one scroll: every dam's card shows, emptiest
	// first (no card list scrolls inside itself, and none folds away), and on a
	// wide page the chart sticks beside the cards as they are read down.
	// Before a run the cards show each dam's capacity.
	// The levels come from overview/damLevels.ts, the loader the Summary's
	// Dams today card and the Network's colour by dam level share; the series
	// come through the Runs tab's cache.
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { beforeForecast, type DailySeries } from '@water-management/engine';
	import { api, type Run, type RunMeta, type RunSeriesRef } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import Sparkline from '$lib/components/charts/Sparkline.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { runHref } from '$lib/components/overview/attention';
	import { forecastBand } from '$lib/components/forecast/forecast';
	import { AGO_DAYS, capacityOver, damsInRun, levelBand, loadDamLevels, LOW_PCT, type DamLevel } from '$lib/components/overview/damLevels';
	import { pickRuns, ranAgo } from '$lib/components/overview/latestRun';
	import { FLOW_OPEN_DAYS, FLOW_WINDOWS } from '$lib/components/overview/summaryChart';
	import { cachedSeries, detailCache } from '$lib/components/runs/cache';
	import { fmtDay, fmtNum } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { withParam } from '$lib/workspace/overlays';
	import { mapNodeHref } from '$lib/workspace/mapLinks';
	import { MappedNodes } from '$lib/workspace/mappedNodes.svelte';
	import { changeWords, damCards, damsSummary, fmtVolume, pickDam, SPARK_CAPTION, storageChartSeries, storageSpark, type StorageUnit } from './dams';
	import DamProposalsBox from './DamProposalsBox.svelte';

	let {
		projectId,
		editor,
		runs,
		readonly,
		onModelChanged = () => {}
	}: {
		projectId: string;
		editor: ModelEditor;
		/** The page's runs list (null if it couldn't be loaded). */
		runs: RunMeta[] | null;
		readonly: boolean;
		/** Reload the saved model after a proposal is used (it is saved on the server, issue #326 B-dams). */
		onModelChanged?: () => Promise<void> | void;
	} = $props();

	// Which dams have a map feature, for their "Show on map" links (issue #326 A2): fetched after the
	// page has drawn, so the map's list never delays it (workspace/mapLinks.ts).
	const mapped = new MappedNodes(() => projectId, api.map.linkedNodes);
	// After the first paint, and again if the workspace switches project under this tab.
	$effect(() => {
		void projectId;
		void untrack(() => mapped.load());
	});

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const pick = $derived(pickRuns(runs));
	const latest = $derived(pick?.latest ?? null);

	// --- the latest run's record (its model and stored series), through the Runs cache ---
	let run = $state.raw<Run | null>(null);
	let refs = $state.raw<RunSeriesRef[]>([]);
	let runLoading = $state(false);
	let runError = $state<string | null>(null);
	let runAttempt = $state(0);
	let runKey = '';
	$effect(() => {
		const id = latest?.id ?? null;
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

	// --- each dam's daily storage in that run, a few at a time; kept for the sparklines and the chart ---
	let levels = $state.raw<DamLevel[]>([]);
	let storage = $state.raw<Map<string, DailySeries>>(new Map());
	let damsTotal = $state(0);
	let damsDone = $state(0);
	let damsLoading = $state(false);
	let damsError = $state<string | null>(null);
	let damsAttempt = $state(0);
	let damsKey = '';
	$effect(() => {
		const r = run;
		const key = r ? `${r.id}|${damsAttempt}` : '';
		untrack(() => {
			if (key === damsKey) return;
			damsKey = key;
			levels = [];
			storage = new Map();
			damsDone = 0;
			damsError = null;
			if (!r) {
				damsTotal = 0;
				damsLoading = false;
				return;
			}
			const id = r.id;
			const list = damsInRun(r.model?.nodes as { id: string }[] | undefined, editor.model.nodes, refs);
			damsTotal = list.length;
			damsLoading = list.length > 0;
			if (!list.length) return;
			const current = () => damsKey === key;
			const got = new Map<string, DailySeries>();
			loadDamLevels(
				list,
				async (nodeId) => {
					const s = await cachedSeries(id, 'dam_storage', nodeId, () => api.runs.series(projectId, id, 'dam_storage', nodeId));
					got.set(nodeId, s);
					return s;
				},
				4,
				(n) => {
					if (current()) damsDone = n;
				},
				// A forecast run's cards are its record's (issue #51); the chart still shows the forecast days, in their band.
				r.summary.forecast?.from ?? null
			)
				.then((l) => {
					if (!current()) return;
					levels = l;
					storage = got;
				})
				.catch((e) => {
					if (current()) damsError = msg(e);
				})
				.finally(() => {
					if (current()) damsLoading = false;
				});
		});
	});

	// --- the cards, the picked dam and the header line ---
	const cards = $derived(damCards(editor.model.nodes, levels));
	const damParam = $derived(page.url.searchParams.get('dam'));
	const picked = $derived(pickDam(cards, damParam));
	// A failed run list is not "no run yet": the header says which it is, as the alert below does.
	const runText = $derived(
		runs === null ? 'run list couldn’t be loaded' : latest ? `latest run “${latest.label || 'Untitled run'}”, ran ${ranAgo(latest.createdAt)}` : null
	);
	const summary = $derived(damsSummary(cards.length, cards.reduce((s, c) => s + c.capacityM3, 0), runText));
	// The card's sparkline is its record's, as its figures are (issue #51): a forecast run's stops before the forecast.
	const record = (s: DailySeries): DailySeries => ({ startDate: s.startDate, values: Array.from(beforeForecast(s.values, s.startDate, run?.summary.forecast?.from)) });
	const sparks = $derived(new Map(cards.map((c) => [c.nodeId, storage.has(c.nodeId) ? storageSpark(record(storage.get(c.nodeId)!), c.capacityM3, 365, 60, c.level ? capacityOver(c.level, storage.get(c.nodeId)!.startDate) : undefined) : null])));
	const pct = (v: number) => `${fmtNum(v, 0)}%`;
	const BAND_WORDS = { 'at-min': 'at its minimum level', low: `below ${LOW_PCT}%`, ok: '' } as const;
	/** Why a card has no level: the run list didn't load, before a run, while loading, or the run has no storage for it. */
	function noLevel(): string {
		if (runs === null) return 'Run list couldn’t be loaded';
		if (!latest) return 'No run yet';
		if (damsLoading && damsTotal) return `Loading dam levels (${damsDone} of ${damsTotal})…`;
		if (runLoading || damsLoading) return 'Loading…';
		if (runError || damsError) return 'Level couldn’t be loaded';
		return 'Not in the latest run';
	}

	// --- picking a dam: a link (`dam=<id>`, so it can be shared and Back returns); stacked, the chart comes into view ---
	let pageW = $state(0);
	// The container query that sets the two columns is 56rem: in px at the root's font size (14 px, app.css), so one number drives both.
	const SIDE_REM = 56;
	const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
	const side = $derived(pageW >= SIDE_REM * remPx);
	let chartEl: HTMLElement | undefined = $state();
	function choose(e: MouseEvent, id: string) {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		void goto(withParam(page.url, 'dam', id), { noScroll: true, keepFocus: true }).then(() => {
			if (!side) chartEl?.scrollIntoView({ block: 'start' });
		});
	}

	// --- the chart of the picked dam ---
	let unit = $state<StorageUnit>('pct');
	const pickedSeries = $derived(picked ? (storage.get(picked.nodeId) ?? null) : null);
	const chartSeries = $derived(picked && pickedSeries ? storageChartSeries(pickedSeries, picked.capacityM3, picked.minPct, unit, picked.level ? capacityOver(picked.level, pickedSeries.startDate) : undefined) : []);
	// A fixed plot height: taller beside the cards, where it sits level with the first few.
	const chartH = $derived(side ? 420 : 260);
	// --- the proposals box (issue #326 B-dams): every hydrological unit, the dams first in the cards' order ---
	const proposalUnits = $derived.by(() => {
		const farms = editor.model.nodes.filter((n) => n.kind === 'farm');
		const order = new Map(cards.map((c, i) => [c.nodeId, i]));
		return [...farms].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity)).map((n) => ({ id: n.id, name: n.name }));
	});
	const proposalStart = $derived(damParam && proposalUnits.some((u) => u.id === damParam) ? damParam : (cards[0]?.nodeId ?? null));
	const PROPOSALS_ID = 'dam-proposals';
	// A card's Proposals: pick the dam (the box follows `dam=`), then bring the box into view.
	function toProposals(e: MouseEvent, id: string) {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		void goto(withParam(page.url, 'dam', id), { noScroll: true, keepFocus: true }).then(() => {
			const box = document.getElementById(PROPOSALS_ID);
			box?.scrollIntoView({ block: 'start' });
			box?.querySelector<HTMLElement>('select')?.focus({ preventScroll: true });
		});
	}
	// The section header (workspace/SectionHeader) carries the title; the tab gives it the summary line and Open in Runs.
	$effect(() => fillHeader({ context: headerContext, actions: headerActions }));
</script>

{#snippet headerContext()}<span data-testid="dams-summary">{summary}</span>{/snippet}
{#snippet headerActions()}
	{#if cards.length}<a class="btn" href={withParam(page.url, 'grid', 'nodes')}>Hydrological unit table</a>{/if}
	{#if latest}<a class="btn" href={runHref(latest.id)}>Open in Runs</a>{/if}
{/snippet}

<div class="dams-page" bind:clientWidth={pageW}>

	{#if cards.length === 0}
		<section class="panel" aria-label="No dams yet">
			<div class="empty">
				<p>
					No dams in this catchment's model. A dam belongs to a hydrological unit: give a hydrological unit a dam capacity and its
					storage shows here after the next run.
				</p>
				<p class="empty-links">
					<a class="btn btn-sm" href="?tab=network">Open the Network</a>
					<a class="btn btn-sm" href={withParam(page.url, 'grid', 'nodes')}>{readonly ? 'Hydrological unit table' : 'Hydrological unit table: add a hydrological unit or set a dam capacity'}</a>
				</p>
			</div>
		</section>
	{:else}
		{#if runs === null}
			<!-- The page loads the run list before any tab draws, so null is a failure, never "still loading" (as River & reserve). -->
			<p class="alert alert-error" role="alert" data-testid="dams-runs-error">
				The run list couldn’t be loaded, so the cards show each dam's capacity only. Reload the page to try again.
			</p>
		{:else if !latest}
			<p class="alert alert-info" role="note">
				{#if readonly}
					No run yet, so the cards show each dam's capacity only. Once an editor runs the model, how full each dam was shows
					here.
				{:else}
					No run yet, so the cards show each dam's capacity only. <a href="?tab=runs">Run the model</a> (Runs &amp; results)
					to see how full each dam gets.
				{/if}
			</p>
		{/if}

		<div class="first" class:with-chart={!!latest}>
			<section class="list" aria-labelledby="dam-cards-h">
				<h2 id="dam-cards-h" class="visually-hidden">Each dam</h2>
				<ul class="cards" aria-label="Dams">
					{#each cards as c (c.nodeId)}
						{@const band = c.level ? levelBand(c.level) : null}
						{@const chg = c.level ? changeWords(c.level, AGO_DAYS) : null}
						{@const spark = sparks.get(c.nodeId)}
						<li class="card {band ?? 'none'}" class:picked={latest && picked?.nodeId === c.nodeId} data-dam={c.nodeId}>
							<div class="card-head">
								{#if latest}
									<a
										class="name"
										href={withParam(page.url, 'dam', c.nodeId)}
										aria-current={picked?.nodeId === c.nodeId ? 'true' : undefined}
										onclick={(e) => choose(e, c.nodeId)}>{c.name}</a
									>
								{:else}
									<span class="name">{c.name}</span>
								{/if}
								<span class="cap muted">{fmtVolume(c.capacityM3)}</span>
							</div>
							{#if c.level && band}
								<p class="level">
									<span class="v">{pct(c.level.endPct)}</span> full{#if BAND_WORDS[band]}<span class="band {band}">{` · ${BAND_WORDS[band]}`}</span>{/if}
								</p>
								<p class="chg {chg?.dir ?? ''} small">
									{#if chg}<span aria-hidden="true">{chg.dir === 'up' ? '▲' : chg.dir === 'down' ? '▼' : '■'}</span> {chg.text}{:else}under {AGO_DAYS} days in the run{/if}
								</p>
								{#if c.level.minPct > 0}
									<p class="atmin small" data-testid="dam-days-at-min">
										{fmtNum(c.level.daysAtMin)} day{c.level.daysAtMin === 1 ? '' : 's'} at its minimum ({pct(c.level.minPct)}) in its last year
									</p>
								{/if}
								{#if spark}
									<!-- Above the card's stretched link so pointing at the line reads it out; a click still picks the dam (the name is the keyboard's way). -->
									<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
									<div class="spark-box" onclick={(e) => latest && choose(e, c.nodeId)}>
										<Sparkline
											values={spark.values}
											x={spark.x}
											labels={spark.labels}
											ends={spark.ends}
											caption={SPARK_CAPTION}
											name={c.name}
											format={pct}
											hi={100}
											mark="min"
											markLabel
											px={30}
											color="var(--series-1)"
											stroke={2}
										/>
									</div>
								{/if}
							{:else}
								<p class="muted small nolevel">{noLevel()}</p>
							{/if}
							<p class="links small">
								<!-- The dam's inputs (capacity, minimum level, area, curve, release rule) are its node sheet's (ui.md § Network). -->
								<a href="?tab=network&edit={encodeURIComponent(c.nodeId)}" aria-label="{readonly ? 'Dam details' : 'Edit dam'}: {c.name}" data-testid="dam-edit-link">{readonly ? 'Dam details' : 'Edit dam'}</a>
								<a href="?tab=network&node={encodeURIComponent(c.nodeId)}" aria-label="{c.name} on the Network">On the Network</a>
								{#if mapped.has(c.nodeId)}<a href={mapNodeHref(c.nodeId)} aria-label="Show on map ({c.name})" data-testid="dam-map-link">Show on map</a>{/if}
								{#if c.farm}<a href={withParam(page.url, 'farm', c.nodeId)} aria-label="{c.name}: planted areas">Planted areas</a>{/if}
								{#if c.farm}<a href="{withParam(page.url, 'dam', c.nodeId)}#{PROPOSALS_ID}" aria-label="{c.name}: proposed from the register and the map" onclick={(e) => toProposals(e, c.nodeId)}>Proposals</a>{/if}
							</p>
						</li>
					{/each}
				</ul>
			</section>

			{#if latest}
				<section class="panel chart-panel" bind:this={chartEl} aria-labelledby="dam-chart-h" aria-busy={runLoading || damsLoading}>
					<div class="panel-head">
						<h2 id="dam-chart-h">Storage{#if picked}: {picked.name}{/if}</h2>
						<span class="seg" role="group" aria-label="Show storage as">
							<button type="button" class="btn btn-sm" aria-pressed={unit === 'pct'} onclick={() => (unit = 'pct')}>% full</button>
							<button type="button" class="btn btn-sm" aria-pressed={unit === 'm3'} onclick={() => (unit = 'm3')}>m³</button>
						</span>
					</div>
					<LoadState loading={runLoading || damsLoading} error={runError ?? damsError} retry={() => (runError ? runAttempt++ : damsAttempt++)}>
						{#if !damsTotal}
							<p class="muted">The latest run stored no dam storage to show.</p>
						{:else if picked?.level && pickedSeries}
							{@const l = picked.level}
							<p class="facts small" data-testid="dam-facts">
								<strong>{pct(l.endPct)} full</strong> on {fmtDay(l.endDate)} ({fmtNum((l.endPct / 100) * (l.endCapacityM3 ?? l.capacityM3))} of {fmtNum(l.endCapacityM3 ?? l.capacityM3)} m³) ·
								lowest in its last year {pct(l.lowPct)} on {fmtDay(l.lowDate)}{#if l.minPct > 0}{` · ${fmtNum(l.daysAtMin)} day${l.daysAtMin === 1 ? '' : 's'} at its minimum level (${pct(l.minPct)})`}{/if}
							</p>
							<LineChart
								title="{picked.name} storage"
								unit={unit === 'pct' ? '% of capacity' : 'm³'}
								height={chartH}
								series={chartSeries}
								recentDays={FLOW_OPEN_DAYS}
								windows={FLOW_WINDOWS}
								band={forecastBand(run?.summary.forecast?.from)}
								pannable={false}
								caption="Dashed: the dam's capacity{picked.minPct > 0 ? ' and its minimum operating level' : ''}."
							/>
						{:else}
							<p class="muted">{picked?.name ?? 'This dam'} isn't in the latest run: add it before the next run, or pick another dam.</p>
						{/if}
					</LoadState>
				</section>
			{/if}
		</div>

	{/if}

	{#if proposalUnits.length}
		<DamProposalsBox id={PROPOSALS_ID} {projectId} units={proposalUnits} initial={proposalStart} follow={damParam} {readonly} dirty={editor.dirty} {onModelChanged} />
	{/if}
</div>

<style>
	.dams-page {
		container: dams-page / inline-size;
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
	.first {
		display: grid;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
		min-height: 0;
	}
	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		/* Two to a row on a phone, so the chart isn't eight cards down. */
		grid-template-columns: repeat(auto-fill, minmax(min(10rem, 100%), 1fr));
		gap: 0.6rem;
		align-content: start;
	}
	.card {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		padding: 0.55rem 0.75rem 0.45rem 0.9rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: inset 4px 0 0 var(--accent);
	}
	.card.low {
		box-shadow: inset 4px 0 0 var(--warning);
	}
	.card.at-min {
		box-shadow: inset 4px 0 0 var(--danger);
	}
	.card.none {
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
		flex-wrap: wrap;
		gap: 0 0.5rem;
	}
	.name {
		font-weight: 600;
		font-size: 1rem;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--text);
	}
	a.name {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		text-decoration: underline;
		text-decoration-color: var(--border-strong);
		text-underline-offset: 3px;
	}
	/* The whole card picks the dam: the name's link is stretched over it; the other links sit above it. */
	a.name::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: var(--radius);
	}
	a.name:focus-visible {
		outline: none;
	}
	.card:has(a.name:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.cap {
		flex: none;
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
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
	.band.low,
	.chg.down {
		color: var(--warning);
	}
	.band.at-min {
		color: var(--danger);
	}
	.chg.up {
		color: var(--success);
	}
	.chg,
	.atmin,
	.nolevel {
		margin: 0;
	}
	.atmin {
		color: var(--text-2);
	}
	.chg.flat {
		color: var(--text-muted);
	}
	.spark-box {
		position: relative;
		z-index: 1;
		margin-top: 0.3rem;
		cursor: pointer;
	}
	.links {
		position: relative;
		z-index: 1;
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.9rem;
		margin: 0.15rem 0 0;
		pointer-events: none;
	}
	.links a {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
	.small {
		font-size: 0.85rem;
	}
	.chart-panel {
		margin: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.panel-head h2 {
		font-size: 1.05rem;
	}
	.seg {
		display: inline-flex;
		gap: 0.25rem;
	}
	.facts {
		margin: 0 0 0.5rem;
		color: var(--text-2);
	}
	/* Wide: the cards in a column beside the chart. */
	@container dams-page (min-width: 56rem) {
		.first.with-chart {
			grid-template-columns: minmax(16rem, 22rem) minmax(0, 1fr);
			align-items: start;
		}
		.with-chart .cards {
			grid-template-columns: minmax(0, 1fr);
		}
		/* The chart stays in view beside the cards as they are read down (the window scrolls; nothing inside does). */
		.with-chart .chart-panel {
			position: sticky;
			top: calc(var(--header-h, 0px) + 0.75rem);
		}
	}
</style>
