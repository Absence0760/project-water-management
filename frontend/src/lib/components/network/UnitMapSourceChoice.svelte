<!--
	A unit's "Source of the MAP" (docs/ui.md § Network, docs/maps.md § MAP for
	each unit): one of the loaded MAP grids (the WAAS 2007 MAP, the CCWR MAP) or
	typed by hand. Each grid shows the MAP it gives this unit (the MAP for each
	unit proposal for that grid: the area-weighted mean over its parcel, its
	coverage when 90–100 %), or why it can't (the proposal's own reasons).
	Picking a grid writes the MAP and its source through that proposal's apply,
	saved straight to the model as one change in History, as Settings → Flow
	generation → MAP from the grid does; so it waits while the model has unsaved
	changes. One grid for the whole project: picking one while other units hold
	another grid's MAP asks to switch them too, and a grid that can't take every
	such unit over can't be picked. Other units typed by hand or with no MAP
	keep theirs, unless the question's option (unticked) replaces those the
	grid covers in the same change. Typed by hand is an edit like any other: it
	keeps the number and asks for a source (the `typed` snippet, the text
	field). A viewer sees which it is, read-only.
-->
<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import type { NetworkNode } from '@water-management/engine';
	import { api, type UnitMapCandidate } from '#lib/api/index.js';
	import { confirmDialog, confirmWithOption } from '#lib/components/common/confirm.svelte.js';
	import { mapGridName } from '#lib/components/map/mapGridNames.js';
	import { fmtNum } from '#lib/format/number.js';
	import { choiceOf, gridLabels, gridOptions, pickedNotice, pickNodeIds, pickQuestion, toTyped, type GridLoad, type GridOption } from './unitMapChoice';

	let {
		node,
		projectId,
		readonly,
		modelDirty,
		onModelChanged,
		typed
	}: {
		node: NetworkNode;
		projectId: string;
		readonly: boolean;
		/** Unsaved model edits: a grid can't be picked until they are saved or discarded (its MAP saves straight to the project). */
		modelDirty: boolean;
		/** The model changed on the server: the workspace takes it as it now is. Without it the grids are shown, never picked. */
		onModelChanged?: () => Promise<void> | void;
		/** The typed source's own field, under Typed by hand. */
		typed: Snippet;
	} = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	/** Only an editor reads the proposals (GET …/map/unit-map is an editor's) and picks a grid. */
	const canPick = $derived(!readonly && !!projectId && !!onModelChanged);

	let candidates = $state.raw<UnitMapCandidate[] | null>(null);
	let loads = $state.raw<ReadonlyMap<string, GridLoad>>(new Map());
	let readError = $state<string | null>(null);
	let pending = $state<string | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let seq = 0;

	/** Every loaded grid's proposal: the default one names the loaded grids, then each other grid is asked for by name. */
	async function load() {
		const mine = ++seq;
		readError = null;
		try {
			const first = await api.map.unitMap(projectId);
			if (mine !== seq) return;
			const m = new Map<string, GridLoad>();
			for (const c of first.candidates) m.set(c.label, { kind: 'reading' });
			if (first.dataset) m.set(first.dataset.label, { kind: 'read', proposal: first });
			candidates = first.candidates;
			loads = new Map(m);
			await Promise.all(
				first.candidates
					.filter((c) => c.label !== first.dataset?.label)
					.map(async (c) => {
						let r: GridLoad;
						try {
							r = { kind: 'read', proposal: await api.map.unitMap(projectId, c.label) };
						} catch (e) {
							r = { kind: 'error', message: msg(e) };
						}
						if (mine === seq) loads = new Map(loads).set(c.label, r);
					})
			);
		} catch (e) {
			if (mine === seq) readError = msg(e);
		}
	}
	// Once per unit and project: a reload of the model (after a pick) hands in a new node object, not a new unit.
	const isFarm = $derived(node.kind === 'farm');
	$effect(() => {
		void projectId;
		if (canPick && isFarm) untrack(() => void load());
	});

	const labels = $derived(candidates ? gridLabels(candidates) : gridLabels([]));
	const choice = $derived(choiceOf(node.mapSource, labels));
	const current = $derived(choice.kind === 'grid' ? choice.label : 'typed');
	const checked = $derived(pending ?? current);
	/** The grids offered: read for an editor; for a viewer, by name only (the named grids and the one the unit is on). */
	const options = $derived<GridOption[]>(
		canPick && candidates
			? gridOptions(node.id, candidates, loads)
			: [...labels, ...(choice.kind === 'grid' && !labels.includes(choice.label) ? [choice.label] : [])].map((label) => ({
					label,
					name: mapGridName(label),
					mapMm: null,
					covered: null,
					reason: null,
					same: false,
					switches: [],
					replaceable: [],
					notCovered: []
				}))
	);
	/** Every grid's proposal read (or failed): `data-ready`, so a test waits on the grids, not on time. */
	const ready = $derived(!canPick || readError !== null || (candidates !== null && [...loads.values()].every((l) => l.kind !== 'reading')));
	const gridLocked = $derived(!canPick || !candidates || modelDirty || busy);
	const hasMap = $derived(node.mapMm !== null && node.mapMm !== undefined);

	async function pick(opt: GridOption) {
		pending = opt.label;
		error = null;
		notice = null;
		try {
			const q = pickQuestion(node, choice, opt);
			let replaceTyped = false;
			if (q?.option) {
				const a = await confirmWithOption({ ...q, option: q.option });
				if (!a.ok) return;
				replaceTyped = a.option;
			} else if (q && !(await confirmDialog(q))) return;
			busy = true;
			const r = await api.map.applyUnitMap(projectId, opt.label, pickNodeIds(node.id, opt, replaceTyped));
			notice = pickedNotice(r, node.id, node.name || 'This unit', opt.name);
			await Promise.all([onModelChanged?.(), load()]);
		} catch (e) {
			error = msg(e);
			void load();
		} finally {
			busy = false;
			pending = null;
		}
	}

	function onchange(e: Event & { currentTarget: HTMLInputElement }) {
		const value = e.currentTarget.value;
		if (value === 'typed') {
			toTyped(node);
			return;
		}
		const opt = options.find((o) => o.label === value);
		if (opt && !opt.reason) void pick(opt);
	}
