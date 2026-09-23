<script lang="ts">
	import { untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import type { SeriesMeta } from '@water-management/engine';
	import { api, ApiError, hasRole, type Project, type RunMeta } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import CropsTab from '$lib/components/crops/CropsTab.svelte';
	import IssueList from '$lib/components/model/IssueList.svelte';
	import SaveBar from '$lib/components/model/SaveBar.svelte';
	import NetworkTab from '$lib/components/network/NetworkTab.svelte';
	import OverviewTab from '$lib/components/overview/OverviewTab.svelte';
	import RunsTab from '$lib/components/runs/RunsTab.svelte';
	import SeriesTab from '$lib/components/series/SeriesTab.svelte';
	import SettingsTab from '$lib/components/settings/SettingsTab.svelte';
	import TransfersTab from '$lib/components/transfers/TransfersTab.svelte';
	import { ModelEditor } from '$lib/model/editor.svelte';

	// Workflow order: describe the catchment, feed it data, calibrate, run.
	const TABS = [
		{ id: 'overview', label: 'Overview' },
		{ id: 'network', label: 'Network' },
		{ id: 'crops', label: 'Crops & demand' },
		{ id: 'transfers', label: 'Transfers' },
		{ id: 'series', label: 'Time series' },
		{ id: 'settings', label: 'Settings & calibration' },
		{ id: 'runs', label: 'Runs & results' }
	] as const;
	type TabId = (typeof TABS)[number]['id'];
	const MODEL_TABS: TabId[] = ['network', 'crops', 'transfers'];
	// Friendlier ?tab= spellings that resolve to the canonical keys above.
	const TAB_ALIASES: Record<string, TabId> = {
		data: 'series',
		demand: 'crops',
		calibration: 'settings',
		results: 'runs'
	};

	const projectId = $derived(page.params.id ?? '');
	const tab = $derived.by<TabId>(() => {
		const raw = page.url.searchParams.get('tab') ?? '';
		const t = TAB_ALIASES[raw] ?? raw;
		return TABS.some((x) => x.id === t) ? (t as TabId) : 'overview';
	});

	let project = $state<Project | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let notFound = $state(false);
	const editor = new ModelEditor();
	// Shared with the Overview checklist, the Time series tab and the Runs tab.
	let series = $state<SeriesMeta[] | null>(null);
	let runs = $state<RunMeta[] | null>(null);
	let saveBarHeight = $state(0);

	const canEdit = $derived(hasRole(project?.role, 'editor'));
	const isOwner = $derived(hasRole(project?.role, 'owner'));

	async function load() {
		loading = true;
		error = null;
		notFound = false;
		try {
			// Everything a tab's first render needs, behind one loading gate, so no
			// tab (or the Overview checklist) flashes an empty state. The lists are
			// best-effort: a failure there shouldn't hide the project.
			const [p, m, sl, rl] = await Promise.all([
				api.projects.get(projectId),
				api.model.get(projectId),
				api.series.list(projectId).catch(() => null),
				api.runs.list(projectId).catch(() => null)
			]);
			project = p;
			editor.load(m);
			series = sl;
			runs = rl;
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) notFound = true;
			else error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	/** Refresh the shared lists in place (keeps the current values on failure). */
	async function loadLists() {
		const [sl, rl] = await Promise.allSettled([api.series.list(projectId), api.runs.list(projectId)]);
		if (sl.status === 'fulfilled') series = sl.value;
		if (rl.status === 'fulfilled') runs = rl.value;
	}

	// Reload when the route param changes (e.g. navigating between projects).
	$effect(() => {
		void projectId;
		untrack(load);
	});

	async function saveModel() {
		if (editor.issues.length || editor.saving) return;
		editor.saving = true;
		editor.saveError = null;
		try {
			editor.load(await api.model.save(projectId, editor.snapshot()));
		} catch (e) {
			editor.saveError = e instanceof Error ? e.message : String(e);
		} finally {
			editor.saving = false;
		}
	}

	const UNSAVED = 'You have unsaved model changes. Leave without saving?';
	beforeNavigate((nav) => {
		if (!editor.dirty || nav.to?.url.pathname === page.url.pathname) return;
		if (nav.type === 'leave') {
			nav.cancel(); // browser shows its own "leave site?" prompt
			return;
		}
		if (!confirm(UNSAVED)) nav.cancel();
	});

	// Selecting a tab keeps focus/scroll and adds a history entry so Back works.
	function tabHref(id: TabId) {
		return id === 'overview' ? page.url.pathname : `?tab=${id}`;
	}

	function onProjectChange(p: Project) {
		project = p;
	}

	async function onLeftProject() {
		await goto(`${base}/`);
	}

	// Keep the active tab in view in the scrolling strip (phones).
	let tabStrip: HTMLElement | undefined = $state();
	$effect(() => {
		void tab;
		tabStrip?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});

	function tabKeydown(e: KeyboardEvent, idx: number) {
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
		e.preventDefault();
		const next = TABS[(idx + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
		goto(tabHref(next.id), { keepFocus: false, noScroll: true }).then(() =>
			document.getElementById(`tab-${next.id}`)?.focus()
		);
	}
</script>

<svelte:head><title>{project ? `${project.name} · ` : ''}Water Management</title></svelte:head>

<main class="page" style:--dock-h="{saveBarHeight}px">
	<LoadState {loading} error={notFound ? null : error} retry={load}>
		{#if notFound || !project}
			<div class="alert alert-error" role="alert">
				This project doesn't exist or you don't have access to it. <a href="{base}/">Back to projects</a>
			</div>
		{:else}
			<div class="head">
				<nav class="crumbs" aria-label="Breadcrumb"><a href="{base}/">Projects</a> <span aria-hidden="true">/</span></nav>
				<h1>{project.name}</h1>
				<span class="badge" class:badge-owner={isOwner}>{project.role}</span>
				{#if editor.dirty && canEdit}<span class="badge badge-warn">Unsaved changes</span>{/if}
			</div>

			<nav class="tabs" aria-label="Project sections" bind:this={tabStrip}>
				{#each TABS as t, i (t.id)}
					<a
						id="tab-{t.id}"
						href={tabHref(t.id)}
						data-sveltekit-noscroll
						aria-current={tab === t.id ? 'page' : undefined}
						onkeydown={(e) => tabKeydown(e, i)}
					>
						{t.label}
						{#if MODEL_TABS.includes(t.id) && editor.issues.some((x) => x.area === t.id)}
							<span class="issue-dot" title="Has problems to fix"><span class="visually-hidden">(has problems)</span></span>
						{/if}
					</a>
				{/each}
			</nav>

			{#if !canEdit && tab !== 'overview'}
				<div class="readonly-note" role="note">
					<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
						<path d="M1.5 10s3-6 8.5-6 8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6Z" fill="none" stroke="currentColor" stroke-width="1.6" />
						<circle cx="10" cy="10" r="2.6" fill="currentColor" />
					</svg>
					<span>
						<strong>View only.</strong> You have view-only access to this project. You can explore every input and
						result; ask the project owner for editor access to change anything or run the model.
					</span>
				</div>
			{/if}

			<section class="tab-body" class:readonly={!canEdit} aria-labelledby="tab-{tab}">
				{#if tab === 'overview'}
					<OverviewTab
						{project}
						{editor}
						{canEdit}
						{isOwner}
						currentUserId={session.user?.id ?? ''}
						{onProjectChange}
						{onLeftProject}
					/>
				{:else if tab === 'network'}
					<IssueList issues={editor.issues} area="network" />
					<NetworkTab {editor} settings={project.settings} readonly={!canEdit} />
				{:else if tab === 'crops'}
					<IssueList issues={editor.issues} area="crops" />
					<CropsTab {editor} settings={project.settings} readonly={!canEdit} />
				{:else if tab === 'transfers'}
					<IssueList issues={editor.issues} area="transfers" />
					<TransfersTab {editor} readonly={!canEdit} />
				{:else if tab === 'settings'}
					<SettingsTab {project} {editor} readonly={!canEdit} {onProjectChange} />
				{:else if tab === 'series'}
					<SeriesTab {projectId} readonly={!canEdit} initial={series} {runs} onSeriesChange={(l) => (series = l)} />
				{:else if tab === 'runs'}
					<RunsTab
						{projectId}
						{project}
						{editor}
						{series}
						canRun={canEdit}
						modelDirty={editor.dirty}
						onRunsChange={(l) => (runs = l)}
					/>
				{/if}
			</section>

			<SaveBar {editor} onsave={saveModel} readonly={!canEdit} bind:height={saveBarHeight} />
		{/if}
	</LoadState>
</main>

<svelte:window
	onbeforeunload={(e) => {
		if (editor.dirty) e.preventDefault();
	}}
/>

<style>
	.page {
		/* Room for the fixed model save bar so it never hides the last row or a
		   tab's own sticky actions (Settings). */
		padding-bottom: calc(var(--dock-h, 0px) + 4rem);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}
	.head h1 {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.crumbs {
		color: var(--text-muted);
	}
	/* The strip scrolls sideways on phones. The underline is drawn inside each
	   tab (inset shadow), so nothing overflows vertically and no stray vertical
	   scrollbar appears with classic (always-visible) scrollbars. */
	.tabs {
		display: flex;
		gap: 0.15rem;
		box-shadow: inset 0 -1px 0 var(--border);
		margin-bottom: 1rem;
		overflow: auto hidden;
		scrollbar-width: thin;
		overscroll-behavior-x: contain;
	}
	.tabs a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 0.85rem;
		color: var(--text-2);
		font-weight: 500;
		white-space: nowrap;
		flex: none;
	}
	.tabs a:focus-visible {
		outline-offset: -2px;
	}
	.tabs a:hover {
		color: var(--text);
		text-decoration: none;
		background: var(--surface-2);
	}
	.tabs a[aria-current='page'] {
		color: var(--accent);
		box-shadow: inset 0 -2px 0 var(--accent);
	}
	.issue-dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--warning);
		margin-left: 0.3rem;
	}
	.readonly-note {
		display: flex;
		gap: 0.6rem;
		align-items: flex-start;
		margin: -0.25rem 0 1rem;
		padding: 0.55rem 0.8rem;
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-2);
		font-size: 0.875rem;
	}
	.readonly-note svg {
		flex: none;
		color: var(--accent);
		margin-top: 0.05rem;
	}
	.readonly-note strong {
		color: var(--text);
	}
	/* Read-only inputs read as plain values, not as a broken, greyed-out form. */
	.readonly :global(input:not([type='checkbox']):read-only),
	.readonly :global(select:disabled),
	.readonly :global(textarea:read-only) {
		background: transparent;
		border-color: transparent;
		color: var(--text);
		appearance: none;
		opacity: 1;
		cursor: default;
	}
</style>
