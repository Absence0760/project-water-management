<!--
	Settings → Data feeds (roadmap WP-2.10; docs/ui.md § Data feeds): the
	project's scheduled feeds (CHIRPS rainfall, the CHIRPS-GEFS forecast, DWS
	gauge flow) with their health, "Run now", and a form to attach one. Owners
	attach, switch off and remove feeds; editors can run one now; viewers read.
	Part of the Settings tab's chunk. Helpers in ./feeds.ts.
-->
<script lang="ts">
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { onMount, tick } from 'svelte';
	import { api } from '$lib/api';
	import { fmtNum } from '$lib/format/number';
	import { kindLabel } from '$lib/series/kinds';
	import {
		CHIRPS_PRODUCT_FIRST_DAY,
		conflictMessage,
		describePlace,
		describeRunsAs,
		describeTarget,
		describeTimes,
		describeWrites,
		draftToBody,
		emptyDraft,
		type FeedDraft,
		type FeedList,
		type FeedMeta,
		errorText,
		feedsApi,
		healthMessage,
		keptNote,
		needsAttention,
		targetHint,
		separateName,
		STATE_LABELS,
		takeoverOf,
		versionClash
	} from './feeds';

	let { projectId }: { projectId: string } = $props();

	const uid = $props.id();
	const feeds = $derived(feedsApi(api, projectId));

	let data = $state<FeedList | null>(null);
	let loadError = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let refreshing = $state(false);
	let message = $state<string | null>(null);
	let error = $state<string | null>(null);
	let adding = $state(false);
	let draft = $state<FeedDraft>(emptyDraft());
	let formError = $state<string | null>(null);
	/** The field formError is about (a client-side check), for aria-invalid and focus. */
	let formField = $state<'cells' | 'bbox' | 'station' | 'start' | null>(null);
	let heading = $state<HTMLElement>();
	let attachButton = $state<HTMLButtonElement>();
	/**
	 * The target already holds data (issue #30): the feed would replace its
	 * values on the days it fetches, so the form asks first. Shown only while
	 * the form still names that series; changing it drops the question.
	 */
	let takeover = $state<{ kind: string; name: string; days: number; suggestion: string; clash: { holds: string; writes: string } | null } | null>(null);
	const asking = $derived(takeover && takeover.kind === draft.targetKind && takeover.name === draft.targetName.trim() ? takeover : null);
	let separateButton = $state<HTMLButtonElement>();

	const source = $derived(data?.sources.find((s) => s.source === draft.source));
	// What the chosen series means for the model when it isn't the obvious one (CHIRPS as the catchment rain, issue #51).
	const kindHint = $derived(targetHint(draft.source, draft.targetKind));
	const attention = $derived(data ? needsAttention(data.feeds) : 0);
	const sourceLabel = (f: FeedMeta) => data?.sources.find((s) => s.source === f.source)?.label ?? f.source;

	// Only the newest list request may land: an older one answering late
	// (a slow first load, a double press of Refresh) must not overwrite it.
	let seq = 0;
	/** Re-read the list. Never throws: with a list already shown, a failure keeps it and says so. */
	async function reload(): Promise<boolean> {
		const mine = ++seq;
		try {
			const next = await feeds.list();
			if (mine !== seq) return false;
			data = next;
			loadError = null;
			return true;
		} catch (e) {
			if (mine !== seq) return false;
			if (data) error = `Couldn’t refresh the data feeds: ${errorText(e)}`;
			else loadError = errorText(e);
			return false;
		}
	}
	onMount(reload);

	async function refresh() {
		if (refreshing) return;
		message = error = null;
		refreshing = true;
		if (await reload()) message = 'Status refreshed.';
		refreshing = false;
	}

	// Focus follows the form: into it when it opens, back to "Attach a feed"
	// when it closes, so a keyboard user is never dropped on the page body.
	async function startAdding() {
		draft = emptyDraft('chirps', data?.sources.find((s) => s.source === 'chirps')?.kinds);
		formError = formField = takeover = null;
		adding = true;
		await tick();
		document.getElementById(`${uid}-src`)?.focus();
	}

	async function closeForm() {
		adding = false;
		await tick();
		attachButton?.focus();
	}

	function pickSource(s: FeedDraft['source']) {
		draft.source = s;
		draft.targetKind = data?.sources.find((x) => x.source === s)?.kinds[0] ?? '';
		// A problem with the other source's field (or series) no longer applies.
		formError = formField = takeover = null;
	}

	/** Submit the form; `confirmed` once the owner chose to write into the existing series. */
	async function add(e: SubmitEvent | null, confirmed = false) {
		e?.preventDefault();
		if (busy) return;
		const parsed = draftToBody(draft);
		if ('error' in parsed) {
			formError = parsed.error;
			formField = parsed.field;
			await tick();
			document.getElementById(`${uid}-${parsed.field}`)?.focus();
			return;
		}
		busy = 'add';
		formError = formField = message = error = null;
		// Confirming a takeover of a series of another CHIRPS version replaces it whole (issue #40c).
		const replaceSeries = confirmed && !!asking?.clash;
		if (!confirmed && data) {
			// Ask before a feed writes into a series that already holds data (the two records would mix).
			let series;
			try {
				series = await api.series.list(projectId);
			} catch (err) {
				formError = `Couldn’t check whether that series already has data: ${errorText(err)}`;
				busy = null;
				return;
			}
			const hit = takeoverOf(series, data.feeds, parsed.body);
			if (hit) {
				takeover = {
					kind: hit.kind,
					name: hit.name,
					days: hit.length,
					suggestion: separateName(parsed.body, series, data.feeds),
					clash: versionClash(hit, parsed.body)
				};
				busy = null;
				await tick();
				separateButton?.focus();
				return;
			}
		}
		takeover = null;
		let attached = false;
		try {
			const feed = await feeds.create(replaceSeries ? { ...parsed.body, replaceSeries } : parsed.body);
			attached = true;
			message = replaceSeries
				? `Feed attached: its first fetch replaces ${describeTarget(feed)} with ${describeWrites(feed).slice(3)}. The old values stay in the History tab. Refit afterwards.`
				: `Feed attached: ${describeTarget(feed)} from ${describePlace(feed)}. It runs on the next schedule, or now with “Run now”.`;
		} catch (err) {
			formError = errorText(err);
		}
		// Either way the list may have moved (another owner's feed for the same series is the usual 409).
		await reload();
		busy = null;
		if (attached) await closeForm();
	}

	/** Leave the question: with `name`, into that separate series. Focus goes to the name field either way. */
	async function answerTakeover(name?: string) {
		if (name !== undefined) draft.targetName = name;
		takeover = null;
		await tick();
		document.getElementById(`${uid}-name`)?.focus();
	}

	async function act(f: FeedMeta, what: 'run' | 'toggle' | 'remove' | 'replace' | 'withdraw') {
		if (busy) return;
		if (
			what === 'remove' &&
			!(await confirmDialog({
				title: 'Remove this feed?',
				message: `Remove the ${sourceLabel(f)} feed into “${describeTarget(f)}”? The series keeps the days it already has.`,
				confirmLabel: 'Remove feed',
				danger: true
			}))
		)
			return;
		if (
			what === 'replace' &&
			!(await confirmDialog({
				title: `Replace “${describeTarget(f)}”?`,
				message: `Replace “${describeTarget(f)}” with${describeWrites(f).slice(2)}? The feed’s next fetch replaces the whole series from its start date; the old values stay in the History tab, where they can be restored. The CHIRPS factors change with it, so refit afterwards.`,
				confirmLabel: 'Replace series',
				danger: true
			}))
		)
			return;
		busy = f.id;
		message = error = null;
		try {
			if (what === 'run') {
				const r = await feeds.runNow(f.id);
				message = r.created ? 'Fetch queued. The status below updates once the background worker has run it.' : 'A fetch for this feed is already waiting to run.';
			} else if (what === 'replace') {
				await feeds.update(f.id, { replaceSeries: true });
				message = 'Replacement confirmed: the feed backfills the new record, then replaces the series. Run it now, or wait for the schedule.';
			} else if (what === 'withdraw') {
				await feeds.update(f.id, { replaceSeries: false });
				message = 'Replacement withdrawn: what was backfilled is discarded, and the series stays as it is.';
			} else if (what === 'toggle') {
				await feeds.update(f.id, { enabled: !f.enabled });
				message = f.enabled ? 'Feed switched off.' : 'Feed switched on; it runs on the next schedule.';
			} else {
				await feeds.remove(f.id);
				message = 'Feed removed.';
			}
		} catch (e) {
			error = errorText(e);
		}
		// Also after a failure: it usually means the list is out of date (the
		// feed was switched off or removed elsewhere), so show what is there now.
		await reload();
		busy = null;
		// A removed feed takes its buttons with it: keep focus in the section.
		if (what === 'remove' && !data?.feeds.some((x) => x.id === f.id)) heading?.focus();
	}