</script>

<fieldset class="choice" data-testid="unit-map-choice" data-ready={ready} aria-describedby="{uid}-h">
	<legend class="lbl">Source of the MAP</legend>
	<span class="hint explain" id="{uid}-h">A MAP grid’s area-weighted mean over the unit’s parcel, or a MAP you type in with its source. One grid for the whole project: two are never mixed.</span>
	{#each options as opt, i (opt.label)}
		{@const why = canPick ? opt.reason : null}
		<div class="opt" data-grid={opt.label}>
			<label>
				<input
					type="radio"
					name="{uid}-src"
					value={opt.label}
					checked={checked === opt.label}
					disabled={readonly || gridLocked || (!!why && checked !== opt.label)}
					aria-describedby={why || (modelDirty && canPick && checked !== opt.label) ? `${uid}-why-${i}` : undefined}
					{onchange}
				/>
				<span class="nm">{opt.name}</span>{#if opt.mapMm !== null}{' '}<span class="val">{fmtNum(opt.mapMm)} mm{#if opt.covered}, {opt.covered}{/if}</span>{/if}
			</label>
			{#if why}
				<span class="why" id="{uid}-why-{i}">{why}</span>
			{:else if modelDirty && canPick && checked !== opt.label}
				<span class="why" id="{uid}-why-{i}">Save or discard your model changes first: a grid’s MAP is saved straight away.</span>
			{/if}
			{#if current === opt.label}
				<span class="line" data-testid="unit-map-source-line">{node.mapSource}</span>
				{#if canPick && !why && !opt.same && opt.mapMm !== null && !gridLocked}
					<button type="button" class="btn btn-sm again" onclick={() => pick(opt)}>Take it again: {fmtNum(opt.mapMm)} mm now</button>
				{/if}
			{/if}
		</div>
	{/each}
	<div class="opt">
		<label>
			<input type="radio" name="{uid}-src" value="typed" checked={checked === 'typed'} disabled={readonly || busy} {onchange} />
			<span class="nm">Typed by hand</span>
		</label>
		{#if current === 'typed' && hasMap}{@render typed()}{/if}
	</div>
	{#if canPick && readError}<p class="err small" data-testid="unit-map-choice-error">The grids couldn’t be read: {readError}</p>{/if}
	{#if busy}<p class="muted small">Saving…</p>{/if}
	<p class="small" role="status" data-testid="unit-map-choice-notice">{notice ?? ''}</p>
	{#if error}<p class="err small" aria-live="assertive" data-testid="unit-map-choice-failed">{error}</p>{/if}
</fieldset>

<style>
	.choice {
		grid-column: 1 / -1;
		display: grid;
		gap: 0.35rem;
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
	}
	.lbl {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
		padding: 0;
	}
	.opt {
		display: grid;
		gap: 0.15rem;
	}
	.opt label {
		display: inline-flex;
		align-items: baseline;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.val {
		font-variant-numeric: tabular-nums;
		color: var(--text-2);
		font-size: 0.85rem;
	}
	.why,
	.line {
		margin-left: 1.5rem;
		font-size: 0.85rem;
		color: var(--text-2);
		overflow-wrap: anywhere;
	}
	.again {
		margin-left: 1.5rem;
		justify-self: start;
	}
	.opt :global(.field) {
		margin-left: 1.5rem;
	}
	.err {
		color: var(--danger);
	}
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
</style>
