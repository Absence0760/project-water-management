<!--
	Data → Data feeds (roadmap WP-2.10; docs/ui.md § Data feeds; on Settings
	until issue #586 moved it beside the series it fills): the
	project's scheduled feeds (CHIRPS rainfall, the CHIRPS-GEFS and ECMWF ENS forecasts, DWS
	gauge flow, a weather station's own API: StationApiFeedForm.svelte, with its key write-only) with their health, "Run now", and a card to attach one. Owners
	attach, switch off and remove feeds; editors can run one now; viewers read.
	The add action sits in the panel's head (issue #521) and opens the card
	above the list; the card's Area choice also holds the two proposals from
	the map (the catchment boundary, for CHIRPS or the daily reference ET
	feed; each unit's parcel, CHIRPS only), which editors open
	from the head's "Rain from the map" to read. Helpers in ./feeds.ts.
-->
<script lang="ts">
	import DayInput from '#lib/components/common/DayInput.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import Lazy from '#lib/components/common/Lazy.svelte';
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
		credentialLine,
		credentialPatch,
		warningText,
		describePlace,
		describeRunsAs,
		describeTarget,
		describeTimes,
		describeWrites,
		draftToBody,
		emptyDraft,
		type FeedBody,
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
		attentionText,
		catchingUp,
		pendingNote,
		stateLabel,
		takeoverOf,
		versionClash
	} from './feeds';
	import { cardFetchNote, createPoller, fetchOutcome, FOLLOW_TAIL_MS, outcomeMessage, queuedMessage, STILL_WAITING, type CardFetchState } from './follow';
	import { SvelteMap } from 'svelte/reactivity';
	import type { StationBody, StationField } from './stationApi';

	/** The weather station API form (issue #784): its own chunk, loaded only when that source is picked. */
	const loadStationForm = () => import('./StationApiFeedForm.svelte');

	let { projectId }: { projectId: string } = $props();

	const uid = $props.id();
	const feeds = $derived(feedsApi(api, projectId));

	let data = $state<FeedList | null>(null);
	let loadError = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let refreshing = $state(false);
	let message = $state<string | null>(null);
	/** For screen readers only, in the section's live region: what became of a Run now, whose words show on its card. */
	let announce = $state<string | null>(null);
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
	let formField = $state<'cells' | 'bbox' | 'station' | 'start' | StationField | null>(null);
	/** The station API form, once its chunk is in: build() gives the body or the first problem. */
	let stationForm = $state<{
		build: () => { body: StationBody } | { error: string; field: StationField };
		serverProblem: (e: unknown) => { error: string; field: StationField } | null;
	}>();
	/** The card whose key is being replaced (owners only), and the write-only fields of its small form. */
	let keyFor = $state<string | null>(null);
	let keySecret = $state('');
	let keyUser = $state('');
	let keyError = $state<string | null>(null);
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
	/** A weather station API feed can't be attached on this server (STATION_API_FEEDS off): its source is offered disabled, with a note. */
	const stationOff = $derived(data?.stationApiFeeds === false && data.sources.some((s) => s.source === 'station_api'));
	// What the chosen series means for the model when it isn't the obvious one (CHIRPS as the catchment rain, issue #51).
	const kindHint = $derived(targetHint(draft.source, draft.targetKind));
	const attention = $derived(data ? needsAttention(data.feeds) : 0);
	/** How far our copy of the CHIRPS rain data reaches, for a project with a CHIRPS feed (issue #604); null otherwise. */
	const copyNote = $derived(data ? rainCopyNote(data.rainCopy, data.feeds) : null);
	/**
	 * The map's proposals, for editors as well as owners (editors read them; an owner applies): the catchment boundary
	 * for CHIRPS and the daily reference ET feed (agera5_et0), each unit's parcel for CHIRPS only.
	 */
	const mapAreas = $derived(!!data?.canRun && (draft.source === 'chirps' || draft.source === 'agera5_et0'));
	const unitAreas = $derived(mapAreas && draft.source === 'chirps');
	/** An editor (not an owner) opens the card only to read the map's proposals. */
	const mapOnly = $derived(!!data && data.canRun && !data.canEdit);
	const sourceLabel = (f: FeedMeta) => data?.sources.find((s) => s.source === f.source)?.label ?? f.source;

	/**
	 * Each card's Run now: feed id → its lastAttemptAt when the button was
	 * pressed (follow.ts fetchOutcome), and where it stands, shown on that card
	 * (`data-fetch`, its line) with its Run now disabled while queued. Every
	 * list that lands settles the queued ones; the poller re-reads the list
	 * until none is left. Done, failed and slow lines stay until the next action.
	 */
	const fetches = new SvelteMap<string, { before: string | null; state: CardFetchState; created: boolean }>();
	const queuedCount = () => [...fetches.values()].filter((x) => x.state === 'queued').length;
	/** Run now waits while its own press is followed or the server reports a fetch under way (a backfill's next window). */
	const runWaits = (f: FeedMeta) => fetches.get(f.id)?.state === 'queued' || !!f.pendingFetch;
	/** The card's line: the fetch the server reports under way, else what became of this page's Run now. */
	const fetchLine = (f: FeedMeta) => {
		const x = fetches.get(f.id);
		return pendingNote(f) ?? (x ? cardFetchNote(x.state, x.created) : null);
	};
	const serverPending = () => !!data?.feeds.some((f) => f.pendingFetch);
	/** Drop the cards' finished lines (done, failed, slow) at the next action; queued ones are still followed. */
	function clearFinished() {
		for (const [id, x] of fetches) if (x.state !== 'queued') fetches.delete(id);
	}

	/** Mark each followed fetch that has now run on its card, and say how it went in the live region; focus stays where it is. */
	function settle() {
		if (!data || queuedCount() === 0) return;
		const said: string[] = [];
		for (const [id, x] of fetches) {
			if (x.state !== 'queued') continue;
			const f = data.feeds.find((y) => y.id === id);
			const outcome = fetchOutcome(x.before, f);
			if (outcome === 'waiting') continue;
			// Removed or switched off meanwhile: the row (or its absence) says so.
			if (outcome === 'gone' || !f) {
				fetches.delete(id);
				continue;
			}
			fetches.set(id, { ...x, state: outcome });
			said.push(outcomeMessage(outcome, f, healthMessage(f.health), nextTryNote(f)));
		}
		if (said.length) announce = said.join(' ');
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
			// A fetch under way that this page didn't start (a backfill's windows, the schedule's): follow it too.
			if (serverPending() && !poller.active) poller.start();
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
			return queuedCount() > 0 || serverPending();
		},
		onGiveUp: () => {
			if (queuedCount() === 0) return;
			for (const [id, x] of fetches) if (x.state === 'queued') fetches.set(id, { ...x, state: 'slow' });
			announce = STILL_WAITING;
		},
		// After the schedule, on while the server reports a fetch under way: a backfill can take an hour.
		tailMs: FOLLOW_TAIL_MS,
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
		message = error = announce = null;
		clearFinished();
		refreshing = true;
		// A followed fetch that has run says so instead.
		if ((await reload()) && !announce) message = 'Status refreshed.';
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

	// ?feed=dws (the Map's Start sheet and Getting started pill, issue #646 F4) opens the card on a DWS gauge, so the
	// nearest gauging stations to the outlet are proposed at once; once per arrival. An owner's only: an editor's card
	// holds the map's rain proposals alone (DWS feeds are an owner's to attach).
	const feedAsked = $derived(page.url.searchParams.get('feed') === 'dws');
	let feedAnswered = false;
	$effect(() => {
		if (!feedAsked) {
			feedAnswered = false;
			return;
		}
		if (!data?.canEdit || feedAnswered || !data.sources.some((x) => x.source === 'dws')) return;
		feedAnswered = true;
		untrack(() => {
			void startAdding().then(() => pickSource('dws'));
		});
	});

	async function closeForm() {
		adding = false;
		await tick();
		attachButton?.focus();
	}

	function pickSource(s: FeedDraft['source']) {
		draft.source = s;
		// The boundary's proposal is CHIRPS's and reference ET's; each unit's, CHIRPS's only.
		if ((s !== 'chirps' && s !== 'agera5_et0') || (s !== 'chirps' && mapArea === 'units')) mapArea = null;
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
		// Text a start date field can't read as a day: it says so under itself (DayInput); go there (the station form's
		// is inside its Requests fold, which opens).
		for (const id of [`${uid}-start`, `${uid}-st-start`]) {
			const box = document.getElementById(id) as HTMLInputElement | null;
			if (box?.validity.customError) {
				await focusField(id);
				return;
			}
		}
		const parsed = draft.source === 'station_api' ? stationBody() : draftToBody(draft);
		if ('error' in parsed) {
			formError = parsed.error;
			formField = parsed.field;
			await focusField(`${uid}-${parsed.field}`);
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
			const { feed, warning } = await feeds.create(replaceSeries ? { ...parsed.body, replaceSeries } : parsed.body);
			attached = true;
			message =
				(replaceSeries
					? `Feed attached: its first fetch replaces ${describeTarget(feed)} with ${describeWrites(feed).slice(3)}. The old values stay in the History tab. Refit afterwards.`
					: `Feed attached: ${describeTarget(feed)} from ${describePlace(feed)}. It runs on the next schedule, or now with “Run now”.`) + warningText(warning);
		} catch (err) {
			// A station feed's refusal names its field (the server's 400 details): show it there, as the form's own checks do.
			const p = draft.source === 'station_api' ? (stationForm?.serverProblem(err) ?? null) : null;
			formError = p?.error ?? errorText(err);
			formField = p?.field ?? null;
		}
		// Either way the list may have moved (another owner's feed for the same series is the usual 409).
		await reload();
		busy = null;
		if (attached) await closeForm();
		else if (formField) await focusField(`${uid}-${formField}`);
	}

	/** Focus a field of the form, opening the fold it sits in (the station form's Requests and Values) first. */
	async function focusField(id: string) {
		await tick();
		const el = document.getElementById(id);
		const fold = el?.closest('details');
		if (fold && !fold.open) fold.open = true;
		el?.focus();
	}

	/** A station API feed's body from its form (issue #784): it writes a rainfall station series named after the station. */
	function stationBody(): { body: FeedBody } | { error: string; field: StationField } {
		const built = stationForm?.build() ?? { error: 'The form is still loading: try again in a moment.', field: 'name' as const };
		if ('error' in built) return built;
		const { config, credential } = built.body;
		return {
			body: { source: 'station_api', config, targetKind: 'rain_catchment_mm', targetName: draft.targetName.trim(), schedule: 'daily', ...(credential ? { credential } : {}) }
		};
	}

	/** Open (or close) a station card's Replace key form; its fields start empty and are never filled from the server. */
	async function toggleKeyForm(f: FeedMeta) {
		keySecret = keyUser = '';
		keyError = null;
		keyFor = keyFor === f.id ? null : f.id;
		await tick();
		if (keyFor) document.getElementById(`${uid}-key-secret-${f.id}`)?.focus();
		else document.getElementById(`${uid}-key-${f.id}`)?.focus();
	}

	/** Save a replacement key (PATCH credential); the typed key is dropped from the page whatever happens. */
	async function saveKey(e: SubmitEvent, f: FeedMeta) {
		e.preventDefault();
		if (busy) return;
		const patch = credentialPatch(keySecret, keyUser, f.config.auth?.kind === 'basic');
		if ('error' in patch) {
			keyError = patch.error;
			await tick();
			document.getElementById(`${uid}-key-secret-${f.id}`)?.focus();
			return;
		}
		busy = f.id;
		message = error = announce = keyError = null;
		let saved = false;
		try {
			const r = await feeds.update(f.id, patch);
			saved = true;
			message = (f.credential?.saved ? 'Key replaced: the next fetch uses it.' : 'Key saved: the next fetch uses it.') + warningText(r.warning);
		} catch (err) {
			keyError = errorText(err);
		}
		keySecret = keyUser = '';
		await reload();
		busy = null;
		if (saved) {
			keyFor = null;
			await tick();
			document.getElementById(`${uid}-key-${f.id}`)?.focus();
		}
	}

	/** Clear a station feed's key (PATCH credential: null), after a confirm. */
	async function removeKey(f: FeedMeta) {
		if (busy) return;
		const ok = await confirmDialog({
			title: 'Remove the key?',
			message: `Remove the key of the ${sourceLabel(f)} feed into “${describeTarget(f)}”? The feed can’t sign in to its API until an owner adds one again.`,
			confirmLabel: 'Remove key',
			danger: true
		});
		if (!ok) return;
		busy = f.id;
		message = error = announce = null;
		try {
			const r = await feeds.update(f.id, { credential: null });
			message = `Key removed.${warningText(r.warning)}`;
		} catch (err) {
			error = errorText(err);
		}
		await reload();
		busy = null;
		keyFor = null;
		await tick();
		document.getElementById(`${uid}-key-${f.id}`)?.focus();
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
		// Its fetch is queued: the card says so, and the button waits with it.
		if (busy || (what === 'run' && runWaits(f))) return;
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
		message = error = announce = null;
		clearFinished();
		let follow = false;
		try {
			if (what === 'run') {
				const before = f.lastAttemptAt;
				const r = await feeds.runNow(f.id);
				// The words are on the card; the live region says them, naming the feed.
				announce = queuedMessage(f, r.created);
				fetches.set(f.id, { before, state: 'queued', created: r.created });
				follow = true;
			} else if (what === 'replace') {
				await feeds.update(f.id, { replaceSeries: true });
				message = 'Replacement confirmed: the feed backfills the new record, then replaces the series. Run it now, or wait for the schedule.';
			} else if (what === 'withdraw') {
				await feeds.update(f.id, { replaceSeries: false });
				message = 'Replacement withdrawn: what was backfilled is discarded, and the series stays as it is.';
			} else if (what === 'toggle') {
				const r = await feeds.update(f.id, { enabled: !f.enabled });
				message = (f.enabled ? 'Feed switched off.' : 'Feed switched on; it runs on the next schedule.') + warningText(r.warning);
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
		if (follow && queuedCount() > 0) poller.start();
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
		<div role="status" data-testid="feeds-status">{#if message}<p class="muted msg">{message}</p>{/if}{#if announce}<span class="visually-hidden">{announce}</span>{/if}</div>
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

		{#if adding}
			<!-- The add card, above the list (an add form above a long list, not under it), with its own action row. -->
			<form class="add" onsubmit={add} novalidate aria-labelledby="{uid}-add-h">
				<h3 id="{uid}-add-h">{mapOnly ? 'Rain from the map' : 'Attach a feed'}</h3>
				<div class="form-row">
					{#if !mapOnly}
						<div class="field">
							<label for="{uid}-src">Source</label>
							<select id="{uid}-src" value={draft.source} aria-describedby={stationOff ? `${uid}-src-off` : undefined} onchange={(e) => pickSource(e.currentTarget.value as FeedDraft['source'])}>
								{#each data.sources as s (s.source)}
									<option value={s.source} disabled={s.source === 'station_api' && stationOff}>{s.label}{s.source === 'station_api' && stationOff ? ' (off on this server)' : ''}</option>
								{/each}
							</select>
							{#if stationOff}<p class="hint" id="{uid}-src-off" data-testid="station-api-off">Weather station API feeds are off on this server: the operator switches them on.</p>{/if}
						</div>
					{/if}
					{#if draft.source !== 'dws' && draft.source !== 'station_api'}
						<div class="field">
							<label for="{uid}-area">Area</label>
							<select id="{uid}-area" value={mapArea ?? draft.area} onchange={(e) => pickArea(e.currentTarget.value)}>
								{#if !mapOnly}
									<option value="cells">Grid cells</option>
									<option value="bbox">Bounding box</option>
								{/if}
								{#if mapAreas}
									<option value="boundary">The catchment boundary, from the map</option>
									{#if unitAreas}<option value="units">Each unit’s parcel: a feed per unit</option>{/if}
								{/if}
							</select>
						</div>
					{/if}
				</div>
				{#if !mapArea && draft.source !== 'station_api'}
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
					<!-- The rain (or reference ET) feed from the map's catchment boundary (issue #326 B-rain): a proposal for editors, applied by an owner. -->
					{#key draft.source}
						<BoundaryRain
							{projectId}
							feeds={data.feeds}
							source={draft.source === 'agera5_et0' ? 'agera5_et0' : 'chirps'}
							focus={mapFocus}
							onclose={closeForm}
							onapplied={() => reload().then(() => undefined)}
						/>
					{/key}
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
					{:else if draft.source === 'station_api'}
						<!-- A rainfall station read from its provider's web API (issue #784): writes a station series named after it. -->
						<p class="hint">Writes a rainfall station’s daily rain ({kindLabel('rain_catchment_mm')}), fetched from its provider’s web API every day.</p>
						<Lazy load={loadStationForm}>
							{#snippet children(StationForm)}
								<StationForm bind:this={stationForm} {uid} bind:name={draft.targetName} errorField={formField} error={formError} errorId="{uid}-err" />
							{/snippet}
						</Lazy>
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
					<!-- The station form shows a problem with one of its fields under that field. -->
					{#if formError && !(draft.source === 'station_api' && formField)}<p class="err" id="{uid}-err" role="alert">{formError}</p>{/if}
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
				{attentionText(attention)}
			</div>
		{/if}

		<!-- The app's one empty state (LoadState's dashed box), as API keys and Scheduled reports show theirs (issue #586, C17). -->
		<LoadState loading={false} empty={data.feeds.length === 0} emptyText="No feeds yet{data.canEdit ? '.' : '. An owner can attach one.'}">
			<ul class="feeds" aria-label="Data feeds">
				{#each data.feeds as f (f.id)}
					{@const line = fetchLine(f)}
					<li class="feed" data-state={f.health.state} data-fetch={f.pendingFetch ?? fetches.get(f.id)?.state}>
						<div class="head">
							<span class="state state-{catchingUp(f) ? 'catching' : f.health.state}">{stateLabel(f)}</span>
							<strong>{sourceLabel(f)}</strong>
							<span class="muted">→ {describeTarget(f)}</span>
						</div>
						<p class="where muted small">{describePlace(f)}{describeWrites(f)} · {f.schedule}{describeRunsAs(f)}</p>
						<!-- The schedule's next try says nothing while a fetch is already under way (the line below says so). -->
						<p class="health">{healthMessage(f.health)}{#if nextTryNote(f) && !f.pendingFetch}{' '}{nextTryNote(f)}{/if}</p>
						<!-- Run now's feedback, on the card that was run (the section's live region announces it). -->
						{#if line}<p class="run-note small" id="{uid}-fetch-{f.id}" data-testid="feed-fetch">{line}</p>{/if}
						{#if conflictMessage(f)}
							<p class="alert alert-warning version" data-testid="feed-version-conflict">{conflictMessage(f)}</p>
						{/if}
						<p class="muted small">{describeTimes(f)}{#if f.lastMeta?.prelimDays}{' '}· {f.lastMeta.prelimDays} preliminary days{/if}{#if keptNote(f.lastMeta)}{' '}· {keptNote(f.lastMeta)}{/if}{#if cellsUsedNote(f)}{' '}· {cellsUsedNote(f)} with data{/if}{#if calibrationNote(f)}{' '}· {calibrationNote(f)}{/if}{#if et0Note(f)}{' '}· {et0Note(f)}{/if}{#if gapFillNote(f.lastMeta)}{' '}· {gapFillNote(f.lastMeta)}{/if}</p>
						{#if credentialLine(f)}<p class="muted small" data-testid="feed-key">{credentialLine(f)}</p>{/if}
						{#if data.canRun || data.canEdit}
							<div class="act">
								{#if data.canRun && f.enabled}
									<button type="button" class="btn btn-sm" aria-disabled={busy !== null || runWaits(f)} aria-describedby={runWaits(f) && line ? `${uid}-fetch-${f.id}` : undefined} title={runWaits(f) ? line : undefined} aria-label="Run now: {describeTarget(f)}" onclick={() => act(f, 'run')}>Run now</button>
								{/if}
								{#if data.canEdit && f.versionConflict && f.replaceFrom === null}
									<button type="button" class="btn btn-sm btn-danger" aria-disabled={busy !== null} aria-label="Replace the series: {describeTarget(f)}" onclick={() => act(f, 'replace')}>Replace the series</button>
								{/if}
								{#if data.canEdit && f.replaceFrom !== null}
									<button type="button" class="btn btn-sm" aria-disabled={busy !== null} aria-label="Withdraw the replacement: {describeTarget(f)}" onclick={() => act(f, 'withdraw')}>Withdraw the replacement</button>
								{/if}
								{#if data.canEdit && f.source === 'station_api' && (f.credential?.saved || (f.config.auth && f.config.auth.kind !== 'none'))}
									<!-- Write-only: the key is never shown; owners replace or remove it (issue #784). -->
									<button
										type="button"
										class="btn btn-sm"
										id="{uid}-key-{f.id}"
										aria-expanded={keyFor === f.id}
										aria-controls="{uid}-keyform-{f.id}"
										aria-disabled={busy !== null}
										aria-label="{f.credential?.saved ? 'Replace key' : 'Add a key'}: {describeTarget(f)}"
										onclick={() => !busy && toggleKeyForm(f)}>{f.credential?.saved ? 'Replace key' : 'Add a key'}</button
									>
									{#if f.credential?.saved}
										<button type="button" class="btn btn-sm" aria-disabled={busy !== null} aria-label="Remove key: {describeTarget(f)}" onclick={() => removeKey(f)}>Remove key</button>
									{/if}
								{/if}
								{#if data.canEdit}
									<button type="button" class="btn btn-sm" aria-disabled={busy !== null} aria-label="{f.enabled ? 'Switch off' : 'Switch on'}: {describeTarget(f)}" onclick={() => act(f, 'toggle')}>
										{f.enabled ? 'Switch off' : 'Switch on'}
									</button>
									<button type="button" class="btn btn-sm btn-danger" aria-disabled={busy !== null} aria-label="Remove feed: {describeTarget(f)}" onclick={() => act(f, 'remove')}>Remove</button>
								{/if}
							</div>
						{/if}
						{#if keyFor === f.id && data.canEdit}
							{@const basic = f.config.auth?.kind === 'basic'}
							{@const replacing = !!f.credential?.saved}
							<form class="key-form" id="{uid}-keyform-{f.id}" onsubmit={(e) => saveKey(e, f)} novalidate aria-label="{replacing ? 'Replace the key' : 'Add a key'}: {describeTarget(f)}">
								{#if basic}
									<div class="field">
										<label for="{uid}-key-user-{f.id}">User name</label>
										<input id="{uid}-key-user-{f.id}" type="text" autocomplete="off" spellcheck="false" maxlength="200" bind:value={keyUser} />
									</div>
								{/if}
								<div class="field">
									<label for="{uid}-key-secret-{f.id}">{basic ? 'New password' : 'New key'}</label>
									<input
										id="{uid}-key-secret-{f.id}"
										type="password"
										autocomplete="off"
										spellcheck="false"
										bind:value={keySecret}
										aria-invalid={keyError ? true : undefined}
										aria-describedby="{uid}-key-h-{f.id}{keyError ? ` ${uid}-key-err-${f.id}` : ''}"
									/>
									<span class="hint" id="{uid}-key-h-{f.id}"
										>{replacing ? 'It replaces the saved one, sealed' : 'At least 8 characters. Kept sealed'} so only the server’s fetcher can read it; it is never shown again.</span
									>
								</div>
								{#if keyError}<p class="err" id="{uid}-key-err-{f.id}" role="alert">{keyError}</p>{/if}
								<div class="act">
									<button type="submit" class="btn btn-sm btn-primary" aria-disabled={busy !== null}>{busy === f.id ? 'Saving…' : 'Save the key'}</button>
									<button type="button" class="btn btn-sm" onclick={() => toggleKeyForm(f)}>Cancel</button>
								</div>
							</form>
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
	/* Run now's feedback and a fetch under way, on the card (a catching-up chip keeps .state's neutral look). */
	.run-note {
		color: var(--accent);
		font-weight: 600;
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
	/* A station card's Replace key: a small write-only form under its actions. */
	.key-form {
		margin-top: 0.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
		max-width: 32rem;
	}
	.key-form .field {
		margin-bottom: 0.4rem;
	}
</style>
