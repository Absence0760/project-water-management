<!--
	Delineate a catchment, in a side sheet over the Map (`delineate=1`; issue
	#326 B-delineate, docs/design/delineation.md, docs/ui.md § Map). Two
	steps. Ask: the point (clicked on the map in the draw bar, or typed: the
	non-pointer way, and the one e2e drives) and whether it is the outlet or
	just below a dam wall; the server snaps it to the channel and proposes the
	catchment upstream. Decide: the proposal's facts, its caveats and the
	dataset's notice, then Accept as the catchment boundary (replacing one
	only with the tick: never silently), Accept as an area (an "other"
	polygon), or Reject. Opened with an open proposal and no new point, the
	sheet starts at Decide.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { api, type DelineationProposal, type DelineationState, type MapFeature } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import type { MapPosition } from '$lib/api/types';
	import { CAVEATS, datasetNotice, FROM_LABEL, openProposal, proposalFacts, provenanceFacts } from './delineation';
	import { parseDegrees, positionText } from './mapData';
	import { largerChannelOf } from './largerChannel';
	import type { LargerChannel } from '$lib/api';

	let {
		open = $bindable(false),
		projectId,
		info,
		at = null,
		step = 'decide',
		boundary,
		onproposed,
		onaccepted,
		onrejected
	}: {
		open?: boolean;
		projectId: string;
		/** GET …/map/delineation: the dataset and the proposals (the open one is decided here). */
		info: DelineationState;
		/** Where the point was clicked (lon, lat), or null: typed. */
		at?: MapPosition | null;
		/** Where the sheet opens: asking for a point (from Delineate), or deciding the waiting proposal (Review it); with none waiting, it asks. */
		step?: 'ask' | 'decide';
		/** The project's catchment boundary, if it has one: accepting as the boundary then needs the tick. */
		boundary: MapFeature | null;
		onproposed: (p: DelineationProposal) => Promise<void> | void;
		onaccepted: (f: MapFeature, summary: string) => Promise<void> | void;
		onrejected: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const formId = `${uid}-form`;
	const pending = $derived(openProposal(info));
	// Seeded once from the caller: Delineate asks, Review it decides.
	// svelte-ignore state_referenced_locally
	let asking = $state(step === 'ask' || !openProposal(info));
	/** The body's first element: its dialog's title takes the focus when the step changes (the focused control went with the old step). */
	let bodyEl: HTMLElement | undefined = $state();
	async function focusTitle() {
		await tick();
		const h = bodyEl?.closest('dialog')?.querySelector<HTMLElement>('h2');
		if (!h) return;
		h.tabIndex = -1;
		h.focus();
	}
	function setAsking(v: boolean) {
		asking = v;
		void focusTitle();
	}
	const deg = (v: number) => String(Math.round(v * 1e7) / 1e7);
	// svelte-ignore state_referenced_locally
	let latText = $state(at ? deg(at[1]) : '');
	// svelte-ignore state_referenced_locally
	let lonText = $state(at ? deg(at[0]) : '');
	// svelte-ignore state_referenced_locally
	let showCoords = $state(!at);
	let from = $state<DelineationProposal['from']>('outlet');
	const lat = $derived(parseDegrees(latText, 'lat'));
	const lon = $derived(parseDegrees(lonText, 'lon'));
	let tried = $state(false);
	let busy = $state<null | 'propose' | 'boundary' | 'other' | 'reject'>(null);
	let error = $state<string | null>(null);
	let replace = $state(false);
	const notice = $derived(datasetNotice(info.dataset));

	/** A refusal beside a much larger channel (issue #374): the sentence, the channel, and the point that was asked for. */
	let larger = $state<{ message: string; channel: LargerChannel; asked: [number, number] } | null>(null);
	async function propose(e: SubmitEvent) {
		e.preventDefault();
		tried = true;
		error = null;
		if ('error' in lat || 'error' in lon) {
			showCoords = true;
			return;
		}
		await send([lon.value, lat.value]);
	}
	/** Ask the server for the catchment above `at`; `keepPoint` keeps it beside a much larger channel. */
	async function send(at: [number, number], keepPoint = false) {
		busy = 'propose';
		error = null;
		larger = null;
		try {
			const r = await api.delineation.propose(projectId, { lon: at[0], lat: at[1], from, ...(keepPoint ? { keepPoint } : {}) });
			replace = false;
			await onproposed(r.proposal);
			setAsking(false);
		} catch (err) {
			const channel = largerChannelOf(err);
			if (channel) larger = { message: err instanceof Error ? err.message : '', channel, asked: at };
			else error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = null;
		}
	}
	/** Use the channel the server named: the point moves there (the fields say so) and it is asked again. */
	async function useLarger() {
		if (!larger) return;
		const at = larger.channel.at;
		latText = deg(at[1]);
		lonText = deg(at[0]);
		await send([at[0], at[1]]);
	}

	async function accept(p: DelineationProposal, as: 'catchment_boundary' | 'other') {
		busy = as === 'catchment_boundary' ? 'boundary' : 'other';
		error = null;
		try {
			const r = await api.delineation.accept(projectId, p.id, { as, ...(as === 'catchment_boundary' && boundary ? { replaceBoundary: replace } : {}) });
			await onaccepted(r.feature, r.summary);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = null;
		}
	}

	async function reject(p: DelineationProposal) {
		busy = 'reject';
		error = null;
		try {
			await api.delineation.reject(projectId, p.id);
			await onrejected();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = null;
		}
	}
</script>

<Dialog bind:open title={asking || !pending ? 'Delineate a catchment' : 'The delineated catchment'} side>
	<span bind:this={bodyEl} hidden></span>
	{#if asking || !pending}
		<form id={formId} onsubmit={propose} novalidate data-testid="delineate-form">
			<p class="lead">The app proposes the catchment that drains to a point on a river, from the elevation model. You decide whether to keep it.</p>
			<fieldset class="from">
				<legend>The point is</legend>
				{#each Object.entries(FROM_LABEL) as [value, label] (value)}
					<label class="radio"><input type="radio" name="{uid}-from" {value} bind:group={from} /> {label}</label>
				{/each}
			</fieldset>
			{#if at}
				<p class="at" data-testid="delineate-at">Clicked at {positionText(at)}. The point moves onto the channel nearby: the cell most water drains through.</p>
			{/if}
			<details class="coords" bind:open={showCoords}>
				<summary>Enter coordinates</summary>
				<div class="form-row">
					<div class="field">
						<label for="{uid}-lat">Latitude</label>
						<input id="{uid}-lat" inputmode="decimal" placeholder="-33.54" bind:value={latText} aria-invalid={tried && 'error' in lat ? 'true' : undefined} aria-describedby="{uid}-lat-e" />
						<span class="hint" id="{uid}-lat-e">{#if tried && 'error' in lat}<span class="err">{lat.error}</span>{:else}Decimal degrees; south is negative.{/if}</span>
					</div>
					<div class="field">
						<label for="{uid}-lon">Longitude</label>
						<input id="{uid}-lon" inputmode="decimal" placeholder="20.74" bind:value={lonText} aria-invalid={tried && 'error' in lon ? 'true' : undefined} aria-describedby="{uid}-lon-e" />
						<span class="hint" id="{uid}-lon-e">{#if tried && 'error' in lon}<span class="err">{lon.error}</span>{:else}Decimal degrees; east is positive.{/if}</span>
					</div>
				</div>
			</details>
			{#if info.dataset}<p class="hint">From {info.dataset.label}. {#if notice}{notice}{/if}</p>{/if}
			{#if error}<p class="err" role="alert" data-testid="delineate-error">{error}</p>{/if}
			{#if larger}
				{@const l = larger}
				<div class="offer" role="alert" data-testid="delineate-larger">
					<p>{l.message}</p>
					<div class="offer-actions">
						<button type="button" class="btn btn-primary" disabled={!!busy} onclick={useLarger} data-testid="delineate-use-larger">Use that channel</button>
						<button type="button" class="btn" disabled={!!busy} onclick={() => send(l.asked, true)} data-testid="delineate-keep-point">Keep my point</button>
					</div>
				</div>
			{/if}
		</form>
	{:else}
		{@const p = pending}
		<div class="review" data-testid="delineate-review">
			<dl class="facts">
				{#each proposalFacts(p) as [k, v] (k)}
					<dt>{k}</dt>
					<dd data-testid="delineate-fact-{k.toLowerCase().replace(/\s+/g, '-')}">{v}</dd>
				{/each}
			</dl>
			<details class="how">
				<summary>How it was made</summary>
				<dl class="facts">
					{#each provenanceFacts(p) as [k, v] (k)}
						<dt>{k}</dt>
						<dd data-testid="delineate-fact-{k.toLowerCase()}">{v}</dd>
					{/each}
				</dl>
			</details>
			<section aria-labelledby="{uid}-cav-h">
				<h3 id="{uid}-cav-h" class="sub">Before you accept it</h3>
				<ul class="caveats">
					{#each CAVEATS as c (c)}<li>{c}</li>{/each}
				</ul>
			</section>
			{#if notice}<p class="hint notice">{notice}</p>{/if}
			{#if boundary}
				<label class="tick">
					<input type="checkbox" bind:checked={replace} data-testid="delineate-replace" />
					Replace the current boundary{boundary.name ? ` “${boundary.name}”` : ''} if I accept this as the catchment boundary
				</label>
			{/if}
			{#if error}<p class="err" role="alert" data-testid="delineate-error">{error}</p>{/if}
			<div class="decide">
				<button type="button" class="btn btn-primary" disabled={!!busy || (!!boundary && !replace)} onclick={() => accept(p, 'catchment_boundary')} data-testid="delineate-accept-boundary">
					{busy === 'boundary' ? 'Saving…' : 'Accept as the catchment boundary'}
				</button>
				<button type="button" class="btn" disabled={!!busy} onclick={() => accept(p, 'other')} data-testid="delineate-accept-area">{busy === 'other' ? 'Saving…' : 'Accept as an area'}</button>
				<button type="button" class="btn btn-ghost" disabled={!!busy} onclick={() => reject(p)} data-testid="delineate-reject">{busy === 'reject' ? 'Rejecting…' : 'Reject'}</button>
			</div>
			{#if boundary && !replace}<p class="hint">The catchment has a boundary already: tick the box to replace it, or accept this as an area.</p>{/if}
		</div>
	{/if}

	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
		{#if asking && pending}
			<button type="button" class="btn" onclick={() => setAsking(false)} disabled={busy === 'propose'} data-testid="delineate-back">Back to the proposal</button>
		{/if}
		{#if asking || !pending}
			<button type="submit" form={formId} class="btn btn-primary" disabled={busy === 'propose'} data-testid="delineate-submit">{busy === 'propose' ? 'Delineating…' : 'Delineate'}</button>
		{:else}
			<button type="button" class="btn" onclick={() => setAsking(true)} disabled={!!busy}>Delineate another point</button>
		{/if}
	{/snippet}
</Dialog>

<style>
	form,
	.review {
		display: grid;
		gap: 0.75rem;
	}
	.lead,
	.at {
		margin: 0;
	}
	.from {
		border: 0;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.25rem;
	}
	.from legend {
		font-weight: 600;
		padding: 0;
		margin-bottom: 0.25rem;
	}
	.radio,
	.tick {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
		min-height: 24px;
	}
	.radio input,
	.tick input {
		flex: none;
	}
	.how summary {
		cursor: pointer;
		min-height: 24px;
		color: var(--accent);
		font-weight: 600;
	}
	.how[open] summary {
		margin-bottom: 0.5rem;
	}
	.field {
		display: grid;
		gap: 0.25rem;
	}
	.form-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr));
		gap: 0.75rem;
	}
	.hint {
		font-size: 0.85rem;
		color: var(--text-muted);
		margin: 0;
	}
	.offer {
		display: grid;
		gap: 0.5rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--warning);
		border-radius: var(--radius-sm);
		background: var(--warning-soft);
	}
	.offer p {
		margin: 0;
	}
	.offer-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.err {
		color: var(--danger);
		margin: 0;
	}
	.coords summary {
		cursor: pointer;
		min-height: 24px;
		color: var(--accent);
		font-weight: 600;
	}
	.coords[open] summary {
		margin-bottom: 0.5rem;
	}
	.facts {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.25rem 0.75rem;
		margin: 0;
	}
	.facts dt {
		color: var(--text-muted);
	}
	.facts dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.sub {
		font-size: 0.95rem;
		margin: 0 0 0.25rem;
	}
	.caveats {
		margin: 0;
		padding-left: 1.2rem;
		display: grid;
		gap: 0.25rem;
	}
	.decide {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
</style>
