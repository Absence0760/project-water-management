<script lang="ts">
	import { untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError, hasRole, type Project } from '$lib/api';
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

	const TABS = [
		{ id: 'overview', label: 'Overview' },
		{ id: 'network', label: 'Network' },
		{ id: 'crops', label: 'Crops' },
		{ id: 'transfers', label: 'Transfers' },
		{ id: 'settings', label: 'Settings' },
		{ id: 'series', label: 'Time series' },
		{ id: 'runs', label: 'Runs' }
	] as const;
	type TabId = (typeof TABS)[number]['id'];
	const MODEL_TABS: TabId[] = ['network', 'crops', 'transfers'];

	const projectId = $derived(page.params.id ?? '');
	const tab = $derived.by<TabId>(() => {
		const t = page.url.searchParams.get('tab');
		return TABS.some((x) => x.id === t) ? (t as TabId) : 'overview';
	});

	let project = $state<Project | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let notFound = $state(false);
	const editor = new ModelEditor();

	const canEdit = $derived(hasRole(project?.role, 'editor'));
	const isOwner = $derived(hasRole(project?.role, 'owner'));

	async function load() {
		loading = true;
		error = null;
		notFound = false;
		try {
			const [p, m] = await Promise.all([api.projects.get(projectId), api.model.get(projectId)]);
			project = p;
			editor.load(m);
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) notFound = true;
			else error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
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

	function tabKeydown(e: KeyboardEvent, idx: number) {
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
		e.preventDefault();
		const next = TABS[(idx + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
		goto(tabHref(next.id), { keepFocus: false, noScroll: true }).then(() =>
			document.getElementById(`tab-${next.id}`)?.focus()
		);
	}
</script>

<svelte:head><title>{project ? `${project.name} · ` : ''}Water Balance</title></svelte:head>

<main class="page">
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

			<nav class="tabs" aria-label="Project sections">
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
				<p class="readonly-note muted">You have view-only access to this project.</p>
			{/if}

			<section class="tab-body" aria-labelledby="tab-{tab}">
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
					<NetworkTab {editor} readonly={!canEdit} />
				{:else if tab === 'crops'}
					<IssueList issues={editor.issues} area="crops" />
					<CropsTab {editor} readonly={!canEdit} />
				{:else if tab === 'transfers'}
					<IssueList issues={editor.issues} area="transfers" />
					<TransfersTab {editor} readonly={!canEdit} />
				{:else if tab === 'settings'}
					<SettingsTab {project} readonly={!canEdit} {onProjectChange} />
				{:else if tab === 'series'}
					<SeriesTab {projectId} readonly={!canEdit} />
				{:else if tab === 'runs'}
					<RunsTab {projectId} {editor} canRun={canEdit} modelDirty={editor.dirty} />
				{/if}
			</section>

			<SaveBar {editor} onsave={saveModel} readonly={!canEdit} />
		{/if}
	</LoadState>
</main>

<svelte:window
	onbeforeunload={(e) => {
		if (editor.dirty) e.preventDefault();
	}}
/>

<style>
	.head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}
	.head h1 {
		margin: 0;
	}
	.crumbs {
		color: var(--text-muted);
	}
	.tabs {
		display: flex;
		gap: 0.25rem;
		border-bottom: 1px solid var(--border);
		margin-bottom: 1rem;
		overflow-x: auto;
		scrollbar-width: thin;
	}
	.tabs a {
		position: relative;
		padding: 0.5rem 0.85rem;
		color: var(--text-2);
		font-weight: 500;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		white-space: nowrap;
	}
	.tabs a:hover {
		color: var(--text);
		text-decoration: none;
		background: var(--surface-2);
	}
	.tabs a[aria-current='page'] {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}
	.issue-dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--warning);
		margin-left: 0.3rem;
		vertical-align: middle;
	}
	.readonly-note {
		margin: -0.25rem 0 0.75rem;
		font-size: 0.85rem;
	}
</style>
