<!--
	Divide a model that has nodes into sub-catchments from the map, in a side
	sheet over the Map (`divide=1`; #326 C3's follow-up,
	docs/design/start-from-map.md § Dividing a model that has nodes, docs/ui.md
	§ Map). Two steps, read from the server's state: the points (which node
	each dam, other point and gauge on the map stands for, or a new gauge, and
	the outlet), then the proposal (each point's own area, what it drains
	into and, for a dam, all of its runoff to the dam, each shown beside the
	node's value now and taken only when ticked; the rest of the catchment
	given to a unit, a new unit or nobody). Each card carries its piece's number
	and tint, as on the map: a card with the focus or the pointer lights its
	piece, and a piece clicked on the map opens here at its card. Needs an
	elevation model on the server; without one the sheet says so.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import type { NetworkNode } from '@water-management/engine';
	import { api, type DivideProposal, type DivideTicks, type MapFeature, type StartState } from '$lib/api';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { fmtNum } from '$lib/format/number';
	import {
		defaultDivideChoice,
		divideBody,
		divideDrainsIntoName,
		divideOffers,
		dividePoints,
		divideProblem,
		divideSummary,
		doubleNode,
		initialDivideTicks,
		km2,
		km2Now,
		NEW_GAUGE,
		NONE,
		nodeOptions,
		outflowOf,
		sameAsNow,
		tickAllDivide,
		type DivideChoice,
		type DivideDraft
	} from './divideFlow';
	import { featureName } from './mapList';
	import PieceBadge from './PieceBadge.svelte';
	import { PIECE_TINT_COUNT, REST_KEY } from './pieces';
	import { openDivide, outletGauges } from './startFlow';

	let {
		open = $bindable(false),
		projectId,
		features,
		nodes,
		info,
		draft = $bindable(),
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
		/** The model's nodes (the editor's): what each point can stand for. */
		nodes: readonly NetworkNode[];
		/** GET …/map/start: the DEM and the proposals of both modes. */
		info: StartState;
		/** The choices and ticks, kept by the Map tab so closing the sheet loses nothing. */
		draft: DivideDraft;
		/** Place a point (the sheet closes into the drawing mode). */
		onplace: () => void;
		onproposed: (p: DivideProposal) => Promise<void> | void;
		onapplied: (p: DivideProposal) => Promise<void> | void;
		ondiscarded: () => Promise<void> | void;
		/** A card took the focus or the pointer (its piece's key), or let it go: the map lights that piece. */
		onhighlight?: (key: string | null) => void;
		/** A piece clicked on the map: its card is brought into view and focused. */
		focusKey?: string | null;
	} = $props();

	const uid = $props.id();
	const pending = $derived(openDivide(info));
	const outflowId = $derived(outflowOf(nodes));
	const outflow = $derived(nodes.find((n) => n.id === outflowId) ?? null);
	const step = $derived<'off' | 'outflow' | 'points' | 'review'>(!info.elevation ? 'off' : !outflow ? 'outflow' : pending ? 'review' : 'points');
	const boundary = $derived(features.find((f) => f.kind === 'catchment_boundary') ?? null);
	const nodeName = (id: string | null) => nodes.find((n) => n.id === id)?.name ?? '–';

	// --- the points: which node each stands for, and the outlet ---
	const candidates = $derived(dividePoints(features));
	const gauges = $derived(outletGauges(features).filter((g) => !g.nodeId || g.nodeId === outflowId));
	const choiceOf = (f: MapFeature): DivideChoice => draft.picked[f.id] ?? defaultDivideChoice(f, nodes);
	const outlet = $derived(draft.outlet ?? (boundary ? '' : (gauges.find((g) => g.nodeId === outflowId) ?? gauges[0])?.id ?? ''));
	const choices = $derived(Object.fromEntries(candidates.map((f) => [f.id, choiceOf(f)])));
	const twice = $derived(doubleNode(choices, outlet));
	const chosen = $derived(Object.entries(choices).filter(([id, c]) => c !== NONE && id !== outlet).length);

	let busy = $state<null | 'propose' | 'apply' | 'discard'>(null);
	let error = $state<string | null>(null);
	let bodyEl: HTMLElement | undefined = $state();
	async function focusTitle() {
		await tick();
		const h = bodyEl?.closest('dialog')?.querySelector<HTMLElement>('h2');
		if (!h) return;
		h.tabIndex = -1;
		h.focus();
	}

	async function propose(e: SubmitEvent) {
		e.preventDefault();
		busy = 'propose';
		error = null;
		try {
			const r = await api.divide.propose(projectId, divideBody(choices, outlet));
			await onproposed(r.proposal);
			void focusTitle();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = null;
		}
	}

	// --- the proposal: its ticks, kept in the draft by proposal id ---
	$effect(() => {
		if (pending && !draft.ticks[pending.id]) draft.ticks[pending.id] = initialDivideTicks(pending.plan);
	});
	const ticks = $derived<DivideTicks | null>(pending ? (draft.ticks[pending.id] ?? null) : null);
	const problem = $derived(pending && ticks ? divideProblem(pending.plan, ticks, nodes.map((n) => n.name)) : null);
	/** Units that may take the rest of the catchment: a unit of the model that isn't one of the points. */
	const restTargets = $derived(pending ? nodes.filter((n) => n.kind === 'farm' && n.id !== outflowId && !pending.plan.units.some((u) => u.nodeId === n.id)) : []);
	const restChoice = $derived(ticks ? (ticks.rest.to === 'node' ? ticks.rest.nodeId : ticks.rest.to) : 'none');
	let restNewName = $state('Rest of the catchment');
	function setRest(v: string) {
		if (!ticks) return;
		ticks.rest = v === 'none' ? { to: 'none' } : v === 'new' ? { to: 'new', name: restNewName } : { to: 'node', nodeId: v };
	}

	async function apply(p: DivideProposal) {
		if (!ticks || problem) return;
		const ok = await confirmDialog({ title: 'Apply the ticked values?', message: `${divideSummary(ticks)} It is saved now as one change in History.`, confirmLabel: 'Apply' });
		if (!ok) return;
		busy = 'apply';
		error = null;
		try {
			const r = await api.divide.apply(projectId, p.id, ticks);
			delete draft.ticks[p.id];
			await onapplied(r.proposal);
			void focusTitle();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = null;
		}
	}
	async function discard(p: DivideProposal) {
		const ok = await confirmDialog({
			title: 'Discard the proposed division?',
			message: 'The proposal and your ticks go; nothing in the model changes. You can propose again from the points.',
			confirmLabel: 'Discard',
			danger: true
		});
		if (!ok) return;
		busy = 'discard';
		error = null;
		try {
			await api.start.discard(projectId, p.id);
			delete draft.ticks[p.id];
			await ondiscarded();
			void focusTitle();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = null;
		}
	}

	// --- the cards as the map's key ---
	const light = (key: string | null) => onhighlight?.(key);
	function cardOut(e: FocusEvent) {
		if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) light(null);
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
	const pct = (f: number) => `${fmtNum(f * 100, 0)} %`;
