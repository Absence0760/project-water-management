<script lang="ts">
	// Twelve toggle checkboxes in water-year order, bound to calendar months 1–12,
	// each named by its month (Oct, Nov …), with All months / No months straight
	// after them (named "<label>: all months" for a screen reader) and the months
	// in words (`summary`) on a line under them. Each toggle is at least 24 × 24 px
	// (WCAG 2.5.8); in a narrow column or on a touch screen they wrap to two rows
	// of six at the 44 px tap size.
	import { monthName, WATER_YEAR_CALENDAR } from '#lib/format/months.js';

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
	<!-- The months as Allocations' licence-condition months show them (issue #521): each named in full (Oct, Nov …),
	     a 24 px row, with All months straight after them rather than at the far edge. -->
	<div class="picker">
		<div class="row">
			<div class="toggles">
				{#each WATER_YEAR_CALENDAR as m (m)}
					<label class:on={months.includes(m)}>
						<input
							type="checkbox"
							checked={months.includes(m)}
							{disabled}
							onchange={(e) => toggle(m, e.currentTarget.checked)}
						/>
						{monthName(m)}
					</label>
				{/each}
			</div>
			{#if !disabled}
				<button
					type="button"
					class="btn btn-sm btn-ghost all"
					aria-label="{label}: {months.length === 12 ? 'no months' : 'all months'}"
					onclick={() => (months = months.length === 12 ? [] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])}
				>
					{months.length === 12 ? 'No months' : 'All months'}
				</button>
			{/if}
		</div>
	</div>
	{#if summary}<p class="summary muted">{summary}</p>{/if}
</fieldset>

<style>
	.months {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	/* The toggles' own width decides the layout (a container, so a narrow column wraps them, not the window). */
	.picker {
		container: months / inline-size;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem 0.75rem;
	}
	.toggles {
		display: flex;
		gap: 4px;
	}
	label {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		min-width: 2.4rem;
		min-height: 24px;
		height: 1.5rem;
		padding: 0 0.3rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-size: var(--font-sm);
		color: var(--text-2);
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
	/* Over the whole toggle, its 1 px border too, so the control itself is the 24 px target (not 2 px short of it). */
	input {
		position: absolute;
		opacity: 0;
		inset: -1px;
		width: calc(100% + 2px);
		height: calc(100% + 2px);
		/* app.css caps every control at its box (max-width: 100%), which would undo the 2 px. */
		max-width: none;
		margin: 0;
		cursor: pointer;
	}
	input:disabled {
		cursor: default;
	}
	/* Twelve toggles (2.4rem, 33.6 px at the 14 px root) and their gaps need about 33rem: narrower, or on a touch
	   screen, two rows of six at the tap size (44 px), All months under them. */
	@container months (max-width: 33rem) {
		.toggles {
			display: grid;
			grid-template-columns: repeat(6, minmax(var(--tap), 1fr));
			flex: 1 1 100%;
		}
		label {
			height: var(--tap);
		}
	}
	@media (pointer: coarse) {
		.toggles {
			display: grid;
			grid-template-columns: repeat(6, minmax(var(--tap), var(--tap)));
		}
		label {
			height: var(--tap);
		}
	}
	.summary {
		font-size: var(--font-xs);
		margin: 0.2rem 0 0;
	}
	.all {
		font-size: var(--font-xs);
		min-height: 24px;
		padding: 0 0.4rem;
	}
</style>
