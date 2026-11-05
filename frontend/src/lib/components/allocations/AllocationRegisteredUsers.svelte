<script lang="ts">
	// Registered users by hydrological unit (docs/allocations.md § Registered
	// users by hydrological unit; docs/ui.md § Allocations): one row per
	// registered user per farm (Farm no. is the allocation's property field),
	// with what their authorisations in force today register: irrigated area,
	// farm dam capacity and water use. Grouped by unit, each group ending in its
	// subtotal, the not-matched group last and the catchment total after it.
	// What is registered only (registeredUsers.ts): no run is read, so it shows
	// before the model has run, and the map below shades the units by these
	// subtotals. Names only for a reader who may see them (D3, `canSeeHolders`);
	// otherwise the rows are per farm with no name column. A read-only table:
	// below 50rem of its box each row is a block (app.css .table-stack). The
	// first GROUP_CAP units show until "Show all" (a unit picked on the map opens
	// the rest). Editors load and remove invented demo users here (315, POST /
	// DELETE …/allocations/demo), each with a confirm; while they are on the
	// page a notice says so, with Remove demo users.
	import { untrack } from 'svelte';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import { api, type AllocationList } from '#lib/api/index.js';
	import { saveBlob } from '#lib/export/download.js';
	import { fmtDate, fmtNum, localIsoDate } from '#lib/format/number.js';
	import { registeredUsers, registeredUsersCsv, type RegisteredFigures } from './registeredUsers';

	let {
		projectId,
		data,
		canEdit,
		focusUnit = null,
		onstart,
		onchanged,
		onfailed
	}: {
		projectId: string;
		data: AllocationList;
		canEdit: boolean;
		/** A unit picked on the map: its group opens (under the fold) and scrolls into view. */
		focusUnit?: { id: string; at: number } | null;
		/** An action starts: the page clears the last one's notice. */
		onstart: () => void;
		/** The volumes changed: the page reloads them and shows `message`. */
		onchanged: (message?: string) => Promise<void>;
		onfailed: (err: unknown) => void;
	} = $props();

	const day = localIsoDate();
	const holders = $derived(data.canSeeHolders);
	const table = $derived(registeredUsers(data.allocations, data.nodes, day, holders));
	const demo = $derived(data.sources.find((s) => s.kind === 'demo') ?? null);
	const cols = $derived(holders ? 6 : 5);

	const GROUP_CAP = 5;
	let all = $state(false);
	const shown = $derived(all || table.groups.length <= GROUP_CAP + 1 ? table.groups : table.groups.slice(0, GROUP_CAP));
	const hidden = $derived(table.groups.length - shown.length);

	$effect(() => {
		const f = focusUnit;
		if (!f) return;
		if (!untrack(() => shown).some((g) => g.nodeId === f.id)) all = true;
		queueMicrotask(() => document.getElementById(`alloc-users-${f.id}`)?.scrollIntoView({ block: 'start' }));
	});

	const ha = (v: number | null) => (v === null ? '–' : fmtNum(v, 2, true));
	const m3 = (v: number | null) => (v === null ? '–' : fmtNum(v));
	const usersText = (n: number) => `${fmtNum(n)} registered user${n === 1 ? '' : 's'}`;

	function download() {
		saveBlob(new Blob(['﻿', registeredUsersCsv(table, holders)], { type: 'text/csv;charset=utf-8' }), `registered-users-by-unit-${day}.csv`);
	}

	let busy = $state(false);
	async function loadDemo() {
		const ok = await confirmDialog({
			title: 'Load demo registered users?',
			message:
				'This adds two or three invented registered users, named “… (invented)”, to every farm and water user of the current model, with invented farm numbers and figures worked out from each unit’s crops, dam and demand. They are for display only, not anyone’s registration. Remove demo users takes them all away again and leaves every volume entered or imported; loading again replaces them.',
			confirmLabel: 'Load demo users'
		});
		if (!ok) return;
		onstart();
		busy = true;
		try {
			const r = await api.allocations.loadDemo(projectId);
			await onchanged(`Loaded ${usersText(r.users)} (invented) on ${fmtNum(r.units)} hydrological unit${r.units === 1 ? '' : 's'}.`);
		} catch (err) {
			onfailed(err);
		} finally {
			busy = false;
		}
	}
	async function removeDemo() {
		const ok = await confirmDialog({
			title: 'Remove the demo registered users?',
			message: 'Remove every invented demo registered user and their volumes? Volumes entered by hand or imported stay.',
			confirmLabel: 'Remove demo users',
			danger: true
		});
		if (!ok) return;
		onstart();
		busy = true;
		try {
			const r = await api.allocations.removeDemo(projectId);
			await onchanged(`Removed the demo registered users and their ${fmtNum(r.removed)} registered volume${r.removed === 1 ? '' : 's'}.`);
		} catch (err) {
			onfailed(err);
		} finally {
			busy = false;
		}
	}
