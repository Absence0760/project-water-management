<!--
	Dams → "Proposed from the register and the map" (issue #326 B-dams;
	docs/ui.md § Dams, docs/maps.md § Dams from the register and the map).
	For one hydrological unit's dam: the registered dams within 1 km of its dam
	on the map, each listing its capacity for reference only (the unit's dam is
	its composite dam, all its farm dams, many unregistered: its volume is the
	user's to enter, #523 C1), and the dam polygon proposing its area as the
	full-supply area. Each row shows the source and what the saved model holds
	now; Use (editors, the area only) asks first, then saves that one value to
	the model as a revision naming the source. Nothing is applied by itself.
	Two places: `inline`, inside the picked dam's chart panel once there is a
	run, folded to one line of what is proposed (proposalsLine), its Dam of
	following the page's pick and a dam picked there moving it (`onpick`), so
	the chart and the box are about one dam; `page`, a panel under the cards
	before a run or with no dam (Dam of picks for the box alone).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { api, type DamProposals } from '#lib/api/index.js';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import ProposalNoDataset from '#lib/components/proposals/ProposalNoDataset.svelte';
	import ProposalPanel from '#lib/components/proposals/ProposalPanel.svelte';
	import ProposalSynthetic from '#lib/components/proposals/ProposalSynthetic.svelte';
	import { mapNodeHref } from '#lib/workspace/mapLinks.js';
	import { fmtNum } from '#lib/format/number.js';
	import { confirmWords, damProposalRows, fmtDamArea, proposalsLine, searchedFrom, type DamProposalRow } from './damProposals';

	let {
		id,
		projectId,
		units,
		initial,
		follow = null,
		readonly,
		dirty,
		onModelChanged,
		variant = 'page',
		open = $bindable(),
		dams = [],
		onpick
	}: {
		/** The panel's anchor (a card's Proposals link scrolls to it). */
		id?: string;
		projectId: string;
		/** The hydrological units to choose from, dams first; never empty (DamsTab draws the panel only when there is one). */
		units: { id: string; name: string }[];
		/** The unit shown first (the page's picked dam). */
		initial: string | null;
		/** The page's picked dam (`dam=`): the box moves to it whenever it changes, so a card click and a fresh load of the same URL agree. */
		follow?: string | null;
		readonly: boolean;
		/** Unsaved model changes: Use waits until they are saved or discarded (it saves straight to the model). */
		dirty: boolean;
		onModelChanged: () => Promise<void> | void;
		/** 'inline' inside the picked dam's chart panel, folded to one line; 'page' a panel of its own. */
		variant?: 'page' | 'inline';
		/** The fold's open state ('inline'): a card's Proposals link opens it. */
		open?: boolean;
		/** The units with a dam card, which the page can pick (`dam=`); the rest are listed apart. */
		dams?: string[];
		/** Dam of picked a unit with a card: the page picks it too (its chart, its card, the URL). */
		onpick?: (id: string) => void;
	} = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let unitId = $state(untrack(() => initial ?? units[0]?.id ?? ''));
	// Follow the picked dam; Dam of still picks any unit until the page's pick changes again.
	$effect(() => {
		const f = follow;
		untrack(() => {
			if (f && f !== unitId && units.some((u) => u.id === f)) unitId = f;
		});
	});
	let data = $state.raw<DamProposals | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let rowError = $state<{ key: string; text: string } | null>(null);
	let notice = $state<string | null>(null);
	let seq = 0;
	let frame = $state<ProposalPanel | null>(null);

	async function load(id: string) {
		const mine = ++seq;
		loading = true;
		error = null;
		try {
			const d = await api.damProposals.get(projectId, id);
			if (mine === seq) data = d;
		} catch (e) {
			if (mine === seq) {
				data = null;
				error = msg(e);
			}
		} finally {
			if (mine === seq) loading = false;
		}
	}
	$effect(() => {
		const id = unitId;
		untrack(() => {
			notice = null;
			rowError = null;
			if (id) void load(id);
		});
	});

	const rows = $derived(data ? damProposalRows(data) : []);
	const capacityRows = $derived(rows.filter((r) => r.kind === 'capacity'));
	const synthetic = $derived(rows.some((r) => r.synthetic));
	const damSet = $derived(new Set(dams));
	const withDam = $derived(units.filter((u) => damSet.has(u.id)));
	const withoutDam = $derived(units.filter((u) => !damSet.has(u.id)));
	const unitName = $derived(units.find((u) => u.id === unitId)?.name || '(unnamed)');
	const fold = $derived(variant === 'inline' ? { name: `${unitName}:`, line: proposalsLine(data?.nodeId === unitId ? data : null, loading, error), change: 'Show' } : undefined);
	function picked() {
		if (onpick && damSet.has(unitId)) onpick(unitId);
	}

	async function use(r: Extract<DamProposalRow, { kind: 'area' }>) {
		if (!data) return;
		const d = data;
		if (!(await confirmDialog(confirmWords(d, r)))) return;
		busy = r.key;
		rowError = null;
		try {
			const res = await api.damProposals.areaFromMap(projectId, d.nodeId, r.featureId);
			notice = `${d.nodeName}’s full-supply area is now ${fmtDamArea(res.damAreaFullM2)}, from the map.`;
			await Promise.all([load(d.nodeId), onModelChanged()]);
			await frame?.focusNotice();
		} catch (e) {
			rowError = { key: r.key, text: msg(e) };
		} finally {
			busy = null;
		}
	}
</script>

<ProposalPanel
	bind:this={frame}
	bind:open
	{id}
	{fold}
	testid="dam-proposals"
	prefix="dam-proposals"
	{variant}
	title="Proposed from the register and the map"
	helpKey="dam-proposals"
	what="proposals"
	{notice}
	{loading}
	loaded={data !== null}
	{error}
	onretry={() => load(unitId)}
>
	{#snippet intro()}
		<p class="hint muted">
			The registered dams within 1 km of the unit’s dam on the map, with their capacities for reference only: the unit’s dam is its
			composite dam (all its farm dams, many of them unregistered), so its volume is yours to enter. And its area when full from the
			dam’s polygon on the map. Each value shows its source; nothing changes until you use it.
		</p>
	{/snippet}
	{#snippet controls()}
		<div class="field">
			<label for="{uid}-unit">Dam of</label>
			<select id="{uid}-unit" bind:value={unitId} onchange={picked}>
				{#if dams.length && withoutDam.length}
					<optgroup label="Dams">
						{#each withDam as u (u.id)}<option value={u.id}>{u.name || '(unnamed)'}</option>{/each}
					</optgroup>
					<optgroup label="Hydrological units with no dam yet">
						{#each withoutDam as u (u.id)}<option value={u.id}>{u.name || '(unnamed)'}</option>{/each}
					</optgroup>
				{:else}
					{#each units as u (u.id)}<option value={u.id}>{u.name || '(unnamed)'}</option>{/each}
				{/if}
			</select>
		</div>
	{/snippet}
		{#if data}
			{#if !data.dam}
				<p class="alert alert-info slim" data-testid="dam-proposals-no-dam">
					No dam on the map is linked to {data.nodeName}. Draw its dam (or place it as a point) on the Map and link it to {data.nodeName}; the register is searched from there.
					<a href="?tab=map">Open the Map</a>
				</p>
			{:else}
				<p class="small">
					{searchedFrom(data.dam)} · <a href={mapNodeHref(data.nodeId)}>Show on map</a>
				</p>
				{#if !data.datasets.length}
					<ProposalNoDataset testid="dam-proposals-no-register" what="register of dams" consequence="no capacity can be proposed" instead="Enter the dam’s capacity by hand." />
				{:else if capacityRows.length === 0}
					<p class="muted small" data-testid="dam-proposals-none">No registered dam within {fmtNum(data.radiusM / 1000)} km of the dam on the map.</p>
				{/if}
				{#if synthetic}
					<ProposalSynthetic testid="dam-proposals-synthetic" subject="The register" notWhat="the DWS list" forWhat="dam" />
				{/if}
				{#if rows.length}
					<div class="rows-box">
					<div class="table-wrap">
						<table class="data compact" data-testid="dam-proposals-rows">
							<caption class="visually-hidden">Values proposed for {data.nodeName}’s dam, beside the saved model’s</caption>
							<thead>
								<tr>
									<th scope="col">Value</th>
									<th scope="col">Saved now</th>
									<th scope="col">Proposed</th>
									<th scope="col">Source</th>
									<th scope="col"><span class="visually-hidden">Use</span></th>
								</tr>
							</thead>
							<tbody>
								{#each rows as r (r.key)}
									<tr data-key={r.key}>
										<th scope="row">{r.label}<span class="detail muted">{r.detail}</span></th>
										<td class="num" data-label="Saved now">{r.now}</td>
										<td class="num" data-label="Proposed">{r.proposed}</td>
										<td class="src small" data-label="Source" data-testid="dam-proposal-source">{r.source}</td>
										<td class="use">
											{#if r.kind === 'capacity'}
												<span class="muted small" data-testid="dam-proposal-reference">Reference only</span>
											{:else if r.missing}
												<span class="muted small">Nothing to use</span>
											{:else if r.same}
												<span class="muted small">Saved</span>
											{:else if !readonly}
												<button
													type="button"
													class="btn btn-sm"
													disabled={busy !== null || dirty}
													aria-describedby={dirty ? `${uid}-dirty` : undefined}
													aria-label="Use the map’s area"
													onclick={() => use(r)}>{busy === r.key ? 'Saving…' : 'Use'}</button
												>
											{/if}
											{#if rowError?.key === r.key}<p class="err small" role="alert">{rowError.text}</p>{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					</div>
				{/if}
				{#if !readonly && dirty}
					<p class="hint muted" id="{uid}-dirty">Save or discard your model changes first: a value used here is saved to the model straight away.</p>
				{/if}
				<p class="hint muted">
					The register’s wall height and completion year are shown for reference; the model has no field for them.
					{#if readonly}Only an editor can use a value.{/if}
				</p>
			{/if}
		{/if}
</ProposalPanel>

<style>
	.field {
		display: grid;
		gap: 0.25rem;
		justify-items: start;
	}
	.field select {
		max-width: 100%;
	}
	.detail {
		display: block;
		font-weight: 400;
		font-size: var(--font-sm);
		overflow-wrap: anywhere;
	}
	/* Inside the chart panel the box is ~680 px at 1280: the columns keep a readable width (a word breaks only
	   when it alone is wider than its column, never "synthet|ic"), and a narrower box scrolls the table sideways. */
	th[scope='row'] {
		min-width: 10rem;
	}
	/* app.css keeps .num on one line; here "Not set (estimated from capacity)" and "164 568 m² (16.5 ha)" wrap
	   between words, and 6rem keeps a volume ("35 000 m³") whole. */
	.num {
		font-variant-numeric: tabular-nums;
		white-space: normal;
		min-width: 6rem;
	}
	.src {
		min-width: 12rem;
		max-width: 22rem;
		overflow-wrap: break-word;
		color: var(--text-2);
	}
	.slim {
		padding: 0.5rem 0.75rem;
		margin: 0;
	}
	.err {
		color: var(--danger);
		margin: 0;
	}
	.hint,
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
	.table-wrap {
		width: 100%;
	}
	/* Narrower than the table's 549 px (a phone; a 1280 px column is 680): each row is a block, its value's name on
	   top, Saved now and Proposed side by side under their labels, then the source and the Use, so nothing scrolls
	   sideways (ui-playbook.md § 2 "Fit a wide table by stacking"; the same markup, restyled, as YearTable).
	   40rem = 560 px at the 14 px root. */
	.rows-box {
		container: dam-proposal-rows / inline-size;
	}
	@container dam-proposal-rows (max-width: 40rem) {
		.table-wrap {
			max-height: none;
		}
		table,
		tbody {
			display: block;
		}
		thead {
			display: none;
		}
		tr {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.4rem 0.75rem;
			padding: 0.6rem 0.75rem;
		}
		tr + tr {
			border-top: 1px solid var(--border);
		}
		/* table.data: app.css's cell padding and rule (table.data td) outrank a scoped td. */
		table.data th,
		table.data td {
			display: block;
			padding: 0;
			border-bottom: none;
			text-align: left;
			min-width: 0;
			max-width: none;
		}
		th[scope='row'],
		.src,
		.use {
			grid-column: 1 / -1;
		}
		td[data-label]::before {
			content: attr(data-label);
			display: block;
			font-size: var(--font-xs);
			font-weight: 400;
			color: var(--text-2);
		}
		/* An empty Use cell (a viewer's area row) takes no line. */
		.use:empty {
			display: none;
		}
		.use .btn {
			min-height: 44px;
			min-width: 44px;
		}
	}
</style>
