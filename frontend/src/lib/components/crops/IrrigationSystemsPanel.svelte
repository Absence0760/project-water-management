<script lang="ts">
	// The project's irrigation systems (engine ≥ 1.72.0, docs/ui.md §
	// Irrigation systems), in the grid modal (`grid=systems`, opened from
	// Crops & demand's Tables menu; the modal's title names it): each row's name and efficiency, SABI's
	// range beside a row that started as a SABI system, and how many crops and
	// plantings are on it. An editor changes an efficiency (every crop on the
	// system follows), adds a system of the scheme's own, or removes one (asked
	// first while anything is on it: those fall back to none). Edits go into the
	// shared ModelEditor and are saved with the model.
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { sabiRange, systemsOf, systemUse } from '$lib/model/systems';
	import GridPasteDialog from '$lib/components/model/GridPasteDialog.svelte';
	import { gridPasteTarget, type PasteAnchor, type PastePlan } from '$lib/spreadsheet/paste/grid';
	import { applySystemPaste, planSystemPaste, systemsCsv, SYSTEMS_FORMAT } from './systemsPaste';

	let { editor, readonly }: { editor: ModelEditor; readonly: boolean } = $props();

	const rows = $derived(systemsOf(editor.model));
	/** The model's own table, made from the defaults the first time it is edited. */
	function table() {
		return (editor.model.irrigationSystems ??= systemsOf(editor.model).map((s) => ({ ...s })));
	}
	const useText = (id: string) => {
		const u = systemUse(editor.model, id);
		const parts = [u.crops ? `${u.crops} crop${u.crops === 1 ? '' : 's'}` : '', u.plantings ? `${u.plantings} unit planting${u.plantings === 1 ? '' : 's'}` : ''].filter(Boolean);
		return parts.length ? parts.join(', ') : 'Not used';
	};
	let announce = $state('');

	function add() {
		const s = editor.addIrrigationSystem();
		announce = `Added ${s.name}. Name it and set its efficiency.`;
		queueMicrotask(() => document.getElementById(`sys-name-${s.id}`)?.focus());
	}

	// --- paste names and efficiencies from a spreadsheet (issue #477): into an efficiency, or from the button ---
	let pasteOpen = $state(false);
	let pasteText = $state('');
	let pasteAnchor = $state<PasteAnchor | null>(null);
	const pasteWhere = $derived(pasteAnchor ? `${rows[pasteAnchor.row]?.name || '(unnamed)'}, Efficiency` : null);
	function openPaste() {
		pasteAnchor = null;
		pasteText = '';
		pasteOpen = true;
	}
	function onPaste(e: ClipboardEvent) {
		const t = gridPasteTarget(e);
		if (!t) return;
		pasteAnchor = t.anchor;
		pasteText = t.text;
		pasteOpen = true;
	}
	function applyPaste(plan: PastePlan) {
		applySystemPaste(
			plan,
			(id, eff) => {
				const row = table().find((x) => x.id === id);
				if (row) row.efficiency = eff;
			},
			(name) => {
				const s = editor.addIrrigationSystem();
				s.name = name.slice(0, 100);
				return s.id;
			}
		);
		const n = plan.added?.length ?? 0;
		announce = `Pasted ${plan.changes.length} ${plan.changes.length === 1 ? 'efficiency' : 'efficiencies'}${n ? `, adding ${n} ${n === 1 ? 'system' : 'systems'}` : ''}. Save the model to keep them.`;
	}

	async function remove(id: string, name: string) {
		const u = systemUse(editor.model, id);
		if (
			(u.crops || u.plantings) &&
			!(await confirmDialog({
				title: `Remove “${name}”?`,
				message: `${useText(id)} ${u.crops + u.plantings === 1 ? 'is' : 'are'} on it. A crop on it has no default system any more, and a unit's planting on it takes the crop's default.`,
				confirmLabel: 'Remove system',
				danger: true
			}))
		)
			return;
		editor.removeIrrigationSystem(id);
		announce = `Removed ${name}.`;
	}
</script>

