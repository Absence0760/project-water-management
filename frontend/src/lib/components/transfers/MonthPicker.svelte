<script lang="ts">
	// Twelve toggle checkboxes in water-year order, bound to calendar months 1–12.
	import { monthName, WATER_YEAR_CALENDAR } from '$lib/format/months';

	let { months = $bindable(), label, disabled = false }: { months: number[]; label: string; disabled?: boolean } = $props();

	function toggle(m: number, on: boolean) {
		const set = new Set(months);
		if (on) set.add(m);
		else set.delete(m);
		months = [...set].sort((a, b) => a - b);
	}
</script>

<fieldset class="months">
	<legend class="visually-hidden">{label}</legend>
	{#each WATER_YEAR_CALENDAR as m (m)}
		<label class:on={months.includes(m)}>
			<input
				type="checkbox"
				checked={months.includes(m)}
				{disabled}
				onchange={(e) => toggle(m, e.currentTarget.checked)}
			/>
			<span>{monthName(m).slice(0, 1)}</span>
			<span class="visually-hidden">{monthName(m)}</span>
		</label>
	{/each}
	{#if !disabled}
		<button type="button" class="btn btn-sm btn-ghost all" onclick={() => (months = months.length === 12 ? [] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])}>
			{months.length === 12 ? 'None' : 'All'}
		</button>
	{/if}
</fieldset>

<style>
	.months {
		display: flex;
		gap: 2px;
		border: 0;
		margin: 0;
		padding: 0;
		align-items: center;
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
	.all {
		margin-left: 0.25rem;
		font-size: 0.75rem;
	}
</style>
