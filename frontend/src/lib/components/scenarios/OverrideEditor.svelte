<script module lang="ts">
	// The workspace's own Network, Crops and Transfers tabs, each its own chunk
	// (the same modules the workspace page loads, so the same chunks).
	const LOAD = {
		network: () => import('$lib/components/network/NetworkTab.svelte'),
		crops: () => import('$lib/components/crops/CropsTab.svelte'),
		transfers: () => import('$lib/components/transfers/TransfersTab.svelte')
	};
</script>

<script lang="ts">
	// Override mode (docs/ui.md § Scenarios, docs/scenarios.md § UI): the
	// Network, Crops and Transfers tables on a copy of the scenario's model
	// (its base run's snapshot with its changes applied), in their own
	// ModelEditor. The live model is never loaded or saved here. "Record" turns
	// the edits into changes (overrideDiff.ts diffModel: each op through the
	// "Add a change" form's check, the list checked to give back the edited
	// model) and hands them to the scenario editor, which appends them with
	// one PATCH, as the form does. Edits no op can express are listed and
	// block recording; nothing is dropped silently.
	import { untrack } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import type { ModelInput, ProjectSettings, ScenarioOp } from '@water-management/engine';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { provideUnsaved } from '$lib/components/common/chunkFailed';
	import IssueList from '$lib/components/model/IssueList.svelte';
	import { ModelEditor } from '$lib/model/editor.svelte';
	import OpList from './OpList.svelte';
	import { namesOf, opItems } from './ops';
	import { diffModel } from './overrideDiff';

	let {
		scenarioName,
		input,
		loadKey,
		saving,
		anonymisedCount = 0,
		onrecord,
		onclose,
		dirty = $bindable(false)
	}: {
		scenarioName: string;
		/** The model the edits start from: the base run's snapshot with the scenario's changes applied. */
		input: ModelInput;
		/** Changes when the scenario's changes or base do: the editor then reloads from `input`. */
		loadKey: string;
		saving: boolean;
		/**
		 * Nodes an applicant sees only by kind and an anonymous name (WP-3.3):
		 * their values are blanks, not the base's, so an edit isn't described
		 * "from" them.
		 */
		anonymisedCount?: number;
		/** Append these changes to the scenario; true once saved. */
		onrecord: (ops: ScenarioOp[]) => Promise<boolean>;
		onclose: () => void;
		/** Edits not yet recorded. */
		dirty?: boolean;
	} = $props();

	const editor = new ModelEditor();
	// A table whose chunk fails to download warns about unrecorded edits before offering a reload.
	provideUnsaved(() => editor.dirty);
	let loaded = $state.raw<ModelInput | null>(null);
	$effect(() => {
		void loadKey;
		untrack(() => {
			editor.load(input.model);
			loaded = input;
		});
	});
	$effect(() => {
		dirty = editor.dirty;
	});

	type Area = 'network' | 'crops' | 'transfers';
	const AREAS: { id: Area; label: string }[] = [
		{ id: 'network', label: 'Network' },
		{ id: 'crops', label: 'Crops' },
		{ id: 'transfers', label: 'Transfers' }
	];
	let area = $state<Area>('network');

	const diff = $derived(editor.dirty && loaded ? diffModel(loaded, editor.snapshot()) : null);
	const blocking = $derived(editor.issues.length);
	const pending = $derived(diff && loaded ? opItems(diff.ops, null, null, anonymisedCount ? null : loaded, namesOf([editor.model, loaded.model], diff.ops)) : null);
	const canRecord = $derived(!!diff && diff.ops.length > 0 && !diff.unsupported.length && !diff.problems.length && !blocking && !saving);
	let note = $state('');

	async function record() {
		if (!diff || !canRecord) return;
		const n = diff.ops.length;
		if (await onrecord(diff.ops)) note = `${n === 1 ? '1 change' : `${n} changes`} recorded in “${scenarioName}”.`;
	}
	const LEAVE = "Your edits to the scenario haven't been recorded. Leave override mode and lose them?";
	function close() {
		if (editor.dirty && !confirm(LEAVE)) return;
		onclose();
	}
	// A navigation that stays on this scenario (only other URL parameters
	// change) keeps override mode and its edits: only leaving the scenario
	// (another tab, scenario or page, or the browser) asks.
	const leaves = (to: URL | undefined) =>
		!to ||
		to.pathname !== page.url.pathname ||
		['tab', 'scenario'].some((k) => to.searchParams.get(k) !== page.url.searchParams.get(k));
	beforeNavigate((nav) => {
		if (editor.dirty && leaves(nav.to?.url) && !confirm(LEAVE)) nav.cancel();
	});

	// Opened below the fold on a long scenario, the sticky "Edits to record" bar would cover this banner and its
	// Close button (issue #17): bring the banner to the top once, when override mode opens.
	let modeEl: HTMLElement | undefined = $state();
	$effect(() => {
		if (!modeEl) return;
		untrack(() => modeEl?.scrollIntoView({ block: 'start' }));
	});
</script>

<svelte:window
	onbeforeunload={(e) => {
		if (editor.dirty) e.preventDefault();
	}}
/>