<section class="systems" aria-label="Irrigation systems" data-testid="irrigation-systems">
	<div class="head">
		<p class="muted small intro">
			Each crop is on one of these, by default or on a unit that waters it differently; a unit's efficiency is its crops'
			combined. Changing an efficiency changes every crop on the system. <HelpTip key="crop.irrigationSystemId" label="About irrigation systems" />
		</p>
		{#if !readonly}
			<div class="toolbar grid-actions" data-testid="grid-actions">
				<button type="button" class="btn btn-sm" onclick={add}>+ Add system</button>
				<button type="button" class="btn btn-sm" onclick={openPaste}>Paste from a spreadsheet…</button>
			</div>
		{/if}
	</div>
	<div class="table-wrap">
		<table class="data compact">
			<thead>
				<tr>
					<th scope="col">System</th>
					<th scope="col" class="num">Efficiency <span class="u">%</span></th>
					<th scope="col">Used by</th>
					{#if !readonly}<th scope="col"><span class="visually-hidden">Remove</span></th>{/if}
				</tr>
			</thead>
			<tbody onpaste={readonly ? undefined : onPaste}>
				{#each rows as s, i (s.id)}
					{@const range = sabiRange(s)}
					<tr data-idx={i}>
						<th scope="row">
							{#if readonly}
								{s.name}
							{:else}
								<input
									id="sys-name-{s.id}"
									class="name"
									maxlength="100"
									aria-label="Name of irrigation system {i + 1}"
									value={s.name}
									oninput={(e) => (table()[i]!.name = e.currentTarget.value)}
								/>
							{/if}
						</th>
						<td class="eff" data-paste-col="0">
							<NumberInput
								label="Efficiency of {s.name || 'the system'}, %"
								min={1}
								max={100}
								step={1}
								scale={100}
								disabled={readonly}
								value={s.efficiency}
								onchange={(v) => {
									if (v !== null && v > 0 && v <= 1) table()[i]!.efficiency = v;
								}}
							/>
							{#if range}<span class="range muted">{range}</span>{/if}
						</td>
						<td class="use muted">{useText(s.id)}</td>
						{#if !readonly}
							<td class="rm">
								<button type="button" class="btn btn-icon" aria-label="Remove {s.name || 'the system'}" title="Remove system" onclick={() => remove(s.id, s.name || 'the system')}>✕</button>
							</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="muted small">
		Starts with SABI's Agricultural Design Norms (2021, Table 4), each at a value inside SABI's range; a scheme's own
		measurement is better.
	</p>
	<p class="visually-hidden" aria-live="polite">{announce}</p>
	{#if !readonly}
		<GridPasteDialog
			bind:open={pasteOpen}
			bind:text={pasteText}
			title="Paste irrigation systems"
			layout="Efficiency in %: a row per system with its name first, under a heading row (System, Efficiency (%), as the CSV below has them). A name the table doesn't have adds a system; without names the values fill the efficiencies from the row you pasted into."
			where={pasteWhere}
			plan={(t) => planSystemPaste(t, rows, pasteAnchor)}
			onapply={applyPaste}
			csv={() => systemsCsv(rows)}
			csvName="irrigation-systems.csv"
			format={SYSTEMS_FORMAT}
			rowNoun={['system', 'systems']}
		/>
	{/if}
</section>

<style>
	/* Kept to what its columns need: the modal is full width, and a wider table only spread the columns apart. */
	.systems {
		container: systems / inline-size;
		max-width: 48rem;
	}
	.systems p {
		margin: 0 0 0.5rem;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.5rem 1rem;
	}
	.intro {
		flex: 1 1 20rem;
		max-width: 70ch;
	}
	/* The name column stops at 20rem, so on a wide modal the efficiency and use sit by the name, not across the screen. */
	th[scope='row'] {
		width: 20rem;
		max-width: 20rem;
	}
	.name {
		width: 100%;
		min-width: 10rem;
	}
	/* The efficiency right-aligned over its SABI range. */
	.eff {
		white-space: nowrap;
		text-align: right;
	}
	.eff :global(input) {
		width: 4.5rem;
	}
	.range {
		display: block;
		font-size: 0.75rem;
		text-align: right;
	}
	.use {
		font-size: 0.85rem;
	}
	.rm {
		width: 2.5rem;
		text-align: right;
	}
	/* A phone-wide box: the name takes what the efficiency, use and remove leave, so the table fits without scrolling sideways. */
	@container systems (max-width: 40rem) {
		th[scope='row'] {
			width: auto;
		}
		.name {
			min-width: 0;
		}
		.use {
			font-size: 0.8rem;
		}
	}
</style>
