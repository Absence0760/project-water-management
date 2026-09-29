<script lang="ts">
	// Your teams (docs/ui.md § Teams): each as a card with the numbers that
	// matter (projects, members, farms short this week, the last run) and its
	// projects' EWR traffic lights, worst first. The numbers come from each
	// team's portfolio (GET /teams/:id/portfolio, the same request the
	// portfolio page makes), fetched once the list is in; a card shows its
	// counts straight away and fills in the rest when its portfolio arrives.
	// Beside the cards, what a team is and what each role may do.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { api, roleLabel, roleTitle, type Portfolio, type Team } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import StatusBar from '$lib/components/portfolio/StatusBar.svelte';
	import StatusPill from '$lib/components/portfolio/StatusPill.svelte';
	import { DEFAULT_SORT, ewrWindowLabel, portfolioTotals, sortPortfolio } from '$lib/components/portfolio/portfolio';
	import { fmtDate, fmtDay } from '$lib/format/number';

	let teams = $state<Team[]>([]);
	/** Projects listed on a card (more when it's your only team: its card is the page); the rest are one click away on the portfolio. */
	const LISTED = $derived(teams.length === 1 ? 10 : 5);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	/** Each team's portfolio: undefined while loading, null when it failed (the card keeps its counts). */
	let portfolios = $state<Record<string, Portfolio | null | undefined>>({});

	let createOpen = $state(false);
	let name = $state('');
	let creating = $state(false);
	let createError = $state<string | null>(null);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	/** Bumped per load, so a slow portfolio from an earlier load never lands on a newer list. */
	let generation = 0;

	async function load() {
		const gen = ++generation;
		loading = true;
		loadError = null;
		try {
			teams = await api.teams.list();
			portfolios = {};
			for (const t of teams) {
				api.teams
					.portfolio(t.id)
					.then((p) => gen === generation && (portfolios[t.id] = p))
					.catch(() => gen === generation && (portfolios[t.id] = null));
			}
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function openCreate() {
		name = '';
		createError = null;
		createOpen = true;
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		creating = true;
		createError = null;
		try {
			const t = await api.teams.create(name.trim());
			createOpen = false;
			await goto(`${base}/teams/${t.id}`);
		} catch (err) {
			createError = msg(err);
		} finally {
			creating = false;
		}
	}

	const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
</script>

<svelte:head><title>Teams · Water Management</title></svelte:head>

{#snippet card(t: Team)}
	{@const pf = portfolios[t.id]}
	{@const totals = pf ? portfolioTotals(pf.projects) : null}
	{@const rows = pf ? sortPortfolio(pf.projects, DEFAULT_SORT) : []}
	<li class="card" aria-labelledby="team-{t.id}">
		<div class="card-head">
			<h2 id="team-{t.id}"><a href="{base}/teams/{t.id}">{t.name}</a></h2>
			<span class="badge" class:badge-owner={t.role === 'admin'}>{roleLabel(t.role)}</span>
		</div>
		<div class="card-body">
			<div class="summary">
				<dl class="facts">
					<div><dt>Projects</dt><dd>{t.projectCount}</dd></div>
					<div><dt>Members</dt><dd>{t.memberCount}</dd></div>
				</dl>
				{#if totals}
					<div class="ewr">
						<span class="ewr-h">{ewrWindowLabel(pf?.projects ?? [])}</span>
						<StatusBar counts={totals.counts} empty="No projects yet" />
					</div>
				{:else if pf === null}
					<p class="muted small">The projects' status couldn't be loaded. Open the team to see them.</p>
				{/if}
				<p class="since muted small">Since {fmtDay(fmtDate(t.createdAt))}</p>
			</div>
			{#if rows.length}
				<div class="projects">
					<ul class="plist" aria-label="Projects of {t.name}, worst first">
						{#each rows.slice(0, LISTED) as p (p.id)}
							<li>
								<a href="{base}/projects/{p.id}">{p.name}</a>
								<StatusPill {p} />
							</li>
						{/each}
					</ul>
					{#if rows.length > LISTED}
						<p class="more small"><a href="{base}/teams/{t.id}/portfolio">{plural(rows.length - LISTED, 'more project')} on the portfolio</a></p>
					{/if}
				</div>
			{/if}
		</div>
		<div class="card-foot">
			<a class="btn btn-sm" href="{base}/teams/{t.id}">Open team</a>
			<a class="btn btn-sm" href="{base}/teams/{t.id}/portfolio">Portfolio</a>
		</div>
	</li>
{/snippet}

<main class="page">
	<div class="page-head">
		<div>
			<h1>Teams</h1>
			<p class="muted sub">Catchments you model together, with how each is doing in its latest run.</p>
		</div>
		<button type="button" class="btn btn-primary" onclick={openCreate}>New team</button>
	</div>

	<div class="teams-body">
		<div class="cols">
			<div class="main-col">
				<LoadState {loading} error={loadError} retry={load} empty={teams.length === 0} emptyText="You're not in any team yet.">
					<ul class="teams" class:single={teams.length === 1} aria-label="Your teams">
						{#each teams as t (t.id)}{@render card(t)}{/each}
					</ul>
					{#snippet emptyAction()}
						<p class="muted help">
							Create one for your consultancy or department, then add colleagues by the email they registered with. Anyone can
							still share a single project directly from its Project page.
						</p>
						<button type="button" class="btn btn-primary" onclick={openCreate}>New team</button>
					{/snippet}
				</LoadState>
			</div>
			<aside class="panel about" aria-labelledby="about-h">
				<h2 id="about-h">How teams work</h2>
				<p class="small">A team owns catchments together: everyone in it gets the team's projects, as the role they hold.</p>
				<dl class="roles">
					<div><dt>{roleTitle('viewer')}</dt><dd>Reads every team project and its runs, but can't change or run anything.</dd></div>
					<div><dt>{roleTitle('member')}</dt><dd>Edits every team project: model, data and runs.</dd></div>
					<div><dt>{roleTitle('admin')}</dt><dd>Owns every team project (delete, share, move) and manages the team.</dd></div>
				</dl>
				<p class="small muted">
					Add colleagues on the team's page by the email they registered with; anyone without an account gets an invitation.
					Each team's portfolio shows every catchment's EWR status, hydrological units and dams on one screen.
				</p>
			</aside>
		</div>
	</div>
</main>

<Dialog bind:open={createOpen} title="New team">
	<form id="team-form" onsubmit={create}>
		{#if createError}<div class="alert alert-error" role="alert">{createError}</div>{/if}
		<div class="field">
			<label for="team-name">Team name</label>
			<input id="team-name" required maxlength="200" placeholder="e.g. Breede Hydrology Consultants" bind:value={name} />
			<span class="hint">You'll be its owner. Add people on the next page.</span>
		</div>
	</form>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (createOpen = false)}>Cancel</button>
		<button type="submit" form="team-form" class="btn btn-primary" disabled={creating || !name.trim()}>
			{creating ? 'Creating…' : 'Create team'}
		</button>
	{/snippet}
</Dialog>

<style>
	.page-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.25rem;
	}
	.page-head h1 {
		margin: 0 0 0.2rem;
	}
	.sub {
		margin: 0;
		max-width: 65ch;
	}
	/* The layout answers to the page's own width (the sidebar takes 240 px), not the window's. */
	.teams-body {
		container: teams-page / inline-size;
	}
	.cols {
		display: grid;
		gap: 1rem;
		align-items: start;
	}
	@container teams-page (min-width: 60rem) {
		.cols {
			grid-template-columns: minmax(0, 1fr) 19rem;
		}
	}
	.main-col {
		min-width: 0;
		container: teams-list / inline-size;
	}
	.teams {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 24rem), 1fr));
		gap: 1rem;
	}
	.teams.single {
		grid-template-columns: minmax(0, 1fr);
	}
	.card {
		container: team-card / inline-size;
		display: flex;
		flex-direction: column;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		min-width: 0;
	}
	.card-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.9rem 1.1rem 0;
	}
	.card-head h2 {
		margin: 0;
		font-size: 1.1rem;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.card-body {
		display: grid;
		gap: 1rem;
		padding: 0.8rem 1.1rem 1rem;
		flex: 1;
	}
	/* A wide card (one team, or a wide page) puts its projects beside the numbers. */
	@container team-card (min-width: 44rem) {
		.card-body {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
			gap: 1.5rem;
		}
		.projects {
			border-left: 1px solid var(--border);
			padding-left: 1.5rem;
		}
	}
	.summary {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		min-width: 0;
	}
	.facts {
		margin: 0;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.6rem 1rem;
	}
	.facts dt {
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.facts dd {
		margin: 0.1rem 0 0;
		font-size: 1.15rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.ewr {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.ewr-h {
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.since {
		margin: auto 0 0;
	}
	.plist {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.plist li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.25rem 0.75rem;
		padding: 0.45rem 0;
		border-bottom: 1px solid var(--border);
	}
	.plist li:first-child {
		padding-top: 0;
	}
	.plist li:last-child {
		border-bottom: none;
	}
	.plist a {
		font-weight: 600;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.more {
		margin: 0.4rem 0 0;
	}
	.card-foot {
		display: flex;
		gap: 0.5rem;
		padding: 0.7rem 1.1rem;
		border-top: 1px solid var(--border);
		background: var(--surface-2);
		border-radius: 0 0 var(--radius) var(--radius);
	}
	.about {
		margin: 0;
	}
	.about h2 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	.about p {
		margin: 0 0 0.75rem;
	}
	.about p:last-child {
		margin-bottom: 0;
	}
	.roles {
		margin: 0 0 0.75rem;
		display: grid;
		gap: 0.5rem;
		font-size: 0.85rem;
	}
	.roles dt {
		font-weight: 600;
	}
	.roles dd {
		margin: 0.05rem 0 0;
		color: var(--text-2);
	}
	.help {
		max-width: 55ch;
	}
	@media (max-width: 560px) {
		.page-head {
			flex-direction: column;
			align-items: stretch;
		}
		.page-head .btn {
			justify-content: center;
		}
	}
</style>
