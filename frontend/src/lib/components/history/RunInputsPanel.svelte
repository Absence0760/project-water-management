<!--
	On a run (Runs tab, WP-2.4): "Changes since this run", the input lines
	between the run's own snapshot and the saved inputs now, with the changes
	recorded since, and for an editor "Restore these inputs", which saves the
	run's settings and model back as a new change (docs/ui.md § Runs).
-->
<script lang="ts">
	import { isScenarioRun } from '$lib/components/runs/scenarioRun';
	import type { InputChange } from '@water-management/engine';
	import { api, type HistoryRevision, type Relink, type RunMeta } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import ChangesList from '$lib/components/compare/ChangesList.svelte';
	import { fmtDate } from '$lib/format/number';
	import { revisionLines, revisionTitle } from './timeline';

	let {
		projectId,
		run,
		canEdit,
		modelDirty,
		onRestored
	}: {
		projectId: string;
		run: RunMeta;
		canEdit: boolean;
		/** Unsaved model edits: a restore would replace what they're based on, so it waits. */
		modelDirty: boolean;
		onRestored?: () => Promise<void>;
	} = $props();

	const uid = $props.id();
	const scenarioRun = $derived(isScenarioRun(run));

	let changes = $state<InputChange[] | null>(null);
	let revisions = $state<HistoryRevision[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let open = $state(false);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	async function load() {
		loading = true;
		error = null;
		try {
			const r = await api.history.changesSince(projectId, run.id);
			changes = r.changes;
			revisions = r.revisions;
		} catch (e) {
			error = msg(e);
		} finally {
			loading = false;
		}
	}
	function toggle(e: Event) {
		open = (e.currentTarget as HTMLDetailsElement).open;
		if (open && changes === null && !loading) load();
	}

	let confirmOpen = $state(false);
	let reason = $state('');
	let restoring = $state(false);
	let restoreError = $state<string | null>(null);
	let restored = $state<Relink[] | null>(null);

	async function askRestore() {
		restoreError = null;
		reason = '';
		confirmOpen = true;
		if (changes === null) await load();
	}
	const canRestore = $derived(!restoring && changes !== null && changes.some((c) => c.area !== 'series'));
	async function restore() {
		if (restoring) return;
		restoring = true;
		restoreError = null;
		try {
			const res = await api.history.restoreRunInputs(projectId, run.id, reason.trim() || undefined);
			confirmOpen = false;
			restored = res.relink;
			await onRestored?.();
			await load();
		} catch (e) {
			restoreError = msg(e);
		} finally {
			restoring = false;
		}
	}
</script>

<section aria-labelledby="{uid}-h" class="since">
	<details ontoggle={toggle}>
		<summary><h3 id="{uid}-h">Changes since this run</h3></summary>
		{#if loading && changes === null}
			<p class="muted" role="status">Loading…</p>
		{:else if error}
			<div class="alert alert-error" role="alert">{error} <button type="button" class="btn btn-sm" onclick={load}>Try again</button></div>
		{:else if changes}
			{#if changes.length === 0}
				<p class="muted">The saved inputs are the ones this run used.</p>
			{:else}
				<p class="muted small">From this run’s inputs to the saved inputs now (series compared by their fingerprints):</p>
				<ChangesList {changes} />
			{/if}
			{#if revisions.length}
				<h4>Recorded since the run</h4>
				<ul class="revs">
					{#each revisions as r (r.id)}
						<li>
							<span class="muted">{fmtDate(r.createdAt, true)}{r.actor ? ` · ${r.actor}` : ''}</span> — {revisionTitle(r)}:
							{revisionLines(r).join('; ')}{#if r.reason} <em>({r.reason})</em>{/if}
						</li>
					{/each}
				</ul>
				<a class="small" href="?tab=history">Open the full history</a>
			{/if}
		{/if}
	</details>
	{#if canEdit}
		<div class="restore-row">
			{#if scenarioRun}
				<p class="muted small">A scenario run’s inputs are its scenario’s changes on the base run, so they can’t be restored into the project.</p>
			{:else}
				<button type="button" class="btn btn-sm" onclick={askRestore} disabled={modelDirty} title={modelDirty ? 'Save or discard your unsaved model changes first' : undefined}>
					Restore these inputs
				</button>
				<span class="muted small">Puts back the settings and model this run used, as a new change. Series values stay as they are.</span>
			{/if}
		</div>
		{#if restored}
			<div class="alert alert-success-ish" role="status">
				This run’s inputs are restored. Run the model again to see them in the results.
				{#if restored.length}
					Farmers to link again (<a href="?tab=project#farmers-h">Project page</a>): {restored.map((r) => `${r.displayName} to ${r.nodeName}`).join(', ')}.
				{/if}
			</div>
		{/if}
	{/if}
</section>

<Dialog bind:open={confirmOpen} title="Restore this run’s inputs?" wide>
	<p>
		The settings and model go back to what the run “{run.label || 'Untitled run'}” of {fmtDate(run.createdAt, true)} used. This is saved as a new change in the
		History tab. Series values aren’t part of it.
	</p>
	{#if changes === null && error}
		<!-- The load failed: say so here, where the question is, not only in the closed "Changes since this run" above. -->
		<div class="alert alert-error" role="alert">{error} <button type="button" class="btn btn-sm" onclick={load} disabled={loading}>Try again</button></div>
	{:else if changes === null}
		<p class="muted" role="status">Working out what changes…</p>
	{:else if changes.filter((c) => c.area !== 'series').length === 0}
		<p class="muted">The saved settings and model already match this run.</p>
	{:else}
		<p class="small">Restoring undoes these differences:</p>
		<ChangesList changes={changes.filter((c) => c.area !== 'series')} />
	{/if}
	<!-- A form, so Enter in the reason restores (the action row's button submits it). -->
	<form
		id="{uid}-restore"
		class="field"
		onsubmit={(e) => {
			e.preventDefault();
			if (canRestore) restore();
		}}
	>
		<label for="{uid}-reason">Reason for restoring <span class="muted">(optional)</span></label>
		<input id="{uid}-reason" maxlength="500" bind:value={reason} />
	</form>
	{#if restoreError}<div class="alert alert-error" role="alert">{restoreError}</div>{/if}
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (confirmOpen = false)}>Cancel</button>
		<button type="submit" form="{uid}-restore" class="btn btn-primary" disabled={!canRestore}>
			{restoring ? 'Restoring…' : 'Restore'}
		</button>
	{/snippet}
</Dialog>

<style>
	.since {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	summary {
		cursor: pointer;
	}
	summary h3 {
		display: inline;
		margin: 0;
		font-size: 1rem;
	}
	h4 {
		margin: 0.75rem 0 0.3rem;
		font-size: 0.9rem;
	}
	.revs {
		margin: 0 0 0.4rem;
		padding-left: 1.1rem;
	}
	.revs li {
		overflow-wrap: anywhere;
	}
	.restore-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.6rem;
	}
	.restore-row p {
		margin: 0;
	}
	.alert-success-ish {
		margin-top: 0.5rem;
		background: var(--success-soft);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
		color: var(--text);
	}
	.field input {
		width: 100%;
	}
	@media (max-width: 640px) {
		.restore-row .btn {
			min-height: 44px;
		}
	}
</style>
