<!--
	Trace a dam from typed coordinates (issue #326 C2; docs/ui.md § Map): the
	non-pointer way to the same trace a click inside the water asks for, and
	the one e2e drives. The point and the share of observations a cell must
	be water in; Trace asks the server, and the outline comes back as a
	drawing to adjust and save (nothing is saved here). A refusal (dry land,
	water too large or cut off by the data's edge) shows here with its reason.
-->
<script lang="ts">
	import { api, type DamTraceProposal, type DamTraceState, type MapPosition, type MinOccurrence } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { parseDegrees } from '../mapData';

	let {
		open = $bindable(false),
		projectId,
		info,
		at = null,
		minOccurrence = $bindable(25),
		ontraced
	}: {
		open?: boolean;
		projectId: string;
		info: DamTraceState;
		/** The point placed on the map, if any: the fields start from it. */
		at?: MapPosition | null;
		minOccurrence?: MinOccurrence;
		ontraced: (t: DamTraceProposal) => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const formId = `${uid}-form`;
	const deg = (v: number) => String(Math.round(v * 1e7) / 1e7);
	// svelte-ignore state_referenced_locally
	let latText = $state(at ? deg(at[1]) : '');
	// svelte-ignore state_referenced_locally
	let lonText = $state(at ? deg(at[0]) : '');
	const lat = $derived(parseDegrees(latText, 'lat'));
	const lon = $derived(parseDegrees(lonText, 'lon'));
	let tried = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function trace(e: SubmitEvent) {
		e.preventDefault();
		tried = true;
		error = null;
		if ('error' in lat || 'error' in lon) return;
		busy = true;
		try {
			await ontraced(await api.map.traceDam(projectId, { lon: lon.value, lat: lat.value, minOccurrence }));
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog bind:open title="Trace a dam" side>
	<form id={formId} onsubmit={trace} novalidate data-testid="trace-form">
		<p class="lead">The app proposes the dam’s outline from where water is mapped round a point inside it. You adjust it and decide whether to keep it.</p>
		<div class="form-row">
			<div class="field">
				<label for="{uid}-lat">Latitude</label>
				<input id="{uid}-lat" inputmode="decimal" placeholder="-33.67" bind:value={latText} aria-invalid={tried && 'error' in lat ? 'true' : undefined} aria-describedby="{uid}-lat-e" />
				<span class="hint" id="{uid}-lat-e">{#if tried && 'error' in lat}<span class="err">{lat.error}</span>{:else}Decimal degrees; south is negative.{/if}</span>
			</div>
			<div class="field">
				<label for="{uid}-lon">Longitude</label>
				<input id="{uid}-lon" inputmode="decimal" placeholder="21.32" bind:value={lonText} aria-invalid={tried && 'error' in lon ? 'true' : undefined} aria-describedby="{uid}-lon-e" />
				<span class="hint" id="{uid}-lon-e">{#if tried && 'error' in lon}<span class="err">{lon.error}</span>{:else}Decimal degrees; east is positive.{/if}</span>
			</div>
		</div>
		<div class="field">
			<label for="{uid}-share">Count a cell as water if it was water in at least</label>
			<select id="{uid}-share" bind:value={minOccurrence}>
				{#each [10, 25, 50, 75] as const as v (v)}<option value={v}>{v} % of the observations</option>{/each}
			</select>
			<span class="hint">Lower takes in the edge a full dam reaches now and then; higher, only what is usually wet.</span>
		</div>
		{#if info.dataset}<p class="hint">From {info.dataset.label}.{#if info.dataset.attribution && info.dataset.attribution !== 'synthetic'} {info.dataset.attribution}{/if}</p>{/if}
		{#if error}<p class="err" role="alert" data-testid="trace-error">{error}</p>{/if}
	</form>

	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
		<button type="submit" form={formId} class="btn btn-primary" disabled={busy} data-testid="trace-submit">{busy ? 'Tracing…' : 'Trace'}</button>
	{/snippet}
</Dialog>

<style>
	form {
		display: grid;
		gap: 0.75rem;
	}
	.lead {
		margin: 0;
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
	.err {
		color: var(--danger);
		margin: 0;
	}
</style>
