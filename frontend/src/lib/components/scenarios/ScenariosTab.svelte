<script lang="ts">
	// The workspace's Scenarios tab (?tab=scenarios, docs/ui.md § Scenarios,
	// docs/scenarios.md): the project's scenarios, a form to start one on a
	// run, and the chosen one (?scenario=<id>) in the editor. Viewers read
	// every scenario; farmers never reach the workspace (their view is the
	// farm page), and the API refuses them scenarios anyway. An applicant (the
	// contributor role, WP-3.3) gets the same tab in the Applicant view: their
	// own applications, and a new one always starts on the published baseline.
	//
	// Layout (issue #17, option A): the section header carries the counts
	// (summary.ts) and + New scenario, which opens the create dialog at
	// `new=1` (Back closes it). The list is a rail beside the scenario, as tall
	// as the window from where it starts and scrolling inside itself; the
	// scenario is an editing page and scrolls with the page. With none picked
	// the first (newest) opens, in place (replaceState), so there's no empty
	// half-page. The Applicant view has no section header: its New
	// application button sits at the top of the list instead.
	import { tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { api, type Run, type RunMeta, type Scenario, type ScenarioWithCheck } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { fmtDate } from '$lib/format/number';
	import { withParam, withoutParam } from '$lib/workspace/overlays';
	import { guardUnsaved } from '$lib/nav/unsaved';
	import { leavesScenariosTab } from './leaves';
	import ScenarioEditor from './ScenarioEditor.svelte';
	import { scenariosSummary } from './summary';

	let {
		projectId,
		runs,
		canEdit,
		applicant = false,
		publishedRunId = null,
		onRunsChange,
		reloadRuns
	}: {
		projectId: string;
		runs: RunMeta[] | null;
		canEdit: boolean;
		/** The caller is an applicant: applications only, on the published run. */
		applicant?: boolean;
		/** The current publication's run: an applicant's base. */
		publishedRunId?: string | null;
		onRunsChange: (runs: RunMeta[]) => void;
		/**
		 * Re-read the shared run list (the page's loadRuns): a list read before a later change, such as a
		 * scenario run made here (onRunsChange bumps the page's count), is asked for again, never applied (issue #77).
		 */
		reloadRuns: () => Promise<void>;
	} = $props();

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	// --- the list ---------------------------------------------------------------------
	let scenarios = $state<Scenario[] | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	async function loadList() {
		loading = true;
		error = null;
		try {
			scenarios = await api.scenarios.list(projectId);
		} catch (e) {
			error = msg(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void projectId;
		untrack(loadList);
	});

	// --- the chosen scenario (?scenario=) ----------------------------------------------
	const selectedId = $derived(page.url.searchParams.get('scenario'));
	let detail = $state<ScenarioWithCheck | null>(null);
	let detailLoading = $state(false);
	let detailError = $state<string | null>(null);
	let wanted = '';
	async function loadDetail(id: string) {
		wanted = id;
		detailLoading = true;
		detailError = null;
		try {
			const d = await api.scenarios.get(projectId, id);
			if (wanted === id) detail = d;
		} catch (e) {
			if (wanted === id) {
				detail = null;
				detailError = msg(e);
			}
		} finally {
			if (wanted === id) detailLoading = false;
		}
	}
	$effect(() => {
		const id = selectedId;
		untrack(() => {
			if (id && detail?.scenario.id !== id) loadDetail(id);
			if (!id) {
				wanted = '';
				detail = null;
				detailError = null;
			}
		});
	});

	/** Pick a scenario (`replace`: in place, as the default pick is, so Back doesn't stop on the bare list). */
	function select(id: string | null, replace = false) {
		const q = new URLSearchParams(page.url.searchParams);
		if (id) q.set('scenario', id);
		else q.delete('scenario');
		q.delete('new');
		q.delete('base');
		return goto(`?${q}`, { noScroll: true, keepFocus: true, replaceState: replace });
	}
	// None picked: open the first (the newest). Not while the URL asks for the
	// create dialog (it picks the new one), and not while any navigation is in
	// flight: the newest navigation wins in SvelteKit, so a pick started just
	// after a click on + New scenario (the list landing a few ms later) used to
	// cancel the click and drop its `new=1`, and the dialog never opened. The
	// effect re-runs once the navigation settles. It reads the URL (newParam),
	// not createOpen, which an effect sets a step later.
	$effect(() => {
		const first = scenarios?.[0]?.id;
		if (!first || selectedId || newParam || createOpen || navigating.to) return;
		untrack(() => void select(first, true));
	});

	/**
	 * A scenario's base run is cited (kept, no delete or unpin): after one is
	 * created, rebased or deleted, reload the runs so the Runs tab's lock
	 * (RunMeta.citedBy) is current. Best effort, like the page's own list
	 * refresh: on failure the list keeps its values, and the server still
	 * refuses to delete a cited run.
	 */
	async function refreshRuns() {
		// An applicant has no run list (the workspace's routes refuse them).
		if (applicant) return;
		try {
			await reloadRuns();
		} catch {
			// The lists stay as they were (see above).
		}
	}

	function changed(d: ScenarioWithCheck) {
		const rebased = detail?.scenario.id === d.scenario.id && detail.scenario.baseRunId !== d.scenario.baseRunId;
		detail = d;
		scenarios = (scenarios ?? []).map((x) => (x.id === d.scenario.id ? d.scenario : x));
		if (rebased) refreshRuns();
	}
	async function deleted() {
		const id = detail?.scenario.id;
		scenarios = (scenarios ?? []).filter((x) => x.id !== id);
		detail = null;
		select(null);
		refreshRuns();
	}
	async function ran(run: Run, removedRunIds: string[]) {
		const { summary: _s, ...meta } = run;
		if (!applicant) onRunsChange([meta, ...(runs ?? []).filter((x) => x.id !== run.id && !removedRunIds.includes(x.id))]);
		// The scenario's run count and latest run come from the server.
		if (detail) await loadDetail(detail.scenario.id);
		if (detail) changed(detail);
	}

	// --- a new scenario ------------------------------------------------------------------
	/** Runs of the model a scenario can start from: a scenario run can't be a base. */
	const bases = $derived((runs ?? []).filter((r) => !r.scenarioId));
	/** The published run when there is one (what stakeholders see), else the latest. */
	const defaultBase = $derived(bases.find((r) => r.published)?.id ?? bases[0]?.id ?? '');
	let newName = $state('');
	let newBase = $state('');
	let creating = $state(false);
	let createError = $state<string | null>(null);
	async function create(e: SubmitEvent) {
		e.preventDefault();
		const baseRunId = applicant ? (publishedRunId ?? '') : newBase || defaultBase;
		if (!newName.trim() || !baseRunId) return;
		creating = true;
		createError = null;
		try {
			const d = await api.scenarios.create(projectId, { name: newName.trim(), baseRunId });
			scenarios = [d.scenario, ...(scenarios ?? [])];
			detail = d;
			newName = '';
			newBase = '';
			// Drops `new` (which closes the dialog) and replaces its history entry: Back goes to where it was opened from.
			await select(d.scenario.id, true);
			refreshRuns();
		} catch (err) {
			createError = msg(err);
		} finally {
			creating = false;
		}
	}
	// --- the create dialog, open while the URL says `new` (Back closes it) ---
	const newParam = $derived(page.url.searchParams.has('new'));
	/** Who may start one here: an editor with a run to start from, or an applicant once a baseline is published. */
	const canCreate = $derived(applicant ? !!publishedRunId : canEdit && bases.length > 0);
	let createOpen = $state(false);
	$effect(() => {
		createOpen = newParam && (applicant || canEdit);
	});
	$effect(() => {
		// Closed (Cancel, Esc, the ✕): drop `new` in place.
		if (!createOpen && untrack(() => newParam)) {
			void goto(withoutParam(page.url, 'new'), { replaceState: true, noScroll: true, keepFocus: true });
		}
	});
	$effect(() => {
		if (!createOpen) return;
		// Each opening starts empty: a name typed and then cancelled (Cancel, Esc, Back) is thrown away, not shown again.
		newName = '';
		newBase = '';
		createError = null;
		void tick().then(() => document.getElementById('new-scenario-name')?.focus());
	});
	// A name typed into the open dialog is unsaved work: leaving the tab asks first (lib/nav/leaveGuard.ts).
	guardUnsaved({
		dirty: () => createOpen && !!newName.trim(),
		what: () => (applicant ? 'a new application not yet created' : 'a new scenario not yet created'),
		leaves: leavesScenariosTab
	});
	const newHref = $derived(withParam(page.url, 'new', '1'));
	const newLabel = $derived(applicant ? 'New application' : 'New scenario');

	// --- the section header (the Applicant view draws its own, with New application) ---
	const summary = $derived(scenarios ? scenariosSummary(scenarios) : null);
	$effect(() => fillHeader({ context: summary ? headerContext : undefined, actions: headerActions }, !applicant));

	// --- the rail: as tall as the window from where it starts (the playbook's list-beside-detail) ---
	// Measured on the layout, not the rail: a stuck sticky element reports where it is stuck, which grows with the scroll.
	let layoutEl: HTMLElement | undefined = $state();
	let railTop = $state(0);
	$effect(() => {
		if (!layoutEl) return;
		const el = layoutEl;
		const measure = () => (railTop = el.getBoundingClientRect().top + window.scrollY);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		return () => ro.disconnect();
	});

	const runLabel = (r: RunMeta) => `${r.label || 'Untitled run'} · ${fmtDate(r.createdAt, true)}${r.published ? ' · published' : ''}`;
	const STATUS: Record<Scenario['status'], string> = { draft: 'Draft', submitted: 'Submitted', withdrawn: 'Withdrawn', decided: 'Decided' };
</script>

{#snippet headerContext()}<span data-testid="scenarios-summary">{summary}</span>{/snippet}
{#snippet headerActions()}{#if canEdit && bases.length}<a class="btn" href={newHref}>+ New scenario</a>{/if}{/snippet}

<div class="scenarios-page" data-testid="scenarios-page">
<div class="layout" bind:this={layoutEl}>
	<section class="panel rail" style:--rail-top="{railTop}px" aria-labelledby="scenarios-h">
		<!-- Not "Scenarios": the tab body is already the region of that name (landmarks need unique names). -->
		<div class="panel-head">
			<h2 id="scenarios-h">{applicant ? 'Your applications' : 'All scenarios'}</h2>
		</div>
		{#if applicant && !publishedRunId}
			<p class="muted small">Nothing is published yet: an application starts on the published baseline.</p>
		{/if}
		<LoadState {loading} {error} retry={loadList}>
			{#if scenarios?.length}
				<ul class="list" aria-label={applicant ? 'Your applications' : 'Scenarios, newest first'}>
					{#each scenarios as sc (sc.id)}
						<li>
							<button type="button" class="pick" aria-current={sc.id === selectedId || undefined} onclick={() => select(sc.id)}>
								<span class="name">{sc.name}</span>
								<span class="meta">
									<span class="status status-{sc.status}">{STATUS[sc.status]}</span>{sc.origin === 'applicant' && !applicant ? ` application by ${sc.owner ?? 'an applicant'}` : ''} · {sc.ops.length} change{sc.ops.length === 1 ? '' : 's'} · on {sc.baseRun.label || 'Untitled run'}{sc.lastRun ? ` · run ${fmtDate(sc.lastRun.createdAt, true)}` : ''}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{:else}
				<div class="empty">
					<p data-testid="scenarios-empty">
						{applicant
							? 'No applications yet. An application is a set of changes to the published baseline (a bigger dam, a new crop) that you run and then submit to the assessors.'
							: 'No scenarios yet. A scenario changes the published baseline without copying it.'}
					</p>
					{#if !applicant && canEdit}
						{#if bases.length}
							<a class="btn btn-primary" href={newHref}>Start a scenario</a>
						{:else}
							<p class="muted">Run the model first: a scenario is a set of changes to a run.</p>
						{/if}
					{/if}
				</div>
			{/if}
		</LoadState>
	</section>

	<div class="detail">
		{#if selectedId}
			<LoadState loading={detailLoading && !detail} error={detailError} retry={() => selectedId && loadDetail(selectedId)}>
				{#if detail}
					<ScenarioEditor {projectId} data={detail} runs={runs ?? []} {canEdit} {applicant} onchange={changed} ondeleted={deleted} onran={ran} />
				{/if}
			</LoadState>
		{/if}
	</div>
</div>
</div>

{#if canCreate}
	<Dialog bind:open={createOpen} title={newLabel}>
		<form id="new-scenario-form" class="create" onsubmit={create} aria-label={newLabel}>
			<div class="field">
				<label for="new-scenario-name">Name</label>
				<input
					id="new-scenario-name"
					type="text"
					maxlength="100"
					placeholder={applicant ? 'e.g. Raise my dam to 120 000 m³' : 'e.g. Upper dam +20 %'}
					bind:value={newName}
				/>
				{#if applicant}
					<span class="hint">It starts on the published baseline, and only you (and whoever you share it with) see it until you submit it.</span>
				{/if}
			</div>
			{#if !applicant}
				<div class="field">
					<label for="new-scenario-base">Base run</label>
					<select id="new-scenario-base" value={newBase || defaultBase} onchange={(e) => (newBase = e.currentTarget.value)}>
						{#each bases as r (r.id)}<option value={r.id}>{runLabel(r)}</option>{/each}
					</select>
					<span class="hint">The scenario's changes apply to this run's stored inputs, never to the live model.</span>
				</div>
			{/if}
			{#if createError}<p class="err" role="alert">{createError}</p>{/if}
		</form>
		{#snippet actions()}
			<button type="button" class="btn" onclick={() => (createOpen = false)}>Cancel</button>
			<button type="submit" form="new-scenario-form" class="btn btn-primary" disabled={creating || !newName.trim()}
				>{creating ? 'Creating…' : applicant ? 'Create application' : 'Create scenario'}</button
			>
		{/snippet}
	</Dialog>
{/if}

<style>
	.scenarios-page {
		container: scenarios-page / inline-size;
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	.rail {
		margin: 0;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.rail .panel-head {
		flex: 0 0 auto;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 3px;
		display: grid;
		gap: 0.2rem;
		overflow-y: auto;
		/* Stacked (phones, narrow windows): a few rows, then the scenario; the list scrolls inside itself. */
		max-height: 17rem;
	}
	.pick {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.15rem;
		width: 100%;
		min-height: 44px;
		padding: 0.4rem 0.6rem;
		text-align: left;
		border: 1px solid transparent;
		border-radius: var(--radius);
		background: none;
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}
	.pick:hover {
		background: var(--surface-2);
	}
	.pick[aria-current='true'] {
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
	}
	.name {
		font-weight: 600;
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.meta {
		font-size: 0.8rem;
		color: var(--text-2);
		overflow-wrap: anywhere;
	}
	/* The status in words, as a pill: submitted and decided in the accent (the editor's own pills). */
	.status {
		display: inline-block;
		font-size: 0.72rem;
		font-weight: 600;
		padding: 0 0.45rem;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text-2);
		border: 1px solid var(--border);
	}
	.status-submitted,
	.status-decided {
		background: var(--accent-soft);
		color: var(--accent);
		border-color: transparent;
	}
	.empty p {
		color: var(--text-2);
		margin: 0 0 0.75rem;
	}
	.small {
		font-size: 0.85rem;
	}
	.create select {
		width: 100%;
	}
	.hint {
		display: block;
		font-size: 0.82rem;
		color: var(--text-muted);
		margin-top: 0.25rem;
	}
	.err {
		color: var(--danger);
		margin: 0.5rem 0 0;
	}
	.detail {
		min-width: 0;
		display: grid;
		/* One column no wider than the page: a wide table or select inside scrolls, not the page. */
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
	}
	/* Wide (784 px at the 14 px root): the list is a rail beside the scenario, as tall as the window from where it
	   starts (less the save bar), kept in view while the scenario scrolls; its rows scroll inside it. */
	@container scenarios-page (min-width: 56rem) {
		.layout {
			grid-template-columns: minmax(16rem, 21rem) minmax(0, 1fr);
		}
		.rail {
			position: sticky;
			top: 1rem;
			max-height: max(18rem, calc(100vh - var(--rail-top, 0px) - var(--dock-h, 0px) - 1rem));
		}
		.list {
			max-height: none;
			flex: 1 1 auto;
		}
	}
</style>
