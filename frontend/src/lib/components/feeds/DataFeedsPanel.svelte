<!--
	Settings → Data feeds (roadmap WP-2.10; docs/ui.md § Data feeds): the
	project's scheduled feeds (CHIRPS rainfall, the CHIRPS-GEFS forecast, DWS
	gauge flow) with their health, "Run now", and a form to attach one. Owners
	attach, switch off and remove feeds; editors can run one now; viewers read.
	Its own chunk: SettingsTab loads it lazily. Helpers in ./feeds.ts.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { kindLabel } from '$lib/series/kinds';
	import { describePlace, describeTarget, describeTimes, draftToBody, emptyDraft, type FeedDraft, type FeedList, type FeedMeta, feedsApi, needsAttention, STATE_LABELS } from './feeds';

	let { projectId }: { projectId: string } = $props();

	const uid = $props.id();
	const feeds = $derived(feedsApi(api, projectId));

	let data = $state<FeedList | null>(null);
	let loadError = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let message = $state<string | null>(null);
	let error = $state<string | null>(null);
	let adding = $state(false);
	let draft = $state<FeedDraft>(emptyDraft());
	let formError = $state<string | null>(null);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const source = $derived(data?.sources.find((s) => s.source === draft.source));
	const attention = $derived(data ? needsAttention(data.feeds) : 0);

	async function reload() {
		loadError = null;
		try {
			data = await feeds.list();
		} catch (e) {
			loadError = msg(e);
		}
	}
	onMount(reload);

	function startAdding() {
		draft = emptyDraft('chirps', data?.sources.find((s) => s.source === 'chirps')?.kinds);
		formError = null;
		adding = true;
	}

	function pickSource(s: FeedDraft['source']) {
		draft.source = s;
		draft.targetKind = data?.sources.find((x) => x.source === s)?.kinds[0] ?? '';
	}

	async function add(e: SubmitEvent) {
		e.preventDefault();
		const parsed = draftToBody(draft);
		if ('error' in parsed) {
			formError = parsed.error;
			return;
		}
		busy = 'add';
		formError = message = error = null;
		try {
			const feed = await feeds.create(parsed.body);
			adding = false;
			message = `Feed attached: ${describeTarget(feed)} from ${describePlace(feed)}. It runs on the next schedule, or now with “Run now”.`;
			await reload();
		} catch (err) {
			formError = msg(err);
		} finally {
			busy = null;
		}
	}

	async function act(f: FeedMeta, what: 'run' | 'toggle' | 'remove') {
		if (what === 'remove' && !confirm(`Remove the ${f.source === 'dws' ? 'DWS' : 'CHIRPS'} feed into “${describeTarget(f)}”? The series keeps the days it already has.`)) return;
		busy = f.id;
		message = error = null;
		try {
			if (what === 'run') {
				const r = await feeds.runNow(f.id);
				message = r.created ? 'Fetch queued. The status below updates once the background worker has run it.' : 'A fetch for this feed is already waiting to run.';
			} else if (what === 'toggle') {
				await feeds.update(f.id, { enabled: !f.enabled });
				message = f.enabled ? 'Feed switched off.' : 'Feed switched on; it runs on the next schedule.';
			} else {
				await feeds.remove(f.id);
				message = 'Feed removed.';
			}
			await reload();
		} catch (e) {
			error = msg(e);
		} finally {
			busy = null;
		}
	}
</script>

