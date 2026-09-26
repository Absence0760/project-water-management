<script lang="ts">
	// Overview → "Alerts" (WP-2.13, docs/ui.md § Alerts): the alerts firing now,
	// and for an editor the rules that decide which alert emails the
	// catchment sends. Alerts are opt-in per catchment: until an editor
	// switches a kind on, nothing is sent. The rule editor loads on demand
	// (its own chunk), so the workspace doesn't carry it.
	import { onMount } from 'svelte';
	import { api, type AlertEvent } from '$lib/api';
	import ChunkFailed from '$lib/components/common/ChunkFailed.svelte';
	import { eventText, KIND_NAME } from './alerts';

	let { projectId, canEdit }: { projectId: string; canEdit: boolean } = $props();

	let events = $state<AlertEvent[] | null>(null);
	let error = $state<string | null>(null);
	let editorOpen = $state(false);
	let Editor = $state<typeof import('./AlertRulesEditor.svelte').default | null>(null);

	async function load() {
		error = null;
		try {
			events = await api.alerts.events(projectId);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}
	onMount(load);

	// A failed download says so and offers a reload (ChunkFailed; lazy.ts says
	// why pressing again can't help).
	let editorFailed = $state(false);
	async function openEditor() {
		editorFailed = false;
		try {
			Editor ??= (await import('./AlertRulesEditor.svelte')).default;
			editorOpen = true;
		} catch {
			editorFailed = true;
		}
	}
</script>

<section class="panel alerts" aria-labelledby="alerts-h" data-ready={events !== null || error !== null ? 'true' : undefined}>
	<div class="panel-head">
		<h2 id="alerts-h">Active alerts</h2>
		{#if events?.length}<span class="muted">{events.length} firing</span>{/if}
	</div>
	{#if error}
		<div class="alert alert-error" role="alert">Couldn’t load the alerts: {error} <button type="button" class="btn btn-sm" onclick={load}>Try again</button></div>
	{:else if events === null}
		<p class="muted" role="status">Loading…</p>
	{:else if !events.length}
		<p class="muted">No alert is firing.</p>
	{:else}
		<ul>
			{#each events as e (e.id)}
				<li data-alert-kind={e.kind}><strong>{KIND_NAME[e.kind]}.</strong> {eventText(e)}</li>
			{/each}
		</ul>
	{/if}
	{#if canEdit}
		{#if editorOpen && Editor}
			<Editor {projectId} onClose={() => (editorOpen = false)} onSaved={load} />
		{:else if editorFailed}
			<ChunkFailed what="The alert email settings" />
		{:else}
			<p><button type="button" class="btn btn-sm" onclick={openEditor}>Set up alert emails</button></p>
		{/if}
	{/if}
</section>

<style>
	.alerts {
		margin-bottom: 1rem;
	}
	ul {
		margin: 0 0 0.75rem;
		padding-left: 1.2rem;
		display: grid;
		gap: 0.35rem;
		font-size: 0.9rem;
	}
</style>
