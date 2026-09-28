<script lang="ts">
	// Twelve toggle checkboxes in water-year order, bound to calendar months 1–12,
	// with a line under them: the months in words (`summary`) and All / None.
	import { monthName, WATER_YEAR_CALENDAR } from '$lib/format/months';

	let {
		months = $bindable(),
		label,
		summary,
		disabled = false
	}: { months: number[]; label: string; summary?: string; disabled?: boolean } = $props();

	function toggle(m: number, on: boolean) {
		const set = new Set(months);
		if (on) set.add(m);
		else set.delete(m);
		months = [...set].sort((a, b) => a - b);
	}
</script>

<fieldset class="months">
	<legend class="visually-hidden">{label}</legend>
	<div class="toggles">
		{#each WATER_YEAR_CALENDAR as m (m)}
			<label class:on={months.includes(m)}>
				<input
					type="checkbox"
					checked={months.includes(m)}
					{disabled}
					onchange={(e) => toggle(m, e.currentTarget.checked)}
				/>
				<!-- The initial is visual only; each toggle is named by its full month ("Oct", not "O Oct"). -->
				<span aria-hidden="true">{monthName(m).slice(0, 1)}</span>
				<span class="visually-hidden">{monthName(m)}</span>
			</label>
		{/each}
	</div>
	{#if summary || !disabled}
		<div class="foot">
			{#if summary}<span class="summary muted">{summary}</span>{/if}
			{#if !disabled}
				<button type="button" class="btn btn-sm btn-ghost all" onclick={() => (months = months.length === 12 ? [] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])}>
					{months.length === 12 ? 'None' : 'All'}
				</button>
			{/if}
		</div>
	{/if}
</fieldset>

<style>
	.months {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.toggles {
		display: flex;
		gap: 2px;
	}
	label {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.45rem;
		height: 1.6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.75rem;
		color: var(--text-muted);
		cursor: pointer;
		user-select: none;
	}
	label.on {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-contrast);
		font-weight: 600;
	}
	label:focus-within {
		outline: 2px solid var(--focus);
		outline-offset: 1px;
	}
	input {
		position: absolute;
		opacity: 0;
		inset: 0;
		width: 100%;
		height: 100%;
		margin: 0;
		cursor: pointer;
	}
	input:disabled {
		cursor: default;
	}
	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 0.15rem;
		min-height: 24px;
	}
	.summary {
		font-size: 0.72rem;
	}
	.all {
		margin-left: auto;
		font-size: 0.75rem;
		min-height: 24px;
		padding: 0 0.4rem;
	}
</style>
