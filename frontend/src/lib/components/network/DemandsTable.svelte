<script lang="ts">
	// The Demands grid (Network → Tables → Demands, `grid=demands`, docs/ui.md
	// § Demands grid): every demand in the catchment, one row each: a unit's
	// crops, its demand objects in the unit's supply order, each other water
	// user. An editor types a monthly object's or a user's m³/day here; the rest
	// of a demand (its sizing, schedule, source, priority) stays in the node
	// sheet its row's Edit opens, and the crops' demand comes from their
	// planted areas (the farm drawer). Edits go into the shared ModelEditor.
	import type { ProjectSettings } from '@water-management/engine';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api, type AllocationList } from '$lib/api';
	import { STATUS_LABEL } from '$lib/components/allocations/allocations';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { fmtNum, fmtPct, fmtQty, localIsoDate } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { withoutParam, withParam } from '$lib/workspace/overlays';
	import { demandRows, demandShares, demandTotal, type DemandRow } from './demands';
	import { DEMANDS_UNIT_CHOICES, demandsUnitView, parseDemandsUnit, UNIT_PARAM } from './demandUnits';
	import { nodeSpans, registeredCells, registeredTotal } from './demandsRegistered';

	let {
		editor,
		settings,
		readonly,
		projectId = null
	}: {
		editor: ModelEditor;
		settings: ProjectSettings;
		readonly: boolean;
		/** Reads the project's registered volumes (docs/allocations.md) for the Registered column; none without it. */
		projectId?: string | null;
	} = $props();

	const rows = $derived(demandRows(editor.model, settings.apanMm, settings.februaryDays));
	const total = $derived(demandTotal(rows, settings.februaryDays));
	const shares = $derived(demandShares(rows));
	const peak = $derived(Math.max(1e-9, ...rows.filter((r) => r.enabled).flatMap((r) => r.monthlyM3Day)));
	const shade = (v: number) => `--i: ${Math.round((v / peak) * 100)}%`;
	const scheduled = $derived(rows.some((r) => r.scheduled));

	// The display unit (`unit=` in the URL, m³/day without it): cells, mean and the catchment row; the model keeps m³/day.
	const unit = $derived(parseDemandsUnit(page.url.searchParams.get(UNIT_PARAM)));
	const uv = $derived(demandsUnitView(unit));
	const show = (m3Day: number) => fmtNum(m3Day * uv.scale, uv.decimals);
	function pickUnit(v: string) {
		const next = parseDemandsUnit(v);
		void goto(next ? withParam(page.url, UNIT_PARAM, next) : withoutParam(page.url, UNIT_PARAM), { noScroll: true, keepFocus: true });
	}
	// --- registered volumes (docs/allocations.md): per unit or user, read as the Allocations page reads them, so a viewer
	// sees per-unit volumes only when the owners allow it, and a farmer is refused (no column) ---
	let allocations = $state<AllocationList | null>(null);
	$effect(() => {
		const id = projectId;
		allocations = null;
		if (!id) return;
		let live = true;
		api.allocations.list(id).then(
			(l) => live && (allocations = l),
			() => live && (allocations = null)
		);
		return () => (live = false);
	});
	/** The column shows once the volumes are in and this reader may see them per unit, with at least one in the project. */
	const showRegistered = $derived(!!allocations && !allocations.unitsHidden && allocations.allocations.length > 0);
	const cells = $derived(showRegistered ? registeredCells(rows, allocations!.allocations, localIsoDate(), settings.allocationTolerance ?? 0.1) : null);
	const spans = $derived(nodeSpans(rows));
	const regTotal = $derived(cells ? registeredTotal(cells) : null);

	/** Where the rest of a row is set: a unit's crops in its farm drawer on Crops & demand, anything else in its node's sheet. */
	const editHref = (r: DemandRow) => (r.kind === 'crops' ? `?tab=crops&farm=${encodeURIComponent(r.nodeId)}` : `?tab=network&edit=${encodeURIComponent(r.nodeId)}`);

	/** Writes one month of an editable row into the model (a monthly object's `monthlyM3Day`, a user's `userDemandM3Day`). */
	function setMonth(r: DemandRow, m: number, v: number | null) {
		if (v === null || !(v >= 0)) return;
		const model = editor.model;
		if (r.kind === 'user') {
			const n = model.nodes.find((x) => x.id === r.nodeId);
			if (!n) return;
			const months = n.userDemandM3Day ? [...n.userDemandM3Day] : new Array<number>(12).fill(0);
			months[m] = v;
			n.userDemandM3Day = months;
		} else if (r.kind === 'object') {
			const o = model.demandObjects?.find((x) => `object@${x.id}` === r.key);
			if (!o || o.sizing !== 'monthly') return;
			const months = o.monthlyM3Day ? [...o.monthlyM3Day] : new Array<number>(12).fill(0);
			months[m] = v;
			o.monthlyM3Day = months;
		}
	}