</script>

<Dialog bind:open title="Divide the model from the map" side>
	<span bind:this={bodyEl} hidden></span>
	<div class="divide" data-testid="divide-sheet" data-step={step}>
		{#if step === 'off'}
			<p data-testid="divide-off">Dividing the model needs an elevation model on the server, and this one has none. Set each unit’s area and order on the Network, or one unit at a time with the map’s Delineate and Use this area.</p>
		{:else if step === 'outflow'}
			<p data-testid="divide-outflow">The model needs exactly one outflow gauge (a node that drains nowhere) before it can be divided: set it on the Network.</p>
		{:else if step === 'points'}
			<form id="{uid}-points" onsubmit={propose} novalidate data-testid="divide-points">
				<p class="lead">
					Say which node each point on the map stands for. Each gets its own sub-catchment (what drains to its point and to no point above it) and the point below it, proposed beside its values now; nothing changes until you tick it. A gauge with no node can be added as a new gauge node.
				</p>
				{#if candidates.length}
					<ul class="points">
						{#each candidates as f (f.id)}
							{@const options = nodeOptions(f, nodes)}
							<li data-feature={f.id}>
								<label for="{uid}-node-{f.id}" class="pname">{featureName(f)} <span class="muted small">({f.kind === 'dam' ? 'dam' : f.kind === 'gauge' ? 'gauge' : 'point'})</span></label>
								{#if f.id === outlet}
									<span class="muted small">The outlet ({outflow?.name})</span>
								{:else}
									<select id="{uid}-node-{f.id}" value={choiceOf(f)} onchange={(e) => (draft.picked[f.id] = e.currentTarget.value)} aria-invalid={twice && choiceOf(f) === twice ? 'true' : undefined}>
										<option value={NONE}>Not in the division</option>
										{#if f.kind === 'gauge' && f.geometry.type === 'Point' && !f.nodeId}<option value={NEW_GAUGE}>A new gauge node</option>{/if}
										{#each options as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
									</select>
								{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<p class="muted" data-testid="divide-no-points">No dams or points on the map yet: place each unit’s point (a dam at its wall, an abstraction point where it takes water) first.</p>
				{/if}
				<p><button type="button" class="btn btn-sm" onclick={onplace} data-testid="divide-place">Place a point</button></p>
				<div class="field">
					<label for="{uid}-outlet">The outlet ({outflow?.name})</label>
					<select id="{uid}-outlet" value={outlet} onchange={(e) => (draft.outlet = e.currentTarget.value)} data-testid="divide-outlet">
						{#if boundary}<option value="">The boundary’s own outlet</option>{:else if !outlet}<option value="" disabled>Choose a gauge…</option>{/if}
						{#each gauges as g (g.id)}<option value={g.id}>{featureName(g)} (gauge)</option>{/each}
					</select>
					<span class="hint">Where the river leaves the catchment: the model’s outflow, {outflow?.name}.</span>
				</div>
				{#if twice}<p class="err" role="alert">Two points stand for {nodeName(twice)}: each node takes one point.</p>{/if}
				<p class="hint" data-testid="divide-count">{chosen === 1 ? '1 point' : `${chosen} points`} in the division.</p>
			</form>
		{:else if step === 'review' && pending && ticks}
			{@const p = pending.plan}
			<div class="review" data-testid="divide-review">
				<p class="lead">
					Tick each value to take it; anything unticked stays as it is in the model. The catchment above the outlet: <strong>{km2(p.catchment.areaM2)}</strong>.
				</p>
				{#if p.warnings.length || p.dropped.length || p.untouched.length}
					<ul class="warnings" data-testid="divide-warnings">
						{#each p.warnings as w (w)}<li>{w}</li>{/each}
						{#each p.dropped as d (d.featureId)}<li>{d.name || 'A point'} isn’t in the division: it {d.reason}.</li>{/each}
						{#if p.untouched.length}<li>No point stands for {p.untouched.map((u) => u.name).join(', ')}: {p.untouched.length === 1 ? 'it keeps its' : 'they keep their'} values.</li>{/if}
					</ul>
				{/if}
				<p class="tick-all">
					<button type="button" class="btn btn-sm" onclick={() => pending && (draft.ticks[pending.id] = tickAllDivide(pending.plan, ticks))} data-testid="divide-tick-all">Tick every value</button>
					<span class="hint">{p.units.length} {p.units.length === 1 ? 'point' : 'points'}, upstream first.</span>
				</p>
				{#if problem}<p class="err" role="alert" id="{uid}-problem" data-testid="divide-problem">{problem}</p>{/if}
				<ul class="units">
					{#each ticks.units as t, i (t.key)}
						{@const u = p.units[i]!}
						{@const offer = divideOffers(u)}
						<li
							class="unit"
							data-testid="divide-unit"
							data-key={u.key}
							data-piece-card={u.key}
							onmouseenter={() => light(u.key)}
							onmouseleave={() => light(null)}
							onfocusin={() => light(u.key)}
							onfocusout={cardOut}
						>
							<p class="named">
								<PieceBadge label={String(i + 1)} tint={i % PIECE_TINT_COUNT} />
								<strong>{u.nodeId ? u.name : 'A new gauge'}</strong>
								<span class="muted small">from “{u.featureName}”</span>
							</p>
							{#if offer.add}
								<label class="tick">
									<input type="checkbox" bind:checked={t.add} data-testid="divide-tick-add" />
									<span>Add it to the model as a gauge node{u.totalAreaM2 !== null ? `, measuring ${km2(u.totalAreaM2)} above it` : ''}</span>
								</label>
								{#if t.add}
									<div class="field">
										<label for="{uid}-name-{u.key}">Its name</label>
										<input id="{uid}-name-{u.key}" bind:value={t.name} maxlength="100" aria-describedby={problem ? `${uid}-problem` : undefined} />
									</div>
								{/if}
							{:else if u.role === 'gauge' && u.totalAreaM2 !== null}
								<p class="hint">It measures {km2(u.totalAreaM2)} above it; a gauge owns no land of its own.</p>
							{/if}
							{#if offer.area}
								<label class="tick">
									<input type="checkbox" bind:checked={t.area} data-testid="divide-tick-area" />
									<span
										>Area <strong>{km2(u.areaM2)}</strong>, its own piece (whole catchment {km2(u.totalAreaM2)}), saved as its parcel. Now:
										{u.current ? `${km2Now(u.current.areaKm2)}, ${u.current.areaSource === 'map' ? 'from the map' : 'typed'}` : '–'}{sameAsNow(p, u, 'area') ? ' (the same)' : ''}</span
									>
								</label>
							{/if}
							{#if offer.drainsInto}
								<label class="tick">
									<input type="checkbox" bind:checked={t.drainsInto} data-testid="divide-tick-drains" />
									<span
										>Drains into <strong>{divideDrainsIntoName(p, ticks, u)}</strong>. Now: {u.current ? (u.current.downstreamName ?? 'nothing') : 'the outflow'}{sameAsNow(p, u, 'drainsInto')
											? ' (the same)'
											: ''}</span
									>
								</label>
							{/if}
							{#if offer.runoffToDam}
								<label class="tick">
									<input type="checkbox" bind:checked={t.runoffToDam} data-testid="divide-tick-dam" />
									<span>All of its own runoff reaches the dam (its piece ends at the wall). Now: {u.current ? pct(u.current.pctRunoffToDam) : '–'}</span>
								</label>
							{/if}
							{#if u.snapDistanceM !== null}<p class="hint">Moved {fmtNum(u.snapDistanceM, 0)} m onto the river.</p>{/if}
						</li>
					{/each}
					<li class="unit" data-testid="divide-rest" data-piece-card={REST_KEY} onmouseenter={() => light(REST_KEY)} onmouseleave={() => light(null)} onfocusin={() => light(REST_KEY)} onfocusout={cardOut}>
						<p class="named">
							{#if p.rest.geometry}<PieceBadge label="R" tint={-1} />{/if}
							<strong>The rest of the catchment</strong>
							<span class="muted small">{km2(p.rest.areaM2)}: what drains to the outlet through no point</span>
						</p>
						{#if p.rest.geometry}
							<div class="field">
								<label for="{uid}-rest">Its area goes to</label>
								<select id="{uid}-rest" value={restChoice} onchange={(e) => setRest(e.currentTarget.value)} data-testid="divide-rest-to">
									<option value="none">Nobody (not taken)</option>
									{#each restTargets as n (n.id)}<option value={n.id}>{n.name} (now {km2Now(n.areaKm2)})</option>{/each}
									<option value="new">A new unit</option>
								</select>
							</div>
							{#if ticks.rest.to === 'new'}
								{@const r = ticks.rest}
								<div class="field">
									<label for="{uid}-rest-name">Its name</label>
									<input id="{uid}-rest-name" bind:value={r.name} oninput={(e) => (restNewName = e.currentTarget.value)} maxlength="100" />
								</div>
							{/if}
						{:else}
							<p class="hint">Its outline couldn’t be made a polygon, so it has no parcel to save; type its area on the Network.</p>
						{/if}
					</li>
				</ul>
				<details class="how">
					<summary>How it was made</summary>
					<dl class="facts">
						<dt>Dataset</dt>
						<dd>{pending.dataset}</dd>
						<dt>Method</dt>
						<dd>{pending.method} [{pending.methodVersion}]</dd>
						<dt>Cell size</dt>
						<dd>{fmtNum(p.cellSizeM, 0)} m</dd>
					</dl>
					<p class="hint">A proposal from an elevation model, not a survey: check each area against the map before you tick it (design/delineation.md § Accuracy).</p>
				</details>
			</div>
		{/if}
		{#if error}<p class="err" role="alert" data-testid="divide-error">{error}</p>{/if}
	</div>

	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
		{#if step === 'points'}
			<button type="submit" form="{uid}-points" class="btn btn-primary" disabled={busy === 'propose' || !!twice || chosen === 0 || (!boundary && !outlet)} data-testid="divide-propose">
				{busy === 'propose' ? 'Proposing…' : 'Propose the division'}
			</button>
		{:else if step === 'review' && pending}
			{@const p = pending}
			<button type="button" class="btn btn-ghost" disabled={!!busy} onclick={() => discard(p)} data-testid="divide-discard">{busy === 'discard' ? 'Discarding…' : 'Discard'}</button>
			<button type="button" class="btn btn-primary" disabled={!!busy || !!problem} onclick={() => apply(p)} data-testid="divide-apply">{busy === 'apply' ? 'Applying…' : 'Apply the ticked values'}</button>
		{/if}
	{/snippet}
</Dialog>

<style>
	.divide,
	.review,
	form {
		display: grid;
		gap: 0.75rem;
	}
	.divide {
		container: divide-sheet / inline-size;
	}
	.tick-all {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
	}
	.lead {
		margin: 0;
	}
	.points,
	.units,
	.warnings {
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}
	.points,
	.units {
		list-style: none;
	}
	.warnings {
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
	.named {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
	}
	.field {
		display: grid;
		gap: 0.25rem;
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
	@container divide-sheet (max-width: 26rem) {
		.points li {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
