<script lang="ts">
	// "Setup complete ✓" in the Summary's section header, beside the rain pill
	// (docs/ui.md § Summary). Once every setup step is done the checklist leaves
	// the page; this pill opens its steps as a popover over the page instead, so
	// opening it never makes the page taller. The same pattern as the page's
	// rain-freshness pill (routes/projects/[id]/+page.svelte): a pill that opens
	// a list under it, closed by Escape (focus back on the pill) or a click
	// outside. A button with aria-expanded rather than <details>, so its state
	// is announced as a button's.
	import { progress, type ChecklistStep } from './checklist';
	import SetupSteps from './SetupSteps.svelte';

	let { steps, tabs }: { steps: ChecklistStep[]; tabs: readonly string[] } = $props();

	const id = $props.id();
	const prog = $derived(progress(steps));
	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();
	let button: HTMLButtonElement | undefined = $state();
	let pop: HTMLDivElement | undefined = $state();
	/** Sideways nudge (px) that keeps the popover inside the window whatever row the pill lands on. */
	let shift = $state(0);

	function keydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !open) return;
		e.preventDefault();
		e.stopPropagation();
		open = false;
		button?.focus();
	}

	$effect(() => {
		if (!open) return;
		const onDoc = (e: PointerEvent) => {
			if (root && !root.contains(e.target as Node)) open = false;
		};
		// Opens leftwards from the pill's right edge when that fits (the pill sits beside the title),
		// else rightwards from its left edge (it starts a wrapped row), else against the window's gutter.
		const fit = () => {
			if (!pop || !button) return;
			// Measure where it sits without the nudge: the one still applied (from the last open or
			// resize) is in the box, and resetting `shift` first wouldn't reach the DOM before this read.
			const r = pop.getBoundingClientRect();
			const natural = r.left - shift;
			const b = button.getBoundingClientRect();
			const gutter = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gutter')) || 16;
			const max = document.documentElement.clientWidth - gutter - r.width;
			let left = b.right - r.width;
			if (left < gutter) left = b.left <= max ? b.left : max;
			shift = Math.max(gutter, left) - natural;
		};
		fit();
		document.addEventListener('pointerdown', onDoc);
		window.addEventListener('resize', fit);
		return () => {
			document.removeEventListener('pointerdown', onDoc);
			window.removeEventListener('resize', fit);
		};
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="setup-pill" bind:this={root} onkeydown={keydown}>
	<button
		type="button"
		class="pill"
		bind:this={button}
		aria-expanded={open}
		aria-controls="{id}-pop"
		onclick={() => (open = !open)}
	>
		<svg class="tick" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="9" /><path d="m6 10.5 2.6 2.5L14 7.5" /></svg>
		Setup complete
	</button>
	<div class="pop" id="{id}-pop" bind:this={pop} hidden={!open} style:translate={shift ? `${shift}px 0` : null}>
		<p class="pop-h"><strong>Setup complete</strong> <span class="muted">· all {prog.total} steps done</span></p>
		<SetupSteps {steps} {tabs} compact />
	</div>
</div>

<style>
	.setup-pill {
		position: relative;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	/* The rain pill's shape (routes/projects/[id]/+page.svelte `.fresh summary`), in the success colour. */
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.3rem 0.6rem;
		border: 1px solid color-mix(in srgb, var(--success) 45%, var(--border));
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-2);
		font: inherit;
		min-height: 38px;
		cursor: pointer;
	}
	.pill:hover {
		background: var(--success-soft);
	}
	.pill[aria-expanded='true'] {
		background: var(--success-soft);
		color: var(--text);
	}
	.tick circle {
		fill: var(--success);
	}
	.tick path {
		fill: none;
		stroke: var(--success-soft);
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	/* Over the page (it never makes the page taller), under the pill, opening leftwards from its right edge. */
	.pop {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		z-index: 35;
		width: min(360px, calc(100vw - 2 * var(--gutter)));
		padding: 0.6rem 0.75rem 0.4rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.14);
		font-size: 0.9rem;
		color: var(--text);
	}
	.pop[hidden] {
		display: none;
	}
	.pop-h {
		margin: 0 0 0.2rem;
	}
	.pop-h .muted {
		font-size: 0.85rem;
	}
	/* In a narrow header the pills start their own row at the left (SectionHeader), so the list opens rightwards. */
	@container section-header (max-width: 640px) {
		.pop {
			left: 0;
			right: auto;
		}
		.pill {
			min-height: 44px;
		}
	}
</style>
