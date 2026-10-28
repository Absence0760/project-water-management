<!--
	Data → Data feeds (roadmap WP-2.10; docs/ui.md § Data feeds; on Settings
	until issue #586 moved it beside the series it fills): the
	project's scheduled feeds (CHIRPS rainfall, the CHIRPS-GEFS and ECMWF ENS forecasts, DWS
	gauge flow) with their health, "Run now", and a card to attach one. Owners
	attach, switch off and remove feeds; editors can run one now; viewers read.
	The add action sits in the panel's head (issue #521) and opens the card
	above the list; the card's Area choice also holds the two proposals from
	the map (the catchment boundary, each unit's parcel), which editors open
	from the head's "Rain from the map" to read. Helpers in ./feeds.ts.
-->
<script lang="ts">
	import DayInput from '#lib/components/common/DayInput.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import { onMount, tick, untrack } from 'svelte';
	import { page } from '$app/state';
	import { api } from '#lib/api/index.js';
	import { fmtNum } from '#lib/format/number.js';
	import NearestGauges from './NearestGauges.svelte';
	import { kindLabel } from '#lib/series/kinds.js';
	import BoundaryRain from './BoundaryRain.svelte';
	import UnitRain from './UnitRain.svelte';
	import {
		calibrationNote,
		et0Note,
		gapFillNote,
		cellsUsedNote,
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
		nextTryNote,
		rainCopyNote,
		targetHint,
		separateName,
		STATE_LABELS,
		takeoverOf,
		versionClash
	} from './feeds';
	import { createPoller, fetchOutcome, outcomeMessage, STILL_WAITING } from './follow';

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
	/**
	 * The Area choice's two proposals from the map (issue #521: they were two unlabelled buttons under
	 * the list): CHIRPS for the catchment boundary, or one feed per unit's parcel. Each brings its own
	 * proposal and action row in place of the hand-typed area and Attach feed. Null: cells or a box.
	 */
	let mapArea = $state<'boundary' | 'units' | null>(null);
	/** Focus the proposal's heading once loaded: it was opened by a link (?rain=), not by the select. */
	let mapFocus = $state(false);
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
	/** How far our copy of the CHIRPS rain data reaches, for a project with a CHIRPS feed (issue #604); null otherwise. */
	const copyNote = $derived(data ? rainCopyNote(data.rainCopy, data.feeds) : null);
	/** The map's proposals: CHIRPS only, and for editors as well as owners (editors read them; an owner applies). */
	const mapAreas = $derived(!!data?.canRun && draft.source === 'chirps');
	/** An editor (not an owner) opens the card only to read the map's proposals. */
	const mapOnly = $derived(!!data && data.canRun && !data.canEdit);
	const sourceLabel = (f: FeedMeta) => data?.sources.find((s) => s.source === f.source)?.label ?? f.source;

	/**
	 * Fetches queued by Run now that haven't run yet: feed id → its
	 * lastAttemptAt when the button was pressed (follow.ts fetchOutcome). Every
	 * list that lands settles them; the poller re-reads the list until none is left.
	 */
	const following = new Map<string, string | null>();

	/** Say how each followed fetch that has now run went, in the live region; focus stays where it is. */
	function settle() {
		if (!data || following.size === 0) return;
		const said: string[] = [];
		for (const [id, before] of following) {
			const f = data.feeds.find((x) => x.id === id);
			const outcome = fetchOutcome(before, f);
			if (outcome === 'waiting') continue;
			following.delete(id);
			// Removed or switched off meanwhile: the row (or its absence) says so.
			if (outcome === 'gone' || !f) continue;
			said.push(outcomeMessage(outcome, f, healthMessage(f.health), nextTryNote(f)));
		}
		if (said.length) message = said.join(' ');
	}

	// Only the newest list request may land: an older one answering late
	// (a slow first load, a double press of Refresh, a poll) must not overwrite it.
	let seq = 0;
	/**
	 * Re-read the list. Never throws: with a list already shown, a failure keeps
	 * it and says so, unless `quiet` (a background poll, which just tries again).
	 */
	async function reload(quiet = false): Promise<boolean> {
		const mine = ++seq;
		try {
			const next = await feeds.list();
			if (mine !== seq) return false;
			data = next;
			loadError = null;
			settle();
			return true;
		} catch (e) {
			if (mine !== seq || quiet) return false;
			if (data) error = `Couldn’t refresh the data feeds: ${errorText(e)}`;
			else loadError = errorText(e);
			return false;
		}
	}

	// Follows the fetches Run now queued (issue #586 Round 4), never while the page is hidden.
	const poller = createPoller({
		poll: async () => {
			await reload(true);
			return following.size > 0;
		},
		onGiveUp: () => {
			following.clear();
			message = STILL_WAITING;
		},
		hidden: () => document.hidden
	});

	onMount(() => {
		void reload();
		const onVisibility = () => (document.hidden ? poller.pause() : poller.resume());
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			document.removeEventListener('visibilitychange', onVisibility);
			poller.stop();
		};
	});

	async function refresh() {
		if (refreshing || busy) return;
		message = error = null;
		refreshing = true;
		// A followed fetch that has run says so instead.
		if ((await reload()) && !message) message = 'Status refreshed.';
		refreshing = false;
	}

	// Focus follows the form: into it when it opens, back to "Attach a feed"
	// when it closes, so a keyboard user is never dropped on the page body.
	async function startAdding(area: 'boundary' | 'units' | null = null, focusProposal = false) {
		draft = emptyDraft('chirps', data?.sources.find((s) => s.source === 'chirps')?.kinds);
		formError = formField = takeover = null;
		// An editor's card has only the map's proposals: it opens on the first.
		mapArea = area ?? (mapOnly ? 'boundary' : null);
		mapFocus = focusProposal;
		adding = true;
		if (focusProposal) return;
		await tick();
		document.getElementById(mapOnly ? `${uid}-area` : `${uid}-src`)?.focus();
	}

	function pickArea(v: string) {
		mapFocus = false;
		if (v === 'boundary' || v === 'units') mapArea = v;
		else {
			mapArea = null;
			draft.area = v as FeedDraft['area'];
		}
		// A problem with the other way of naming the area no longer applies.
		if (formField === 'cells' || formField === 'bbox') formError = formField = null;
	}

	// ?rain=boundary (the Map tab's link) and ?rain=units (Settings' Rain for each unit), both links to
	// ?tab=series…#data-feeds, open the card on that proposal, also when the link is followed on this page;
	// once per arrival, so closing it while the URL still asks doesn't open it again. Not for a viewer, who has neither.
	const rainAsked = $derived.by(() => {
		const r = page.url.searchParams.get('rain');
		return r === 'boundary' || r === 'units' ? r : null;
	});
	let rainAnswered: string | null = null;
	$effect(() => {
		const asked = rainAsked;
		if (!asked) {
			rainAnswered = null;
			return;
		}
		if (!data?.canRun || rainAnswered === asked) return;
		rainAnswered = asked;
		untrack(() => void startAdding(asked, true));
	});

	async function closeForm() {
		adding = false;
		await tick();
		attachButton?.focus();
	}

	function pickSource(s: FeedDraft['source']) {
		draft.source = s;
		// The map's proposals are CHIRPS only.
		if (s !== 'chirps') mapArea = null;
		draft.targetKind = data?.sources.find((x) => x.source === s)?.kinds[0] ?? '';
		// A problem with the other source's field (or series) no longer applies.
		formError = formField = takeover = null;
	}

	/** A proposed station (NearestGauges): it only fills the field; the owner still attaches the feed. */
	async function useStation(code: string) {
		draft.station = code;
		if (formField === 'station') formError = formField = null;
		await tick();
		document.getElementById(`${uid}-station`)?.focus();
	}

	/** Submit the form; `confirmed` once the owner chose to write into the existing series. */
	async function add(e: SubmitEvent | null, confirmed = false) {
		e?.preventDefault();
		// A map proposal has its own Apply (Enter in its start date lands here).
		if (busy || mapArea) return;
		// Text the start date field can't read as a day: it says so under itself (DayInput); go there.
		const box = document.getElementById(`${uid}-start`) as HTMLInputElement | null;
		if (box?.validity.customError) {
			box.focus();
			return;
		}
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

	// One action at a time, on any card: each ends by re-reading the list, and
	// two at once could lay an older list over a newer one. So while one saves,
	// every card's buttons (and the form's) are aria-disabled, never live-looking
	// buttons whose press is dropped (seen in production: 5 of 11 Switch on).
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
		let follow = false;
		try {
			if (what === 'run') {
				const before = f.lastAttemptAt;
				const r = await feeds.runNow(f.id);
				message = r.created ? 'Fetch queued. The status below updates once the background worker has run it.' : 'A fetch for this feed is already waiting to run.';
				following.set(f.id, before);
				follow = true;
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
		if (follow && following.size > 0) poller.start();
		// A removed feed takes its buttons with it: keep focus in the section.
		if (what === 'remove' && !data?.feeds.some((x) => x.id === f.id)) heading?.focus();
	}
</script>

<!-- Its #data-feeds anchor is on the wrapper in series/SeriesTab.svelte, which lazy-loads this panel. -->
<section class="panel" aria-labelledby="{uid}-h">
	<!-- The panel's actions in its head (issue #521): Refresh status, and the add action that opens the card. The words
	     that were a paragraph under the heading are the (i)'s, with the rest in the glossary. -->
	<div class="panel-head">
		<div class="title">
			<h2 id="{uid}-h" tabindex="-1" bind:this={heading}>Data feeds <HelpTip key="data-feeds" /></h2>
			{#if data?.mode === 'fixtures'}<span class="badge badge-warn" title="This server reads synthetic sample files, not the real sources">Sample data</span>{/if}
		</div>
		{#if data}
			<div class="head-actions">
				<button type="button" class="btn btn-sm" onclick={refresh} aria-disabled={busy !== null || refreshing}>{refreshing ? 'Refreshing…' : 'Refresh status'}</button>
				{#if data.canRun && !adding}
					<button type="button" class="btn btn-sm btn-primary" bind:this={attachButton} onclick={() => startAdding()}>{mapOnly ? 'Rain from the map' : 'Attach a feed'}</button>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Feeds save on their own, never through the workspace's save bar: say so where the changes are made (issue #586, E13). -->
	{#if data?.canEdit}
		<p class="muted small saves" data-testid="feeds-saves">Feeds save as you change them: attaching, switching off or removing one needs no Save changes.</p>
	{/if}

	{#if loadError}
		<div class="alert alert-error" role="alert">
			Couldn’t load the data feeds: {loadError}
			<button type="button" class="btn btn-sm" onclick={refresh}>Try again</button>
		</div>
	{:else if !data}
		<p class="muted" role="status">Loading…</p>
	{:else}
		<!-- Always in the page, so screen readers announce each new message. -->
		<div role="status">{#if message}<p class="muted msg">{message}</p>{/if}</div>
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

		{#if adding}
			<!-- The add card, above the list (an add form above a long list, not under it), with its own action row. -->
			<form class="add" onsubmit={add} novalidate aria-labelledby="{uid}-add-h">
				<h3 id="{uid}-add-h">{mapOnly ? 'Rain from the map' : 'Attach a feed'}</h3>
				<div class="form-row">
					{#if !mapOnly}
						<div class="field">
							<label for="{uid}-src">Source</label>
							<select id="{uid}-src" value={draft.source} onchange={(e) => pickSource(e.currentTarget.value as FeedDraft['source'])}>
								{#each data.sources as s (s.source)}<option value={s.source}>{s.label}</option>{/each}
							</select>
						</div>
					{/if}
					{#if draft.source !== 'dws'}
						<div class="field">
							<label for="{uid}-area">Area</label>
							<select id="{uid}-area" value={mapArea ?? draft.area} onchange={(e) => pickArea(e.currentTarget.value)}>
								{#if !mapOnly}
									<option value="cells">Grid cells</option>
									<option value="bbox">Bounding box</option>
								{/if}
								{#if mapAreas}
									<option value="boundary">The catchment boundary, from the map</option>
									<option value="units">Each unit’s parcel: a feed per unit</option>
								{/if}
							</select>
						</div>
					{/if}
				</div>
				{#if !mapArea}
					<div class="form-row">
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
					</div>
				{/if}
				{#if mapArea === 'boundary'}
					<!-- The rain feed from the map's catchment boundary (issue #326 B-rain): a proposal for editors, applied by an owner. -->
					<BoundaryRain {projectId} feeds={data.feeds} focus={mapFocus} onclose={closeForm} onapplied={() => reload().then(() => undefined)} />
				{:else if mapArea === 'units'}
					<!-- One CHIRPS feed per land unit, from its parcel (issue #482): owners set them up, editors read. -->
					<UnitRain {projectId} feeds={data.feeds} focus={mapFocus} onclose={closeForm} onapplied={() => reload().then(() => undefined)} />
				{:else}
					{#if draft.source === 'dws'}
						<NearestGauges {projectId} current={draft.station} onuse={useStation} />
						<div class="field">
							<label for="{uid}-station">DWS station <HelpTip key="dws-flow" /></label>
							<input
								id="{uid}-station"
								type="text"
								required
								autocomplete="off"
								autocapitalize="characters"
								spellcheck="false"
								bind:value={draft.station}
								aria-invalid={formField === 'station' || undefined}
								aria-describedby="{uid}-station-h {uid}-station-x{formField === 'station' ? ` ${uid}-err` : ''}"
							/>
							<span class="hint" id="{uid}-station-h">The gauge code, e.g. A2H012.</span>
							<span class="hint explain" id="{uid}-station-x">Verified DWS data lags by months: use it for calibration, not day-to-day operation.</span>
						</div>
					{:else}
						{#if draft.source === 'chirps'}
							<div class="form-row">
								<div class="field">
									<label for="{uid}-product">Daily product <HelpTip key="chirps-version" label="About which CHIRPS a series holds" /></label>
									<select id="{uid}-product" bind:value={draft.product} aria-describedby="{uid}-product-h">
										<option value="sat">sat: from 1998, with preliminary days</option>
										<option value="rnl">rnl: from 1981, final days only</option>
									</select>
								</div>
								<div class="field">
									<label for="{uid}-start">Start date <span class="muted">(optional)</span></label>
									<DayInput
										id="{uid}-start"
										bind:value={draft.startDate}
										aria-invalid={formField === 'start' || undefined}
										aria-describedby="{uid}-product-h{formField === 'start' ? ` ${uid}-err` : ''}"
									/>
								</div>
							</div>
							<span class="hint explain" id="{uid}-product-h">
								CHIRPS v3 comes as two daily products with the same pentad totals but different daily timing. A feed reads one of them for the
								whole record, never one spliced onto the other: choose rnl for a record that starts before 1998. Without a start date the feed
								reads the last 60 days, then keeps up.
							</span>
						{/if}
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
									aria-describedby="{uid}-bbox-h {uid}-bbox-x{formField === 'bbox' ? ` ${uid}-err` : ''}"
								/>
								<span class="hint" id="{uid}-bbox-h">
									“south, west, north, east” in degrees.{#if data.mode === 'fixtures'}{' '}The sample grid covers latitude −20.00 to −20.30, longitude 25.00 to 25.40; try
										−20.20, 25.10, −20.10, 25.20.{/if}
								</span>
								<span class="hint explain" id="{uid}-bbox-x">
									The rainfall is the area-weighted mean of every 0.05° cell the box overlaps, a cell partly inside counting for its share; at most 100
									cells in 25 rows (about 0.5° × 0.5°). A sea cell in the box fails the fetch unless the sea cells are left out.
								</span>
							</div>
							<div class="field">
								<label class="check"><input type="checkbox" bind:checked={draft.skipNoData} aria-describedby="{uid}-skip-h" /> Leave out sea cells</label>
								<span class="hint explain" id="{uid}-skip-h">
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
									aria-describedby="{uid}-cells-h {uid}-cells-x{formField === 'cells' ? ` ${uid}-err` : ''}"
								></textarea>
								<span class="hint" id="{uid}-cells-h">
									One per line: “latitude, longitude”, optionally “, weight”.{#if data.mode === 'fixtures'}{' '}The sample grid covers latitude −20.00 to −20.30, longitude 25.00 to 25.40.{/if}
								</span>
								<span class="hint explain" id="{uid}-cells-x">The rainfall is the weighted mean of the 0.05° (about 5.5 km) cells holding these points.</span>
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
									<button type="button" class="btn btn-sm btn-danger" aria-disabled={busy !== null} onclick={() => add(null, true)}>Replace the series with {q.clash.writes}</button>
								{:else}
									<button type="button" class="btn btn-sm" aria-disabled={busy !== null} onclick={() => add(null, true)}>Fill its empty days</button>
								{/if}
							</div>
						</div>
					{/if}
					<div class="action-row">
						<button type="submit" class="btn btn-primary" aria-disabled={busy !== null}>{busy === 'add' ? 'Attaching…' : 'Attach feed'}</button>
						<button type="button" class="btn" onclick={closeForm}>Cancel</button>
					</div>
				{/if}
			</form>
		{/if}

		{#if copyNote}
			<!-- Our copy of the rain data (issue #604): a plain line, a warning box when it is late; never role="alert", as nothing here can fix it. -->
			<p class={copyNote.behind ? 'alert alert-warning copy' : 'muted small copy'} data-testid="rain-copy" data-behind={copyNote.behind}>{copyNote.text}</p>
		{/if}

		{#if attention}
			<div class="alert alert-warning" role="alert" data-testid="feeds-attention">
				{attention === 1 ? '1 feed needs' : `${attention} feeds need`} attention: its data is out of date or its last fetch failed.
			</div>
		{/if}

		<!-- The app's one empty state (LoadState's dashed box), as API keys and Scheduled reports show theirs (issue #586, C17). -->
		<LoadState loading={false} empty={data.feeds.length === 0} emptyText="No feeds yet{data.canEdit ? '.' : '. An owner can attach one.'}">
			<ul class="feeds" aria-label="Data feeds">
				{#each data.feeds as f (f.id)}
					<li class="feed" data-state={f.health.state}>
						<div class="head">
							<span class="state state-{f.health.state}">{STATE_LABELS[f.health.state]}</span>
							<strong>{sourceLabel(f)}</strong>
							<span class="muted">→ {describeTarget(f)}</span>
						</div>
						<p class="where muted small">{describePlace(f)}{describeWrites(f)} · {f.schedule}{describeRunsAs(f)}</p>
						<p class="health">{healthMessage(f.health)}{#if nextTryNote(f)}{' '}{nextTryNote(f)}{/if}</p>
						{#if conflictMessage(f)}
							<p class="alert alert-warning version" data-testid="feed-version-conflict">{conflictMessage(f)}</p>
						{/if}
						<p class="muted small">{describeTimes(f)}{#if f.lastMeta?.prelimDays}{' '}· {f.lastMeta.prelimDays} preliminary days{/if}{#if keptNote(f.lastMeta)}{' '}· {keptNote(f.lastMeta)}{/if}{#if cellsUsedNote(f)}{' '}· {cellsUsedNote(f)} with data{/if}{#if calibrationNote(f)}{' '}· {calibrationNote(f)}{/if}{#if et0Note(f)}{' '}· {et0Note(f)}{/if}{#if gapFillNote(f.lastMeta)}{' '}· {gapFillNote(f.lastMeta)}{/if}</p>
						{#if data.canRun || data.canEdit}
							<div class="act">
								{#if data.canRun && f.enabled}
									<button type="button" class="btn btn-sm" aria-disabled={busy !== null} aria-label="Run now: {describeTarget(f)}" onclick={() => act(f, 'run')}>Run now</button>
								{/if}
								{#if data.canEdit && f.versionConflict && f.replaceFrom === null}
									<button type="button" class="btn btn-sm btn-danger" aria-disabled={busy !== null} aria-label="Replace the series: {describeTarget(f)}" onclick={() => act(f, 'replace')}>Replace the series</button>
								{/if}
								{#if data.canEdit && f.replaceFrom !== null}
									<button type="button" class="btn btn-sm" aria-disabled={busy !== null} aria-label="Withdraw the replacement: {describeTarget(f)}" onclick={() => act(f, 'withdraw')}>Withdraw the replacement</button>
								{/if}
								{#if data.canEdit}
									<button type="button" class="btn btn-sm" aria-disabled={busy !== null} aria-label="{f.enabled ? 'Switch off' : 'Switch on'}: {describeTarget(f)}" onclick={() => act(f, 'toggle')}>
										{f.enabled ? 'Switch off' : 'Switch on'}
									</button>
									<button type="button" class="btn btn-sm btn-danger" aria-disabled={busy !== null} aria-label="Remove feed: {describeTarget(f)}" onclick={() => act(f, 'remove')}>Remove</button>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</LoadState>
	{/if}
</section>

<style>
	/* The box and its words on one line; a full-height target on a phone. */
	.check {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
	}
	@media (pointer: coarse), (max-width: 640px) {
		.check {
			min-height: var(--tap);
		}
	}
	.hint {
		font-size: var(--font-sm);
		max-width: 75ch;
	}
	.saves {
		margin: 0 0 0.6rem;
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
	/* A badge's corners (app.css .badge): a pill on one line, a rounded box if "Copy behind" wraps on a phone. */
	.state {
		font-size: var(--font-xs);
		font-weight: 600;
		padding: 0.05rem 0.45rem;
		border-radius: 0.7rem;
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
	.title {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
	}
	.head-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.msg {
		margin: 0 0 0.5rem;
	}
	.copy {
		margin: 0 0 0.6rem;
		max-width: 75ch;
	}
	/* The add card: bordered, above the list, its action row at its foot. */
	.add {
		margin: 0 0 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem 0.9rem;
	}
	/* A long choice ("The catchment boundary, from the map") never pushes a field out of a phone's card. */
	.add .field {
		min-width: 0;
		max-width: 100%;
	}
	.add select {
		max-width: 100%;
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
</style>
