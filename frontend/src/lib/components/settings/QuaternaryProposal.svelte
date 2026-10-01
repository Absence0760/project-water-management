<!--
	Settings → WR2012 check → "Propose from the map" (issue #288 phase 2,
	WP-3.12; docs/ui.md § Settings, docs/maps.md § Quaternary lookup): a point
	(the catchment boundary's centre, a gauge, or typed coordinates) → the
	quaternary it lies in → its reference values, each with "Use" beside what
	the form holds now, and the source shown. A used value goes into the form
	only; Save keeps it, as for any typed value. Never fills anything by itself.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { api, type QuaternaryLookup } from '$lib/api';
	import { parseDegrees } from '$lib/components/map/mapData';
	import { fmtNum } from '$lib/format/number';
	import type { Wr2012Draft } from './wr2012';
	import { lookupPoints, proposalRows, useValue, type LookupPoint, type ProposalKey } from './quaternaryProposal';

	let { projectId, ref = $bindable() }: { projectId: string; ref: Wr2012Draft } = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let points = $state<LookupPoint[] | null>(null);
	let pointsError = $state<string | null>(null);
	let choice = $state('');
	let latText = $state('');
	let lonText = $state('');
	let looking = $state(false);
	let lookupError = $state<string | null>(null);
	let result = $state<QuaternaryLookup | null>(null);
	let used = $state<ProposalKey[]>([]);

	// Opened by Settings' "Propose from the map": the gauges and the boundary to start from.
	$effect(() => {
		void projectId;
		untrack(() => void start());
	});
	async function start() {
		try {
			points = lookupPoints((await api.map.list(projectId)).features);
			choice = points[0]?.id ?? 'typed';
		} catch (e) {
			pointsError = msg(e);
			choice = 'typed';
		}
	}

	const typedLat = $derived(parseDegrees(latText, 'lat'));
	const typedLon = $derived(parseDegrees(lonText, 'lon'));

	async function lookUp(e: SubmitEvent) {
		e.preventDefault();
		lookupError = null;
		let at: [number, number];
		if (choice === 'typed') {
			if ('error' in typedLat || 'error' in typedLon) {
				lookupError = 'error' in typedLat ? typedLat.error : (typedLon as { error: string }).error;
				return;
			}
			at = [typedLon.value, typedLat.value];
		} else {
			const p = points?.find((x) => x.id === choice);
			if (!p) return;
			at = p.at;
		}
		looking = true;
		try {
			result = await api.map.quaternary(projectId, at[0], at[1]);
			used = [];
		} catch (err) {
			lookupError = msg(err);
		} finally {
			looking = false;
		}
	}

	const rows = $derived(result?.quaternary ? proposalRows(ref, result.quaternary, result.point) : []);

	function use(key: ProposalKey) {
		if (!result?.quaternary) return;
		useValue(ref, result.quaternary, key, result.point);
		used = [...used, key];
	}
</script>

<div class="proposal" data-testid="quaternary-proposal">
		<form class="pick" onsubmit={lookUp} novalidate aria-labelledby="{uid}-h">
			<h3 id="{uid}-h" class="sub-h">Propose from the map</h3>
			{#if pointsError}<p class="err" role="alert">The map’s features couldn’t be loaded ({pointsError}); type the coordinates instead.</p>{/if}
			<div class="field">
				<label for="{uid}-pt">Look up at</label>
				<select id="{uid}-pt" bind:value={choice}>
					{#each points ?? [] as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
					<option value="typed">Coordinates I type</option>
				</select>
			</div>
			{#if choice === 'typed'}
				<div class="form-row">
					<div class="field">
						<label for="{uid}-lat">Latitude</label>
						<input id="{uid}-lat" inputmode="decimal" placeholder="-33.61" bind:value={latText} />
					</div>
					<div class="field">
						<label for="{uid}-lon">Longitude</label>
						<input id="{uid}-lon" inputmode="decimal" placeholder="21.34" bind:value={lonText} />
					</div>
				</div>
			{/if}
			<button type="submit" class="btn btn-sm btn-primary" disabled={looking}>{looking ? 'Looking up…' : 'Look up the quaternary'}</button>
			{#if lookupError}<p class="err" role="alert">{lookupError}</p>{/if}
		</form>

		{#if result}
			<div role="status" aria-live="polite">
				{#if !result.datasets.length}
					<p class="alert alert-info slim" data-testid="quaternary-no-dataset">No quaternary dataset is loaded, so there is nothing to propose. The operator loads one with <code>pnpm import:quaternaries</code> (docs/maps.md).</p>
				{:else if !result.quaternary}
					<p class="alert alert-info slim" data-testid="quaternary-none">
						No quaternary in the loaded data ({result.datasets.map((d) => d.dataset).join(', ')}) contains {fmtNum(result.point[1], 4)}, {fmtNum(result.point[0], 4)}.
					</p>
				{:else}
					{@const q = result.quaternary}
					{#if q.synthetic}
						<p class="alert alert-warning slim" data-testid="quaternary-synthetic">
							<strong>Synthetic test data.</strong> These values are invented for development and tests, not DWS or WR2012 figures. Never use them for a real catchment.
						</p>
					{/if}
					<p class="small">
						Quaternary <strong data-testid="quaternary-code">{q.code}</strong> · dataset “{q.dataset}” · <span class="muted">Source: {q.source}</span>
					</p>
					<div class="table-wrap">
						<table class="data compact" data-testid="quaternary-rows">
							<caption class="visually-hidden">Values proposed from quaternary {q.code}, beside what the form holds now</caption>
							<thead>
								<tr>
									<th scope="col">Value</th>
									<th scope="col">In the form now</th>
									<th scope="col">Proposed</th>
									<th scope="col"><span class="visually-hidden">Use</span></th>
								</tr>
							</thead>
							<tbody>
								{#each rows as r (r.key)}
									<tr data-key={r.key}>
										<th scope="row">{r.label}</th>
										<td class="val">{r.now}</td>
										<td class="val">{r.proposed}</td>
										<td>
											{#if r.missing}
												<span class="muted small">Not in the data</span>
											{:else if r.same}
												<span class="muted small">{used.includes(r.key) ? 'Used' : 'Same'}</span>
											{:else}
												<button type="button" class="btn btn-sm" onclick={() => use(r.key)} aria-label="Use the proposed {r.label.toLowerCase()}">Use</button>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<p class="hint muted">A value you use goes into the form above; save the settings to keep it. Check each against the study before you sign anything off.</p>
				{/if}
			</div>
		{/if}
</div>

<style>
	.proposal {
		display: grid;
		gap: 0.6rem;
		justify-items: start;
		margin: 0.75rem 0;
	}
	.pick {
		display: grid;
		gap: 0.5rem;
		justify-items: start;
	}
	.field {
		display: grid;
		gap: 0.25rem;
	}
	.form-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.val {
		max-width: 28rem;
		overflow-wrap: anywhere;
	}
	.slim {
		padding: 0.5rem 0.75rem;
		margin: 0;
	}
	.err {
		color: var(--danger);
		margin: 0;
	}
	.hint {
		font-size: 0.85rem;
	}
	.table-wrap {
		width: 100%;
	}
</style>
