<script lang="ts">
	// An existing model grid, unchanged, in a full-screen modal over any
	// workspace tab (issue #17: the simpler screens keep every grid one click
	// away). `grid=<id>` in the URL opens it (lib/workspace/overlays.ts); the
	// page closes it by dropping the parameter. It edits the shared
	// ModelEditor, like the tab the grid comes from, and carries the save row,
	// since the modal makes the page's save bar unreachable.
	import type { ProjectSettings } from '@water-management/engine';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import CropsTab from '$lib/components/crops/CropsTab.svelte';
	import IrrigationSystemsPanel from '$lib/components/crops/IrrigationSystemsPanel.svelte';
	import DemandsTable from '$lib/components/network/DemandsTable.svelte';
	import NetworkTab from '$lib/components/network/NetworkTab.svelte';
	import type { RunMeta } from '$lib/api';
	import TransfersTab from '$lib/components/transfers/TransfersTab.svelte';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { GRIDS, type GridId } from '$lib/workspace/overlays';
	import IssueList from './IssueList.svelte';
	import ModelSaveRow from './ModelSaveRow.svelte';

	let {
		open = $bindable(false),
		grid,
		editor,
		settings,
		readonly,
		onsave,
		reason = $bindable(''),
		projectId,
		runs = null,
		apanDaily = false
	}: {
		open?: boolean;
		grid: GridId;
		editor: ModelEditor;
		settings: ProjectSettings;
		readonly: boolean;
		/** The page's model save. */
		onsave: () => void;
		/** The save bar's reason, shared. */
		reason?: string;
		projectId: string;
		/** The project's runs (the node table's flow shares and the farmers' notes need none, but NetworkTab takes them). */
		runs?: RunMeta[] | null;
		/** The project has a daily A-pan series (the demand preview says it shows the monthly means, issue #173). */
		apanDaily?: boolean;
	} = $props();

	const CROP_SECTION = { 'crop-factors': 'factors', 'planted-areas': 'areas' } as const;
	const area = $derived(grid === 'nodes' || grid === 'demands' ? 'network' : grid === 'transfers' ? 'transfers' : 'crops');
</script>

<Dialog bind:open title={GRIDS[grid]} full keepInputs>
	<div class="grid-body" class:readonly data-grid={grid}>
		<IssueList issues={editor.issues} {area} />
		{#if grid === 'nodes'}
			<NetworkTab {editor} {settings} {readonly} {projectId} {runs} only="table" />
		{:else if grid === 'transfers'}
			<TransfersTab {editor} {readonly} inModal />
		{:else if grid === 'demands'}
			<DemandsTable {editor} {settings} {readonly} {projectId} />
		{:else if grid === 'systems'}
			<IrrigationSystemsPanel {editor} {readonly} />
		{:else}
			<CropsTab {editor} {settings} {readonly} sections={[CROP_SECTION[grid]]} {apanDaily} inModal />
		{/if}
	</div>

	{#snippet actions()}
		{#if readonly}
			<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
		{:else}
			<ModelSaveRow {editor} {onsave} ondone={() => (open = false)} bind:reason listed={area} />
		{/if}
	{/snippet}
</Dialog>

<style>
	/* The grid scrolls inside the modal; the title and the save row stay put. */
	.grid-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.grid-body :global(.table-wrap) {
		position: relative;
	}
	/* Read-only inputs read as values, as on the tabs (routes/projects/[id]). */
	.readonly :global(input:not([type='checkbox']):read-only),
	.readonly :global(select:disabled) {
		background: transparent;
		border-color: transparent;
		color: var(--text);
		appearance: none;
		opacity: 1;
	}
</style>
