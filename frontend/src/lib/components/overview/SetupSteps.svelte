<script lang="ts">
	// The setup checklist's steps: in the page's checklist (SetupChecklist, five
	// columns wide) and, once setup is complete, in the header pill's popover
	// (SetupPill, one compact column).
	import { nextStep, type ChecklistStep, type StepStatus } from './checklist';

	let {
		steps,
		tabs,
		compact = false
	}: {
		steps: ChecklistStep[];
		/**
		 * The tabs this member is shown (`visibleTabs`, lib/workspace/tabs.ts).
		 * A step whose tab is hidden keeps its status but isn't a link, so the
		 * checklist never points into a tab the strip doesn't show.
		 */
		tabs: readonly string[];
		/** One column of rows with no boxes around them (the popover). */
		compact?: boolean;
	} = $props();

	const next = $derived(nextStep(steps));
	const STATUS: Record<StepStatus, string> = {
		done: 'Done',
		partial: 'Needs a look',
		todo: 'To do',
		unknown: 'Checking'
	};
</script>

<ol class="steps" class:compact>
	{#each steps as s, i (s.id)}
		<li class="step {s.status}" class:next={next?.id === s.id}>
			<span class="icon" aria-hidden="true">
				{#if s.status === 'done'}
					<svg viewBox="0 0 20 20" width="20" height="20"><circle cx="10" cy="10" r="9" /><path d="m6 10.5 2.6 2.5L14 7.5" /></svg>
				{:else if s.status === 'partial'}
					<svg viewBox="0 0 20 20" width="20" height="20"><circle cx="10" cy="10" r="8.25" /><path d="M10 1.75a8.25 8.25 0 0 1 0 16.5z" /></svg>
				{:else}
					<svg viewBox="0 0 20 20" width="20" height="20"><circle cx="10" cy="10" r="8.25" /><text x="10" y="14">{i + 1}</text></svg>
				{/if}
			</span>
			<div class="body">
				<div class="title">
					{#if tabs.includes(s.tab)}<a href="?tab={s.tab}">{s.title}</a>{:else}<span>{s.title}</span>{/if}
					<span class="visually-hidden">: {STATUS[s.status]}.</span>
					{#if s.optional && s.status !== 'done'}<span class="opt">optional</span>{/if}
					{#if next?.id === s.id}<span class="badge badge-owner">Next</span>{/if}
				</div>
				<p>{s.detail}</p>
			</div>
		</li>
	{/each}
</ol>

<style>
	.steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 0.6rem;
	}
	.step {
		display: flex;
		gap: 0.6rem;
		padding: 0.7rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
	}
	.step.next {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	/* The popover: one column, each step a row divided by a rule rather than a box of its own. */
	.steps.compact {
		grid-template-columns: minmax(0, 1fr);
		gap: 0;
	}
	.compact .step {
		padding: 0.5rem 0.15rem;
		border: 0;
		border-radius: 0;
		background: none;
	}
	.compact .step + .step {
		border-top: 1px solid var(--border);
	}
	.icon {
		flex: none;
		line-height: 0;
		margin-top: 1px;
	}
	.icon svg {
		overflow: visible;
	}
	.done .icon circle {
		fill: var(--success);
	}
	.done .icon path {
		fill: none;
		stroke: var(--success-soft);
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.partial .icon circle {
		fill: none;
		stroke: var(--warning);
		stroke-width: 1.6;
	}
	.partial .icon path {
		fill: var(--warning);
	}
	.todo .icon circle,
	.unknown .icon circle {
		fill: none;
		stroke: var(--text-muted);
		stroke-width: 1.6;
	}
	.unknown .icon circle {
		stroke-dasharray: 3 3;
	}
	.icon text {
		fill: var(--text-2);
		font-size: 11px;
		font-weight: 700;
		text-anchor: middle;
		font-family: var(--font-sans);
	}
	.body {
		min-width: 0;
	}
	.title {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.35rem;
		font-weight: 600;
	}
	.title a {
		color: var(--text);
		text-decoration: underline;
		text-decoration-color: var(--border-strong);
		text-underline-offset: 3px;
	}
	.title a:hover {
		color: var(--accent);
		text-decoration-color: currentColor;
	}
	.opt {
		font-size: 0.72rem;
		font-weight: 500;
		color: var(--text-muted);
	}
	.step p {
		margin: 0.2rem 0 0;
		font-size: 0.8rem;
		color: var(--text-2);
	}
	@media (max-width: 1200px) {
		.steps:not(.compact) {
			grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		}
	}
</style>
