<!--
	Settings → Data feeds → Attach a feed → Area: "The catchment boundary" (issue
	#326 B-rain, issue #521; docs/ui.md § Data feeds, docs/maps.md § Rain from
	the boundary): the CHIRPS cells the map's catchment boundary covers, each
	weighted by the share of it inside, shown as a proposal with its source, and
	applied only on Apply (owners; editors see the proposal). Drawn inside the
	attach card while that area is chosen, so it asks for the proposal when it
	mounts; DataFeedsPanel opens it from the Map tab's link (?rain=boundary) with
	`focus`, which puts the focus on its heading once loaded. Close closes the
	card (`onclose`). Helpers in ./feeds.ts.
-->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { onMount, tick } from 'svelte';
	import { api } from '$lib/api';
	import { fmtDay, fmtNum } from '$lib/format/number';
	import { applyWords, type BoundaryProposal, errorText, feedsApi, type FeedMeta } from './feeds';

	let {
		projectId,
		feeds,
		onapplied,
		onclose,
		focus = false
	}: {
		projectId: string;
		feeds: FeedMeta[];
		onapplied: (feed: FeedMeta) => Promise<void> | void;
		/** Close: the card it is drawn in closes. */
		onclose: () => void;
		/** Focus the heading once the proposal has loaded (a link arrived here), not while the area is picked. */
		focus?: boolean;
	} = $props();

	const uid = $props.id();
	const calls = $derived(feedsApi(api, projectId));

	let loading = $state(false);
	let applying = $state(false);
	let proposal = $state<BoundaryProposal | null>(null);
	let error = $state<string | null>(null);
	let done = $state<string | null>(null);
	let heading = $state<HTMLElement>();

	async function show() {
		loading = true;
		error = done = null;
		proposal = null;
		try {
			proposal = await calls.boundaryProposal();
		} catch (e) {
			error = errorText(e);
		}
		loading = false;
		if (!focus) return;
		await tick();
		heading?.focus();
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

	onMount(() => void show());

	const pct = (share: number) => `${fmtNum(share * 100, share < 0.1 ? 1 : 0)} %`;
</script>

<section class="boundary-rain" aria-labelledby="{uid}-h" data-testid="boundary-rain">
	<h4 id="{uid}-h" tabindex="-1" bind:this={heading}>Rain from the catchment boundary <HelpTip key="boundary-rain" /></h4>
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
	{/if}
	<!-- What Apply did, or what went wrong, above the action row so the card reads top to bottom; the status always in the page. -->
	<div role="status">{#if done}<p class="muted" data-testid="boundary-rain-done">{done}</p>{/if}</div>
	{#if error}
		<p class="alert alert-error" role="alert">{error}{#if /no catchment boundary/i.test(error)}{' '}<a href="?tab=map">Open the map</a>{/if}</p>
	{/if}
	{#if !loading}
		<div class="action-row">
			{#if proposal?.canApply && proposal.apply.action !== 'none'}
				<button type="button" class="btn btn-primary" aria-disabled={applying} onclick={apply} data-testid="boundary-rain-apply">{applying ? 'Applying…' : 'Apply'}</button>
			{:else if proposal && !proposal.canApply}
				<p class="muted small">An owner of the project applies it.</p>
			{/if}
			<button type="button" class="btn" onclick={onclose}>Close</button>
		</div>
	{/if}
</section>

<style>
	.boundary-rain {
		margin-top: 0.5rem;
	}
	.boundary-rain h4 {
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
	.btn[aria-disabled='true'] {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>
