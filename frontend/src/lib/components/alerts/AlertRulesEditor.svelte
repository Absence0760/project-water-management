<script lang="ts">
	// The catchment's alert rules (WP-2.13; editors): which kinds send email,
	// and at what level: catchment-wide kinds, a dam level per farm, and a
	// staleness level per data feed (each past that feed's usual delay, 057)
	// and per series an API key writes (141).
	// Loaded on demand by AlertsPanel. Saving evaluates the
	// rules at once, so a kind switched on over a figure already past its
	// line alerts now (once: it re-arms only after the figure recovers).
	import { onMount } from 'svelte';
	import { api, type AlertRule } from '$lib/api';
	import { feedRuleLabel, groupRules, SERIES_STALE_NAME, seriesRuleLabel, KIND_NAME, THRESHOLD_INPUT, thresholdFromInput, thresholdLabel, thresholdProblem, thresholdToInput } from './alerts';

	let { projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: () => void } = $props();

	type Row = AlertRule & { input: number };
	let rows = $state<Row[] | null>(null);
	let error = $state<string | null>(null);
	let saving = $state(false);
	let saved = $state(false);

	const toRows = (rules: AlertRule[]): Row[] => rules.map((r) => ({ ...r, input: thresholdToInput(r.kind, r.threshold) }));
	const groups = $derived(rows ? groupRules(rows) : null);
	const problems = $derived(rows ? rows.map((r) => (r.enabled ? thresholdProblem(r.kind, r.input) : null)) : []);
	const key = (r: AlertRule) => `${r.kind}/${r.nodeId ?? ''}/${r.feedId ?? ''}/${r.seriesId ?? ''}`;
	const idOf = (r: AlertRule) => `rule-${r.kind}-${r.nodeId ?? r.feedId ?? r.seriesId ?? 'all'}`;

	onMount(async () => {
		try {
			rows = toRows(await api.alerts.rules(projectId));
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!rows || problems.some(Boolean)) return;
		saving = true;
		saved = false;
		error = null;
		try {
			const changes = rows.map((r) => ({
				kind: r.kind,
				nodeId: r.nodeId,
				feedId: r.feedId,
				seriesId: r.seriesId,
				threshold: r.kind === 'restriction_published' ? 0 : thresholdFromInput(r.kind, r.input),
				enabled: r.enabled
			}));
			rows = toRows(await api.alerts.saveRules(projectId, changes));
			saved = true;
			onSaved();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

{#snippet rule(r: Row, label: string)}
	{@const i = rows!.indexOf(r)}
	<div class="rule" data-rule={key(r)}>
		<label class="check"><input type="checkbox" bind:checked={r.enabled} /> {label}</label>
		{#if thresholdLabel(r.kind, !!r.seriesId)}
			<label class="level" for={idOf(r)}>{thresholdLabel(r.kind, !!r.seriesId)}</label>
			<input
				id={idOf(r)}
				type="number"
				inputmode="numeric"
				min={THRESHOLD_INPUT[r.kind].min}
				max={THRESHOLD_INPUT[r.kind].max}
				step={THRESHOLD_INPUT[r.kind].step}
				bind:value={r.input}
				disabled={!r.enabled}
				aria-invalid={problems[i] ? 'true' : undefined}
				aria-describedby={problems[i] ? `${idOf(r)}-err` : undefined}
			/>
			{#if problems[i]}<span class="error" id="{idOf(r)}-err">{problems[i]}</span>{/if}
		{/if}
		{#if r.firing}<span class="firing">Firing</span>{/if}
	</div>
{/snippet}

<form class="rules" onsubmit={save} aria-labelledby="alert-rules-h">
	<h3 id="alert-rules-h">Alert emails for this catchment</h3>
	<p class="muted">
		Nothing is sent until you switch a kind on. Each alert is sent once when a figure crosses its level, and again only after it recovers. Farmers get dam
		alerts for their own hydrological unit and the restriction notices; each person chooses how often on their account page.
	</p>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	{#if !groups}
		{#if !error}<p class="muted" role="status">Loading…</p>{/if}
	{:else}
		<fieldset>
			<legend>Catchment</legend>
			{#each groups.catchment as r (key(r))}{@render rule(r, KIND_NAME[r.kind])}{/each}
		</fieldset>
		{#if groups.farms.length}
			<fieldset>
				<legend>Dams</legend>
				{#each groups.farms as r (key(r))}{@render rule(r, r.nodeName ?? 'Hydrological unit')}{/each}
			</fieldset>
		{/if}
		{#if groups.feeds.length}
			<fieldset>
				<legend>Data feeds behind</legend>
				<p class="muted hint">Each feed has its own level: the days past that feed’s usual delay before it alerts.</p>
				{#each groups.feeds as r (key(r))}{@render rule(r, feedRuleLabel(r))}{/each}
			</fieldset>
		{/if}
		{#if groups.series.length}
			<fieldset>
				<legend>{SERIES_STALE_NAME}</legend>
				<p class="muted hint">Each series an API key sends has its own level: the whole days with no new reading before it alerts (today doesn’t count).</p>
				{#each groups.series as r (key(r))}{@render rule(r, seriesRuleLabel(r))}{/each}
			</fieldset>
		{/if}
		<div class="actions">
			<button type="submit" class="btn btn-primary btn-sm" disabled={saving || problems.some(Boolean)}>{saving ? 'Saving…' : 'Save alert rules'}</button>
			<button type="button" class="btn btn-sm" onclick={onClose}>Close</button>
			<span class="muted" role="status">{saved ? 'Saved.' : ''}</span>
		</div>
	{/if}
</form>

<style>
	.rules {
		margin-top: 0.75rem;
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}
	h3 {
		font-size: 1rem;
		margin: 0 0 0.35rem;
	}
	fieldset {
		border: 1px solid var(--border);
		border-radius: 6px;
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
	}
	.hint {
		margin: 0 0 0.25rem;
		font-size: 0.85rem;
	}
	.rule {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.75rem;
		padding: 0.3rem 0;
		min-height: 24px;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 14rem;
		min-height: 24px;
	}
	.level {
		font-size: 0.85rem;
	}
	input[type='number'] {
		width: 5rem;
	}
	.error {
		color: var(--danger);
		font-size: 0.85rem;
	}
	.firing {
		font-size: 0.8rem;
		font-weight: 600;
		border: 1.5px solid var(--warning);
		border-radius: 4px;
		padding: 0 0.3rem;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
</style>