</script>

<section class="demands" aria-label="Demands" data-testid="demands-grid">
	<p class="muted small intro">
		Every demand in the catchment: each unit's crops (their irrigation requirement ÷ the unit's efficiency, before rain), its
		demand objects in the order the unit supplies them, and each other water user, by water-year month.
		{#if !readonly}Type a monthly demand here; a per-person or per-head demand, a schedule, the water source and the supply order are set in the node's form (Edit).{/if}
	</p>
	{#if shares.length}
		<p class="small shares" data-testid="demands-shares">
			{#each shares as s, i (s.what)}{i ? ', ' : ''}<span class="share"><strong>{s.what}</strong> {fmtPct(s.share, 0)}</span>{/each}
			of {fmtQty(total.annualMm3, 3)} Mm³/a.
		</p>
	{/if}
	{#if rows.length}
		<div class="unit-pick">
			<label for="demands-unit">Show demands in</label>
			<select id="demands-unit" value={unit ?? ''} onchange={(e) => pickUnit(e.currentTarget.value)} data-testid="demands-unit">
				{#each DEMANDS_UNIT_CHOICES as c (c.label)}<option value={c.value ?? ''}>{c.label}</option>{/each}
			</select>
		</div>
	{/if}
	{#if !rows.length}
		<p class="muted" data-testid="demands-empty">No demands yet: plant crops on a unit, add a demand object in a unit's form, or add another water user.</p>
	{:else}
		<!-- 20 columns scroll sideways: the wrap takes focus so the keyboard can scroll it (axe scrollable-region-focusable). -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="table-wrap" tabindex="0" role="region" aria-label="Demands by month">
			<table class="data compact">
				<thead>
					<tr>
						<th scope="col" class="sticky">Demand</th>
						<th scope="col">Unit</th>
						<th scope="col">Kind</th>
						<th scope="col">Water from</th>
						<th scope="col">Supply order</th>
						{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}<br /><span class="u">{uv.label}</span></th>{/each}
						<th scope="col" class="num">Mean<br /><span class="u">{uv.label}</span></th>
						<th scope="col" class="num">Annual<br /><span class="u">Mm³/a</span></th>
						{#if cells}<th scope="col" class="num">Registered<br /><span class="u">Mm³/a</span></th>{/if}
						<th scope="col"><span class="visually-hidden">Edit</span></th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.key)}
						<tr class:off={!r.enabled} data-row={r.key}>
							<th scope="row" class="sticky">
								{r.name}
								{#if !r.enabled}<span class="tag">not modelled</span>{/if}
								{#if r.external}<span class="tag">piped out</span>{/if}
								{#if r.scheduled}<span class="tag" title="Its schedule changes its demand on the days it covers">scheduled</span>{/if}
								{#if r.sizing}<span class="sizing muted">{r.sizing}</span>{/if}
							</th>
							<td>{r.kind === 'user' ? '–' : r.unit}</td>
							<td>{r.what}</td>
							<td>{r.from}</td>
							<td>{r.order ?? '–'}</td>
							{#each r.monthlyM3Day as v, m (m)}
								{#if r.editable && !readonly}
									<td class="num cell">
										<NumberInput label="{r.name}, {WATER_YEAR_MONTHS[m]}, {uv.label}" min={0} grouped={!unit} scale={uv.scale} decimals={unit ? uv.decimals : undefined} value={v} onchange={(x) => setMonth(r, m, x)} />
									</td>
								{:else}
									<td class="num heat" style={r.enabled ? shade(v) : undefined}>{show(v)}</td>
								{/if}
							{/each}
							<td class="num">{show(r.meanM3Day)}</td>
							<td class="num strong">{fmtQty(r.annualMm3, 3)}</td>
							{#if cells && spans.has(r.key)}
								{@const c = cells.get(r.nodeId)}
								<td class="num reg" rowspan={spans.get(r.key)} data-registered={r.nodeId} data-status={c?.status}>
									{#if c && c.count}{fmtQty(c.registeredM3 / 1e6, 3)}{:else}–{/if}
									{#if c && c.status !== 'none'}
										<span class="reg-status" class:over={c.status === 'over' || c.status === 'unregistered'}>
											{STATUS_LABEL[c.status]}{#if spans.get(r.key)! > 1}: {fmtQty(c.demandM3 / 1e6, 3)} for the {r.kind === 'user' ? 'user' : 'unit'}{/if}
										</span>
									{/if}
								</td>
							{/if}
							<td class="edit">
								<a href={editHref(r)} aria-label="{readonly ? 'View' : 'Edit'} {r.name}{r.kind === 'user' ? '' : ` on ${r.unit}`}">{readonly ? 'View' : 'Edit'}</a>
							</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row" class="sticky">Catchment</th>
						<td colspan="4"></td>
						{#each total.monthly as v, m (m)}<td class="num">{show(v)}</td>{/each}
						<td class="num">{show(total.meanM3Day)}</td>
						<td class="num strong">{fmtQty(total.annualMm3, 3)}</td>
						{#if regTotal}<td class="num strong">{fmtQty(regTotal.registeredM3 / 1e6, 3)}</td>{/if}
						<td></td>
					</tr>
				</tfoot>
			</table>
		</div>
		<p class="muted small after">
			1 Mm³ = 1 million m³. Darker cells are months of higher demand. A demand object that isn't modelled counts nothing.
			{#if scheduled}A scheduled demand shows its months before its schedule windows.{/if}
			A run's demand also follows rain, daily A-pan, demand factors and restrictions; its own figures are on its results.
		</p>
		{#if cells && regTotal}
			<p class="muted small after" data-testid="demands-registered-note">
				Registered: each unit's or user's registered and licensed volumes in force today (surface and groundwater, takes
				only, not storage), beside the sum of its demands, banded ±{fmtPct(settings.allocationTolerance ?? 0.1, 0)} as the
				Allocations page compares a run's use.{#if regTotal.over}
					<strong>{regTotal.over} {regTotal.over === 1 ? 'is' : 'are'} above registered.</strong>{/if}
				A demand above its registered volume is a flag to check, not a finding: a registered volume is not an entitlement,
				and a run's modelled use is what the Allocations page compares.
			</p>
		{:else if allocations && allocations.unitsHidden}
			<p class="muted small after" data-testid="demands-registered-note">Registered volumes per unit aren't shown to viewers in this project (Allocations).</p>
		{:else if allocations && !allocations.allocations.length}
			<p class="muted small after" data-testid="demands-registered-note">No registered volumes in this project yet, so there is nothing to put beside the demands (Allocations).</p>
		{/if}
	{/if}
</section>

<style>
	.intro {
		margin: 0 0 0.5rem;
		max-width: 80ch;
	}
	.unit-pick {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.75rem;
	}
	.unit-pick select {
		width: auto;
	}
	.shares {
		margin: 0 0 0.75rem;
	}
	th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
		min-width: 150px;
		max-width: 16rem;
		font-weight: 500;
		text-align: left;
	}
	thead th.sticky,
	tfoot th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
	tbody td {
		white-space: nowrap;
	}
	td.num {
		min-width: 64px;
	}
	.cell :global(input) {
		width: 5.25rem;
		text-align: right;
	}
	.tag {
		display: inline-block;
		margin-left: 0.35rem;
		padding: 0 0.35rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 400;
		color: var(--text-muted);
	}
	.sizing {
		display: block;
		font-size: 0.75rem;
		font-weight: 400;
	}
	tr.off td,
	tr.off th {
		color: var(--text-muted);
	}
	.table-wrap:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.heat {
		background: color-mix(in srgb, color-mix(in srgb, var(--brand-outlet) 45%, transparent) var(--i), transparent);
	}
	.strong {
		font-weight: 600;
	}
	td.reg {
		vertical-align: top;
		white-space: normal;
		min-width: 7rem;
	}
	.reg-status {
		display: block;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.reg-status.over {
		color: var(--danger);
		font-weight: 600;
	}
	.after {
		margin: 0.75rem 0 0;
		max-width: 80ch;
	}
</style>