</script>

{#snippet figures(f: RegisteredFigures)}
	<td class="num" data-label="Registered irrigated area (ha)">{ha(f.areaHa)}</td>
	<td class="num" data-label="Registered farm dam capacity (m³)">{m3(f.storageM3)}</td>
	<td class="num" data-label="Registered water use (m³/a)">{m3(f.volumeM3)}</td>
{/snippet}

<section class="panel" aria-labelledby="alloc-users-h" data-testid="allocation-registered-users-panel">
	<div class="panel-head">
		<h2 id="alloc-users-h">Registered users by hydrological unit</h2>
		<div class="head-actions">
			{#if table.users}<button type="button" class="btn btn-sm" onclick={download}>Download this table (CSV)</button>{/if}
			{#if canEdit && !demo}<button type="button" class="btn btn-sm" disabled={busy} onclick={loadDemo}>Load demo registered users</button>{/if}
		</div>
	</div>
	{#if demo}
		<p class="alert alert-info slim demo" data-testid="allocation-demo-notice">
			<span>Demo registered users (invented) are shown, loaded {fmtDate(demo.importedAt, true)}: invented names, farm numbers and figures, for display only.</span>
			{#if canEdit}<button type="button" class="btn btn-sm" disabled={busy} onclick={removeDemo}>Remove demo users</button>{/if}
		</p>
	{/if}
	<p class="small muted lead">
		Each registered user’s authorisations in force today ({fmtDate(day)}), added up per farm: the irrigated area their takes state, their farm dam
		capacity (s21b storage and the storage stated on a take) and their water use (the volumes of their takes, surface and groundwater added). What is
		registered, not what anyone uses; no run is needed.{holders ? '' : ' Names of registered users are shown to editors only.'}
	</p>
	{#if table.users}
		<div class="table-stack">
			<div class="table-wrap users-wrap">
				<table class="data users" id="alloc-users-table" data-testid="allocation-registered-users">
					<caption class="visually-hidden">Registered users by hydrological unit, each unit’s subtotal and the catchment total, registered in force today</caption>
					<thead>
						<tr>
							<th scope="col">Farm no.</th>
							{#if holders}<th scope="col">Registered user</th>{/if}
							<th scope="col">Hydrological unit</th>
							<th scope="col" class="num">Registered irrigated area (ha)</th>
							<th scope="col" class="num">Registered farm dam capacity (m³)</th>
							<th scope="col" class="num">Registered water use (m³/a)</th>
						</tr>
					</thead>
					{#each shown as g (g.nodeId ?? '')}
						<tbody id="alloc-users-{g.nodeId ?? 'unmatched'}" data-group={g.nodeId ?? 'unmatched'} data-testid="allocation-registered-group">
							<tr class="group">
								<th scope="rowgroup" colspan={cols}>{g.name} <span class="muted small">{usersText(g.rows.length)}</span></th>
							</tr>
							{#each g.rows as r (r.key)}
								<tr data-testid="allocation-registered-user">
									<th scope="row">{r.farmNo || '–'}</th>
									{#if holders}<td data-label="Registered user">{r.holder ?? '–'}</td>{/if}
									<td class="unit-cell" data-label="Hydrological unit">{g.name}</td>
									{@render figures(r)}
								</tr>
							{/each}
							<tr class="subtotal" data-testid="allocation-registered-subtotal">
								<th scope="row" colspan={cols - 3}>Subtotal, {g.name}</th>
								{@render figures(g.subtotal)}
							</tr>
						</tbody>
					{/each}
					<tbody>
						<tr class="total" data-testid="allocation-registered-total">
							<th scope="row" colspan={cols - 3}>Catchment total <span class="sub muted">{usersText(table.users)}</span></th>
							{@render figures(table.total)}
						</tr>
					</tbody>
				</table>
			</div>
		</div>
		{#if all || hidden}
			<button type="button" class="btn btn-sm more" aria-expanded={all} aria-controls="alloc-users-table" onclick={() => (all = !all)}>
				{all ? `Show the first ${GROUP_CAP} hydrological units’ registered users` : `Show all ${fmtNum(table.groups.length)} hydrological units’ registered users`}
			</button>
		{/if}
		{#if hidden}<p class="small muted note">The catchment total counts every unit, the ones folded away included.</p>{/if}
		{#if table.notInForce}
			<p class="small muted note" data-testid="allocation-registered-not-in-force">
				{fmtNum(table.notInForce)} registered volume{table.notInForce === 1 ? ' isn’t' : 's aren’t'} in force today (lapsed, or not started yet), so {table.notInForce === 1 ? 'it is' : 'they are'} in no figure.
			</p>
		{/if}
	{:else}
		<p class="muted" data-testid="allocation-registered-users-empty">
			{data.allocations.length ? 'No registered volume is in force today.' : 'No registered users yet.'}{canEdit && !demo ? ' Import or add their volumes, or load invented demo users to see how the table and map read.' : ''}
		</p>
	{/if}
</section>

<style>
	.panel-head {
		flex-wrap: wrap;
		gap: 0.4rem 0.75rem;
	}
	.head-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.lead {
		margin: 0 0 0.6rem;
		max-width: 100ch;
	}
	.demo {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem 0.75rem;
		margin: 0 0 0.6rem;
		padding: 0.4rem 0.75rem;
	}
	.note,
	.more {
		margin: 0.5rem 0 0;
	}
	.sub {
		display: block;
		font-weight: 400;
		font-size: var(--font-xs);
	}
	/* The page is the one scroll: no 70vh cap (app.css). */
	.users-wrap {
		max-height: none;
	}
	.users tbody th[scope='row'] {
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}
	tr.group th {
		font-weight: 600;
		background: var(--surface-2);
		border-top: 1px solid var(--border-strong);
	}
	tr.group th .small {
		font-weight: 400;
		margin-left: 0.35rem;
	}
	tr.subtotal th,
	tr.subtotal td {
		font-weight: 600;
		border-top: 1px solid var(--border-strong);
	}
	tr.total th,
	tr.total td {
		font-weight: 700;
		border-top: 2px solid var(--border-strong);
		background: var(--surface-2);
	}
	/* Stacked (a phone): the group's name across the block, as a row header is; each row under it leaves out the
	   unit (its group says it), so a user is two lines, not three; a subtotal's and the total's rule is the row's. */
	@container table-stack (max-width: 50rem) {
		.users tr.group th {
			grid-column: 1 / -1;
		}
		.users td.unit-cell {
			display: none;
		}
		.users tr.subtotal th,
		.users tr.subtotal td,
		.users tr.total th,
		.users tr.total td {
			border-top: none;
		}
		.users tr.subtotal {
			border-top: 1px solid var(--border-strong);
		}
		.users tr.total {
			border-top: 2px solid var(--border-strong);
			background: var(--surface-2);
		}
	}
	@media (max-width: 640px) {
		.head-actions :global(.btn) {
			min-height: 44px;
		}
	}
</style>
