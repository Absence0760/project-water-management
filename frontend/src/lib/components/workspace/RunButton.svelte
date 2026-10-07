<script lang="ts">
	// The section header's Run model on every section but Runs & results (docs/ui.md
	// § Section header), for editors: last, after Add data. A run is named, so the
	// button doesn't run at once; it opens a small form under it with the Run label,
	// Run forecast (with forecast rain) and Run model, and says why a run can't start
	// yet (runs/runReady.ts, the same reasons Runs & results' run form gives). The
	// page runs it (saving unsaved edits first, with the person's say) and opens it
	// in Runs & results. The popover follows the Setup complete pill's pattern
	// (overview/SetupPill.svelte): a button with aria-expanded, Escape closes it and
	// returns focus, a click outside closes it, nudged to stay inside the window.
	import { tick } from 'svelte';
	import { afterNavigate } from '$app/navigation';

	let {
		missing,
		overAllocated,
		hasForecast,
		modelDirty,
		problems = 0,
		running,
		error = null,
		onrun
	}: {
		/** What a run still needs ('a network', 'a rainfall series'). */
		missing: string[];
		/** Why the flow shares stop a run, or null. */
		overAllocated: string | null;
		/** Forecast rain is stored, so Run forecast shows. */
		hasForecast: boolean;
		/** Unsaved edits: the run asks to save them first. */
		modelDirty: boolean;
		/** Problems that stop the unsaved edits being saved, so the run waits for them (saveBeforeRun). */
		problems?: number;
		/** A run the page started is going. */
		running: boolean;
		/** Why the last run the page started didn't start (also in the header's notice line). */
		error?: string | null;
		onrun: (label: string | undefined, forecast: boolean) => void | Promise<void>;
	} = $props();

	const id = $props.id();
	let open = $state(false);
	let label = $state('');
	let elapsed = $state(0);
	let root: HTMLDivElement | undefined = $state();
	let button: HTMLButtonElement | undefined = $state();
	let pop: HTMLDivElement | undefined = $state();
	let input: HTMLInputElement | undefined = $state();
	let shift = $state(0);

	const blocked = $derived(missing.length > 0 || !!overAllocated);
	// Its links (the network, rainfall data, settings) go to another section, where the same button
	// stays mounted: the form closes rather than sit over the page it opened.
	afterNavigate(() => (open = false));

	async function toggle() {
		open = !open;
		if (open) {
			await tick();
			input?.focus();
		}
	}
	function keydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !open) return;
		e.preventDefault();
		e.stopPropagation();
		open = false;
		button?.focus();
	}
	async function go(forecast: boolean) {
		if (running || blocked) return;
		await onrun(label.trim() || undefined, forecast);
	}
	function submit(e: SubmitEvent) {
		e.preventDefault();
		void go(false);
	}

	// Seconds since the run started, while it goes.
	$effect(() => {
		if (!running) return;
		elapsed = 0;
		const t0 = Date.now();
		const timer = setInterval(() => (elapsed = Math.floor((Date.now() - t0) / 1000)), 250);
		return () => clearInterval(timer);
	});

	$effect(() => {
		if (!open) return;
		const onDoc = (e: PointerEvent) => {
			// The confirm dialog (Save your changes and run?) is outside the popover; it doesn't close it.
			const t = e.target as Element | null;
			if (root && !root.contains(t) && !t?.closest?.('dialog')) open = false;
		};
		// Opens leftwards from the button's right edge, else against the window's gutter.
		const fit = () => {
			if (!pop || !button) return;
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
<div class="run-button" bind:this={root} onkeydown={keydown}>
	<button
		type="button"
		class="btn btn-primary toggle"
		bind:this={button}
		aria-expanded={open}
		aria-haspopup="dialog"
		aria-controls="{id}-pop"
		data-testid="header-run"
		onclick={toggle}
	>
		{#if running}<span class="spin" aria-hidden="true"></span>{:else}<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor" /></svg>{/if}
		{running ? 'Running model…' : 'Run model'}
	</button>
	<div class="pop" id="{id}-pop" role="dialog" aria-label="Run the model" bind:this={pop} hidden={!open} style:translate={shift ? `${shift}px 0` : null}>
		<form onsubmit={submit} aria-busy={running}>
			<label for="{id}-label">Run label <span class="muted">(optional)</span></label>
			<input id="{id}-label" bind:this={input} maxlength="200" placeholder="e.g. Baseline" bind:value={label} disabled={running} />
			<p class="note" id="{id}-note" role="status" aria-live="polite">
				{#if running}
					Simulating every day of the record for all nodes{elapsed >= 1 ? ` · ${elapsed} s` : ''}. It opens in Runs &amp; results when done.
				{:else if error}
					<span class="err">The run didn’t start: {error}</span>
				{:else if missing.length}
					<span class="warn">A run needs {missing.join(' and ')}. Set up the <a href="?tab=network">network</a> and upload <a href="?tab=series">rainfall data</a> first.</span>
				{:else if overAllocated}
					<span class="warn">The run can't start: {overAllocated}. See the <a href="?tab=network">network</a> or <a href="?tab=settings">settings</a>.</span>
				{:else if problems}
					<span class="warn">{problems === 1 ? 'One problem stops' : `${problems} problems stop`} your unsaved changes being saved: a run uses the saved model, so fix {problems === 1 ? 'it' : 'them'} first (the save bar lists {problems === 1 ? 'it' : 'them'}).</span>
				{:else if modelDirty}
					<span class="warn">You have unsaved changes: Run model asks to save them first, since a run uses the saved model.</span>
				{:else}
					Runs the saved network, crops, transfers, settings and time series, and opens the run in Runs &amp; results.
				{/if}
			</p>
			<div class="btns">
				{#if hasForecast}
					<button
						type="button"
						class="btn"
						disabled={running || blocked}
						aria-describedby="{id}-note"
						title="The record as an ordinary run, then the days after the last recorded rain on forecast rain, shown apart. Keeps one forecast run."
						onclick={() => go(true)}>Run forecast</button
					>
				{/if}
				<button type="submit" class="btn btn-primary" disabled={running || blocked} aria-describedby="{id}-note">Run model</button>
			</div>
		</form>
	</div>
</div>

<style>
	.run-button {
		position: relative;
		display: flex;
	}
	.toggle {
		gap: 0.4rem;
		white-space: nowrap;
	}
	.pop {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		z-index: 35;
		width: min(340px, calc(100vw - 2 * var(--gutter)));
		padding: 0.75rem;
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
	form {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	label {
		font-size: 0.85rem;
		font-weight: 600;
		margin: 0;
	}
	label .muted {
		font-weight: 400;
	}
	input {
		width: 100%;
		min-height: 38px;
	}
	.note {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.warn {
		color: var(--warning);
		font-weight: 500;
	}
	.err {
		color: var(--danger);
		font-weight: 500;
	}
	.btns {
		display: flex;
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.spin {
		width: 12px;
		height: 12px;
		border: 2px solid currentColor;
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spin {
			animation-duration: 3s;
		}
	}
	/* In a narrow header the button fills its share of the main box's row; fit() keeps the form on the screen. */
	@container section-header (max-width: 640px) {
		.toggle {
			flex: 1 1 auto;
			justify-content: center;
		}
		input,
		.btns .btn {
			min-height: 44px;
		}
	}
</style>
