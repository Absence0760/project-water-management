<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, type ProjectSummary, type Team } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import GetStarted from '$lib/components/projects/GetStarted.svelte';
	import ProjectTable from '$lib/components/projects/ProjectTable.svelte';
	import {
		filterProjects,
		groupProjects,
		ownerOptions,
		parseOwner,
		parseSort,
		sortProjects,
		type OwnerFilter,
		type SortKey
	} from '$lib/components/projects/grouping';

	let projects = $state<ProjectSummary[]>([]);
	let teams = $state<Team[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	let createOpen = $state(false);
	let newName = $state('');
	let newDescription = $state('');
	let newTeamId = $state('');
	let creating = $state(false);

	let copyOpen = $state(false);
	let copySource = $state<ProjectSummary | null>(null);
	let copyName = $state('');
	let copying = $state(false);

	// Filter state lives in the URL so Back/Forward and shared links keep it.
	const owner = $derived(parseOwner(page.url.searchParams.get('owner')));
	const sort = $derived(parseSort(page.url.searchParams.get('sort')));
	let query = $state(page.url.searchParams.get('q') ?? '');
	// Back/Forward changes ?q= under us: follow it unless it's what we typed.
	$effect(() => {
		const q = page.url.searchParams.get('q') ?? '';
		if (untrack(() => query.trim()) !== q) query = q;
	});

	function setParams(next: { owner?: OwnerFilter; sort?: SortKey; q?: string }) {
		const u = new URL(page.url);
		const set = (k: string, v: string, dflt: string) => (v === dflt ? u.searchParams.delete(k) : u.searchParams.set(k, v));
		if (next.owner !== undefined) set('owner', next.owner, 'all');
		if (next.sort !== undefined) set('sort', next.sort, 'updated');
		if (next.q !== undefined) set('q', next.q.trim(), '');
		goto(u.pathname + u.search, { replaceState: next.q !== undefined, keepFocus: true, noScroll: true });
	}

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load() {
		loading = true;
		loadError = null;
		try {
			const [p, t] = await Promise.allSettled([api.projects.list(), api.teams.list()]);
			if (p.status === 'rejected') throw p.reason;
			projects = p.value;
			// The list still works without teams (filters just show fewer choices).
			teams = t.status === 'fulfilled' ? t.value : [];
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(async () => {
		await load();
		// ?new=1 (e.g. "New project in this team" on a team page) opens the dialog.
		if (page.url.searchParams.get('new') === '1') {
			const u = new URL(page.url);
			u.searchParams.delete('new');
			await goto(u.pathname + u.search, { replaceState: true, keepFocus: true, noScroll: true });
			if (!loadError) openCreate();
		}
	});

	const options = $derived(ownerOptions(projects, teams));
	const visible = $derived(sortProjects(filterProjects(projects, { owner, query }), sort));
	const groups = $derived(owner === 'all' ? groupProjects(visible, teams) : []);
	const ownerLabel = $derived(options.find((o) => o.value === owner)?.label ?? 'All projects');
	const selectedTeam = $derived(owner.startsWith('team:') ? teams.find((t) => `team:${t.id}` === owner) : undefined);

	function openCreate() {
		newName = '';
		newDescription = '';
		newTeamId = selectedTeam?.id ?? '';
		actionError = null;
		createOpen = true;
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		creating = true;
		actionError = null;
		try {
			const p = await api.projects.create(newName.trim(), newDescription.trim() || undefined, newTeamId || null);
			createOpen = false;
			await goto(`${base}/projects/${p.id}`);
		} catch (err) {
			actionError = msg(err);
		} finally {
			creating = false;
		}
	}

	function openCopy(p: ProjectSummary) {
		copySource = p;
		copyName = `${p.name} (copy)`;
		actionError = null;
		copyOpen = true;
	}

	async function copy(e: SubmitEvent) {
		e.preventDefault();
		if (!copySource) return;
		copying = true;
		actionError = null;
		try {
			await api.projects.copy(copySource.id, copyName.trim());
			copyOpen = false;
			await load();
		} catch (err) {
			actionError = msg(err);
		} finally {
			copying = false;
		}
	}

	async function remove(p: ProjectSummary) {
		if (!confirm(`Delete project "${p.name}"? Its model, time series and runs are removed permanently.`)) return;
		actionError = null;
		try {
			await api.projects.remove(p.id);
			projects = projects.filter((x) => x.id !== p.id);
		} catch (err) {
			actionError = msg(err);
		}
	}

	function clearFilters() {
		query = '';
		setParams({ owner: 'all', q: '' });
	}
</script>

<svelte:head><title>Projects · Water Management</title></svelte:head>

<main class="page">
	<div class="page-head">
		<div>
			<h1>Projects</h1>
			<p class="muted sub">Each project models one catchment: its river network, farms, dams and data.</p>
		</div>
		<button type="button" class="btn btn-primary" onclick={openCreate}>New project</button>
	</div>

	{#if actionError && !createOpen && !copyOpen}
		<div class="alert alert-error" role="alert">{actionError}</div>
	{/if}

	<LoadState {loading} error={loadError} retry={load} empty={false}>
		{#if projects.length === 0}
			<GetStarted oncreate={openCreate} hasTeams={teams.length > 0} />
		{:else}
			<div class="layout">
				<nav class="owners" aria-label="Filter by owner">
					<ul>
						{#each options as o (o.value)}
							<li>
								<a
									href="?{new URLSearchParams({ ...(o.value === 'all' ? {} : { owner: o.value }), ...(sort === 'name' ? { sort } : {}), ...(query.trim() ? { q: query.trim() } : {}) })}"
									aria-current={owner === o.value ? 'true' : undefined}
									data-sveltekit-noscroll
									data-sveltekit-keepfocus
								>
									<span class="label">{o.label}</span>
									<span class="count">{o.count}</span>
								</a>
							</li>
						{/each}
					</ul>
					<a class="manage" href="{base}/teams">Manage teams</a>
				</nav>

				<div class="main">
					<div class="filters" role="search">
						<div class="search">
							<label class="visually-hidden" for="pj-q">Search projects</label>
							<input
								id="pj-q"
								type="search"
								placeholder="Search by name, description or team"
								autocomplete="off"
								bind:value={query}
								oninput={() => setParams({ q: query })}
							/>
						</div>
						<div class="owner-select">
							<label class="visually-hidden" for="pj-owner">Show</label>
							<select
								id="pj-owner"
								value={owner}
								onchange={(e) => setParams({ owner: e.currentTarget.value as OwnerFilter })}
							>
								{#each options as o (o.value)}<option value={o.value}>{o.label} ({o.count})</option>{/each}
							</select>
						</div>
						<div class="sort">
							<label for="pj-sort">Sort</label>
							<select id="pj-sort" value={sort} onchange={(e) => setParams({ sort: e.currentTarget.value as SortKey })}>
								<option value="updated">Recently updated</option>
								<option value="name">Name (A–Z)</option>
							</select>
						</div>
					</div>

					<p class="visually-hidden" role="status">{visible.length} project{visible.length === 1 ? '' : 's'} shown</p>

					{#if visible.length === 0}
						<div class="none">
							{#if query.trim()}
								<p>No projects in <strong>{ownerLabel}</strong> match “{query.trim()}”.</p>
								<button type="button" class="btn" onclick={clearFilters}>Clear search and filter</button>
							{:else if selectedTeam}
								<p><strong>{selectedTeam.name}</strong> has no projects yet.</p>
								<p class="muted">Projects you create in a team can be edited by every member; team admins are owners.</p>
								<button type="button" class="btn btn-primary" onclick={openCreate}>New project in {selectedTeam.name}</button>
							{:else}
								<p>Nothing here.</p>
								<button type="button" class="btn" onclick={clearFilters}>Show all projects</button>
							{/if}
						</div>
					{:else if owner === 'all'}
						{#each groups as g (g.key)}
							<section class="group" aria-labelledby="grp-{g.key}">
								<div class="group-head">
									<h2 id="grp-{g.key}">{g.label}</h2>
									<span class="count">{g.projects.length}<span class="visually-hidden"> projects</span></span>
									{#if g.teamId}<a class="team-link" href="{base}/teams/{g.teamId}">Team members & settings</a>{/if}
								</div>
								<ProjectTable projects={g.projects} caption={g.label} showTeam={g.key === 'shared'} oncopy={openCopy} ondelete={remove} />
							</section>
						{/each}
					{:else}
						<ProjectTable projects={visible} caption={ownerLabel} showTeam={owner === 'shared'} oncopy={openCopy} ondelete={remove} />
					{/if}
				</div>
			</div>
		{/if}
	</LoadState>
</main>

<Dialog bind:open={createOpen} title="New project">
	<form id="create-form" onsubmit={create}>
		{#if actionError}<div class="alert alert-error" role="alert">{actionError}</div>{/if}
		<p class="muted small">A project holds one catchment. You'll add its river network, crops and rainfall/flow data next.</p>
		<div class="field">
			<label for="np-name">Name</label>
			<input id="np-name" required maxlength="200" placeholder="e.g. Upper Breede — 2026 baseline" bind:value={newName} />
		</div>
		<div class="field">
			<label for="np-team">Belongs to</label>
			<select id="np-team" bind:value={newTeamId} aria-describedby="np-team-hint">
				<option value="">Personal</option>
				{#each teams as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
			</select>
			<span class="hint" id="np-team-hint">
				{#if teams.length}
					Personal: only you and people you share it with. In a team, every member can edit and team admins are owners.
				{:else}
					Only you and people you share it with. <a href="{base}/teams">Create a team</a> to work on catchments together.
				{/if}
			</span>
		</div>
		<div class="field">
			<label for="np-desc">Description <span class="muted">(optional)</span></label>
			<textarea
				id="np-desc"
				rows="3"
				placeholder="Where it is and what this scenario tests, e.g. its quaternary catchment and river reach. Current dams and 2025/26 planted areas."
				bind:value={newDescription}
			></textarea>
		</div>
	</form>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (createOpen = false)}>Cancel</button>
		<button type="submit" form="create-form" class="btn btn-primary" disabled={creating || !newName.trim()}>
			{creating ? 'Creating…' : 'Create'}
		</button>
	{/snippet}
</Dialog>

<Dialog bind:open={copyOpen} title="Copy project">
	<form id="copy-form" onsubmit={copy}>
		{#if actionError}<div class="alert alert-error" role="alert">{actionError}</div>{/if}
		<p class="muted">
			The model and time series are copied; model runs are not.
			{#if copySource?.team?.name}The copy stays in {copySource.team.name}.{/if}
		</p>
		<div class="field">
			<label for="cp-name">Name of the copy</label>
			<input id="cp-name" required maxlength="200" bind:value={copyName} />
		</div>
	</form>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (copyOpen = false)}>Cancel</button>
		<button type="submit" form="copy-form" class="btn btn-primary" disabled={copying || !copyName.trim()}>
			{copying ? 'Copying…' : 'Copy'}
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
	}
	.small {
		font-size: 0.85rem;
	}
	.layout {
		display: grid;
		grid-template-columns: 240px minmax(0, 1fr);
		gap: 1.5rem;
		align-items: start;
	}
	.owners {
		position: sticky;
		top: calc(var(--header-h) + 1rem);
	}
	.owners ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.owners li a {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.45rem 0.65rem;
		border-radius: var(--radius-sm);
		color: var(--text-2);
		border-left: 3px solid transparent;
	}
	.owners li a:hover {
		background: var(--surface-2);
		color: var(--text);
		text-decoration: none;
	}
	.owners li a[aria-current='true'] {
		background: var(--accent-soft);
		color: var(--text);
		font-weight: 600;
		border-left-color: var(--accent);
	}
	.owners .label {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.count {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.manage {
		display: inline-block;
		margin: 0.75rem 0.65rem 0;
		font-size: 0.85rem;
	}
	.filters {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 1rem;
	}
	.search {
		flex: 1;
		min-width: 200px;
	}
	.search input {
		width: 100%;
		padding-left: 2rem;
		background: var(--surface)
			url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%23858a85' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='7' cy='7' r='5'/%3E%3Cpath d='m11 11 3.5 3.5'/%3E%3C/svg%3E")
			no-repeat 0.6rem center;
	}
	.sort {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.owner-select {
		display: none;
	}
	.group + .group {
		margin-top: 1.5rem;
	}
	.group-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}
	.group-head h2 {
		font-size: 0.95rem;
		margin: 0;
	}
	.team-link {
		margin-left: auto;
		font-size: 0.8rem;
		font-weight: 500;
	}
	.none {
		padding: 2rem 1rem;
		text-align: center;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
	}
	@media (max-width: 900px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
		}
		.owners {
			display: none;
		}
		.owner-select {
			display: block;
		}
	}
	@media (max-width: 560px) {
		.page-head {
			flex-direction: column;
			align-items: stretch;
		}
		.page-head .btn {
			justify-content: center;
		}
		.search {
			flex-basis: 100%;
		}
		.owner-select {
			flex: 1;
		}
		.owner-select select {
			width: 100%;
		}
		.sort label {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
		}
		.filters select,
		.filters input {
			min-height: var(--tap);
		}
	}
</style>
