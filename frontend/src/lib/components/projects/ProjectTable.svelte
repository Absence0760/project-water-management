<script lang="ts">
	// One group of projects as a compact table (issue #17, docs/ui.md § Project
	// list): each row says how the catchment is doing, from the portfolio's
	// figures (GET /projects/outcomes): the EWR status, units short this week,
	// the lowest dam, data freshness and the last run. A click anywhere on a
	// row opens the project (the name link stretches over the row, .name::after).
	// Add data is the one row button; Copy and Delete sit in a ⋯ menu. The
	// table answers to its own width: Lowest dam and Last run fold into the
	// line under the name at 1100 px, every outcome column at 730 px.
	import { base } from '$app/paths';
	import { hasRole, type PortfolioProject, type ProjectSummary } from '$lib/api';
	import StatusPill from '$lib/components/portfolio/StatusPill.svelte';
	import { curtailmentHref, damText, farmsShortText, feedsText } from '$lib/components/portfolio/portfolio';
	import { fmtDate, fmtDay } from '$lib/format/number';
	import { dataFreshness, daysSince } from './freshness';
	import type { SortKey } from './grouping';
	import type { Outcomes } from './outcomes';

	let {
		projects,
		caption,
		showTeam = true,
		outcomes,
		outcomesFailed = false,
		sort,
		onsort,
		oncopy,
		ondelete
	}: {
		projects: ProjectSummary[];
		/** Accessible table name (the group heading's text). */
		caption: string;
		showTeam?: boolean;
		/** The figures per project; null while they load. */
		outcomes: Outcomes | null;
		outcomesFailed?: boolean;
		sort: SortKey;
		onsort: (key: SortKey) => void;
		oncopy: (p: ProjectSummary) => void;
		ondelete: (p: ProjectSummary) => void;
	} = $props();

	// Owner as you see it: a team, someone's team you were shared into, your
	// own personal project, or someone else's shared with you directly.
	const teamLabel = (p: ProjectSummary) =>
		p.team ? (p.team.name ?? 'Another team') : p.role === 'owner' ? 'Personal' : 'Shared directly';

	// Opens the workspace with the upload dialog (the workspace reads ?add=data).
	const addDataHref = (p: ProjectSummary) => `${base}/projects/${p.id}?add=data`;
	const now = new Date();

	/** "today", "yesterday", "3 days ago", "5 months ago". */
	function ago(iso: string): string {
		const d = daysSince(fmtDate(iso), now);
		if (d <= 0) return 'today';
		if (d === 1) return 'yesterday';
		if (d < 60) return `${d} days ago`;
		if (d < 730) return `${Math.floor(d / 30.44)} months ago`;
		return `${Math.floor(d / 365.25)} years ago`;
	}

	/** Why a row has no figures: still loading, the request failed, or none for this role. */
	const noFigures = (p: ProjectSummary) =>
		outcomes === null ? (outcomesFailed ? 'Figures unavailable' : 'Loading…') : hasRole(p.role, 'viewer') ? 'No figures' : 'Not shown to your role';

	const sourceShort = (o: PortfolioProject) =>
		o.source === 'published' ? 'Published' : o.source === 'run' ? 'Latest run' : null;

	// ---- The ⋯ menu: one open at a time, drawn fixed over the scrolling list.
	let menuFor = $state<string | null>(null);
	let menuPos = $state<{ top?: number; bottom?: number; right: number }>({ right: 0 });
	let trigger: HTMLButtonElement | null = null;
	let menuEl: HTMLUListElement | undefined = $state();

	function toggleMenu(p: ProjectSummary, el: HTMLButtonElement) {
		if (menuFor === p.id) return closeMenu();
		trigger = el;
		const r = el.getBoundingClientRect();
		const right = Math.max(8, window.innerWidth - r.right);
		// Opens upward when there's no room for its two items below.
		menuPos = window.innerHeight - r.bottom < 110 ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right };
		menuFor = p.id;
	}
	function closeMenu(refocus = false) {
		menuFor = null;
		if (refocus) trigger?.focus();
	}
	$effect(() => {
		if (!menuFor) return;
		const onDoc = (e: PointerEvent) => {
			const t = e.target as Node;
			if (!menuEl?.contains(t) && !trigger?.contains(t)) closeMenu();
		};
		// The menu is fixed: close it rather than leave it behind when the list scrolls.
		const onScroll = (e: Event) => {
			if (!menuEl?.contains(e.target as Node)) closeMenu();
		};
		const onResize = () => closeMenu();
		document.addEventListener('pointerdown', onDoc);
		document.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', onResize);
		return () => {
			document.removeEventListener('pointerdown', onDoc);
			document.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', onResize);
		};
	});
	function onMenuKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && menuFor) {
			e.stopPropagation();
			closeMenu(true);
		}
	}
	function onMenuFocusOut(e: FocusEvent) {
		const to = e.relatedTarget as Node | null;
		if (menuFor && !menuEl?.contains(to) && !trigger?.contains(to)) closeMenu();
	}

	const SORTABLE: { key: SortKey; label: string; cls: string; col: string }[] = [
		{ key: 'status', label: 'EWR, last 30 days', cls: 'wide', col: 'c-ewr' },
		{ key: 'farms', label: 'Units short', cls: 'wide', col: 'c-units' },
		{ key: 'dam', label: 'Lowest dam', cls: 'wide xwide', col: 'c-dam' }
	];
