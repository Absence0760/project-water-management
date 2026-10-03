<!--
	Start the model from the map, in a side sheet over the Map (`start=1`;
	issue #326 C3, docs/design/start-from-map.md, docs/ui.md § Map). Four
	steps, each read from the server's state, so a reload lands where the
	editor was: the boundary (Delineate, Draw or Upload, the existing tools),
	the points (what each dam, other point and gauge is in the model, and the
	outlet), the proposal (every value ticked one by one, nothing applied
	unticked), and data and the first run (the existing proposals, linked in
	order). Typing the model in on the Network stays the other way.
	Each proposed unit's card carries its piece's number and tint, as on the
	map (pieces.ts): the cards are the map's key, and a card with the focus or
	the pointer lights its piece (`onhighlight`); a piece clicked on the map
	opens here at its card (`focusKey`).
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { api, type MapFeature, type StartProposal, type StartState, type StartTicks } from '$lib/api';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { fmtNum } from '$lib/format/number';
	import { featureName } from './mapList';
	import PieceBadge from './PieceBadge.svelte';
	import PlacementAsk from './PlacementAsk.svelte';
	import { proposalPieces, REST_KEY } from './pieces';
	import { confluencePointsOf, OUTLET_KEY, placementLine, withPlacement } from './placement';
	import type { ConfluencePoint } from '$lib/api/types';
	import {
		applySummary,
		candidatePoints,
		choicesFor,
		defaultChoice,
		defaultOutlet,
		drainsIntoName,
		duplicateName,
		emptyName,
		initialTicks,
		km2Text,
		openStart,
		outletGauges,
		proposeBody,
		restOffersArea,
		ROLE_LABEL,
		startStep,
		STEP_LABEL,
		tickAll,
		unitOffers,
		type PointChoice,
		type StartDraft
	} from './startFlow';

	let {
		open = $bindable(false),
		projectId,
		features,
		info,
		draft = $bindable(),
		onupload,
		ondelineate,
		ondraw,
		onplace,
		onproposed,
		onapplied,
		ondiscarded,
		onhighlight,
		focusKey = null
	}: {
		open?: boolean;
		projectId: string;
		features: MapFeature[];
		/** GET …/map/start: the DEM, whether the model is empty, the proposals. */
		info: StartState;
		/** The choices and ticks, kept by the Map tab so closing the sheet loses nothing. */
		draft: StartDraft;
		/** Open the Upload sheet (the sheet closes into it). */
		onupload: () => void;
		/** The existing tools: the sheet closes into them. */
		ondelineate: (() => void) | null;
		ondraw: () => void;
		onplace: () => void;
		onproposed: (p: StartProposal) => Promise<void> | void;
		onapplied: (p: StartProposal) => Promise<void> | void;
		ondiscarded: () => Promise<void> | void;
		/** A card took the focus or the pointer (its piece's key), or let it go (null): the map lights that piece. */
		onhighlight?: (key: string | null) => void;
		/** A piece clicked on the map: its card is brought into view and focused. */
		focusKey?: string | null;
	} = $props();

	const uid = $props.id();
	const step = $derived(startStep(info, features, draft.pointsAsked));
	const pending = $derived(openStart(info));
	/** The open proposal's pieces by key: the cards read their number and tint from the same list the map draws (pieces.ts). */
	const pieceOf = $derived(new Map(pending ? proposalPieces(pending.plan).map((x) => [x.key, x]) : []));
	const boundary = $derived(features.find((f) => f.kind === 'catchment_boundary') ?? null);
	const STEPS = ['boundary', 'points', 'review', 'data'] as const;

	// --- the points: what each is in the model, and the outlet ---
	const candidates = $derived(candidatePoints(features));
	const gauges = $derived(outletGauges(features));
	const choiceOf = (f: MapFeature): PointChoice => draft.picked[f.id] ?? defaultChoice(f);
	const outlet = $derived(draft.outlet ?? defaultOutlet(features));
	const chosen = $derived(candidates.filter((f) => f.id !== outlet && choiceOf(f) !== 'none'));
	const units = $derived(chosen.filter((f) => choiceOf(f) !== 'gauge').length);
	const gaugeNodes = $derived(chosen.length - units);

	let busy = $state<null | 'propose' | 'apply' | 'discard'>(null);
	let error = $state<string | null>(null);
	let bodyEl: HTMLElement | undefined = $state();
	/** The sheet's title takes the focus when the step changes (the focused control went with the old step). */
	async function focusTitle() {
		await tick();
		const h = bodyEl?.closest('dialog')?.querySelector<HTMLElement>('h2');
		if (!h) return;
		h.tabIndex = -1;
		h.focus();
	}

	/** Points at confluences the last proposal asked about: each one's river is picked, then it proposes again. */
	let asking = $state<ConfluencePoint[] | null>(null);
	async function proposeNow() {
		busy = 'propose';
		error = null;
		try {
			const body = withPlacement(proposeBody(Object.fromEntries(candidates.map((f) => [f.id, choiceOf(f)])), outlet), draft.placement);
			const r = await api.start.propose(projectId, body);
			asking = null;
			await onproposed(r.proposal);
			void focusTitle();
		} catch (err) {
			const points = confluencePointsOf(err);
			if (points) asking = points;
			else error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = null;
		}
	}
	function propose(e: SubmitEvent) {
		e.preventDefault();
		void proposeNow();
	}
	/** Use that channel: the point goes on the larger channel its card names, and the network is proposed again. */
	function useLarger(key: string) {
		draft.placement.useLarger[key] = true;
		void proposeNow();
	}
	/** Another outlet: the old one's river and channel choices don't carry over. */
	function setOutlet(id: string) {
		draft.outlet = id;
		delete draft.placement.reaches[OUTLET_KEY];
		delete draft.placement.useLarger[OUTLET_KEY];
	}

	// --- the proposal: its ticks, kept in the draft by proposal id (a new proposal starts unticked) ---
	$effect(() => {
		if (pending && !draft.ticks[pending.id]) draft.ticks[pending.id] = initialTicks(pending.plan);
	});
	const ticks = $derived<StartTicks | null>(pending ? (draft.ticks[pending.id] ?? null) : null);
	const dup = $derived(ticks ? duplicateName(ticks) : null);
	const blank = $derived(ticks ? emptyName(ticks) : false);
	/** A name the server would refuse: empty, or the one used twice. */
	const bad = (n: string) => !n.trim() || (!!dup && n.trim().toLowerCase() === dup.toLowerCase());

	async function apply(p: StartProposal) {
		if (!ticks) return;
		const ok = await confirmDialog({ title: 'Apply the ticked values?', message: `${applySummary(ticks)} It is saved now as one change in History.`, confirmLabel: 'Apply' });
		if (!ok) return;
		busy = 'apply';
		error = null;
		try {
			const r = await api.start.apply(projectId, p.id, ticks);
			await onapplied(r.proposal);
			void focusTitle();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = null;
		}
	}
	async function discard(p: StartProposal) {
		const ok = await confirmDialog({
			title: 'Discard the proposed model?',
			message: 'The proposal and your ticks go; nothing in the model changes. You can propose again from the points.',
			confirmLabel: 'Discard',
			danger: true
		});
		if (!ok) return;
		busy = 'discard';
		error = null;
		try {
			await api.start.discard(projectId, p.id);
			draft.pointsAsked = true;
			delete draft.ticks[p.id];
			await ondiscarded();
			void focusTitle();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = null;
		}
	}
	// --- the cards as the map's key: a card lights its piece, a piece picked on the map brings its card ---
	const light = (key: string | null) => onhighlight?.(key);
	function cardOut(e: FocusEvent, key: string) {
		// Focus moving within the card keeps it lit.
		if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) light(null);
		void key;
	}
	$effect(() => {
		const k = focusKey;
		if (!k || step !== 'review') return;
		void tick().then(() => {
			const card = bodyEl?.closest('dialog')?.querySelector<HTMLElement>(`[data-piece-card="${CSS.escape(k)}"]`);
			if (!card) return;
			card.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
			card.querySelector<HTMLElement>('input, select, button')?.focus();
		});
	});
	const featureNameOf = (id: string) => {
		const f = features.find((x) => x.id === id);
		return f ? featureName(f) : 'a point since deleted';
	};
