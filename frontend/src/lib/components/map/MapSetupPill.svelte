<!--
	"Getting started · 1 of 2" in the Map's section header (docs/ui.md § Map,
	mapSetup.ts): the map's setup steps (the catchment boundary, then a rain
	feed reading it), which until 2026-10-02 stacked as full-width lines above
	the map. The Summary's Setup pill's pattern (overview/SetupPill.svelte, the
	page's rain pill's): a button with `aria-expanded` that opens the steps
	over the page, so opening it never moves the map; Escape closes it and
	puts the focus back on the pill, a click outside closes it, and it is
	nudged to stay inside the window. Each step left to do carries its way in.
	It goes once every step is done.
-->
<script lang="ts">
	import { setupCount, type MapSetupStep } from './mapSetup';

	let {
		steps,
		rainLink,
		uploadHref,
		ondrawboundary
	}: {
		steps: MapSetupStep[];
		/** The rain step's link and its words (MapRainLink's state), or null when the step has none yet. */
		rainLink: { href: string; text: string } | null;
		uploadHref: string;
		/** Draw the boundary (null while a shape is already being drawn). */
		ondrawboundary: (() => void) | null;
	} = $props();

	const id = $props.id();
	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();
	let button: HTMLButtonElement | undefined = $state();
	let pop: HTMLDivElement | undefined = $state();
	let shift = $state(0);

	function keydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !open) return;
		e.preventDefault();
		e.stopPropagation();
		open = false;
		button?.focus();
	}
	function draw() {
		open = false;
		ondrawboundary?.();
	}

	$effect(() => {
		if (!open) return;
		const onDoc = (e: PointerEvent) => {
			if (root && !root.contains(e.target as Node)) open = false;
		};
		// The pill starts the header's row of controls, so the list opens rightwards from its left edge (over the page, not the
		// sidebar) when that fits, else leftwards from its right edge, else against the window's gutter (SetupPill's nudge).
		const fit = () => {
			if (!pop || !button) return;
			const r = pop.getBoundingClientRect();
			const natural = r.left - shift;
			const b = button.getBoundingClientRect();
			const gutter = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gutter')) || 16;
			const max = document.documentElement.clientWidth - gutter - r.width;
			let left = b.left <= max ? b.left : b.right - r.width;
			if (left < gutter) left = max;
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
<div class="setup-pill" bind:this={root} onkeydown={keydown} data-testid="map-setup">
	<button type="button" class="pill" bind:this={button} aria-expanded={open} aria-controls="{id}-pop" onclick={() => (open = !open)} data-testid="map-setup-pill">
		<svg class="ring" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8" /><path d="M10 2a8 8 0 0 1 0 16" /></svg>
		Getting started <span class="count">· {setupCount(steps)}</span>
	</button>
	<!-- The steps are drawn only while open: closed, the header holds no hidden controls (a check over its buttons' row reads only what shows). -->
	<div class="pop" id="{id}-pop" bind:this={pop} hidden={!open} style:translate={shift ? `${shift}px 0` : null}>
		{#if open}
		<p class="pop-h"><strong>Getting started</strong> <span class="muted">· {setupCount(steps)} done</span></p>
		<ol class="steps">
			{#each steps as s, i (s.id)}
				<li class="step" class:done={s.done} data-step={s.id} data-done={s.done ? 'true' : 'false'}>
					<span class="icon" aria-hidden="true">
						{#if s.done}
							<svg viewBox="0 0 20 20" width="20" height="20"><circle cx="10" cy="10" r="9" /><path d="m6 10.5 2.6 2.5L14 7.5" /></svg>
						{:else}
							<svg viewBox="0 0 20 20" width="20" height="20"><circle cx="10" cy="10" r="8.25" /><text x="10" y="14">{i + 1}</text></svg>
						{/if}
					</span>
					<div class="body">
						<p class="title">{s.title}<span class="visually-hidden">: {s.done ? 'Done' : 'To do'}.</span></p>
						<p class="detail">{s.detail}</p>
						{#if !s.done && s.id === 'boundary'}
							<p class="ways">
								{#if ondrawboundary}<button type="button" class="btn btn-sm btn-primary" onclick={draw} data-testid="map-setup-draw-boundary">Draw the boundary</button>{/if}
								<a class="btn btn-sm" href={uploadHref}>Upload a GeoJSON file</a>
							</p>
						{:else if !s.done && s.id === 'rain' && rainLink}
							<p class="ways"><a href={rainLink.href} data-testid="map-rain-link">{rainLink.text}</a></p>
						{/if}
					</div>
				</li>
			{/each}
		</ol>
		{/if}
	</div>
</div>

<style>
	.setup-pill {
		position: relative;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	/* The rain pill's shape, in the accent: a step to do, not a warning. */
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.3rem 0.6rem;
		border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-2);
		font: inherit;
		min-height: 38px;
		cursor: pointer;
		white-space: nowrap;
	}
	.pill:hover,
	.pill[aria-expanded='true'] {
		background: var(--accent-soft);
		color: var(--text);
	}
	.count {
		color: var(--text-muted);
	}
	.ring circle {
		fill: none;
		stroke: var(--border-strong);
		stroke-width: 2.4;
	}
	.ring path {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2.4;
	}
	.pop {
		position: absolute;
		left: 0;
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
	.steps {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.step {
		display: flex;
		gap: 0.6rem;
		padding: 0.5rem 0.15rem;
	}
	.step + .step {
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
	.step:not(.done) .icon circle {
		fill: none;
		stroke: var(--text-muted);
		stroke-width: 1.6;
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
		margin: 0;
		font-weight: 600;
	}
	.detail {
		margin: 0.2rem 0 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.ways {
		margin: 0.4rem 0 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	@container section-header (max-width: 640px) {
		.pill {
			min-height: 44px;
		}
	}
</style>
