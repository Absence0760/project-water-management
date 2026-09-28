<script lang="ts">
	// A team's portfolio (WP-2.14, docs/ui.md § Portfolio): every catchment of
	// the team on one screen, from the latest published run (or the latest run
	// when nothing is published), each figure with how old it is. A sortable
	// table on a wide screen, stacked cards on a phone (the same rows, and the
	// sort lives in the URL). Every status is text as well as colour. A
	// dashboard: on a wide screen it fits the window (issue #17), the table
	// taking the height left below the header (measured, not assumed) and
	// scrolling inside with its header row stuck, so the page itself doesn't.
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError, hasRole, hasTeamRole, type Portfolio, type PortfolioProject } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import StatusBar from '$lib/components/portfolio/StatusBar.svelte';
	import StatusPill from '$lib/components/portfolio/StatusPill.svelte';
	import { fmtDate, fmtDay } from '$lib/format/number';
	import {
		ageText,
		curtailmentHref as curtailmentLink,
		damText,
		farmsShortText,
		farmsShortTotalText,
		farmsUnknownText,
		feedsText,
		alertsText,
		nextSort,
		parseSort,
		portfolioTotals,
		restrictionText,
		SORT_LABELS,
		sortPortfolio,
		sourceText,
		statusSummary,
		thresholdsRule,
		thresholdsSource,
		type PortfolioSort,
		type PortfolioSortKey
	} from '$lib/components/portfolio/portfolio';

	const teamId = $derived(page.params.id ?? '');

	let data = $state<Portfolio | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let notFound = $state(false);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load() {
		loading = true;
		loadError = null;
		notFound = false;
		try {
			data = await api.teams.portfolio(teamId);
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) {
				// A farmer has no team: their farms are the farmer view (WP-2.6).
				const mine = await api.projects.list().catch(() => []);
				if (mine.length && mine.every((p) => p.role === 'farmer')) {
					await goto(`${base}/farm`, { replaceState: true });
					return;
				}
				notFound = true;
			} else loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void teamId;
		untrack(load);
	});

	const sort = $derived(parseSort(page.url.searchParams.get('sort'), page.url.searchParams.get('dir')));
	const rows = $derived(data ? sortPortfolio(data.projects, sort) : []);
	const totals = $derived(portfolioTotals(data?.projects ?? []));

	// Fit the table to the window on a wide screen (the Network map's technique):
	// the top of the table's box and what sits below it on the page, measured
	// whenever the page's size changes, so the box takes exactly the height left.
	let fillEl: HTMLDivElement | undefined = $state();
	let fillTop = $state(0);
	let fillBelow = $state(0);
	$effect(() => {
		if (!fillEl) return;
		const measure = () => {
			if (!fillEl) return;
			const r = fillEl.getBoundingClientRect();
			fillTop = r.top + window.scrollY;
			fillBelow = Math.max(0, document.documentElement.scrollHeight - (r.bottom + window.scrollY));
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		return () => ro.disconnect();
	});

	function setSort(next: PortfolioSort) {
		const u = new URL(page.url);
		if (next.key === 'status' && next.dir === 'asc') {
			u.searchParams.delete('sort');
			u.searchParams.delete('dir');
		} else {
			u.searchParams.set('sort', next.key);
			if (next.dir === 'desc') u.searchParams.set('dir', 'desc');
			else u.searchParams.delete('dir');
		}
		goto(u.pathname + u.search, { replaceState: true, keepFocus: true, noScroll: true });
	}
	const ariaSort = (key: PortfolioSortKey) => (sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined);
	const indicator = (key: PortfolioSortKey) => (sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '');

	const projectHref = (p: PortfolioProject) => `${base}/projects/${p.id}`;
	// The farms' supply and curtailment on the Runs tab, for the run the figures come from.
	const curtailmentHref = (p: PortfolioProject) => curtailmentLink(p, base);
	// Viewers can't run or publish; "publish a run" is advice for the project's editors.
	const canPublish = (p: PortfolioProject) => hasRole(p.role, 'editor');
</script>

<svelte:head><title>{data ? `${data.team.name} · ` : ''}Portfolio · Water Management</title></svelte:head>

{#snippet status(p: PortfolioProject)}
	<StatusPill {p} />
{/snippet}

{#snippet age(p: PortfolioProject)}
	{@const a = ageText(p)}
	{#if a}
		<span class="sub">Figures {a}</span>
		{#if p.stale}<span class="badge badge-warn flag">Stale: over 7 days old</span>{/if}
	{/if}
{/snippet}

{#snippet farms(p: PortfolioProject)}
	{@const t = farmsShortText(p)}
	{#if t}
		{#if p.farmsShort7 && p.sourceRunId}
			<a href={curtailmentHref(p)}>{t}</a>
		{:else}
			{t}
		{/if}
		{#if p.farmsShort30 != null && p.farmCount}<span class="sub">{p.farmsShort30} in the last 30 days</span>{/if}
	{:else}
		<span class="muted">{farmsUnknownText(p)}</span>
	{/if}
{/snippet}

{#snippet dataCell(p: PortfolioProject)}
	{#if p.dataUntil}Rain to {fmtDay(p.dataUntil)}{:else}<span class="muted">No rain yet</span>{/if}
	{#if p.behindData}<span class="badge badge-warn flag">Newer data not in the figures</span>{/if}
	<span class="sub">{feedsText(p)}</span>
{/snippet}

{#snippet source(p: PortfolioProject)}
	<span class="sub">
		{sourceText(p)}{#if p.publishedAt}, {fmtDay(p.publishedAt.slice(0, 10))}{/if}
		{#if p.source === null && canPublish(p)}· run the model to see figures{:else if p.source === 'run' && canPublish(p)}· publish a run for hydrological unit figures{/if}
	</span>
{/snippet}

<main class="page">
	<LoadState {loading} error={loadError} retry={load}>
		{#if notFound || !data}
			<div class="alert alert-error" role="alert">
				This team doesn't exist or you're not a member. <a href="{base}/teams">Back to teams</a>
			</div>
		{:else}
			<nav class="crumbs" aria-label="Breadcrumb">
				<a href="{base}/teams">Teams</a> <span aria-hidden="true">/</span>
				<a href="{base}/teams/{data.team.id}">{data.team.name}</a> <span aria-hidden="true">/</span>
			</nav>
			<header class="page-head">
				<div class="title">
					<h1>{data.team.name}: portfolio</h1>
					<p class="muted intro">
						Every catchment of the team, from its published run, or its latest run when none is published. EWR status
						is the outlet over the 30 days to the figures' last day: {thresholdsRule(data.thresholds)}.
					</p>
					<p class="muted intro thresholds">
						{thresholdsSource(data.thresholds)}
						{#if hasTeamRole(data.team.role, 'admin')}<a href="{base}/teams/{data.team.id}?settings=1">Change them on the team page</a>.{:else}A team admin can change them on the team page.{/if}
					</p>
				</div>
				<div class="head-actions">
					<a class="btn" href="{base}/teams/{data.team.id}">Team page</a>
					{#if hasTeamRole(data.team.role, 'member')}
						<a class="btn btn-primary" href="{base}/?owner=team:{data.team.id}&new=1">New project in this team</a>
					{/if}
				</div>
			</header>

			{#if !rows.length}
				<div class="state empty">
					<p>No catchments in this team yet.</p>
				</div>
			{:else}
				<dl class="kpis">
					<div class="kpi kpi-ewr">
						<dt>EWR, last 30 days</dt>
						<dd>
							<p class="summary" role="status">
								{rows.length} catchment{rows.length === 1 ? '' : 's'}: {statusSummary(totals.counts)}
							</p>
							<StatusBar counts={totals.counts} />
						</dd>
					</div>
					<div class="kpi">
						<dt>Hydrological units short this week</dt>
						<dd class="num-big">{farmsShortTotalText(totals) ?? 'Unknown'}</dd>
					</div>
					<div class="kpi">
						<dt>Alerts firing</dt>
						<dd class="num-big">{totals.alertsFiring}</dd>
					</div>
					<div class="kpi">
						<dt>Stale figures</dt>
						<dd class="num-big">{totals.stale} <small>of {rows.length}</small></dd>
					</div>
					<div class="kpi">
						<dt>Last run</dt>
						<dd class="num-big">{totals.lastRunAt ? fmtDay(fmtDate(totals.lastRunAt)) : 'None yet'}</dd>
					</div>
				</dl>

				<div class="sort-phone field">
					<label for="pf-sort">Sort by</label>
					<select
						id="pf-sort"
						value={sort.key}
						onchange={(e) => setSort({ key: e.currentTarget.value as PortfolioSortKey, dir: 'asc' })}
					>
						{#each Object.entries(SORT_LABELS) as [k, label] (k)}<option value={k}>{label}</option>{/each}
					</select>
				</div>

				<!-- Wide screens: one sortable table, filling the height left in the window. -->
				<div class="fill wide-only" bind:this={fillEl} style:--fill-top="{fillTop}px" style:--fill-below="{fillBelow}px">
					<div class="table-wrap">
						<table class="data portfolio">
							<caption class="visually-hidden">Catchments of {data.team.name}</caption>
							<thead>
								<tr>
									<th scope="col" aria-sort={ariaSort('name')}>
										<button type="button" class="sort" onclick={() => setSort(nextSort(sort, 'name'))}>Catchment <span aria-hidden="true">{indicator('name')}</span></button>
									</th>
									<th scope="col" aria-sort={ariaSort('status')}>
										<button type="button" class="sort" onclick={() => setSort(nextSort(sort, 'status'))}>EWR, last 30 days <span aria-hidden="true">{indicator('status')}</span></button>
									</th>
									<th scope="col" aria-sort={ariaSort('farms')}>
										<button type="button" class="sort" onclick={() => setSort(nextSort(sort, 'farms'))}>Hydrological units short <span aria-hidden="true">{indicator('farms')}</span></button>
									</th>
									<th scope="col" aria-sort={ariaSort('dam')}>
										<button type="button" class="sort" onclick={() => setSort(nextSort(sort, 'dam'))}>Lowest dam <span aria-hidden="true">{indicator('dam')}</span></button>
									</th>
									<th scope="col">Restriction</th>
									<th scope="col" aria-sort={ariaSort('age')}>
										<button type="button" class="sort" onclick={() => setSort(nextSort(sort, 'age'))}>Data <span aria-hidden="true">{indicator('age')}</span></button>
									</th>
									<th scope="col">Alerts</th>
								</tr>
							</thead>
							<tbody>
								{#each rows as p (p.id)}
									<tr>
										<th scope="row">
											<a class="name" href={projectHref(p)}>{p.name}</a>
											{@render source(p)}
										</th>
										<td>{@render status(p)}{@render age(p)}</td>
										<td>{@render farms(p)}</td>
										<td>{#if p.damsKnown}{damText(p)}{:else}<span class="muted">{damText(p)}</span>{/if}</td>
										<td>{#if p.restriction}{restrictionText(p)}{:else}<span class="muted">{restrictionText(p)}</span>{/if}</td>
										<td>{@render dataCell(p)}</td>
										<td>{#if p.alertsFiring > 0}<span class="badge badge-warn">{alertsText(p)}</span>{:else}<span class="muted">{alertsText(p)}</span>{/if}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>

				<!-- Phones: the same rows as cards. -->
				<ul class="cards phone-only" aria-label="Catchments of {data.team.name}">
					{#each rows as p (p.id)}
						<li class="card">
							<h2 class="card-h"><a href={projectHref(p)}>{p.name}</a></h2>
							{@render source(p)}
							<dl>
								<div><dt>EWR, last 30 days</dt><dd>{@render status(p)}{@render age(p)}</dd></div>
								<div><dt>Hydrological units short</dt><dd>{@render farms(p)}</dd></div>
								<div><dt>Lowest dam</dt><dd>{damText(p)}</dd></div>
								<div><dt>Restriction</dt><dd>{restrictionText(p)}</dd></div>
								<div><dt>Data</dt><dd>{@render dataCell(p)}</dd></div>
								<div><dt>Alerts</dt><dd>{alertsText(p)}</dd></div>
							</dl>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</LoadState>
</main>

<style>
	.crumbs {
		color: var(--text-muted);
		margin-bottom: 0.25rem;
	}
	.page-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem 1.5rem;
		flex-wrap: wrap;
		margin-bottom: 0.9rem;
	}
	.title {
		min-width: 0;
		flex: 1 1 32rem;
	}
	h1 {
		margin: 0;
	}
	.head-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.intro {
		margin: 0.35rem 0 0;
		max-width: 90ch;
		font-size: 0.9rem;
	}
	.intro.thresholds {
		margin-top: 0.2rem;
	}
	/* The numbers across the top: the statuses, farms short, alerts, stale figures, the last run. */
	.kpis {
		margin: 0 0 0.9rem;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
		gap: 0.6rem;
	}
	.kpi {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.55rem 0.8rem;
		min-width: 0;
	}
	.kpi-ewr {
		grid-column: span 2;
	}
	.kpi dt {
		font-size: 0.78rem;
		color: var(--text-muted);
		margin-bottom: 0.2rem;
	}
	.kpi dd {
		margin: 0;
	}
	.num-big {
		font-size: 1.15rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.num-big small {
		font-size: 0.8rem;
		font-weight: 400;
		color: var(--text-muted);
	}
	.summary {
		margin: 0 0 0.35rem;
		font-weight: 600;
	}
	/* The summary line already says the counts in words; the bar's own words would repeat them. */
	.kpi-ewr :global(.status-bar .words) {
		display: none;
	}
	.sub {
		display: block;
		margin-top: 0.2rem;
		font-size: 0.8rem;
		font-weight: 400;
		color: var(--text-muted);
	}
	.flag {
		display: inline-block;
		margin-top: 0.25rem;
		text-transform: none;
	}
	.name {
		font-weight: 600;
	}
	.sort {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: inherit;
		cursor: pointer;
		text-align: inherit;
		min-height: 24px;
	}
	.sort:hover {
		color: var(--accent);
	}
	.portfolio td,
	.portfolio th {
		vertical-align: top;
	}
	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		gap: 0.75rem;
	}
	.card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem 0.9rem;
	}
	.card-h {
		margin: 0;
		font-size: 1rem;
	}
	.card dl {
		margin: 0.6rem 0 0;
		display: grid;
		gap: 0.5rem;
	}
	.card dt {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-2);
	}
	.card dd {
		margin: 0.1rem 0 0;
	}
	/* Wide: the table's box takes the height left in the window, above the
	   page's 1rem gutter (app.css), so nothing but the table scrolls.
	   (The cards stay out: a plain `.cards { display: grid }` used to beat
	   `.phone-only { display: none }` and showed them under the table.) */
	@media (min-width: 761px) {
		.sort-phone,
		.phone-only {
			display: none;
		}
		.fill {
			height: max(320px, calc(100vh - var(--fill-top, 0px) - var(--fill-below, 0px)));
		}
		.fill .table-wrap {
			height: 100%;
			max-height: none;
		}
	}
	@media (max-width: 760px) {
		.wide-only {
			display: none;
		}
		.cards {
			display: grid;
		}
		.sort-phone {
			display: block;
			max-width: 20rem;
		}
		.kpi-ewr {
			grid-column: 1 / -1;
		}
		.head-actions {
			width: 100%;
		}
		.head-actions > * {
			flex: 1 1 auto;
			justify-content: center;
		}
	}
</style>
