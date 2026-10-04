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
		{#if !readonly}<button type="button" class="btn btn-sm" onclick={add}>+ Add system</button>{/if}
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
			<tbody>
				{#each rows as s, i (s.id)}
					{@const range = sabiRange(s)}
					<tr>
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
						<td class="eff">
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