</script>

<!-- Its #set-feeds anchor is on the wrapper in SettingsTab.svelte, which lazy-loads this panel. -->
<section class="panel" aria-labelledby="{uid}-h">
	<div class="panel-head">
		<h2 id="{uid}-h" tabindex="-1" bind:this={heading}>Data feeds</h2>
		{#if data?.mode === 'fixtures'}<span class="badge badge-warn" title="FEED_SOURCE=fixtures: feeds read synthetic sample files, not the real sources">Sample data</span>{/if}
	</div>
	<p class="hint muted">
		Rainfall and gauge flow that arrive by themselves: CHIRPS daily rainfall and the CHIRPS-GEFS 16-day forecast for grid cells or a box over the
		catchment, or a DWS gauge’s verified daily flow. Each feed fetches daily and merges its new days into one series; a day the source has
		no value for never erases what is there. A feed that stops shows as failing or stale here.
	</p>

	{#if loadError}
		<div class="alert alert-error" role="alert">
			Couldn’t load the data feeds: {loadError}
			<button type="button" class="btn btn-sm" onclick={refresh}>Try again</button>
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
							<strong>{sourceLabel(f)}</strong>
							<span class="muted">→ {describeTarget(f)}</span>
						</div>
						<p class="where muted small">{describePlace(f)}{describeWrites(f)} · {f.schedule}{describeRunsAs(f)}</p>
						<p class="health">{healthMessage(f.health)}</p>
						{#if conflictMessage(f)}
							<p class="alert alert-warning version" data-testid="feed-version-conflict">{conflictMessage(f)}</p>
						{/if}
						<p class="muted small">{describeTimes(f)}{#if f.lastMeta?.prelimDays}{' '}· {f.lastMeta.prelimDays} preliminary days{/if}{#if keptNote(f.lastMeta)}{' '}· {keptNote(f.lastMeta)}{/if}</p>
						{#if data.canRun || data.canEdit}
							<div class="act">
								{#if data.canRun && f.enabled}
									<button type="button" class="btn btn-sm" aria-disabled={busy === f.id} aria-label="Run now: {describeTarget(f)}" onclick={() => act(f, 'run')}>Run now</button>
								{/if}
								{#if data.canEdit && f.versionConflict && f.replaceFrom === null}
									<button type="button" class="btn btn-sm btn-danger" aria-disabled={busy === f.id} aria-label="Replace the series: {describeTarget(f)}" onclick={() => act(f, 'replace')}>Replace the series</button>
								{/if}
								{#if data.canEdit && f.replaceFrom !== null}
									<button type="button" class="btn btn-sm" aria-disabled={busy === f.id} aria-label="Withdraw the replacement: {describeTarget(f)}" onclick={() => act(f, 'withdraw')}>Withdraw the replacement</button>
								{/if}
								{#if data.canEdit}
									<button type="button" class="btn btn-sm" aria-disabled={busy === f.id} aria-label="{f.enabled ? 'Switch off' : 'Switch on'}: {describeTarget(f)}" onclick={() => act(f, 'toggle')}>
										{f.enabled ? 'Switch off' : 'Switch on'}
									</button>
									<button type="button" class="btn btn-sm btn-danger" aria-disabled={busy === f.id} aria-label="Remove feed: {describeTarget(f)}" onclick={() => act(f, 'remove')}>Remove</button>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<div class="row">
			<button type="button" class="btn btn-sm" onclick={refresh} aria-disabled={busy !== null || refreshing}>{refreshing ? 'Refreshing…' : 'Refresh status'}</button>
			{#if data.canEdit && !adding}
				<button type="button" class="btn btn-sm btn-primary" bind:this={attachButton} onclick={startAdding}>Attach a feed</button>
			{/if}
		</div>

		<!-- Always in the page, so screen readers announce each new message. -->
		<div role="status">{#if message}<p class="muted">{message}</p>{/if}</div>
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
						<select id="{uid}-kind" bind:value={draft.targetKind} aria-describedby={kindHint ? `${uid}-kind-hint` : undefined}>
							{#each source?.kinds ?? [] as k (k)}<option value={k}>{kindLabel(k)}</option>{/each}
						</select>
						{#if kindHint}<p class="hint" id="{uid}-kind-hint">{kindHint}</p>{/if}
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
						<input
							id="{uid}-station"
							type="text"
							required
							autocomplete="off"
							autocapitalize="characters"
							spellcheck="false"
							bind:value={draft.station}
							aria-invalid={formField === 'station' || undefined}
							aria-describedby="{uid}-station-h{formField === 'station' ? ` ${uid}-err` : ''}"
						/>
						<span class="hint" id="{uid}-station-h">The gauge code, e.g. A2H012. Verified DWS data lags by months: use it for calibration, not day-to-day operation.</span>
					</div>
				{:else}
					{#if draft.source === 'chirps'}
						<div class="form-row">
							<div class="field">
								<label for="{uid}-product">Daily product</label>
								<select id="{uid}-product" bind:value={draft.product} aria-describedby="{uid}-product-h">
									<option value="sat">sat: from 1998, with preliminary days</option>
									<option value="rnl">rnl: from 1981, final days only</option>
								</select>
							</div>
							<div class="field">
								<label for="{uid}-start">Start date <span class="muted">(optional)</span></label>
								<input
									id="{uid}-start"
									type="date"
									min={CHIRPS_PRODUCT_FIRST_DAY[draft.product]}
									bind:value={draft.startDate}
									aria-invalid={formField === 'start' || undefined}
									aria-describedby="{uid}-product-h{formField === 'start' ? ` ${uid}-err` : ''}"
								/>
							</div>
						</div>
						<span class="hint" id="{uid}-product-h">
							CHIRPS v3 comes as two daily products with the same pentad totals but different daily timing. A feed reads one of them for the
							whole record, never one spliced onto the other: choose rnl for a record that starts before 1998. Without a start date the feed
							reads the last 60 days, then keeps up.
						</span>
					{/if}
					<div class="field">
						<label for="{uid}-area">Area</label>
						<select
							id="{uid}-area"
							bind:value={draft.area}
							onchange={() => {
								// A problem with the other way of naming the area no longer applies.
								if (formField === 'cells' || formField === 'bbox') formError = formField = null;
							}}
						>
							<option value="cells">Grid cells</option>
							<option value="bbox">Bounding box</option>
						</select>
					</div>
					{#if draft.area === 'bbox'}
						<div class="field">
							<label for="{uid}-bbox">Bounding box</label>
							<input
								id="{uid}-bbox"
								type="text"
								required
								autocomplete="off"
								spellcheck="false"
								inputmode="decimal"
								bind:value={draft.bbox}
								aria-invalid={formField === 'bbox' || undefined}
								aria-describedby="{uid}-bbox-h{formField === 'bbox' ? ` ${uid}-err` : ''}"
							/>
							<span class="hint" id="{uid}-bbox-h">
								“south, west, north, east” in degrees. The rainfall is the area-weighted mean of every 0.05° cell the box overlaps, a cell
								partly inside counting for its share; at most 100 cells in 25 rows (about 0.5° × 0.5°). A sea cell in the box fails the fetch
								unless the sea cells are left out.{#if data.mode === 'fixtures'}{' '}The sample grid covers latitude −20.00 to −20.30, longitude 25.00 to 25.40; try
									−20.20, 25.10, −20.10, 25.20.{/if}
							</span>
						</div>
						<div class="field">
							<label class="check"><input type="checkbox" bind:checked={draft.skipNoData} aria-describedby="{uid}-skip-h" /> Leave out sea cells</label>
							<span class="hint" id="{uid}-skip-h">
								For a box on the coast: cells with no data (the sea) are left out and the rest averaged. A land cell that loses its data
								still fails the fetch, and so does a box with no land.
							</span>
						</div>
					{:else}
						<div class="field">
							<label for="{uid}-cells">Grid cells</label>
							<textarea
								id="{uid}-cells"
								rows="3"
								required
								spellcheck="false"
								bind:value={draft.cells}
								aria-invalid={formField === 'cells' || undefined}
								aria-describedby="{uid}-cells-h{formField === 'cells' ? ` ${uid}-err` : ''}"
							></textarea>
							<span class="hint" id="{uid}-cells-h">
								One per line: “latitude, longitude”, optionally “, weight”. The rainfall is the weighted mean of the 0.05° (about 5.5 km) cells
								holding these points.{#if data.mode === 'fixtures'}{' '}The sample grid covers latitude −20.00 to −20.30, longitude 25.00 to 25.40.{/if}
							</span>
						</div>
					{/if}
				{/if}
				{#if formError}<p class="err" id="{uid}-err" role="alert">{formError}</p>{/if}
				{#if asking}
					{@const q = asking}
					<!-- An inline, non-modal question (issue #30): focus lands on the safe choice; Escape goes back to the name field. -->
					<div
						class="alert alert-warning takeover"
						role="alertdialog"
						aria-labelledby="{uid}-to-h"
						aria-describedby="{uid}-to-d"
						tabindex="-1"
						onkeydown={(e) => {
							if (e.key === 'Escape') {
								e.preventDefault();
								e.stopPropagation();
								void answerTakeover();
							}
						}}
					>
						<p id="{uid}-to-h"><strong>“{describeTarget({ targetKind: q.kind, targetName: q.name })}” already has data ({fmtNum(q.days)} days).</strong></p>
						{#if q.clash}
							<p id="{uid}-to-d" data-testid="feed-version-question">
								It holds {q.clash.holds}, and this feed writes {q.clash.writes}. The two differ by an amount that changes over the years, so a
								feed never splices one onto the other. It can replace the whole series from its start date (the old values stay in the History
								tab, and the CHIRPS factors and any fit made on the old values no longer hold), or write to a separate series, such as
								“{q.suggestion}”, so you can compare the two.
							</p>
						{:else}
							<p id="{uid}-to-d">
								The values already there stay, including ones you uploaded or imported: the feed fills only the days without one, so the
								series would mix this record with the feed’s. To compare the two side by side, send the feed to a separate series, such as
								“{q.suggestion}”.
							</p>
						{/if}
						<div class="row">
							<button type="button" class="btn btn-sm btn-primary" bind:this={separateButton} onclick={() => answerTakeover(q.suggestion)}>Use a separate series: {q.suggestion}</button>
							{#if q.clash}
								<button type="button" class="btn btn-sm btn-danger" aria-disabled={busy === 'add'} onclick={() => add(null, true)}>Replace the series with {q.clash.writes}</button>
							{:else}
								<button type="button" class="btn btn-sm" aria-disabled={busy === 'add'} onclick={() => add(null, true)}>Fill its empty days</button>
							{/if}
						</div>
					</div>
				{/if}
				<div class="row">
					<button type="submit" class="btn btn-primary btn-sm" aria-disabled={busy === 'add'}>{busy === 'add' ? 'Attaching…' : 'Attach feed'}</button>
					<button type="button" class="btn btn-sm" onclick={closeForm}>Cancel</button>
				</div>
			</form>
		{/if}
	{/if}
</section>

<style>
	/* The box and its words on one line; a full-height target on a phone. */
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 36px;
	}
	@media (pointer: coarse), (max-width: 640px) {
		.check {
			min-height: var(--tap);
		}
	}
	.hint {
		font-size: 0.8rem;
		max-width: 75ch;
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
	.version {
		margin: 0.3rem 0;
		font-size: 0.85rem;
		max-width: 75ch;
	}
	.takeover p {
		margin: 0 0 0.4rem;
		max-width: 75ch;
	}
	.err {
		color: var(--danger);
		font-size: 0.85rem;
	}
	/* Busy buttons stay focusable (aria-disabled, not disabled) but look it. */
	.btn[aria-disabled='true'] {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>
