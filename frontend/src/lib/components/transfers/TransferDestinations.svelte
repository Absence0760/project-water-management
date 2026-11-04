<script lang="ts">
	// A transfer split between destinations (engine ≥ 1.114.0, docs/model.md §2.6
	// *Split between destinations*): a row per destination, its unit and its share
	// of what arrives (after the losses), up to five, the shares adding up to 100 %
	// (the running total says so as it is typed). Removing all but one makes it a
	// plain transfer again, all of it to that one. The rule's toNodeId is kept the
	// first destination's (engine withDestinations), so every reader of the one
	// destination still sees where it goes.
	import { MAX_TRANSFER_DESTINATIONS, SPLIT_SUM_TOLERANCE, transferDestinations, withDestinations, type NetworkNode, type Transfer, type TransferDestination } from '@water-management/engine';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { fmtNum } from '#lib/format/number.js';

	let {
		rule,
		label,
		units,
		name,
		disabled = false,
		onremoved
	}: {
		rule: Transfer;
		/** "transfer 1": names the fields. */
		label: string;
		/** The hydrological units a destination can be. */
		units: readonly Pick<NetworkNode, 'id' | 'name'>[];
		name: (id: string | null) => string;
		disabled?: boolean;
		/** After a row is removed: the caller moves the focus (the row's controls are gone). */
		onremoved?: () => void;
	} = $props();

	const river = $derived((rule.source ?? 'dam') === 'river');
	const rows = $derived(transferDestinations(rule));
	const total = $derived(rows.reduce((a, d) => a + (Number.isFinite(d.pct) ? d.pct : 0), 0));
	const adds = $derived(Math.abs(total - 1) <= SPLIT_SUM_TOLERANCE);
	const pctText = (v: number) => fmtNum(Math.round(v * 10_000) / 100, 2, true);

	function write(next: TransferDestination[]) {
		// One left is all of it to that one: a plain transfer.
		Object.assign(rule, withDestinations(next.length === 1 ? [{ nodeId: next[0]!.nodeId, pct: 1 }] : next));
	}
	function setNode(k: number, id: string | null) {
		write(rows.map((d, j) => (j === k ? { ...d, nodeId: id } : d)));
	}
	function setPct(k: number, v: number | null) {
		write(rows.map((d, j) => (j === k ? { ...d, pct: v ?? 0 } : d)));
	}
	/** The next unit a row can name: one not the source and not named yet, else (a dam rule) outside the catchment. */
	const nextEnd = $derived.by((): { id: string | null } | null => {
		const used = new Set(rows.map((d) => d.nodeId));
		const u = units.find((x) => x.id !== rule.fromNodeId && !used.has(x.id));
		return u ? { id: u.id } : !river && !used.has(null) ? { id: null } : null;
	});
	/** A new row takes what the shares are short of 100 %, or half the last row's when they add up. */
	function addRow() {
		if (!nextEnd) return;
		const short = 1 - total;
		const next = rows.map((d) => ({ ...d }));
		let pct = short;
		if (!(short > SPLIT_SUM_TOLERANCE)) {
			const last = next[next.length - 1]!;
			pct = last.pct / 2;
			last.pct -= pct;
		}
		write([...next, { nodeId: nextEnd.id, pct }]);
	}
	function remove(k: number) {
		write(rows.filter((_, j) => j !== k));
		onremoved?.();
	}
</script>

<fieldset class="dests" data-testid="transfer-destinations">
	<legend class="dests-t">
		<span>Destinations, shares of what arrives</span>
		<HelpTip key="transfer.destinations" />
	</legend>
	<!-- On a phone the unit, share and Remove can be wider than the card: the wrap takes focus so the keyboard can scroll it (axe scrollable-region-focusable). -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="table-wrap" tabindex="0" role="region" aria-label="Destinations of {label}">
	<table class="data">
		<thead>
			<tr><th scope="col">To</th><th scope="col">Share, %</th><th scope="col"><span class="visually-hidden">Remove</span></th></tr>
		</thead>
		<tbody>
			{#each rows as d, k (k)}
				<tr data-testid="transfer-destination">
					<td>
						<select aria-label="Destination {k + 1} of {label}" {disabled} value={d.nodeId ?? ''} onchange={(e) => setNode(k, e.currentTarget.value || null)}>
							{#if d.nodeId !== null && !units.some((u) => u.id === d.nodeId)}<option value={d.nodeId}>{name(d.nodeId)} (not a hydrological unit)</option>{/if}
							{#each units as u (u.id)}<option value={u.id} disabled={u.id === rule.fromNodeId || (u.id !== d.nodeId && rows.some((x) => x.nodeId === u.id))}>{u.name || '(unnamed)'}</option>{/each}
							<!-- Out of the catchment (engine ≥ 1.86.0): a dam rule only, as a rule's one destination. -->
							{#if !river || d.nodeId === null}<option value="" disabled={d.nodeId !== null && rows.some((x) => x.nodeId === null)}>Outside the catchment</option>{/if}
						</select>
					</td>
					<td><NumberInput label="Share of destination {k + 1} of {label}, %" min={0} max={100} scale={100} {disabled} value={d.pct} onchange={(v) => setPct(k, v)} /></td>
					<td>
						{#if !disabled}<button type="button" class="btn btn-sm btn-ghost btn-danger" aria-label="Remove destination {k + 1} ({name(d.nodeId)}) of {label}" onclick={() => remove(k)}>Remove</button>{/if}
					</td>
				</tr>
			{/each}
		</tbody>
		<tfoot>
			<tr>
				<th scope="row">Total</th>
				<td class="total" class:bad={!adds} data-testid="split-total" aria-live="polite">{pctText(total)} %{adds ? '' : ', must be 100 %'}</td>
				<td></td>
			</tr>
		</tfoot>
	</table>
	</div>
	{#if !disabled && rows.length < MAX_TRANSFER_DESTINATIONS}
		<button type="button" class="btn btn-sm add" disabled={!nextEnd} onclick={addRow}>+ Add a destination</button>
	{:else if !disabled}
		<p class="small muted">At most {MAX_TRANSFER_DESTINATIONS} destinations.</p>
	{/if}
</fieldset>

<style>
	.dests {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.dests-t {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0;
		min-height: 24px;
		margin-bottom: 0.3rem;
		font-size: var(--font-xs);
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--text-2);
	}
	table {
		width: auto;
		max-width: 100%;
	}
	td select {
		min-width: 12rem;
		max-width: 100%;
	}
	td :global(input[type='number']) {
		width: 6rem;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.table-wrap:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.total {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		text-align: right;
	}
	.total.bad {
		color: var(--danger);
	}
	.add {
		margin-top: 0.35rem;
	}
</style>