</script>

{#snippet freshBadge(p: ProjectSummary)}
	{@const f = dataFreshness(p.dataUntil, now)}
	<span class="badge fresh" class:badge-warn={f.stale} title={f.detail}>{f.label}</span>
{/snippet}

{#snippet lastRun(p: ProjectSummary)}
	{#if p.lastRunAt}
		<span class="run" title="Newest run: {fmtDate(p.lastRunAt, true)}">last run {fmtDate(p.lastRunAt)}</span>
	{:else if hasRole(p.role, 'viewer')}
		<!-- A farmer sees no runs (lastRunAt is null for them), so "not run yet" would be wrong. -->
		<span class="run">not run yet</span>
	{/if}
	{#if p.publishedAt}
		<span class="run" title="Current published baseline: {fmtDate(p.publishedAt, true)}">published {fmtDate(p.publishedAt)}</span>
	{/if}
{/snippet}

{#snippet units(o: PortfolioProject)}
	{@const t = farmsShortText(o)}
	{#if t}
		{#if o.farmsShort7 && o.sourceRunId}<a class="lift short" href={curtailmentHref(o, base)}>{t}</a>{:else}{t}{/if}
	{:else}
		<span class="muted">{o.source === 'published' ? 'Unknown' : 'Not published'}</span>
	{/if}
{/snippet}

{#snippet dam(o: PortfolioProject)}
	{#if o.damsKnown}{damText(o)}{:else}<span class="muted">Not published</span>{/if}
{/snippet}

<div class="pt">
	<table class="data projects">
		<caption class="visually-hidden">{caption}</caption>
		<thead>
			<tr>
				<th scope="col" aria-sort={sort === 'name' ? 'ascending' : undefined}>
					<button type="button" class="sort" onclick={() => onsort('name')}>Catchment{#if sort === 'name'}<span aria-hidden="true"> ↑</span>{/if}</button>
				</th>
				{#each SORTABLE as c (c.key)}
					<th scope="col" class="{c.cls} {c.col}" aria-sort={sort === c.key ? 'ascending' : undefined}>
						<button type="button" class="sort" onclick={() => onsort(c.key)}>{c.label}{#if sort === c.key}<span aria-hidden="true"> ↑</span>{/if}</button>
					</th>
				{/each}
				<th scope="col" class="wide c-data"><span class="sort">Data</span></th>
				<th scope="col" class="wide xwide c-run" aria-sort={sort === 'run' ? 'descending' : undefined}>
					<button type="button" class="sort" onclick={() => onsort('run')}>Last run{#if sort === 'run'}<span aria-hidden="true"> ↓</span>{/if}</button>
				</th>
				<th scope="col" class="c-act"><span class="visually-hidden">Actions</span></th>
			</tr>
		</thead>
		<tbody>
			{#each projects as p (p.id)}
				{@const o = outcomes?.get(p.id)}
				<tr>
					<!-- Named by the project name alone, not the lines under it. -->
					<th scope="row" aria-label={p.name}>
						<a class="name" href="{base}/projects/{p.id}">{p.name}</a>
						<span class="meta meta-who">
							{#if showTeam}
								{#if p.team?.name}<a class="lift team" href="{base}/teams/{p.team.id}">{p.team.name}</a>{:else}<span>{teamLabel(p)}</span>{/if}
								<span aria-hidden="true">·</span>
							{/if}
							<span class="role" data-testid="project-role">{p.role}</span>
							<span aria-hidden="true">·</span>
							<span title={fmtDate(p.updatedAt, true)}>updated {fmtDate(p.updatedAt)}</span>
						</span>
						{#if p.description}<span class="desc">{p.description}</span>{/if}
						<!-- Narrow tables: the columns that fold away, as lines under the name. -->
						<span class="meta meta-narrow">
							{#if o}<StatusPill p={o} />{:else}<span class="muted">{noFigures(p)}</span>{/if}
							{#if o}<span class="line">{#if !farmsShortText(o)}Units short:{' '}{/if}{@render units(o)}</span>{/if}
						</span>
						<span class="meta meta-narrow">
							{@render freshBadge(p)}
							{#if o?.behindData}<span class="badge badge-warn flag">Newer rain not in the figures</span>{/if}
						</span>
						<span class="meta meta-mid">
							{@render lastRun(p)}
							{#if o}<span class="line">Lowest dam: {@render dam(o)}</span>{/if}
						</span>
					</th>
					<td class="wide c-ewr">
						{#if o}
							<StatusPill p={o} />
							{#if sourceShort(o)}<span class="sub">{sourceShort(o)}{#if o.figuresUntil}{' '}· to {fmtDay(o.figuresUntil)}{/if}</span>{/if}
						{:else}<span class="muted">{noFigures(p)}</span>{/if}
					</td>
					<td class="wide c-units">{#if o}{@render units(o)}{:else}<span class="muted">–</span>{/if}</td>
					<td class="wide xwide c-dam">{#if o}{@render dam(o)}{:else}<span class="muted">–</span>{/if}</td>
					<td class="wide c-data">
						{@render freshBadge(p)}
						{#if o?.behindData}<span class="badge badge-warn flag">Newer rain not in the figures</span>{/if}
						{#if o && o.feeds.total}<span class="sub" class:warn={o.feeds.failing > 0}>{feedsText(o)}</span>{/if}
					</td>
					<td class="wide xwide c-run">
						{#if p.lastRunAt}
							<span class="lift" title="Newest run: {fmtDate(p.lastRunAt, true)}">{ago(p.lastRunAt)}</span>
							{#if p.publishedAt}
								<span class="sub lift" title="Current published baseline: {fmtDate(p.publishedAt, true)}">published {ago(p.publishedAt)}</span>
							{:else}<span class="sub">{fmtDate(p.lastRunAt)}</span>{/if}
						{:else if hasRole(p.role, 'viewer')}<span class="muted">Not run yet</span>{/if}
					</td>
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<td class="actions" onkeydown={onMenuKeydown} onfocusout={onMenuFocusOut}>
						<div class="act">
							{#if hasRole(p.role, 'editor')}
								<a class="btn btn-sm" href={addDataHref(p)} aria-label="Add data to {p.name}">Add data</a>
							{/if}
							<button
								type="button"
								class="btn btn-sm more"
								aria-label="More actions for {p.name}"
								aria-expanded={menuFor === p.id}
								aria-controls="pm-{p.id}"
								onclick={(e) => toggleMenu(p, e.currentTarget)}><span aria-hidden="true">⋯</span></button
							>
						</div>
						{#if menuFor === p.id}
							<ul
								class="menu"
								id="pm-{p.id}"
								bind:this={menuEl}
								style:top={menuPos.top != null ? `${menuPos.top}px` : undefined}
								style:bottom={menuPos.bottom != null ? `${menuPos.bottom}px` : undefined}
								style:right="{menuPos.right}px"
							>
								<li>
									<button type="button" class="item" aria-label="Copy {p.name}" onclick={() => (closeMenu(), oncopy(p))}>Copy…</button>
								</li>
								{#if hasRole(p.role, 'owner')}
									<li>
										<button type="button" class="item item-danger" aria-label="Delete {p.name}" onclick={() => (closeMenu(), ondelete(p))}
											>Delete…</button
										>
									</li>
								{/if}
							</ul>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.pt {
		container-type: inline-size;
	}
	/* Fixed columns so the tables of consecutive groups line up. */
	.projects {
		table-layout: fixed;
	}
	.c-ewr {
		width: 215px;
	}
	.c-units {
		width: 150px;
	}
	.c-dam {
		width: 140px;
	}
	.c-data {
		width: 165px;
	}
	.c-run {
		width: 120px;
	}
	.c-act {
		width: 128px;
	}
	.projects td,
	.projects th {
		vertical-align: top;
	}
	.projects tbody th,
	.projects td {
		padding-top: 0.5rem;
		padding-bottom: 0.5rem;
	}
	.projects td {
		overflow-wrap: anywhere;
	}
	.sort {
		display: inline-flex;
		align-items: center;
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: inherit;
		cursor: pointer;
		text-align: inherit;
		min-height: 24px;
		white-space: nowrap;
	}
	button.sort:hover {
		color: var(--accent);
	}
	.name {
		font-weight: 600;
		font-size: 0.95rem;
	}
	/* The whole row opens the project: the name link's box stretches over the
	   row (a "stretched link"), so a click anywhere on it is a real link click
	   (Ctrl/Cmd-click and middle-click open a new tab) while the keyboard and
	   screen readers meet one named link per row. The row's own links, buttons
	   and titled figures sit above the stretch (.lift, .act, .fresh). */
	.projects tbody tr {
		position: relative;
		cursor: pointer;
	}
	.name::after {
		content: '';
		position: absolute;
		inset: 0;
	}
	.lift,
	.act,
	.fresh,
	.run[title] {
		position: relative;
		z-index: 1;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.15rem 0.4rem;
		margin-top: 0.15rem;
		color: var(--text-muted);
		font-weight: 400;
		font-size: 0.8rem;
	}
	.meta-narrow,
	.meta-mid {
		display: none;
	}
	.role {
		text-transform: capitalize;
	}
	.team {
		color: var(--text-2);
	}
	.team:hover {
		color: var(--accent);
	}
	.desc {
		display: -webkit-box;
		-webkit-line-clamp: 1;
		line-clamp: 1;
		-webkit-box-orient: vertical;
		overflow: hidden;
		margin-top: 0.1rem;
		max-width: 72ch;
		color: var(--text-2);
		font-weight: 400;
		font-size: 0.83rem;
	}
	.sub {
		display: block;
		margin-top: 0.2rem;
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.sub.warn {
		color: var(--warning);
	}
	.fresh,
	.flag {
		text-transform: none;
		font-weight: 500;
		white-space: nowrap;
	}
	.flag {
		display: inline-block;
		margin-top: 0.25rem;
		white-space: normal;
	}
	.run {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.short {
		font-weight: 600;
		color: var(--danger);
	}
	.actions {
		text-align: right;
	}
	.act {
		display: flex;
		justify-content: flex-end;
		gap: 0.25rem;
	}
	.more {
		min-width: 2rem;
		justify-content: center;
		font-weight: 700;
		letter-spacing: 0.05em;
	}
	/* The ⋯ menu: fixed, so the list's scrolling box never clips it. */
	.menu {
		position: fixed;
		z-index: 50;
		list-style: none;
		margin: 0;
		padding: 0.25rem;
		min-width: 9rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow), 0 6px 18px rgb(0 0 0 / 0.14);
		text-align: left;
		cursor: default;
	}
	.item {
		display: block;
		width: 100%;
		min-height: 32px;
		padding: 0.35rem 0.6rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.item:hover,
	.item:focus-visible {
		background: var(--surface-2);
	}
	.item-danger {
		color: var(--danger);
	}
	/* Mid width (the app sidebar and a 1280 px window): Lowest dam and Last run
	   fold into a line under the name. */
	@container (max-width: 1100px) {
		.xwide {
			display: none;
		}
		.meta-mid {
			display: flex;
		}
	}
	/* Narrow (a phone): every figure moves under the name; the row keeps Add data and ⋯. */
	@container (max-width: 730px) {
		.wide {
			display: none;
		}
		.meta-narrow {
			display: flex;
		}
		.c-act {
			width: 6.5rem;
		}
		.act {
			flex-direction: column;
			align-items: stretch;
			gap: 0.35rem;
		}
		.act .btn {
			justify-content: center;
			min-height: var(--tap);
		}
	}
</style>