<section class="panel override" bind:this={modeEl} aria-labelledby="override-h" data-testid="override-mode">
	<div class="banner" role="note">
		<h2 id="override-h">Editing the scenario “{scenarioName}”, not the catchment</h2>
		<p>
			These tables start from the scenario's base run with its changes applied. What you edit here is recorded as changes to this
			scenario; the catchment's own model (the Network, Crops and Transfers tabs) is not touched.
		</p>
		{#if anonymisedCount}
			<p data-testid="override-anonymised">
				Other hydrological units and users appear under an anonymous name with their values blank, as in the published baseline you can see. A value you
				enter on one replaces the baseline's own, which you can't see, and is a baseline assumption.
			</p>
		{/if}
		<button type="button" class="btn btn-sm" onclick={close}>Close override mode</button>
	</div>
	<div class="seg" role="group" aria-label="Part of the model">
		{#each AREAS as a (a.id)}
			<button type="button" class="btn btn-sm" aria-pressed={area === a.id} onclick={() => (area = a.id)}>{a.label}</button>
		{/each}
	</div>
</section>

<div class="tables">
	<IssueList issues={editor.issues} {area} />
	{#if area === 'network'}
		<Lazy load={LOAD.network}>
			{#snippet children(NetworkTab)}<NetworkTab {editor} settings={input.settings as ProjectSettings} readonly={false} only="table" />{/snippet}
		</Lazy>
	{:else if area === 'crops'}
		<Lazy load={LOAD.crops}>
			{#snippet children(CropsTab)}<CropsTab {editor} settings={input.settings as ProjectSettings} readonly={false} sections={['factors', 'areas', 'demand']} />{/snippet}
		</Lazy>
	{:else}
		<Lazy load={LOAD.transfers}>
			{#snippet children(TransfersTab)}<TransfersTab {editor} readonly={false} />{/snippet}
		</Lazy>
	{/if}
</div>

<section class="panel record" aria-labelledby="record-h" data-testid="override-record">
	<h2 id="record-h">Edits to record</h2>
	{#if !editor.dirty}
		<p class="muted">No edits yet. Change a value in the tables above; each edit becomes a change to “{scenarioName}”.</p>
	{:else if diff}
		{#if diff.unsupported.length}
			<div class="alert alert-warning" role="status">
				<strong>{diff.unsupported.length === 1 ? 'This edit' : 'These edits'} can't be recorded as a scenario change:</strong>
				<ul>
					{#each diff.unsupported as u, i (i)}<li>{u}</li>{/each}
				</ul>
				Undo {diff.unsupported.length === 1 ? 'it' : 'them'} (or discard every edit) to record the rest.
			</div>
		{/if}
		{#if diff.problems.length}
			<div class="alert alert-warning" role="status">
				<strong>Fix before recording:</strong>
				<ul>
					{#each diff.problems as p, i (i)}<li>{p}</li>{/each}
				</ul>
			</div>
		{/if}
		{#if blocking}
			<p class="warn" role="status">{blocking === 1 ? '1 problem' : `${blocking} problems`} in the tables to fix before recording.</p>
		{/if}
		{#if pending && pending.items.length}
			<OpList items={pending.items} label="Edits to record in {scenarioName}" />
		{:else if !diff.unsupported.length}
			<p class="muted">Only the row order changed, which a scenario doesn't record.</p>
		{/if}
	{/if}
	<div class="toolbar">
		<button type="button" class="btn btn-primary" disabled={!canRecord} onclick={record}
			>{saving ? 'Recording…' : diff?.ops.length ? `Record ${diff.ops.length === 1 ? '1 change' : `${diff.ops.length} changes`}` : 'Record changes'}</button
		>
		<button type="button" class="btn" disabled={!editor.dirty || saving} onclick={() => editor.revert()}>Discard edits</button>
	</div>
	<p class="visually-hidden" role="status">{note}</p>
</section>

<style>
	.override {
		border-color: var(--warning);
	}
	.banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.75rem;
		margin: 0 0 0.75rem;
		padding: 0.6rem 0.8rem;
		border-left: 4px solid var(--warning);
		border-radius: var(--radius);
		background: var(--warning-soft);
	}
	.banner h2 {
		margin: 0;
		font-size: 1rem;
		flex: 1 1 20rem;
		overflow-wrap: anywhere;
	}
	.banner p {
		margin: 0;
		flex: 1 1 100%;
		max-width: 80ch;
		font-size: 0.9rem;
	}
	.seg .btn[aria-pressed='true'] {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent);
	}
	/* Kept in view while the tables scroll, but never taller than half the screen. */
	.record {
		position: sticky;
		bottom: 0;
		z-index: 5;
		max-height: 50vh;
		overflow-y: auto;
		border-top: 3px solid var(--warning);
	}
	.record h2 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	.record .alert ul {
		margin: 0.3rem 0;
	}
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}
	.warn {
		color: var(--warning);
	}
	@media (max-width: 640px) {
		.seg .btn,
		.toolbar .btn,
		.banner .btn {
			min-height: var(--tap);
		}
		/* On a phone the list would fill the screen: the record bar scrolls with the page. */
		.record {
			position: static;
			max-height: none;
		}
	}
</style>
