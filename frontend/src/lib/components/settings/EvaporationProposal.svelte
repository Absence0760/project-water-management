<!--
	Settings → Flow calibration → "Evaporation from the map" (issue #326 B-evap;
	docs/ui.md § Settings, docs/maps.md § Evaporation from the map). The
	catchment boundary's monthly evaporation from an evaporation grid, beside
	what the saved settings hold, with the dataset, version, period and method
	cited. A reference-ET grid (FAO-56 ET₀) proposes GR4J's monthly PE as it
	stands; an A-pan grid proposes the A-pan row. Nothing is converted between
	the two. A Symons-pan (S-pan) grid proposes nothing: its monthly S-pan over
	the boundary is shown beside the saved A-pan, with A-pan ÷ S-pan per month,
	as a cross-check only (issue #738). Use (editors, in the heading's row, marked "Saves now") asks first, then saves the 12 values as one settings
	revision citing the dataset; it waits while the form has unsaved changes,
	since it saves straight to the project. Nothing is applied by itself.

	With `dataset` (Model settings → Demand → A-pan from "CCWR A-pan grid
	(catchment average)", docs/ui.md § Demand) the panel is pinned to that grid:
	no grid picker, its own heading, and a grid that isn't loaded on this server
	says so with the operator's import command instead of proposing another.
-->
<script lang="ts">
	import { PAN_COEFFICIENT_TYPICAL_MAX, PAN_COEFFICIENT_TYPICAL_MIN } from '@water-management/engine';
	import { untrack } from 'svelte';
	import { api, type EvaporationProposals } from '#lib/api/index.js';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import ProposalNoDataset from '#lib/components/proposals/ProposalNoDataset.svelte';
	import ProposalPanel from '#lib/components/proposals/ProposalPanel.svelte';
	import ProposalSource from '#lib/components/proposals/ProposalSource.svelte';
	import ProposalSynthetic from '#lib/components/proposals/ProposalSynthetic.svelte';
	import { CCWR_APAN_IMPORT, evaporationGridName } from '#lib/components/evaporation/ccwrApan.js';
	import { fmtNum } from '#lib/format/number.js';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import { acceptedText, apanOverSpan, coverageText, datasetCitation, impliedPanCoefficient, KIND_SHORT, outsidePanRange, proposalState, sameAsSaved, savedRow, TARGET_LABEL, useMessage } from './evaporationProposal';

	let {
		projectId,
		readonly,
		formDirty,
		onApplied,
		dataset: pinned
	}: {
		projectId: string;
		readonly: boolean;
		/** Unsaved settings: Use waits until they are saved or discarded (it saves straight to the project). */
		formDirty: boolean;
		/** The settings changed on the server: the form takes them as they now are. */
		onApplied: () => Promise<void> | void;
		/** Pinned to this grid (its label): the CCWR A-pan grid on Demand. Absent: the default grid, with a picker. */
		dataset?: string;
	} = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let data = $state.raw<EvaporationProposals | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let useError = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let frame = $state<ProposalPanel | null>(null);
	/** The grid last asked for (Try again retries it, not the one shown before a failed switch). */
	let wanted = $state<string | undefined>(undefined);
	let seq = 0;

	async function load(dataset?: string) {
		wanted = dataset;
		const mine = ++seq;
		loading = true;
		error = null;
		try {
			const d = await api.evaporation.get(projectId, dataset);
			if (mine === seq) data = d;
		} catch (e) {
			if (mine === seq) error = msg(e);
		} finally {
			if (mine === seq) loading = false;
		}
	}
	$effect(() => {
		void projectId;
		void pinned;
		untrack(() => void load(pinned));
	});

	const view = $derived(data ? proposalState(data) : null);
	const ready = $derived(view?.kind === 'ready' ? view : null);
	const saved = $derived(data && ready ? savedRow(data, ready.target) : null);
	const same = $derived(ready ? sameAsSaved(saved, ready.proposed) : false);
	// Reference ET against the A-pan row: the pan coefficient the two imply (a cross-check, never written).
	const implied = $derived(data && ready?.target === 'pe' && data.settings.apanMm.some((v) => v > 0) ? impliedPanCoefficient(ready.proposed, data.settings.apanMm) : null);
	const impliedOutside = $derived(implied ? outsidePanRange(implied, PAN_COEFFICIENT_TYPICAL_MIN, PAN_COEFFICIENT_TYPICAL_MAX) : []);
	const accepted = $derived(data && ready ? (data.accepted.find((a) => a.target === ready.target) ?? null) : null);
	// An S-pan grid: shown beside the saved A-pan, never used (no S-pan → A-pan conversion here).
	const cross = $derived(view?.kind === 'cross-check' ? view : null);
	const savedApan = $derived(data && cross && data.settings.apanMm.some((v) => v > 0) ? data.settings.apanMm : null);
	const ratio = $derived(cross && savedApan ? apanOverSpan(savedApan, cross.spanMm) : null);
	const total = (row: readonly number[]) => fmtNum(Math.round(row.reduce((a, b) => a + b, 0) * 10) / 10);

	async function use() {
		if (!data?.dataset || !ready) return;
		const d = data.dataset;
		const what = TARGET_LABEL[ready.target];
		const ok = await confirmDialog({
			title: `Use these values as ${what}?`,
			message: useMessage(ready.target, ready.annualMm, data.settings),
			confirmLabel: 'Use these values'
		});
		if (!ok) return;
		busy = true;
		useError = null;
		try {
			await api.evaporation.fromMap(projectId, d.dataset);
			notice = `${what[0]!.toUpperCase()}${what.slice(1)} is now the ${pinned ? `${evaporationGridName(d.dataset)} grid’s catchment average, ` : 'map’s '}${fmtNum(ready.annualMm)} mm a year, saved as a settings revision citing ${d.source} (${d.version}).`;
			await Promise.all([load(d.dataset), onApplied()]);
			// The Use button is gone (the settings hold the values now): keep the keyboard here, on what happened.
			await frame?.focusNotice();
		} catch (e) {
			useError = msg(e);
		} finally {
			busy = false;
		}
	}
</script>

<ProposalPanel
	bind:this={frame}
	testid={pinned ? 'ccwr-apan-proposal' : 'evaporation-proposal'}
	prefix={pinned ? 'ccwr-apan' : 'evaporation'}
	id={pinned ? 'set-ccwr-apan' : 'set-evaporation'}
	variant="inline"
	title={pinned ? `${evaporationGridName(pinned)} grid (catchment average)` : 'Evaporation from the map'}
	level={4}
	helpKey="evaporation-from-map"
	what="evaporation summary"
	bodyGrid
	{notice}
	{loading}
	loaded={data !== null}
	{error}
	onretry={() => load(wanted)}
>
	<!-- Use saves straight to the project, unlike the form's fields above (the save bar): so it sits in the heading's
	     row and says so (issue #521). -->
	{#snippet actions()}
		{#if ready && !same && !readonly}
			<span class="saves-now" id="{uid}-now">Saves now</span>
			<button
				type="button"
				class="btn btn-sm"
				disabled={busy || formDirty}
				aria-describedby={formDirty ? `${uid}-now ${uid}-dirty` : `${uid}-now`}
				onclick={use}>{busy ? 'Saving…' : `Use as ${TARGET_LABEL[ready.target]}`}</button
			>
		{/if}
	{/snippet}
	{#snippet intro()}{#if pinned}<p class="hint muted explain">
			The WRC Atlas’s monthly A-pan equivalent (Schulze and Maharaj 2007, from the CCWR’s Atlas of Agrohydrology), averaged over the catchment
			boundary into the one A-pan row the whole catchment runs on. Modelled from climate surfaces, not a measured pan. Nothing changes until you use it.
		</p>{:else}<p class="hint muted explain">
			The catchment boundary’s monthly evaporation from an evaporation grid. Reference evapotranspiration (FAO-56 ET₀) is proposed as GR4J’s
			monthly PE as it stands, and A-pan evaporation as the A-pan row: neither is converted into the other. Nothing changes until you use it.
		</p>{/if}{/snippet}

	{#if data && view}
		{#if view.kind === 'no-dataset' && pinned}
			<div class="alert alert-info slim" data-testid="ccwr-apan-not-loaded">
				<p class="small">
					The {evaporationGridName(pinned)} grid isn’t loaded on this server, so there is nothing to propose yet. Type or paste the A-pan row below,
					or pick another source. Whoever runs the server loads it with:
				</p>
				<code class="cmd">{CCWR_APAN_IMPORT}</code>
			</div>
		{:else if view.kind === 'no-dataset'}
			<ProposalNoDataset testid="evaporation-no-dataset" what="evaporation map" consequence="nothing can be proposed" instead="Enter the A-pan and pan coefficient by hand." />
		{:else}
			{@const d = data.dataset!}
			{#if data.datasets.length > 1 && !pinned}
				<div class="field">
					<label for="{uid}-ds">Grid</label>
					<select id="{uid}-ds" value={d.dataset} disabled={busy} onchange={(e) => load(e.currentTarget.value)}>
						{#each data.datasets as o (o.dataset)}<option value={o.dataset}>{evaporationGridName(o.dataset)} ({KIND_SHORT[o.kind]}, {o.version})</option>{/each}
					</select>
				</div>
			{/if}
			{#if d.synthetic}
				<ProposalSynthetic testid="evaporation-synthetic" subject="The grid" notWhat="dPET or any real evaporation" forWhat="catchment" />
			{/if}
			{#if view.kind === 'no-boundary'}
				<p class="alert alert-info slim" data-testid="evaporation-no-boundary">
					There is no catchment boundary on the map yet. Draw or import it on the Map; the evaporation is averaged over it. <a href="?tab=map">Open the Map</a>
				</p>
			{:else if view.kind === 'problem'}
				<p class="alert alert-info slim" data-testid="evaporation-problem">The grid can’t be summarised over the boundary “{data.boundary?.name}”: {view.problem}.</p>
			{:else if cross}
				<p class="small">Over the boundary “{data.boundary?.name}” ({coverageText(cross.coverage, cross.cells)}): <strong>a cross-check only</strong>, nothing to use.</p>
				<div class="table-wrap">
					<table class="data compact monthly" data-testid="evaporation-span-rows">
						<caption class="visually-hidden">Monthly S-pan evaporation from the map, beside the saved A-pan, as a cross-check</caption>
						<thead>
							<tr>
								<th scope="col" class="sticky">Month</th>
								{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
								<th scope="col" class="num">Year</th>
							</tr>
						</thead>
						<tbody>
							<tr data-row="span">
								<th scope="row" class="sticky">S-pan from the map <span class="u">mm</span></th>
								{#each cross.spanMm as v, i (i)}<td class="num">{fmtNum(v)}</td>{/each}
								<td class="num">{fmtNum(cross.annualMm)}</td>
							</tr>
							<tr data-row="saved">
								<th scope="row" class="sticky">Saved A-pan <span class="u">mm</span></th>
								{#if savedApan}
									{#each savedApan as v, i (i)}<td class="num">{fmtNum(v)}</td>{/each}
									<td class="num">{total(savedApan)}</td>
								{:else}
									<td colspan="13" class="muted small">None saved</td>
								{/if}
							</tr>
							{#if ratio}
								<tr data-row="ratio">
									<th scope="row" class="sticky">Saved A-pan ÷ S-pan <span class="u">×</span></th>
									{#each ratio as k, i (i)}<td class="num">{k === null ? '–' : fmtNum(k, 2, true)}</td>{/each}
									<td></td>
								</tr>
							{/if}
						</tbody>
					</table>
				</div>
				<p class="hint muted" data-testid="evaporation-span-note">
					This grid is Symons-pan (S-pan) evaporation. It is shown beside the saved A-pan as a cross-check only and is never written to the project: the model reads Class-A pan
					values, and turning S-pan into A-pan needs a conversion the hydrologist chooses.{ratio ? ' A-pan ÷ S-pan is the ratio the two rows imply month by month.' : ''}
				</p>
			{:else if ready}
				<p class="small">
					Over the boundary “{data.boundary?.name}” ({coverageText(ready.coverage, ready.cells)}), into <strong>{TARGET_LABEL[ready.target]}</strong>.
				</p>
				<div class="table-wrap">
					<table class="data compact monthly" data-testid="evaporation-rows">
						<caption class="visually-hidden">Monthly evaporation proposed from the map, beside the saved settings</caption>
						<thead>
							<tr>
								<th scope="col" class="sticky">Month</th>
								{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
								<th scope="col" class="num">Year</th>
							</tr>
						</thead>
						<tbody>
							<tr data-row="proposed">
								<th scope="row" class="sticky">Proposed {ready.target === 'pe' ? 'ET₀' : 'A-pan'} <span class="u">mm</span></th>
								{#each ready.proposed as v, i (i)}<td class="num">{fmtNum(v)}</td>{/each}
								<td class="num">{fmtNum(ready.annualMm)}</td>
							</tr>
							<tr data-row="saved">
								<th scope="row" class="sticky">Saved {ready.target === 'pe' ? 'monthly PE' : 'A-pan'} <span class="u">mm</span></th>
								{#if saved}
									{#each saved as v, i (i)}<td class="num">{fmtNum(v)}</td>{/each}
									<td class="num">{total(saved)}</td>
								{:else}
									<td colspan="13" class="muted small">None: GR4J runs on pan coefficient × A-pan</td>
								{/if}
							</tr>
							{#if implied}
								<tr data-row="implied">
									<th scope="row" class="sticky">ET₀ ÷ saved A-pan <span class="u">×</span></th>
									{#each implied as k, i (i)}<td class="num" class:warn={impliedOutside.includes(i)}>{k === null ? '–' : fmtNum(k, 2, true)}</td>{/each}
									<td></td>
								</tr>
							{/if}
						</tbody>
					</table>
				</div>
				{#if implied}
					<p class="hint muted" data-testid="evaporation-implied">
						ET₀ ÷ A-pan is the pan coefficient the two rows imply, shown as a cross-check only.
						{#if impliedOutside.length}
							In {impliedOutside.map((i) => WATER_YEAR_MONTHS[i]).join(', ')} it is outside FAO-56’s typical Class A range ({PAN_COEFFICIENT_TYPICAL_MIN}–{PAN_COEFFICIENT_TYPICAL_MAX}):
							check the A-pan row against its source.
						{/if}
					</p>
				{/if}
				{#if accepted}<p class="small" data-testid="evaporation-accepted" data-current={accepted.current}>{acceptedText(accepted)}</p>{/if}
				{#if same}
					<p class="muted small" data-testid="evaporation-same">The saved settings hold these values.</p>
				{:else if readonly}
					<p class="hint muted">Only an editor can use these values.</p>
				{:else if formDirty}
					<p class="hint muted" id="{uid}-dirty">Save or discard your settings changes first: values used here are saved straight away.</p>
				{/if}
				{#if useError}<p class="err small" role="alert">{useError}</p>{/if}
			{/if}
			<ProposalSource
				testid="evaporation-source"
				citation={datasetCitation(d)}
				method={d.method}
			/>
		{/if}
	{/if}
</ProposalPanel>

<style>
	.field {
		display: grid;
		gap: 0.25rem;
	}
	.field select {
		max-width: 100%;
	}
	.num {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		text-align: right;
	}
	.saves-now {
		font-size: var(--font-xs);
		font-weight: 600;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		background: var(--warning-soft);
	}
	.warn {
		color: var(--warning);
		font-weight: 600;
	}
	.slim {
		padding: 0.5rem 0.75rem;
		margin: 0;
	}
	.err {
		color: var(--danger);
		margin: 0;
	}
	.cmd {
		display: block;
		margin-top: 0.35rem;
		overflow-wrap: anywhere;
		font-size: var(--font-xs);
	}
	.hint,
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
	.table-wrap {
		width: 100%;
		overflow-x: auto;
	}
	/* The row labels stay put while the months scroll sideways on a phone (as the editable rows above, SettingsTab's styles). */
	th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
		white-space: nowrap;
	}
	thead th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
	.monthly th.sticky {
		width: 13rem;
		white-space: normal;
	}
	/* A narrow panel (a phone): the row label takes a narrow column and wraps, its unit on a line of its own,
	   so about four months show beside it instead of two. A container query on the scroll box: the app
	   frame's width isn't the viewport's. */
	.table-wrap {
		container: monthly / inline-size;
	}
	@container monthly (max-width: 30rem) {
		.monthly th.sticky {
			width: 6.5rem;
			min-width: 6.5rem;
		}
		.monthly th.sticky .u {
			display: block;
		}
	}
	.monthly td {
		width: calc(6.5ch + 0.7rem + 2px + 0.4rem);
		padding-left: 0.2rem;
		padding-right: 0.2rem;
	}

</style>
