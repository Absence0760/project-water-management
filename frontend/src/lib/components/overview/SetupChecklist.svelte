<script lang="ts">
	// Guided setup for a catchment, on the Summary while there's work to do.
	// Once every step is done the Summary drops it for the "Setup complete"
	// pill in the section header (SetupPill), whose popover lists the steps.
	import { checklistMode, progress, type ChecklistStep } from './checklist';
	import SetupSteps from './SetupSteps.svelte';

	let {
		steps,
		tabs
	}: {
		steps: ChecklistStep[];
		/** The tabs this member is shown (SetupSteps links only to these). */
		tabs: readonly string[];
	} = $props();

	const prog = $derived(progress(steps));
	// While series/runs are loading and every step known so far is done, hold a
	// compact bar; a known gap opens the list at once (checklistMode).
	const mode = $derived(checklistMode(steps));
</script>

<section class="panel checklist" aria-labelledby="setup-h">
	{#if mode === 'checking'}
		<div class="compact" role="status">
			<h2 id="setup-h">Setup</h2>
			<span class="muted">Checking data and runs…</span>
		</div>
	{:else}
		<div class="panel-head">
			<h2 id="setup-h">Set up this catchment</h2>
			<span class="count">{prog.done} of {prog.total} done</span>
		</div>
		<div
			class="bar"
			role="progressbar"
			aria-label="Setup progress"
			aria-valuemin="0"
			aria-valuemax={prog.total}
			aria-valuenow={prog.done}
		>
			<span style="width: {(prog.done / prog.total) * 100}%"></span>
		</div>
		<SetupSteps {steps} {tabs} />
	{/if}
</section>

<style>
	.checklist .panel-head {
		margin-bottom: 0.5rem;
	}
	.count {
		font-size: 0.85rem;
		color: var(--text-2);
		font-variant-numeric: tabular-nums;
	}
	.bar {
		height: 6px;
		border-radius: 3px;
		background: var(--surface-sunken);
		overflow: hidden;
		margin-bottom: 0.75rem;
	}
	.bar span {
		display: block;
		height: 100%;
		background: var(--success);
		border-radius: 3px;
	}
	.compact {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
	}
	.compact h2 {
		margin: 0;
		font-size: 1rem;
	}
	.compact .muted {
		font-size: 0.85rem;
	}
</style>
