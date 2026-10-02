<!--
	Settings → Flow calibration → "Evaporation from the map" (issue #326 B-evap;
	docs/ui.md § Settings, docs/maps.md § Evaporation from the map). The
	catchment boundary's monthly evaporation from an evaporation grid, beside
	what the saved settings hold, with the dataset, version, period and method
	cited. A reference-ET grid (FAO-56 ET₀) proposes GR4J's monthly PE as it
	stands; an A-pan grid proposes the A-pan row. Nothing is converted between
	the two. Use (editors) asks first, then saves the 12 values as one settings
	revision citing the dataset; it waits while the form has unsaved changes,
	since it saves straight to the project. Nothing is applied by itself.
-->
<script lang="ts">
	import { PAN_COEFFICIENT_TYPICAL_MAX, PAN_COEFFICIENT_TYPICAL_MIN } from '@water-management/engine';
	import { tick, untrack } from 'svelte';
	import { api, type EvaporationProposals } from '$lib/api';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { fmtNum } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { acceptedText, coverageText, impliedPanCoefficient, outsidePanRange, proposalState, sameAsSaved, savedRow, TARGET_LABEL } from './evaporationProposal';

	let {
		projectId,
		readonly,
		formDirty,
		onApplied
	}: {
		projectId: string;
		readonly: boolean;
		/** Unsaved settings: Use waits until they are saved or discarded (it saves straight to the project). */
		formDirty: boolean;
		/** The settings changed on the server: the form takes them as they now are. */
		onApplied: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let data = $state.raw<EvaporationProposals | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let useError = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let noticeEl = $state<HTMLParagraphElement | null>(null);
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
		untrack(() => void load());
	});

	const view = $derived(data ? proposalState(data) : null);
	const ready = $derived(view?.kind === 'ready' ? view : null);
	const saved = $derived(data && ready ? savedRow(data, ready.target) : null);
	const same = $derived(ready ? sameAsSaved(saved, ready.proposed) : false);
	// Reference ET against the A-pan row: the pan coefficient the two imply (a cross-check, never written).
	const implied = $derived(data && ready?.target === 'pe' && data.settings.apanMm.some((v) => v > 0) ? impliedPanCoefficient(ready.proposed, data.settings.apanMm) : null);
	const impliedOutside = $derived(implied ? outsidePanRange(implied, PAN_COEFFICIENT_TYPICAL_MIN, PAN_COEFFICIENT_TYPICAL_MAX) : []);
	const accepted = $derived(data && ready ? (data.accepted.find((a) => a.target === ready.target) ?? null) : null);
	const total = (row: readonly number[]) => fmtNum(Math.round(row.reduce((a, b) => a + b, 0) * 10) / 10);

	async function use() {
		if (!data?.dataset || !ready) return;
		const d = data.dataset;
		const what = TARGET_LABEL[ready.target];
		const ok = await confirmDialog({
			title: `Use these values as ${what}?`,
			message:
				ready.target === 'pe'
					? `GR4J will run on these 12 monthly values (${fmtNum(ready.annualMm)} mm a year of reference evapotranspiration) instead of ${data.settings.peKind === 'monthly' ? 'the monthly PE row it holds now' : 'pan coefficient × A-pan'}. Irrigation demand and dam evaporation keep reading the A-pan row. A GR4J fit made before is then marked “Forcing changed since fit”.`
					: `Irrigation demand, dam evaporation and, under pan coefficient × A-pan, GR4J will read these 12 monthly values (${fmtNum(ready.annualMm)} mm a year) instead of the A-pan row it holds now.`,
			confirmLabel: 'Use these values'
		});
		if (!ok) return;
		busy = true;
		useError = null;
		try {
			await api.evaporation.fromMap(projectId, d.dataset);
			notice = `${what[0]!.toUpperCase()}${what.slice(1)} is now the map’s ${fmtNum(ready.annualMm)} mm a year, saved as a settings revision citing ${d.source} (${d.version}). Run the model to see its effect.`;
			await Promise.all([load(d.dataset), onApplied()]);
			// The Use button is gone (the settings hold the values now): keep the keyboard here, on what happened.
			await tick();
			noticeEl?.focus();
		} catch (e) {
			useError = msg(e);
		} finally {
			busy = false;
		}
	}
</script>

