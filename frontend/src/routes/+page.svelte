<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { isFarmerOnly } from '$lib/auth/frame';
	import { api, hasTeamRole, type PortfolioProject, type ProjectSummary, type Team } from '$lib/api';
	import ChunkFailed from '$lib/components/common/ChunkFailed.svelte';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { loadOnce, peek, prefetch } from '$lib/components/common/lazy';
	import GetStarted from '$lib/components/projects/GetStarted.svelte';
	import NeedsAttention from '$lib/components/projects/NeedsAttention.svelte';
	import ProjectTable from '$lib/components/projects/ProjectTable.svelte';
	import { needsAttention } from '$lib/components/projects/outcomes';
	import { statusCounts, statusSummary } from '$lib/components/portfolio/portfolio';
	import { evidenceRefusal, type EvidenceRefusal } from '$lib/components/projects/deleteRefusal';
	import {
		filterProjects,
		groupProjects,
		ownerOptions,
		parseOwner,
		parseSort,
		SORT_LABELS,
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

	let importOpen = $state(false);
	/** Which import button opened the dialog: its wording and file picker follow. */
	let importSource = $state<'project' | 'workbook'>('project');
	// The import dialog loads on demand (~18 KB gzip with its preview, the
	// workbook review and the engine code they use; home's first load was
	// 16 KB heavier with it). Hovering or focusing an import button starts
	// the fetch; a press opens the dialog as soon as it's here. No loading
	// state is shown: the chunk is almost always in by the press, and the
	// button keeps focus (so Escape still returns focus to it). A failed
	// download says so and offers a reload (ChunkFailed), since a browser
	// keeps a module that failed to fetch for the life of the page; another
	// press still reruns the import (lazy.ts), which helps only if it was the
	// chunk's CSS that failed.
	// components/import/homeSplit.test.ts keeps the static imports off it.
	const loadImportDialog = () => import('$lib/components/import/ImportProjectDialog.svelte');
	const prefetchImport = () => prefetch(loadImportDialog);
	let ImportProjectDialog = $state.raw(peek(loadImportDialog));
	let importWaiting = $state(false);
	let importFailed = $state(false);
	let importRequest = 0;
	async function openImport(source: 'project' | 'workbook') {
		importSource = source;
		if (ImportProjectDialog) {
			importOpen = true;
			return;
		}
		const request = ++importRequest;
		importWaiting = true;
		importFailed = false;
		try {
			ImportProjectDialog = await loadOnce(loadImportDialog);
			if (request === importRequest) importOpen = true;
		} catch {
			if (request === importRequest) importFailed = true;
		} finally {
			if (request === importRequest) importWaiting = false;
		}
	}

	let copyOpen = $state(false);
	let copySource = $state<ProjectSummary | null>(null);
	let copyName = $state('');
	let copying = $state(false);

	// A delete the server refused because the project has nominated evidence (issue #43).
	let keptOpen = $state(false);
	let kept = $state<(EvidenceRefusal & { project: ProjectSummary }) | null>(null);

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

	// The portfolio's figures per project (GET /projects/outcomes): the outcome
	// columns and the Needs attention strip. They load beside the list, which
	// shows first; a failure leaves the list working and says so.
	let outcomes = $state.raw<Map<string, PortfolioProject> | null>(null);
	let outcomesFailed = $state(false);
	let outcomesRequest = 0;
	function loadOutcomes() {
		const request = ++outcomesRequest;
		outcomes = null;
		outcomesFailed = false;
		api.projects
			.outcomes()
			.then((rows) => request === outcomesRequest && (outcomes = new Map(rows.map((r) => [r.id, r]))))
			.catch(() => request === outcomesRequest && (outcomesFailed = true));
	}

	async function load() {
		loading = true;
		loadError = null;
		loadOutcomes();
		try {
			const [p, t] = await Promise.allSettled([api.projects.list(), api.teams.list()]);
			if (p.status === 'rejected') throw p.reason;
			// A user who is only ever a farmer has no workspace: their farms are
			// the farmer view (WP-2.6, docs/design/farmer-view.md).
			if (isFarmerOnly(p.value.map((x) => x.role))) {
				await goto(`${base}/farm`, { replaceState: true });
				return;
			}
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
	const filtered = $derived(filterProjects(projects, { owner, query }));
	const visible = $derived(sortProjects(filtered, sort, outcomes ?? undefined));
	const flagged = $derived(outcomes ? needsAttention(filtered, outcomes, base) : []);
	// The header's one line: how the catchments in view are doing.
	const inView = $derived(outcomes ? filtered.map((p) => outcomes!.get(p.id)).filter((o): o is PortfolioProject => !!o) : []);
	const summaryLine = $derived(statusSummary(statusCounts(inView)));
	/** A filter link that keeps the sort and the search. */
	const hrefWith = (next: { owner?: OwnerFilter; sort?: SortKey }) => {
		const o = next.owner ?? owner;
		const so = next.sort ?? sort;
		const q = query.trim();
		const qs = new URLSearchParams({ ...(o === 'all' ? {} : { owner: o }), ...(so === 'updated' ? {} : { sort: so }), ...(q ? { q } : {}) }).toString();
		return qs ? `?${qs}` : `${base}/`;
	};

	// A dashboard on a wide screen (issue #17): the list's card takes at most
	// the height left in the window, measured (its top and what sits below it),
	// and scrolls inside, so the page itself doesn't; a short list just ends.
	// What sits below it is measured to the end of this page's <main>, not the
	// document's scrollHeight: that counts the empty window under a short list,
	// so after a search narrowed the list and was cleared the card stayed
	// capped at that short height (its 320 px floor) with the window empty below.
	let fillEl: HTMLDivElement | undefined = $state();
	let fillTop = $state(0);
	let fillBelow = $state(0);
	$effect(() => {
		if (!fillEl) return;
		const main = fillEl.closest('main');
		const measure = () => {
			if (!fillEl || !main) return;
			const r = fillEl.getBoundingClientRect();
			fillTop = r.top + window.scrollY;
			fillBelow = Math.max(0, main.getBoundingClientRect().bottom - r.bottom);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		if (main) ro.observe(main);
		return () => ro.disconnect();
	});
	const groups = $derived(owner === 'all' ? groupProjects(visible, teams) : []);
	const ownerLabel = $derived(options.find((o) => o.value === owner)?.label ?? 'All projects');
	const selectedTeam = $derived(owner.startsWith('team:') ? teams.find((t) => `team:${t.id}` === owner) : undefined);
	// Teams you may add projects to: a team viewer only reads its projects.
	const addableTeams = $derived(teams.filter((t) => hasTeamRole(t.role, 'member')));
	const canAddTo = (teamId: string | undefined) => !!teamId && addableTeams.some((t) => t.id === teamId);

	function openCreate() {
		newName = '';
		newDescription = '';
		newTeamId = canAddTo(selectedTeam?.id) ? selectedTeam!.id : '';
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
			const refusal = evidenceRefusal(err);
			if (refusal) {
				kept = { ...refusal, project: p };
				keptOpen = true;
			} else actionError = msg(err);
		}
	}

	function clearFilters() {
		query = '';
		setParams({ owner: 'all', q: '' });
	}
</script>

<svelte:head><title>Projects · Water Management</title></svelte:head>

<main class="page projects-page" data-outcomes-ready={outcomes !== null || outcomesFailed ? 'true' : 'false'}>
	<div class="page-head">
		<div>
			<h1>Projects</h1>
			<p class="muted sub" data-testid="projects-context">
				{#if !loading && projects.length}
					{filtered.length} catchment{filtered.length === 1 ? '' : 's'}{#if summaryLine}{' '}· EWR, last 30 days: {summaryLine}{/if}
				{:else}
					Each project models one catchment: its river network, hydrological units, dams and data.
				{/if}
			</p>
		</div>
		<div class="head-actions">
			<button
				type="button"
				class="btn"
				aria-busy={importWaiting && importSource === 'workbook' ? 'true' : undefined}
				onpointerenter={prefetchImport}
				onfocus={prefetchImport}
				onclick={() => openImport('workbook')}>Import b023 workbook</button
			>
			<button
				type="button"
				class="btn"
				aria-busy={importWaiting && importSource === 'project' ? 'true' : undefined}
				onpointerenter={prefetchImport}
				onfocus={prefetchImport}
				onclick={() => openImport('project')}>Import project file (.json)</button
			>
			<button type="button" class="btn btn-primary" onclick={openCreate}>New project</button>
		</div>
	</div>

	{#if actionError && !createOpen && !copyOpen}
		<div class="alert alert-error" role="alert">{actionError}</div>
	{/if}
	{#if importFailed}
		<ChunkFailed what="The import" />
	{/if}

	<LoadState {loading} error={loadError} retry={load} empty={false}>
		{#if projects.length === 0}
			<GetStarted oncreate={openCreate} hasTeams={addableTeams.length > 0} />
		{:else}
			<nav class="owners" aria-label="Filter by owner">
				<ul>
					{#each options as o (o.value)}
						<li>
							<a
								href={hrefWith({ owner: o.value })}
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

			<NeedsAttention
				{flagged}
				loading={outcomes === null && !outcomesFailed}
				failed={outcomesFailed}
				shown={filtered.length}
				allHref={hrefWith({ sort: 'attention' })}
			/>

			<div class="list-card" bind:this={fillEl} style:--fill-top="{fillTop}px" style:--fill-below="{fillBelow}px">
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
						<select id="pj-owner" value={owner} onchange={(e) => setParams({ owner: e.currentTarget.value as OwnerFilter })}>
							{#each options as o (o.value)}<option value={o.value}>{o.label} ({o.count})</option>{/each}
						</select>
					</div>
					<div class="sort">
						<label for="pj-sort">Sort</label>
						<select id="pj-sort" value={sort} onchange={(e) => setParams({ sort: e.currentTarget.value as SortKey })}>
							{#each Object.entries(SORT_LABELS) as [k, label] (k)}<option value={k}>{label}</option>{/each}
						</select>
					</div>
				</div>

				<p class="visually-hidden" role="status">{visible.length} project{visible.length === 1 ? '' : 's'} shown</p>

				<div class="groups">
					{#if visible.length === 0}
						<div class="none">
							{#if query.trim()}
								<p>No projects in <strong>{ownerLabel}</strong> match “{query.trim()}”.</p>
								<button type="button" class="btn" onclick={clearFilters}>Clear search and filter</button>
							{:else if selectedTeam}
								<p><strong>{selectedTeam.name}</strong> has no projects yet.</p>
								{#if canAddTo(selectedTeam.id)}
									<p class="muted">
										Projects you create in a team can be edited by its editors and owners; its viewers can only read
										them.
									</p>
									<button type="button" class="btn btn-primary" onclick={openCreate}>New project in {selectedTeam.name}</button>
								{:else}
									<p class="muted">You're a viewer in this team, so you can't add projects to it.</p>
								{/if}
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
									{#if g.teamId}
										<a class="team-link" href="{base}/teams/{g.teamId}/portfolio">Portfolio</a>
										<a class="team-link" href="{base}/teams/{g.teamId}">Team members & settings</a>
									{/if}
								</div>
								{@render table(g.projects, g.label, g.key === 'shared')}
							</section>
						{/each}
					{:else}
						{@render table(visible, ownerLabel, owner === 'shared')}
					{/if}
				</div>
			</div>
		{/if}
	</LoadState>
</main>

{#snippet table(rows: ProjectSummary[], caption: string, showTeam: boolean)}
	<ProjectTable
		projects={rows}
		{caption}
		{showTeam}
		{outcomes}
		{outcomesFailed}
		{sort}
		onsort={(key) => setParams({ sort: key })}
		oncopy={openCopy}
		ondelete={remove}
	/>
{/snippet}

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
				{#each addableTeams as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
			</select>
			<span class="hint" id="np-team-hint">
				{#if addableTeams.length}
					Personal: only you and people you share it with. In a team, its editors and owners can edit it and its
					viewers can only read it.
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

{#if ImportProjectDialog}
	<ImportProjectDialog
		bind:open={importOpen}
		source={importSource}
		teams={addableTeams}
		defaultTeamId={canAddTo(selectedTeam?.id) ? selectedTeam!.id : ''}
		onimported={() => load()}
	/>
{/if}

<Dialog bind:open={keptOpen} title="This project can't be deleted">
	{#if kept}
		<p data-testid="evidence-kept">
			{#if kept.run}“{kept.run.label || 'Untitled run'}” is the nominated evidence run of “{kept.project.name}”.{:else}“{kept.project.name}”
				has an evidence nomination history.{/if}
			A project that has nominated evidence keeps it, with its nomination history{kept.nominations && kept.nominations > 1
				? ` (${kept.nominations} nominations)`
				: ''}, for good, so the evidence can still be read and reproduced.
		</p>
		<p class="muted">
			Replacing or withdrawing a nomination keeps the history. To start again without it, copy the project: the model and time
			series are copied, the runs and their nominations are not.
		</p>
		<p>
			<a href="{base}/projects/{kept.project.id}?tab=runs{kept.run ? `&run=${kept.run.id}` : ''}"
				>{kept.run ? 'Open the evidence run' : 'Open the project’s runs'}</a
			>
		</p>
	{/if}
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (keptOpen = false)}>Close</button>
		<button
			type="button"
			class="btn btn-primary"
			onclick={() => {
				keptOpen = false;
				if (kept) openCopy(kept.project);
			}}>Copy project</button
		>
	{/snippet}
</Dialog>

<Dialog bind:open={copyOpen} title="Copy project">
	<form id="copy-form" onsubmit={copy}>
		{#if actionError}<div class="alert alert-error" role="alert">{actionError}</div>{/if}
		<p class="muted">
			The model and time series are copied; model runs are not.
			{#if copySource?.team?.name}
				{canAddTo(copySource.team.id)
					? `The copy stays in ${copySource.team.name}.`
					: `You're a viewer in ${copySource.team.name}, so the copy is personal.`}
			{/if}
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
	.projects-page {
		container: projects-page / inline-size;
	}
	.page-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.9rem;
	}
	.head-actions {
		display: flex;
		flex: none;
		flex-wrap: wrap;
		gap: 0.5rem;
		justify-content: flex-end;
	}
	/* The import dialog's chunk is still downloading after a click. */
	.head-actions [aria-busy='true'] {
		cursor: progress;
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
	/* The owner filter: chips over the list, grouped as the list is (issue #17). */
	.owners {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.75rem;
		margin-bottom: 0.75rem;
	}
	.owners ul {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.owners li a {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		min-height: 32px;
		padding: 0.2rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-2);
	}
	.owners li a:hover {
		border-color: var(--border-strong);
		color: var(--text);
		text-decoration: none;
	}
	.owners li a[aria-current='true'] {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--text);
		font-weight: 600;
	}
	.count {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.manage {
		font-size: 0.85rem;
	}
	.list-card {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.filters {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
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
	/* Positioned, so the visually hidden captions and counts (position:
	   absolute) are clipped by its scroll box: without it they sat at their
	   static place far down the list and scrolled the whole page. */
	.groups {
		position: relative;
		min-height: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.group-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.55rem 0.6rem 0.4rem;
	}
	.group + .group {
		border-top: 1px solid var(--border-strong);
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
	.team-link + .team-link {
		margin-left: 0.5rem;
	}
	.none {
		padding: 2rem 1rem;
		text-align: center;
	}
	/* Wide and tall enough: the card fits the window from where it starts, and
	   the groups scroll inside it with each table's header row stuck. */
	@media (min-width: 900px) and (min-height: 620px) {
		.page:has(.list-card) {
			padding-bottom: 1rem;
		}
		.list-card {
			max-height: max(320px, calc(100vh - var(--fill-top, 0px) - var(--fill-below, 0px)));
		}
		.groups {
			overflow: auto;
		}
	}
	/* A narrow page (a phone, or the app frame on a small window): the owner
	   filter as a select beside the search, not a row of chips. */
	@container projects-page (max-width: 600px) {
		.owners ul {
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
		.head-actions {
			flex-direction: column-reverse;
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
