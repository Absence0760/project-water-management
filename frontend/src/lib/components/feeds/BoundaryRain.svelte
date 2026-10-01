<!--
	Settings → Data feeds → "Use the catchment boundary" (issue #326 B-rain;
	docs/ui.md § Data feeds, docs/maps.md § Rain from the boundary): the CHIRPS
	cells the map's catchment boundary covers, each weighted by the share of it
	inside, shown as a proposal with its source, and applied only on Apply
	(owners; editors see the proposal). Opens by itself from the Map tab's link
	(?rain=boundary). Helpers in ./feeds.ts.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { onMount, tick } from 'svelte';
	import { api } from '$lib/api';
	import { fmtDay, fmtNum } from '$lib/format/number';
	import { applyWords, type BoundaryProposal, errorText, feedsApi, type FeedMeta } from './feeds';

	let { projectId, feeds, onapplied }: { projectId: string; feeds: FeedMeta[]; onapplied: (feed: FeedMeta) => Promise<void> | void } = $props();

	const uid = $props.id();
	const calls = $derived(feedsApi(api, projectId));

	let open = $state(false);
	let loading = $state(false);
	let applying = $state(false);
	let proposal = $state<BoundaryProposal | null>(null);
	let error = $state<string | null>(null);
	let done = $state<string | null>(null);
	let heading = $state<HTMLElement>();
	let opener = $state<HTMLButtonElement>();

	async function show() {
		open = true;
		loading = true;
		error = done = null;
		proposal = null;
		try {
			proposal = await calls.boundaryProposal();
		} catch (e) {
			error = errorText(e);
		}
		loading = false;
		await tick();
		heading?.focus();
	}

	async function close() {
		open = false;
		await tick();
		opener?.focus();
	}

	async function apply() {
		if (!proposal || applying) return;
		applying = true;
		error = null;
		try {
			const feed = await calls.applyBoundary(proposal);
			done = `Applied: the CHIRPS feed now reads ${proposal.cells.length} cells of “${proposal.boundary.name || 'the catchment boundary'}”. It runs on the next schedule, or now with “Run now”.`;
			proposal = null;
			await onapplied(feed);
		} catch (e) {
			error = errorText(e);
		}
		applying = false;
	}

	// The Map tab's link opens the proposal at once.
	onMount(() => {
		if (page.url.searchParams.get('rain') === 'boundary') void show();
	});

	const pct = (share: number) => `${fmtNum(share * 100, share < 0.1 ? 1 : 0)} %`;
</script>

{#if !open}
	<button type="button" class="btn btn-sm" bind:this={opener} onclick={show} data-testid="boundary-rain-open">Use the catchment boundary</button>
{:else}
	<section class="boundary-rain" aria-labelledby="{uid}-h" data-testid="boundary-rain">
		<h3 id="{uid}-h" tabindex="-1" bind:this={heading}>Rain from the catchment boundary</h3>
		{#if loading}
			<p class="muted" role="status">Working out the cells…</p>
		{:else if proposal}
			{@const p = proposal}
			<dl class="facts">
				<dt>Boundary</dt>
				<dd data-testid="boundary-rain-boundary">
					{p.boundary.name ? `“${p.boundary.name}”` : 'The catchment boundary'}, {fmtNum(p.boundary.areaKm2, 1)} km², drawn or last changed {fmtDay(p.boundary.updatedAt.slice(0, 10))}
				</dd>
				<dt>Cells</dt>
				<dd data-testid="boundary-rain-cells">
					{p.cells.length} CHIRPS v3 cells of 0.05° in {p.rows} rows, {fmtNum(p.cellsKm2, 1)} km² in all, {fmtNum(p.insideKm2, 1)} km² of it inside the boundary
				</dd>
				<dt>Method</dt>
				<dd>Rainfall {p.method}. Source: CHIRPS v3 daily, Climate Hazards Center, UC Santa Barbara.</dd>
			</dl>
			<p data-testid="boundary-rain-apply-words">{applyWords(p, feeds)}</p>
			<details>
				<summary>The cells</summary>
				<div class="table-wrap">
					<table class="cells" aria-label="The boundary’s CHIRPS cells">
						<thead><tr><th scope="col">Latitude</th><th scope="col">Longitude</th><th scope="col">Inside</th><th scope="col">Weight</th></tr></thead>
						<tbody>
							{#each p.cells as c (`${c.lat},${c.lon}`)}
								<tr><td>{c.lat.toFixed(3)}</td><td>{c.lon.toFixed(3)}</td><td>{pct(c.share)}</td><td>{fmtNum(c.weight, 3)}</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
			</details>
			<div class="row">
				{#if p.canApply && p.apply.action !== 'none'}
					<button type="button" class="btn btn-sm btn-primary" aria-disabled={applying} onclick={apply} data-testid="boundary-rain-apply">{applying ? 'Applying…' : 'Apply'}</button>
				{:else if !p.canApply}
					<p class="muted small">An owner of the project applies it.</p>
				{/if}
				<button type="button" class="btn btn-sm" onclick={close}>Close</button>
			</div>
		{:else}
			<div class="row"><button type="button" class="btn btn-sm" onclick={close}>Close</button></div>
		{/if}
		<div role="status">{#if done}<p class="muted" data-testid="boundary-rain-done">{done}</p>{/if}</div>
		{#if error}
			<p class="alert alert-error" role="alert">{error}{#if /no catchment boundary/i.test(error)}{' '}<a href="?tab=map">Open the map</a>{/if}</p>
		{/if}
	</section>
{/if}

<style>
	.boundary-rain {
		margin-top: 0.75rem;
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}
	.boundary-rain h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	.facts {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.2rem 0.75rem;
		margin: 0 0 0.5rem;
		max-width: 75ch;
	}
	.facts dt {
		font-weight: 600;
	}
	.facts dd {
		margin: 0;
	}
	p {
		max-width: 75ch;
	}
	.table-wrap {
		overflow-x: auto;
	}
	.cells {
		border-collapse: collapse;
		font-variant-numeric: tabular-nums;
		font-size: 0.85rem;
	}
	.cells th,
	.cells td {
		padding: 0.2rem 0.6rem;
		text-align: right;
		border-bottom: 1px solid var(--border);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
		margin-top: 0.4rem;
	}
	.btn[aria-disabled='true'] {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>