<section class="proposal" id="set-evaporation" aria-labelledby="{uid}-h" data-testid="evaporation-proposal">
	<h3 id="{uid}-h" class="sub-h">Evaporation from the map</h3>
	<p class="hint muted">
		The catchment boundary’s monthly evaporation from an evaporation grid. Reference evapotranspiration (FAO-56 ET₀) is proposed as GR4J’s
		monthly PE as it stands, and A-pan evaporation as the A-pan row: neither is converted into the other. Nothing changes until you use it.
	</p>

	<!-- Always in the page, so a screen reader announces the text when it arrives. -->
	<p class="alert alert-info slim" class:visually-hidden={!notice} role="status" tabindex="-1" bind:this={noticeEl} data-testid="evaporation-notice">{notice ?? ''}</p>

	<div class="body" aria-busy={loading} data-ready={!loading && (data !== null || error !== null) ? 'true' : undefined} data-testid="evaporation-body">
		{#if error}
			<p class="err" role="alert">The evaporation summary couldn’t be loaded ({error}). <button type="button" class="btn btn-sm" onclick={() => load(wanted)}>Try again</button></p>
		{:else if data && view}
			{#if view.kind === 'no-dataset'}
				<p class="alert alert-info slim" data-testid="evaporation-no-dataset">
					No evaporation grid is loaded, so nothing is proposed. The operator loads one with <code>pnpm import:evaporation</code> (docs/maps.md).
				</p>
			{:else}
				{@const d = data.dataset!}
				{#if data.datasets.length > 1}
					<div class="field">
						<label for="{uid}-ds">Grid</label>
						<select id="{uid}-ds" value={d.dataset} disabled={busy} onchange={(e) => load(e.currentTarget.value)}>
							{#each data.datasets as o (o.dataset)}<option value={o.dataset}>{o.dataset} ({o.kind === 'et0' ? 'reference ET' : 'A-pan'}, {o.version})</option>{/each}
						</select>
					</div>
				{/if}
				{#if d.synthetic}
					<p class="alert alert-warning slim" data-testid="evaporation-synthetic">
						<strong>Synthetic test data.</strong> The grid loaded here is invented for development and tests, not dPET or any real evaporation. Never use it for a real catchment.
					</p>
				{/if}
				{#if view.kind === 'no-boundary'}
					<p class="alert alert-info slim" data-testid="evaporation-no-boundary">
						There is no catchment boundary on the map yet. Draw or import it on the Map; the evaporation is averaged over it. <a href="?tab=map">Open the Map</a>
					</p>
				{:else if view.kind === 'problem'}
					<p class="alert alert-info slim" data-testid="evaporation-problem">The grid can’t be summarised over the boundary “{data.boundary?.name}”: {view.problem}.</p>
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
					{:else if !readonly}
						<button
							type="button"
							class="btn btn-sm"
							disabled={busy || formDirty}
							aria-describedby={formDirty ? `${uid}-dirty` : undefined}
							onclick={use}>{busy ? 'Saving…' : `Use as ${TARGET_LABEL[ready.target]}`}</button
						>
						{#if formDirty}<p class="hint muted" id="{uid}-dirty">Save or discard your settings changes first: values used here are saved straight away.</p>{/if}
					{:else}
						<p class="hint muted">Only an editor can use these values.</p>
					{/if}
					{#if useError}<p class="err small" role="alert">{useError}</p>{/if}
				{/if}
				<details class="method small">
					<summary>Source and method</summary>
					<p data-testid="evaporation-source">{d.source} ({d.version}, {d.firstYear}–{d.lastYear} monthly means; dataset “{d.dataset}”). {d.attribution}</p>
					<p>{d.method}</p>
				</details>
			{/if}
		{/if}
	</div>
</section>

<style>
	.proposal {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.6rem;
		margin: 1rem 0 0;
		min-width: 0;
	}
	/* The body's rows scroll in their own box on a phone; the page doesn't. */
	.body {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.6rem;
		justify-items: start;
		min-width: 0;
	}
	.body > * {
		max-width: 100%;
	}
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
	.hint,
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
	.method p {
		margin: 0.35rem 0 0;
		overflow-wrap: anywhere;
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
	.monthly td {
		width: calc(6.5ch + 0.7rem + 2px + 0.4rem);
		padding-left: 0.2rem;
		padding-right: 0.2rem;
	}

</style>
