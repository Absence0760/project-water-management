<script lang="ts">
	// The Demands grid (Network → Tables → Demands, `grid=demands`, docs/ui.md
	// § Demands grid): every demand in the catchment, one row each: a unit's
	// crops, its demand objects in the unit's supply order, each other water
	// user. An editor types a monthly object's or a user's m³/day here; the rest
	// of a demand (its sizing, schedule, source, priority) stays in the node
	// sheet its row's Edit opens, and the crops' demand comes from their
	// planted areas (the farm drawer). Edits go into the shared ModelEditor.
	import type { ProjectSettings } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { fmtNum, fmtPct, fmtQty } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { demandRows, demandShares, demandTotal, type DemandRow } from './demands';

	let { editor, settings, readonly }: { editor: ModelEditor; settings: ProjectSettings; readonly: boolean } = $props();

	const rows = $derived(demandRows(editor.model, settings.apanMm, settings.februaryDays));
	const total = $derived(demandTotal(rows, settings.februaryDays));
	const shares = $derived(demandShares(rows));
	const peak = $derived(Math.max(1e-9, ...rows.filter((r) => r.enabled).flatMap((r) => r.monthlyM3Day)));
	const shade = (v: number) => `--i: ${Math.round((v / peak) * 100)}%`;
	const scheduled = $derived(rows.some((r) => r.scheduled));

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
		demand objects in the order the unit supplies them, and each other water user, in m³/day by water-year month.
		{#if !readonly}Type a monthly demand here; a per-person or per-head demand, a schedule, the water source and the supply order are set in the node's form (Edit).{/if}
	</p>
	{#if shares.length}
		<p class="small shares" data-testid="demands-shares">
			{#each shares as s, i (s.what)}{i ? ', ' : ''}<span class="share"><strong>{s.what}</strong> {fmtPct(s.share, 0)}</span>{/each}
			of {fmtQty(total.annualMm3, 3)} Mm³/a.
		</p>
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
						{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}<br /><span class="u">m³/day</span></th>{/each}
						<th scope="col" class="num">Mean<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Annual<br /><span class="u">Mm³/a</span></th>
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
										<NumberInput label="{r.name}, {WATER_YEAR_MONTHS[m]}, m³/day" min={0} grouped value={v} onchange={(x) => setMonth(r, m, x)} />
									</td>
								{:else}
									<td class="num heat" style={r.enabled ? shade(v) : undefined}>{fmtNum(v)}</td>
								{/if}
							{/each}
							<td class="num">{fmtNum(r.meanM3Day)}</td>
							<td class="num strong">{fmtQty(r.annualMm3, 3)}</td>
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
						{#each total.monthly as v, m (m)}<td class="num">{fmtNum(v)}</td>{/each}
						<td class="num">{fmtNum(total.meanM3Day)}</td>
						<td class="num strong">{fmtQty(total.annualMm3, 3)}</td>
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
	{/if}
</section>

<style>
	.intro {
		margin: 0 0 0.5rem;
		max-width: 80ch;
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
	.after {
		margin: 0.75rem 0 0;
		max-width: 80ch;
	}
</style>
