<script lang="ts">
	// Guided setup for a catchment. Open while there's work to do; once every
	// step is done it collapses to a one-line summary (expandable).
	import { nextStep, progress, type ChecklistStep, type StepStatus } from './checklist';

	let {
		steps,
		tabs
	}: {
		steps: ChecklistStep[];
		/**
		 * The tabs this member is shown (`visibleTabs`, lib/workspace/tabs.ts).
		 * A step whose tab is hidden keeps its status but isn't a link, so the
		 * checklist never points into a tab the strip doesn't show.
		 */
		tabs: readonly string[];
	} = $props();

	const prog = $derived(progress(steps));
	const next = $derived(nextStep(steps));
	// While series/runs are loading, decide from the steps we already know:
	// if any of those still needs work the list will end up open, so open it
	// now; otherwise hold a compact bar the same height as "Setup complete".
	// Either way the first frame has the final shape: never open-then-collapse.
	const checking = $derived(steps.some((s) => s.status === 'unknown'));
	const knownGap = $derived(
		steps.some((s) => s.status !== 'unknown' && s.status !== 'done' && !(s.optional && s.status === 'partial'))
	);
	const mode = $derived(prog.complete ? 'complete' : checking && !knownGap ? 'checking' : 'open');
	const STATUS: Record<StepStatus, string> = {
		done: 'Done',
		partial: 'Needs a look',
		todo: 'To do',
		unknown: 'Checking'
	};
</script>

{#snippet list()}
	<ol class="steps">
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
{/snippet}

<section class="panel checklist" aria-labelledby="setup-h">
	{#if mode === 'checking'}
		<div class="compact" role="status">
			<h2 id="setup-h">Setup</h2>
			<span class="muted">Checking data and runs…</span>
		</div>
	{:else if mode === 'complete'}
		<details>
			<summary>
				<h2 id="setup-h">Setup complete</h2>
				<span class="muted">All {prog.total} steps done. Show checklist</span>
			</summary>
			{@render list()}
		</details>
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
		{@render list()}
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
	.compact,
	details summary {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		cursor: pointer;
		list-style: none;
	}
	details summary::-webkit-details-marker {
		display: none;
	}
	details summary::before {
		content: '▸';
		color: var(--text-muted);
	}
	details[open] summary::before {
		content: '▾';
	}
	.compact {
		cursor: default;
	}
	.compact::before {
		content: '▸';
		visibility: hidden;
	}
	.compact h2,
	details summary h2 {
		margin: 0;
		font-size: 1rem;
	}
	.compact .muted,
	details summary .muted {
		font-size: 0.85rem;
	}
	details[open] .steps {
		margin-top: 0.75rem;
	}
	@media (max-width: 1200px) {
		.steps {
			grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		}
	}
</style>
