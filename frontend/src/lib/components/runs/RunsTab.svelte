<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api, type Run, type RunMeta, type RunSeriesRef } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fmtDate } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import RunChart from './RunChart.svelte';
	import RunSummaryView from './RunSummaryView.svelte';

	let {
		projectId,
		editor,
		canRun,
		modelDirty
	}: { projectId: string; editor: ModelEditor; canRun: boolean; modelDirty: boolean } = $props();

	let runs = $state<RunMeta[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	let label = $state('');
	let running = $state(false);

	const selectedId = $derived(page.url.searchParams.get('run'));
	let detail = $state<{ run: Run; series: RunSeriesRef[] } | null>(null);
	let detailLoading = $state(false);
	let detailError = $state<string | null>(null);

	const nodeNames = $derived.by(() => {
		const m = new Map(editor.model.nodes.map((n) => [n.id, n.name] as [string, string]));
		for (const f of detail?.run.summary.farms ?? []) if (!m.has(f.nodeId)) m.set(f.nodeId, f.name);
		return m;
	});

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load() {
		loading = true;
		loadError = null;
		try {
			runs = await api.runs.list(projectId);
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function select(id: string | null) {
		const url = new URL(page.url);
		if (id) url.searchParams.set('run', id);
		else url.searchParams.delete('run');
		goto(url, { replaceState: true, noScroll: true, keepFocus: true });
	}

	let detailFor = '';
	async function loadDetail(id: string) {
		detailFor = id;
		detailLoading = true;
		detailError = null;
		try {
			const d = await api.runs.get(projectId, id);
			if (detailFor === id) detail = d;
		} catch (e) {
			if (detailFor === id) {
				detail = null;
				detailError = msg(e);
			}
		} finally {
			if (detailFor === id) detailLoading = false;
		}
	}

	// Load details when the ?run= selection changes (only then — a failed load
	// must not re-trigger itself; the error state offers a retry).
	$effect(() => {
		const id = selectedId;
		untrack(() => {
			if (id && id !== detailFor) loadDetail(id);
			else if (!id) {
				detail = null;
				detailFor = '';
			}
		});
	});

	// Default to the newest run once the list arrives.
	$effect(() => {
		if (!loading && !selectedId && runs.length) select(runs[0]!.id);
	});

	async function run(e: SubmitEvent) {
		e.preventDefault();
		running = true;
		actionError = null;
		try {
			const r = await api.runs.create(projectId, label.trim() || undefined);
			label = '';
			const { summary: _summary, ...meta } = r;
			runs = [meta, ...runs.filter((x) => x.id !== r.id)];
			detail = null;
			detailFor = '';
			select(r.id);
		} catch (err) {
			actionError = msg(err);
		} finally {
			running = false;
		}
	}

	async function remove(r: RunMeta) {
		if (!confirm(`Delete run "${r.label || fmtDate(r.createdAt, true)}"?`)) return;
		actionError = null;
		try {
			await api.runs.remove(projectId, r.id);
			runs = runs.filter((x) => x.id !== r.id);
			if (selectedId === r.id) select(runs[0]?.id ?? null);
		} catch (err) {
			actionError = msg(err);
		}
	}
</script>

{#if canRun}
	<form class="panel run-bar" onsubmit={run}>
		<div class="field grow">
			<label for="run-label">Run label <span class="muted">(optional)</span></label>
			<input id="run-label" maxlength="200" placeholder="e.g. Baseline, 2026 dam raise" bind:value={label} />
		</div>
		<button type="submit" class="btn btn-primary" disabled={running}>
			{running ? 'Running model…' : 'Run model'}
		</button>
		{#if modelDirty}
			<p class="note" role="status">The model has unsaved changes — runs use the last saved version.</p>
		{/if}
	</form>
{/if}

{#if actionError}<div class="alert alert-error" role="alert">{actionError}</div>{/if}

<div class="layout">
	<section class="panel list" aria-labelledby="runs-h">
		<div class="panel-head"><h2 id="runs-h">Runs</h2></div>
		<LoadState
			{loading}
			error={loadError}
			retry={load}
			empty={runs.length === 0}
			emptyText={canRun ? 'No runs yet. Run the model to see results.' : 'No runs yet.'}
		>
			<ul class="runs">
				{#each runs as r (r.id)}
					<li class:active={r.id === selectedId}>
						<button type="button" class="pick" aria-current={r.id === selectedId || undefined} onclick={() => select(r.id)}>
							<span class="lbl">{r.label || 'Untitled run'}</span>
							<span class="meta">{fmtDate(r.createdAt, true)} · {r.startDate} → {r.endDate}</span>
							<span class="meta">engine {r.engineVersion}</span>
						</button>
						{#if canRun}
							<button type="button" class="btn btn-icon" aria-label="Delete run {r.label || fmtDate(r.createdAt, true)}" title="Delete run" onclick={() => remove(r)}>✕</button>
						{/if}
					</li>
				{/each}
			</ul>
		</LoadState>
	</section>

	<div class="detail">
		{#if selectedId}
			<LoadState loading={detailLoading && !detail} error={detailError} retry={() => selectedId && loadDetail(selectedId)}>
				{#if detail}
					<section class="panel" aria-labelledby="res-h">
						<div class="panel-head">
							<h2 id="res-h">{detail.run.label || 'Untitled run'}</h2>
							<span class="muted small">
								{detail.run.startDate} → {detail.run.endDate} · run {fmtDate(detail.run.createdAt, true)}
							</span>
						</div>
						<RunChart {projectId} runId={detail.run.id} refs={detail.series} {nodeNames} />
					</section>
					<section class="panel" aria-label="Run summary">
						<RunSummaryView summary={detail.run.summary} />
					</section>
				{/if}
			</LoadState>
		{:else if !loading && runs.length === 0}
			<div class="panel placeholder muted">Results appear here after a run.</div>
		{/if}
	</div>
</div>

<style>
	.run-bar {
		display: flex;
		align-items: flex-end;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.run-bar .field {
		margin: 0;
	}
	.grow {
		flex: 1;
		max-width: 420px;
	}
	.grow input {
		width: 100%;
	}
	.note {
		width: 100%;
		margin: 0;
		color: var(--warning);
		font-size: 0.85rem;
	}
	.layout {
		display: grid;
		grid-template-columns: 280px minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 900px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.runs {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.runs li {
		display: flex;
		align-items: flex-start;
		border-bottom: 1px solid var(--border);
	}
	.runs li:last-child {
		border-bottom: 0;
	}
	.runs li.active {
		background: var(--accent-soft);
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.pick {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		text-align: left;
		background: none;
		border: 0;
		padding: 0.55rem 0.6rem;
		font: inherit;
		color: inherit;
		cursor: pointer;
		min-width: 0;
	}
	.pick:hover {
		background: var(--row-hover);
	}
	.lbl {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		font-size: 0.75rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.runs .btn-icon {
		margin: 0.45rem 0.3rem 0 0;
	}
	.small {
		font-size: 0.8rem;
	}
	.placeholder {
		text-align: center;
		padding: 3rem 1rem;
	}
</style>