</script>

<Dialog bind:open title="Start the model from the map" side>
	<span bind:this={bodyEl} hidden></span>
	<div class="start" data-testid="start-sheet" data-step={step}>
		{#if step !== 'closed'}
			<ol class="steps" aria-label="Steps">
				{#each STEPS as s, i (s)}
					<li aria-current={s === step ? 'step' : undefined} class:done={STEPS.indexOf(step) > i}>
						<span class="n" aria-hidden="true">{i + 1}</span>{STEP_LABEL[s]}{#if STEPS.indexOf(step) > i}<span class="visually-hidden"> (done)</span>{/if}
					</li>
				{/each}
			</ol>
		{/if}

		{#if step === 'closed'}
			<p data-testid="start-closed">
				The model has nodes already, so it isn’t started from the map. <strong>Divide the model from the map</strong> (under the map, at the end of the key row, with an elevation model on the server) proposes each unit’s own area and order from its point; the map’s per-feature tools (Delineate, Accept as an area, Use this area) change one unit at a time, and the Network the rest.
			</p>
		{:else if step === 'boundary'}
			<h3 class="sub">Put the catchment’s boundary on the map</h3>
			<p class="lead">The units, their areas and their order are proposed inside it. Use whichever you have:</p>
			<div class="ways">
				{#if ondelineate}
					<button type="button" class="btn btn-primary" onclick={ondelineate} data-testid="start-delineate">Delineate from the outlet</button>
				{/if}
				<button type="button" class={ondelineate ? 'btn' : 'btn btn-primary'} onclick={ondraw} data-testid="start-draw">Draw the boundary</button>
				<button type="button" class="btn" onclick={onupload}>Upload a GeoJSON file</button>
			</div>
			{#if gauges.length}
				<p class="hint">
					Or, with no boundary, the outlet gauge on the map can be the outlet:
					<button type="button" class="link" onclick={() => ((draft.pointsAsked = true), void focusTitle())} data-testid="start-skip-boundary">go on to the points</button>.
				</p>
			{/if}
		{:else if step === 'points'}
			<form id="{uid}-points" onsubmit={propose} novalidate data-testid="start-points">
				<h3 class="sub">Say what each point on the map is</h3>
				<p class="lead">
					Each unit’s area becomes what drains to its point and to no unit above it{info.elevation ? '' : ' (with an elevation model on the server; without one, the areas and the order are yours to type)'}. Put a dam on the map at its wall, an abstraction point where water is taken from the river.
				</p>
				{#if candidates.length}
					<ul class="points">
						{#each candidates as f (f.id)}
							<li data-feature={f.id}>
								<label for="{uid}-role-{f.id}" class="pname">{featureName(f)} <span class="muted small">({f.kind === 'dam' ? 'dam' : f.kind === 'gauge' ? 'gauge' : 'point'})</span></label>
								{#if f.id === outlet}
									<span class="muted small">The outlet</span>
								{:else}
									<select id="{uid}-role-{f.id}" value={choiceOf(f)} onchange={(e) => (draft.picked[f.id] = e.currentTarget.value as PointChoice)}>
										{#each choicesFor(f) as value (value)}<option {value}>{ROLE_LABEL[value]}</option>{/each}
									</select>
								{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<p class="muted" data-testid="start-no-points">No dams or points on the map yet: the whole catchment becomes one unit unless you place some.</p>
				{/if}
				<p><button type="button" class="btn btn-sm" onclick={onplace} data-testid="start-place">Place a point</button></p>
				<div class="field">
					<label for="{uid}-outlet">The outlet (the outflow gauge)</label>
					<select id="{uid}-outlet" value={outlet} onchange={(e) => setOutlet(e.currentTarget.value)} data-testid="start-outlet">
						{#if boundary}<option value="">The boundary’s own outlet</option>{:else if !outlet}<option value="" disabled>Choose a gauge…</option>{/if}
						{#each gauges as g (g.id)}<option value={g.id}>{featureName(g)} (gauge)</option>{/each}
					</select>
					<span class="hint">{boundary ? 'Where the river leaves the boundary, unless a gauge on the map marks it.' : 'Without a boundary the outlet is a gauge on the map.'}</span>
				</div>
				<p class="hint" data-testid="start-count">{units === 0 && gaugeNodes === 0
						? 'No units: the catchment becomes one.'
						: `${units} ${units === 1 ? 'unit' : 'units'}${gaugeNodes ? ` and ${gaugeNodes} ${gaugeNodes === 1 ? 'gauge' : 'gauges'}` : ''}, plus the rest of the catchment.`}</p>
			</form>
		{:else if step === 'review' && pending && ticks}
			{@const p = pending.plan}
			<div class="review" data-testid="start-review">
				<p class="lead">
					Tick each value to take it; anything unticked is left for you to type. The catchment above the outlet: <strong data-testid="start-catchment">{km2Text(p.catchment.areaM2 ?? p.catchment.boundaryAreaM2)}</strong>.
				</p>
				{#if p.warnings.length || p.dropped.length}
					<ul class="warnings" data-testid="start-warnings">
						{#each p.warnings as w (w)}<li>{w}</li>{/each}
						{#each p.dropped as d (d.featureId)}<li>
								{d.name || featureNameOf(d.featureId)} isn’t a unit: it {d.reason}.{#if d.placement?.larger}
									<button type="button" class="link" disabled={!!busy} onclick={() => useLarger(d.featureId)} data-testid="start-dropped-use-larger">Use the larger channel beside it</button>{/if}
							</li>{/each}
					</ul>
				{/if}
				{#if p.outlet.placement?.larger}
					<p><button type="button" class="btn btn-sm" disabled={!!busy} onclick={() => useLarger(OUTLET_KEY)} data-testid="start-outlet-use-larger">Use that channel for the outlet</button></p>
				{/if}
				{#if p.outlet.placement}<p class="hint" data-testid="start-outlet-placement">The outlet: {placementLine(p.outlet.placement, p.outlet.snapDistanceM)}</p>{/if}
				<div class="field">
					<label for="{uid}-outlet-name">Outflow gauge’s name</label>
					<input id="{uid}-outlet-name" bind:value={ticks.outletName} maxlength="100" aria-invalid={bad(ticks.outletName) ? 'true' : undefined} aria-describedby={bad(ticks.outletName) ? `${uid}-names` : undefined} />
				</div>
				<p class="tick-all">
					<button type="button" class="btn btn-sm" onclick={() => pending && (draft.ticks[pending.id] = tickAll(pending.plan, ticks))} data-testid="start-tick-all">Tick every value</button>
					<span class="hint">{p.units.length} {p.units.length === 1 ? 'unit' : 'units'}, upstream first.</span>
				</p>
				{#if dup || blank}<p class="err" role="alert" id="{uid}-names">{dup ? `Two nodes would be called “${dup}”: give each its own name.` : 'Every node needs a name: fill in the empty one.'}</p>{/if}
				<ul class="units">
					{#each ticks.units as t, i (t.key)}
						{@const u = p.units[i]!}
						{@const offer = unitOffers(u)}
						<li
							class="unit"
							data-testid="start-unit"
							data-key={u.key}
							data-piece-card={u.key}
							onmouseenter={() => light(u.key)}
							onmouseleave={() => light(null)}
							onfocusin={() => light(u.key)}
							onfocusout={(e) => cardOut(e, u.key)}
						>
							<div class="field">
								<label for="{uid}-name-{u.key}" class="named"
									><PieceBadge label={pieceOf.get(u.key)?.label ?? String(i + 1)} tint={pieceOf.get(u.key)?.tint ?? -1} /> <span>Name <span class="muted small">· {ROLE_LABEL[u.role].toLowerCase()}, from “{u.featureName}”</span></span></label
								>
								<input id="{uid}-name-{u.key}" bind:value={t.name} maxlength="100" aria-invalid={bad(t.name) ? 'true' : undefined} aria-describedby={bad(t.name) ? `${uid}-names` : undefined} />
							</div>
							{#if u.role === 'gauge' && u.totalAreaM2 !== null}<p class="hint">It measures {km2Text(u.totalAreaM2)} of the catchment above it; a gauge owns no land of its own.</p>{/if}
							{#if offer.area}
								<label class="tick">
									<input type="checkbox" bind:checked={t.area} data-testid="start-tick-area" />
									<span>Area <strong>{km2Text(u.areaM2)}</strong>: what drains to it and to no unit above it (its whole catchment: {km2Text(u.totalAreaM2)}), saved as its parcel</span>
								</label>
							{:else if u.role !== 'user'}
								<p class="hint">No area proposed: type it on the Network, or draw its parcel and Use it.</p>
							{/if}
							{#if offer.drainsInto}
								<label class="tick">
									<input type="checkbox" bind:checked={t.drainsInto} data-testid="start-tick-drains" />
									<span>Drains into <strong>{drainsIntoName(p, ticks, u)}</strong></span>
								</label>
							{:else}
								<p class="hint">Drains into the outflow gauge until you set the order on the Network.</p>
							{/if}
							{#if offer.runoffToDam}
								<label class="tick">
									<input type="checkbox" bind:checked={t.runoffToDam} data-testid="start-tick-dam" />
									<span>All of its own runoff reaches the dam (its area ends at the wall)</span>
								</label>
							{/if}
							{#if placementLine(u.placement, u.snapDistanceM)}<p class="hint" data-testid="start-placement">{placementLine(u.placement, u.snapDistanceM)}</p>{/if}
							{#if u.placement?.larger}
								{#if u.placement.larger.outline}<p class="hint">If the dam is on that river, <button type="button" class="link" disabled={!!busy} onclick={() => useLarger(u.key)} data-testid="start-use-outline-channel">use that channel</button>; if it is filled by a pump or a furrow, keep it.</p>{:else}<p class="hint">A much larger channel runs {fmtNum(u.placement.larger.distanceM, 0)} m away: <button type="button" class="link" disabled={!!busy} onclick={() => useLarger(u.key)} data-testid="start-use-larger">use that channel</button>, or keep the point if it is on the small stream.</p>{/if}
							{/if}
						</li>
					{/each}
					<li
						class="unit"
						data-testid="start-rest"
						data-piece-card={REST_KEY}
						onmouseenter={() => light(REST_KEY)}
						onmouseleave={() => light(null)}
						onfocusin={() => light(REST_KEY)}
						onfocusout={(e) => cardOut(e, REST_KEY)}
					>
						{#if pieceOf.has(REST_KEY)}<PieceBadge label="R" tint={-1} />{/if}
						<label class="tick">
							<input type="checkbox" bind:checked={ticks.rest.include} data-testid="start-tick-rest" />
							<span>Add <strong>the rest of the catchment</strong> as a unit (what drains to the outlet through no unit; without it the model’s catchment is only the units’)</span>
						</label>
						{#if ticks.rest.include}
							<div class="field">
								<label for="{uid}-rest-name">Its name</label>
								<input id="{uid}-rest-name" bind:value={ticks.rest.name} maxlength="100" aria-invalid={bad(ticks.rest.name) ? 'true' : undefined} aria-describedby={bad(ticks.rest.name) ? `${uid}-names` : undefined} />
							</div>
							{#if restOffersArea(p)}
								<label class="tick">
									<input type="checkbox" bind:checked={ticks.rest.area} data-testid="start-tick-rest-area" />
									<span>Area <strong>{km2Text(p.rest.areaM2)}</strong>{p.fromDem ? '' : ' (the boundary)'}, saved as its parcel</span>
								</label>
							{/if}
						{/if}
					</li>
				</ul>
				<details class="how">
					<summary>How it was made</summary>
					<dl class="facts">
						<dt>Dataset</dt>
						<dd>{pending.dataset ?? 'None: no elevation model on the server'}</dd>
						<dt>Method</dt>
						<dd>{pending.method} [{pending.methodVersion}]</dd>
						{#if p.cellSizeM}<dt>Cell size</dt><dd>{fmtNum(p.cellSizeM, 0)} m</dd>{/if}
					</dl>
					<p class="hint">A proposal from an elevation model, not a survey: check each area against the map before you tick it (design/delineation.md § Accuracy).</p>
				</details>
			</div>
		{:else if step === 'data'}
			<div data-testid="start-data">
				<p class="lead">The network is in. Next, the data, each proposed from the map and accepted one value at a time where it lives:</p>
				<ol class="todo">
					{#if boundary}<li><a href="?tab=settings&rain=boundary#set-feeds">Rain from the boundary</a>: the CHIRPS feed over its cells (Settings → Data feeds).</li>{/if}
					<li><a href="?tab=settings#set-feeds">Observed flow</a>: the nearest gauging stations to the outlet (Settings → Data feeds).</li>
					<li><a href="?tab=settings#set-demand">Evaporation</a>: the monthly A-pan the dams, river pools and crops lose (Settings &amp; calibration → Demand; Evaporation from the map under Flow calibration proposes it). An ET₀ row from the map feeds the runoff model only; with no A-pan the dams lose nothing.</li>
					<li><a href="?tab=dams">Each dam’s capacity</a> from the register of dams, and its full-supply area from its polygon (Dams).</li>
					<li><a href="?tab=crops">Cultivated area</a> from land cover, per unit (Crops).</li>
					<li><a href="?tab=network">The Network</a>: anything not ticked (areas, the order), dam sizes and irrigation.</li>
					<li><a href="?tab=runs" data-testid="start-run">Run the model</a> once rainfall is in (Runs &amp; results).</li>
				</ol>
			</div>
		{/if}
		{#if asking && (step === 'points' || step === 'review')}
			<PlacementAsk points={asking} bind:picked={draft.placement.reaches} busy={!!busy} onsubmit={() => void proposeNow()} testid="start-confluence" />
		{/if}
		{#if error}<p class="err" role="alert" data-testid="start-error">{error}</p>{/if}
	</div>

	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
		{#if step === 'points'}
			{#if draft.pointsAsked && !boundary}<button type="button" class="btn" onclick={() => ((draft.pointsAsked = false), void focusTitle())}>Back</button>{/if}
			<button type="submit" form="{uid}-points" class="btn btn-primary" disabled={busy === 'propose' || (!boundary && !outlet)} data-testid="start-propose">
				{busy === 'propose' ? 'Proposing…' : 'Propose the network'}
			</button>
		{:else if step === 'review' && pending}
			{@const p = pending}
			<button type="button" class="btn btn-ghost" disabled={!!busy} onclick={() => discard(p)} data-testid="start-discard">{busy === 'discard' ? 'Discarding…' : 'Discard'}</button>
			<button type="button" class="btn btn-primary" disabled={!!busy || !!dup || blank} onclick={() => apply(p)} data-testid="start-apply">{busy === 'apply' ? 'Applying…' : 'Apply the ticked values'}</button>
		{/if}
	{/snippet}
</Dialog>

<style>
	.start {
		container: start-sheet / inline-size;
	}
	.start,
	.review,
	form {
		display: grid;
		gap: 0.75rem;
	}
	.tick-all {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
	}
	.steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.steps li {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}
	.steps li[aria-current='step'] {
		color: var(--text);
		font-weight: 600;
	}
	.steps .n {
		display: inline-grid;
		place-items: center;
		width: 1.4rem;
		height: 1.4rem;
		border-radius: 50%;
		border: 1px solid var(--border);
		font-size: 0.75rem;
	}
	.steps li[aria-current='step'] .n {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-contrast);
	}
	.steps li.done .n {
		background: var(--accent-soft);
	}
	.sub {
		font-size: 0.95rem;
		margin: 0;
	}
	.lead {
		margin: 0;
	}
	.ways {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.points,
	.units,
	.warnings,
	.todo {
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}
	.points,
	.units {
		list-style: none;
	}
	.warnings,
	.todo {
		padding-left: 1.2rem;
	}
	.points li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 15rem);
		gap: 0.25rem 0.75rem;
		align-items: center;
	}
	.pname {
		overflow-wrap: anywhere;
	}
	.unit {
		display: grid;
		gap: 0.4rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
	}
	.field {
		display: grid;
		gap: 0.25rem;
	}
	.named {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.tick {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
		min-height: 24px;
	}
	.tick input {
		flex: none;
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
	.how summary {
		cursor: pointer;
		min-height: 24px;
		color: var(--accent);
		font-weight: 600;
	}
	.how[open] summary {
		margin-bottom: 0.5rem;
	}
	.facts {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.25rem 0.75rem;
		margin: 0 0 0.5rem;
	}
	.facts dt {
		color: var(--text-muted);
	}
	.facts dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.link {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
		min-height: 24px;
	}
	@container start-sheet (max-width: 26rem) {
		.points li {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