<section class="panel" id="set-feeds" aria-labelledby="{uid}-h">
	<div class="panel-head">
		<h2 id="{uid}-h">Data feeds</h2>
		{#if data?.mode === 'fixtures'}<span class="badge badge-warn" title="FEED_SOURCE=fixtures: feeds read synthetic sample files, not the real sources">Sample data</span>{/if}
	</div>
	<p class="hint muted">
		Rainfall and gauge flow that arrive by themselves: CHIRPS daily rainfall and the CHIRPS-GEFS 16-day forecast for grid cells over the
		catchment, or a DWS gauge’s verified daily flow. Each feed fetches daily and merges its new days into one series; a day the source has
		no value for never erases what is there. A feed that stops shows as failing or stale here.
	</p>

	{#if loadError}
		<div class="alert alert-error" role="alert">
			Couldn’t load the data feeds: {loadError}
			<button type="button" class="btn btn-sm" onclick={reload}>Try again</button>
		</div>
	{:else if !data}
		<p class="muted" role="status">Loading…</p>
	{:else}
		{#if attention}
			<div class="alert alert-warning" role="alert" data-testid="feeds-attention">
				{attention === 1 ? '1 feed needs' : `${attention} feeds need`} attention: its data is out of date or its last fetch failed.
			</div>
		{/if}

		{#if data.feeds.length === 0}
			<p class="muted">No feeds yet{data.canEdit ? '.' : '. An owner can attach one.'}</p>
		{:else}
			<ul class="feeds" aria-label="Data feeds">
				{#each data.feeds as f (f.id)}
					<li class="feed" data-state={f.health.state}>
						<div class="head">
							<span class="state state-{f.health.state}">{STATE_LABELS[f.health.state]}</span>
							<strong>{data.sources.find((s) => s.source === f.source)?.label ?? f.source}</strong>
							<span class="muted">→ {describeTarget(f)}</span>
						</div>
						<p class="where muted small">{describePlace(f)} · {f.schedule}{f.actingUser ? ` · runs as ${f.actingUser}` : ' · no acting owner: save it again'}</p>
						<p class="health">{f.health.message}</p>
						<p class="muted small">{describeTimes(f)}{#if f.lastMeta?.prelimDays}{' '}· {f.lastMeta.prelimDays} preliminary days{/if}</p>
						{#if data.canRun || data.canEdit}
							<div class="act">
								{#if data.canRun && f.enabled}
									<button type="button" class="btn btn-sm" disabled={busy === f.id} aria-label="Run now: {describeTarget(f)}" onclick={() => act(f, 'run')}>Run now</button>
								{/if}
								{#if data.canEdit}
									<button type="button" class="btn btn-sm" disabled={busy === f.id} aria-label="{f.enabled ? 'Switch off' : 'Switch on'}: {describeTarget(f)}" onclick={() => act(f, 'toggle')}>
										{f.enabled ? 'Switch off' : 'Switch on'}
									</button>
									<button type="button" class="btn btn-sm btn-danger" disabled={busy === f.id} aria-label="Remove feed: {describeTarget(f)}" onclick={() => act(f, 'remove')}>Remove</button>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<div class="row">
			<button type="button" class="btn btn-sm" onclick={reload} disabled={busy !== null}>Refresh status</button>
			{#if data.canEdit && !adding}
				<button type="button" class="btn btn-sm btn-primary" onclick={startAdding}>Attach a feed</button>
			{/if}
		</div>

		{#if message}<p class="muted" role="status">{message}</p>{/if}
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

		{#if adding}
			<form class="add" onsubmit={add} novalidate aria-labelledby="{uid}-add-h">
				<h3 id="{uid}-add-h">Attach a feed</h3>
				<div class="form-row">
					<div class="field">
						<label for="{uid}-src">Source</label>
						<select id="{uid}-src" value={draft.source} onchange={(e) => pickSource(e.currentTarget.value as FeedDraft['source'])}>
							{#each data.sources as s (s.source)}<option value={s.source}>{s.label}</option>{/each}
						</select>
					</div>
					<div class="field">
						<label for="{uid}-kind">Into series</label>
						<select id="{uid}-kind" bind:value={draft.targetKind}>
							{#each source?.kinds ?? [] as k (k)}<option value={k}>{kindLabel(k)}</option>{/each}
						</select>
					</div>
					<div class="field">
						<label for="{uid}-name">Series name <span class="muted">(optional)</span></label>
						<input id="{uid}-name" type="text" maxlength="100" bind:value={draft.targetName} />
					</div>
					<div class="field">
						<label for="{uid}-sched">Schedule</label>
						<select id="{uid}-sched" bind:value={draft.schedule}>
							<option value="daily">Daily</option>
							<option value="hourly">Hourly</option>
						</select>
					</div>
				</div>
				{#if draft.source === 'dws'}
					<div class="field">
						<label for="{uid}-station">DWS station</label>
						<input id="{uid}-station" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" bind:value={draft.station} aria-describedby="{uid}-station-h" />
						<span class="hint" id="{uid}-station-h">The gauge code, e.g. A2H012. Verified DWS data lags by months: use it for calibration, not day-to-day operation.</span>
					</div>
				{:else}
					<div class="field">
						<label for="{uid}-cells">Grid cells</label>
						<textarea id="{uid}-cells" rows="3" spellcheck="false" bind:value={draft.cells} aria-describedby="{uid}-cells-h"></textarea>
						<span class="hint" id="{uid}-cells-h">
							One per line: “latitude, longitude”, optionally “, weight”. The rainfall is the weighted mean of the 0.05° (about 5.5 km) cells
							holding these points.{#if data.mode === 'fixtures'}{' '}The sample grid covers latitude −20.00 to −20.30, longitude 25.00 to 25.40.{/if}
						</span>
					</div>
				{/if}
				{#if formError}<p class="err" role="alert">{formError}</p>{/if}
				<div class="row">
					<button type="submit" class="btn btn-primary btn-sm" disabled={busy === 'add'}>{busy === 'add' ? 'Attaching…' : 'Attach feed'}</button>
					<button type="button" class="btn btn-sm" onclick={() => (adding = false)}>Cancel</button>
				</div>
			</form>
		{/if}
	{/if}
</section>

<style>
	.hint {
		font-size: 0.8rem;
		max-width: 75ch;
	}
	.small {
		font-size: 0.8rem;
	}
	.feeds {
		list-style: none;
		margin: 0 0 0.75rem;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}
	.feed {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.6rem 0.75rem;
	}
	.feed p {
		margin: 0.2rem 0;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: baseline;
	}
	.state {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text-2);
	}
	.state-ok {
		background: var(--accent-soft);
		color: var(--accent);
		border-color: transparent;
	}
	.state-stale,
	.state-failing {
		background: var(--warning-soft);
		color: var(--warning);
		border-color: transparent;
	}
	.state-failing {
		background: var(--danger-soft);
		color: var(--danger);
	}
	.act,
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.4rem;
	}
	.add {
		margin-top: 0.75rem;
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}
	.add h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	.err {
		color: var(--danger);
		font-size: 0.85rem;
	}
</style>
