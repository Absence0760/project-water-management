<script module lang="ts">
	// Only the Overview tab (the default, first paint) ships in this page's
	// chunk. Every other tab, and the Add data dialog, is its own chunk, fetched
	// when first shown and warmed when its tab link is hovered or focused
	// (docs/architecture.md § Code splitting). Module scope keeps each loader's
	// identity stable, which is what lazy.ts memoises on.
	const LOAD = {
		network: () => import('$lib/components/network/NetworkTab.svelte'),
		crops: () => import('$lib/components/crops/CropsTab.svelte'),
		transfers: () => import('$lib/components/transfers/TransfersTab.svelte'),
		series: () => import('$lib/components/series/SeriesTab.svelte'),
		settings: () => import('$lib/components/settings/SettingsTab.svelte'),
		runs: () => import('$lib/components/runs/RunsTab.svelte'),
		scenarios: () => import('$lib/components/scenarios/ScenariosTab.svelte'),
		applications: () => import('$lib/components/scenarios/ApplicationsTab.svelte'),
		history: () => import('$lib/components/history/HistoryTab.svelte')
	};
	const loadAddData = () => import('$lib/components/series/AddDataDialog.svelte');
	// An applicant's whole view of the project (WP-3.3): the workspace's tabs all refuse them.
	const loadApplicantView = () => import('$lib/components/scenarios/ApplicantView.svelte');
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import type { SeriesMeta } from '@water-management/engine';
	import { chirpsSourceOf } from '$lib/series/provenance';
	import { api, ApiError, hasRole, type Project, type ProjectSummary, type RunMeta } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { prefetch } from '$lib/components/common/lazy';
	import IssueList from '$lib/components/model/IssueList.svelte';
	import SaveBar from '$lib/components/model/SaveBar.svelte';
	import OverviewTab from '$lib/components/overview/OverviewTab.svelte';
	import { describeAge } from '$lib/components/series/coverage';
	import { freshness, newDataSinceRun, STALE_DAYS } from '$lib/components/series/freshness';
	import type { UploadResult } from '$lib/components/series/upload';
	import { fmtDay, localIsoDate } from '$lib/format/number';
	import { kindLabel } from '$lib/series/kinds';
	import { ModelEditor } from '$lib/model/editor.svelte';
	import { hasModelInputsToggle, stripTabs, VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT, visibleTabs } from '$lib/workspace/tabs';

	// Workflow order: describe the catchment, feed it data, calibrate, run.
	const TABS = [
		{ id: 'overview', label: 'Overview' },
		{ id: 'network', label: 'Network' },
		{ id: 'crops', label: 'Crops & demand' },
		{ id: 'transfers', label: 'Transfers' },
		{ id: 'series', label: 'Data' },
		{ id: 'settings', label: 'Settings & calibration' },
		{ id: 'runs', label: 'Runs & results' },
		{ id: 'scenarios', label: 'Scenarios' },
		{ id: 'applications', label: 'Applications' },
		{ id: 'history', label: 'History' }
	] as const;
	type TabId = (typeof TABS)[number]['id'];
	const TAB_IDS: TabId[] = TABS.map((t) => t.id);
	const MODEL_TABS: TabId[] = ['network', 'crops', 'transfers'];
	// Friendlier ?tab= spellings that resolve to the canonical keys above.
	const TAB_ALIASES: Record<string, TabId> = {
		data: 'series',
		timeseries: 'series',
		demand: 'crops',
		calibration: 'settings',
		results: 'runs',
		changes: 'history'
	};

	const projectId = $derived(page.params.id ?? '');
	const tab = $derived.by<TabId>(() => {
		const raw = page.url.searchParams.get('tab') ?? '';
		const t = TAB_ALIASES[raw] ?? raw;
		return TABS.some((x) => x.id === t) ? (t as TabId) : 'overview';
	});

	let project = $state<Project | null>(null);
	/** Set when the caller is an applicant here (the contributor role): the page is the Applicant view. */
	let applicantProject = $state<ProjectSummary | null>(null);
	// Which tabs each role is shown (presentation only; a hidden tab still
	// opens from a deep link, and then shows in the strip while it's open).
	let showModelInputs = $state(VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT);
	const shownIds = $derived(visibleTabs(project?.role, { showModelInputs }, TAB_IDS));
	const stripIds = $derived(stripTabs(shownIds, tab, TAB_IDS));
	const strip = $derived(TABS.filter((t) => stripIds.includes(t.id)));
	let loading = $state(true);
	let error = $state<string | null>(null);
	let notFound = $state(false);
	const editor = new ModelEditor();
	// Shared with the Overview checklist, the Time series tab and the Runs tab.
	let series = $state<SeriesMeta[] | null>(null);
	let runs = $state<RunMeta[] | null>(null);
	let saveBarHeight = $state(0);
	/** The save bar's optional "Reason for this change", kept with the change in the History tab. */
	let saveReason = $state('');

	// --- data freshness, "Add data" (button or drop a CSV anywhere) ------------
	// The viewer's calendar date, as on the project list (projects/freshness.ts).
	const today = localIsoDate();
	const fresh = $derived(freshness(series ?? [], today));

	// The "Data up to" dropdown closes on Escape (focus back on its summary)
	// and on a click outside it, like the other popups.
	let freshEl: HTMLDetailsElement | undefined = $state();
	let freshOpen = $state(false);
	function freshKeydown(e: KeyboardEvent) {
		// Read the element: the toggle event that updates freshOpen is async.
		if (e.key !== 'Escape' || !freshEl?.open) return;
		e.preventDefault();
		freshEl.open = false;
		freshEl.querySelector('summary')?.focus();
	}
	$effect(() => {
		if (!freshOpen) return;
		const onDoc = (e: PointerEvent) => {
			if (freshEl && !freshEl.contains(e.target as Node)) freshOpen = false;
		};
		document.addEventListener('pointerdown', onDoc);
		return () => document.removeEventListener('pointerdown', onDoc);
	});
	const behindRun = $derived(newDataSinceRun(series ?? [], runs?.[0] ?? null));
	let addOpen = $state(false);
	// The dialog's chunk is fetched the first time it's wanted; then it stays mounted.
	let addMounted = $state(false);
	let droppedFile = $state.raw<File | null>(null);
	let dragDepth = $state(0);
	let banner = $state<{ text: string; added: number } | null>(null);
	let rerunning = $state(false);
	let rerunError = $state<string | null>(null);


	function openAddData(file: File | null = null) {
		droppedFile = file;
		addMounted = true;
		addOpen = true;
	}
	const hasFiles = (e: DragEvent) => canEdit && !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
	function onDragEnter(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		if (dragDepth === 0) prefetch(loadAddData);
		dragDepth++;
	}
	function onDragOver(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
	}
	function onDragLeave(e: DragEvent) {
		if (!hasFiles(e)) return;
		dragDepth = Math.max(0, dragDepth - 1);
	}
	function onDrop(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		dragDepth = 0;
		const f = e.dataTransfer?.files?.[0];
		if (f) openAddData(f);
	}

	async function onUploaded(r: UploadResult) {
		await loadLists();
		const what = r.meta.name || kindLabel(r.meta.kind);
		banner = {
			text: r.added || r.changed ? `${r.message.replace(/\.$/, '')}.` : `No new days for “${what}”: the file matched what is stored.`,
			added: r.added + r.changed
		};
	}

	async function rerun() {
		rerunning = true;
		rerunError = null;
		try {
			const { run: r, removedRunIds } = await api.runs.create(projectId, `Data to ${fresh?.latest ?? today}`);
			const { summary: _s, ...meta } = r;
			runs = [meta, ...(runs ?? []).filter((x) => x.id !== r.id && !removedRunIds.includes(x.id))];
			banner = null;
			await goto(`?tab=runs&run=${r.id}`, { noScroll: true });
		} catch (e) {
			rerunError = e instanceof Error ? e.message : String(e);
		} finally {
			rerunning = false;
		}
	}

	const canEdit = $derived(hasRole(project?.role, 'editor'));
	const isOwner = $derived(hasRole(project?.role, 'owner'));

	async function load() {
		loading = true;
		error = null;
		notFound = false;
		applicantProject = null;
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
			// A farmer gets 403 from the workspace's routes: their view of this
			// project is the farm page (WP-2.6). An applicant's is the Applicant
			// view (WP-3.3).
			if (e instanceof ApiError && e.status === 403) {
				const here = await summaryHere();
				if (here?.role === 'farmer') {
					await goto(`${base}/farm/${encodeURIComponent(projectId)}`, { replaceState: true });
					return;
				}
				if (here?.role === 'contributor') {
					applicantProject = here;
					return;
				}
			}
			if (e instanceof ApiError && e.status === 404) notFound = true;
			else error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	/** This project as the project list shows it to the caller (their role), or null. */
	async function summaryHere(): Promise<ProjectSummary | null> {
		try {
			return (await api.projects.list()).find((p) => p.id === projectId) ?? null;
		} catch {
			return null;
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
			editor.load(await api.model.save(projectId, editor.snapshot(), saveReason.trim() || undefined));
			saveReason = '';
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

	/** A restore (History tab, or a run's "Restore these inputs") changed the saved settings and model. */
	async function reloadInputs() {
		const [p, m] = await Promise.all([api.projects.get(projectId), api.model.get(projectId)]);
		project = p;
		editor.load(m);
	}

	async function onLeftProject() {
		await goto(`${base}/`);
	}

	// Start the open tab's chunk alongside the project fetch; warm the others
	// when their tab link is hovered or focused.
	function warmTab(id: TabId) {
		if (id !== 'overview') prefetch(LOAD[id]);
	}
	$effect(() => warmTab(tab));

	// Keep the active tab in view in the scrolling strip (phones).
	let tabStrip: HTMLElement | undefined = $state();
	$effect(() => {
		void tab;
		tabStrip?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});

	function tabKeydown(e: KeyboardEvent, idx: number) {
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
		e.preventDefault();
		const next = strip[(idx + (e.key === 'ArrowRight' ? 1 : strip.length - 1)) % strip.length]!;
		goto(tabHref(next.id), { keepFocus: false, noScroll: true }).then(() =>
			document.getElementById(`tab-${next.id}`)?.focus()
		);
	}
</script>

<svelte:head><title>{project ? `${project.name} · ` : ''}Water Management</title></svelte:head>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<main
	class="page"
	style:--dock-h="{saveBarHeight}px"
	ondragenter={onDragEnter}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
>
	<LoadState {loading} error={notFound ? null : error} retry={load}>
		{#if applicantProject}
			<Lazy load={loadApplicantView}>
				{#snippet children(ApplicantView)}<ApplicantView project={applicantProject!} />{/snippet}
			</Lazy>
		{:else if notFound || !project}
			<div class="alert alert-error" role="alert">
				This project doesn't exist or you don't have access to it. <a href="{base}/">Back to projects</a>
			</div>
		{:else}
			<div class="head">
				<nav class="crumbs" aria-label="Breadcrumb"><a href="{base}/">Projects</a> <span aria-hidden="true">/</span></nav>
				<h1>{project.name}</h1>
				<span class="badge" class:badge-owner={isOwner}>{project.role}</span>
				{#if editor.dirty && canEdit}<span class="badge badge-warn">Unsaved changes</span>{/if}
				<div class="head-actions">
					{#if fresh}
						<details class="fresh" class:stale={fresh.stale} bind:this={freshEl} bind:open={freshOpen} onkeydown={freshKeydown}>
							<summary>
								<span class="dot" aria-hidden="true"></span>
								{#if fresh.latest !== null && fresh.age !== null}
									Rain up to <strong>{fmtDay(fresh.latest)}</strong> · {describeAge(fresh.age)}{#if fresh.stale}<span class="visually-hidden">{` (older than ${STALE_DAYS} days)`}</span>{/if}
								{:else}
									No recorded rain yet
								{/if}
							</summary>
							<div class="fresh-pop">
								<table class="data compact">
									<thead><tr><th scope="col">Series</th><th scope="col" class="num">Up to</th><th scope="col" class="num">Age</th></tr></thead>
									<tbody>
										{#each fresh.perSeries as p (p.id)}
											<tr><th scope="row">{kindLabel(p.kind)}{p.name ? ` · ${p.name}` : ''}</th><td class="num">{p.end}</td><td class="num">{describeAge(p.age)}</td></tr>
										{/each}
									</tbody>
								</table>
								<p class="muted">
									Flagged when the newest recorded rain (catchment or CHIRPS) is more than {STALE_DAYS} days old. A forecast
									and flow series don't count: runs are driven by the recorded rain.
								</p>
							</div>
						</details>
					{:else if series}
						<span class="fresh-none muted">No data yet</span>
					{/if}
					{#if canEdit}
						<button
							type="button"
							class="btn btn-primary add"
							onclick={() => openAddData()}
							onpointerenter={() => prefetch(loadAddData)}
							onfocus={() => prefetch(loadAddData)}
						>
							<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 11V2M4.5 5.5 8 2l3.5 3.5M2 11v3h12v-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
							Add data
						</button>
					{/if}
				</div>
			</div>

			{#if banner}
				<div class="alert alert-success-ish" role="status">
					<span>{banner.text}</span>
					{#if canEdit && banner.added > 0}
						<button type="button" class="btn btn-primary btn-sm" disabled={rerunning} onclick={rerun}>{rerunning ? 'Running model…' : 'Re-run model'}</button>
					{/if}
					<button type="button" class="btn btn-ghost btn-sm" onclick={() => (banner = null)}>Dismiss</button>
					{#if rerunError}<span class="err">{rerunError}</span>{/if}
				</div>
			{:else if behindRun.length && tab !== 'runs' && tab !== 'series'}
				<div class="alert alert-info behind" role="status">
					<span>New data since the last run ({behindRun.map((s) => s.name || kindLabel(s.kind)).join(', ')}).</span>
					{#if canEdit}<button type="button" class="btn btn-sm" disabled={rerunning} onclick={rerun}>{rerunning ? 'Running model…' : 'Re-run model'}</button>{/if}
				</div>
			{/if}

			<div class="tab-row">
				<nav class="tabs" aria-label="Project sections" bind:this={tabStrip}>
					{#each strip as t, i (t.id)}
						<a
							id="tab-{t.id}"
							href={tabHref(t.id)}
							data-sveltekit-noscroll
							aria-current={tab === t.id ? 'page' : undefined}
							onkeydown={(e) => tabKeydown(e, i)}
							onpointerenter={() => warmTab(t.id)}
							onfocus={() => warmTab(t.id)}
						>
							{t.label}
							{#if MODEL_TABS.includes(t.id) && editor.issues.some((x) => x.area === t.id)}
								<span class="issue-dot" title="Has problems to fix"><span class="visually-hidden">(has problems)</span></span>
							{/if}
						</a>
					{/each}
				</nav>
				{#if hasModelInputsToggle(project.role)}
					<label class="inputs-toggle">
						<input type="checkbox" bind:checked={showModelInputs} />
						Show model inputs
					</label>
				{/if}
			</div>

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
						{series}
						{runs}
						{canEdit}
						{isOwner}
						currentUserId={session.user?.id ?? ''}
						visibleTabs={shownIds}
						{onProjectChange}
						{onLeftProject}
					/>
				{:else if tab === 'network'}
					<IssueList issues={editor.issues} area="network" />
					<Lazy load={LOAD.network}>
						{#snippet children(NetworkTab)}<NetworkTab {editor} settings={project!.settings} readonly={!canEdit} {projectId} {runs} />{/snippet}
					</Lazy>
				{:else if tab === 'crops'}
					<IssueList issues={editor.issues} area="crops" />
					<Lazy load={LOAD.crops}>
						{#snippet children(CropsTab)}<CropsTab {editor} settings={project!.settings} readonly={!canEdit} />{/snippet}
					</Lazy>
				{:else if tab === 'transfers'}
					<IssueList issues={editor.issues} area="transfers" />
					<Lazy load={LOAD.transfers}>
						{#snippet children(TransfersTab)}<TransfersTab {editor} readonly={!canEdit} />{/snippet}
					</Lazy>
				{:else if tab === 'settings'}
					<Lazy load={LOAD.settings}>
						{#snippet children(SettingsTab)}
							<SettingsTab
								project={project!}
								{editor}
								seriesKinds={series?.map((x) => x.kind) ?? null}
								chirpsSource={chirpsSourceOf(series)}
								readonly={!canEdit}
								{onProjectChange}
							/>
						{/snippet}
					</Lazy>
				{:else if tab === 'series'}
					<Lazy load={LOAD.series}>
						{#snippet children(SeriesTab)}
							<SeriesTab {projectId} readonly={!canEdit} initial={series} {runs} settings={project!.settings} onSeriesChange={(l) => (series = l)} />
						{/snippet}
					</Lazy>
				{:else if tab === 'runs'}
					<Lazy load={LOAD.runs}>
						{#snippet children(RunsTab)}
							<RunsTab
								{projectId}
								project={project!}
								{editor}
								{series}
								{runs}
								canRun={canEdit}
								modelDirty={editor.dirty}
								onRunsChange={(l) => (runs = l)}
								onInputsRestored={reloadInputs}
							/>
						{/snippet}
					</Lazy>
				{:else if tab === 'scenarios'}
					<Lazy load={LOAD.scenarios}>
						{#snippet children(ScenariosTab)}<ScenariosTab {projectId} {runs} {canEdit} onRunsChange={(l) => (runs = l)} />{/snippet}
					</Lazy>
				{:else if tab === 'applications'}
					<Lazy load={LOAD.applications}>
						{#snippet children(ApplicationsTab)}<ApplicationsTab {projectId} />{/snippet}
					</Lazy>
				{:else if tab === 'history'}
					<Lazy load={LOAD.history}>
						{#snippet children(HistoryTab)}<HistoryTab {projectId} {editor} {canEdit} onRestored={reloadInputs} />{/snippet}
					</Lazy>
				{/if}
			</section>

			<SaveBar {editor} onsave={saveModel} readonly={!canEdit} bind:height={saveBarHeight} bind:reason={saveReason} />
			{#if canEdit}
				{#if addMounted}
					<Lazy load={loadAddData}>
						{#snippet children(AddDataDialog)}
							<AddDataDialog bind:open={addOpen} {projectId} list={series ?? []} file={droppedFile} onuploaded={onUploaded} />
						{/snippet}
					</Lazy>
				{/if}
				{#if dragDepth > 0}
					<div class="drop" aria-hidden="true"><div>Drop the CSV to add daily data to {project.name}</div></div>
				{/if}
				<p class="visually-hidden" aria-live="polite">{dragDepth > 0 ? 'Drop the file to add data.' : ''}</p>
			{/if}
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
	.head-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.add {
		min-height: 36px;
	}
	.fresh {
		position: relative;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.fresh summary {
		cursor: pointer;
		list-style: none;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.3rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		min-height: 36px;
	}
	.fresh summary::-webkit-details-marker {
		display: none;
	}
	.fresh .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--success);
	}
	.fresh.stale summary {
		border-color: color-mix(in srgb, var(--warning) 50%, var(--border));
		background: var(--warning-soft);
		color: var(--warning);
	}
	.fresh.stale .dot {
		background: var(--warning);
	}
	.fresh-pop {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		z-index: 35;
		width: min(440px, calc(100vw - 2 * var(--gutter)));
		padding: 0.6rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.14);
	}
	.fresh-pop p {
		margin: 0.4rem 0 0;
		font-size: 0.78rem;
	}
	.fresh-none {
		font-size: 0.85rem;
	}
	.alert-success-ish,
	.behind {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.alert-success-ish {
		background: var(--success-soft);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
		color: var(--text);
	}
	.alert-success-ish > span:first-child,
	.behind > span:first-child {
		flex: 1;
		min-width: 12rem;
	}
	.err {
		color: var(--danger);
	}
	.drop {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem;
		background: color-mix(in srgb, var(--bg) 75%, transparent);
		pointer-events: none;
	}
	.drop div {
		padding: 2.5rem 3rem;
		border: 3px dashed var(--accent);
		border-radius: 12px;
		background: var(--surface);
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--accent);
		text-align: center;
	}
	@media (max-width: 640px) {
		.head-actions {
			margin-left: 0;
			width: 100%;
		}
		.add,
		.fresh summary {
			min-height: 44px;
		}
	}
	.crumbs {
		color: var(--text-muted);
	}
	/* The strip scrolls sideways on phones. The underline is drawn inside each
	   tab (inset shadow), so nothing overflows vertically and no stray vertical
	   scrollbar appears with classic (always-visible) scrollbars. */
	.tab-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		box-shadow: inset 0 -1px 0 var(--border);
		margin-bottom: 1rem;
	}
	.tabs {
		display: flex;
		flex: 1 1 auto;
		min-width: 0;
		gap: 0.15rem;
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
	/* A viewer's "Show model inputs" (lib/workspace/tabs.ts), at the strip's end. */
	.inputs-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		flex: none;
		min-height: 44px;
		padding: 0 0.25rem;
		color: var(--text-2);
		font-size: 0.875rem;
		white-space: nowrap;
		cursor: pointer;
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
	/* Absolutely positioned bits inside wide tables (visually-hidden labels)
	   must be clipped by their scroll container, not widen the page. */
	.tab-body :global(.table-wrap) {
		position: relative;
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
