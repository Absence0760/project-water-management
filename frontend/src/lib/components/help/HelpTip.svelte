<script lang="ts">
	// ⓘ toggletip for a field or term: <HelpTip key="node.damCapacityM3" />.
	// Keys are field keys or glossary ids from $lib/help/content (the full list
	// is helpFieldKeys()). A button, not a hover tooltip, so it works with the
	// keyboard and on touch: click/Enter/Space toggles, Escape closes and keeps
	// focus on the button, clicking or tabbing away closes. The text lives in a
	// polite live region so screen readers announce it when it opens.
	import { tick } from 'svelte';
	import { base } from '$app/paths';
	import { helpFor } from '$lib/help/content';

	let { key, label }: { key: string; label?: string } = $props();

	const entry = $derived(helpFor(key));
	let open = $state(false);
	let shift = $state(0);
	let root: HTMLSpanElement | undefined = $state();
	let button: HTMLButtonElement | undefined = $state();
	let bubble: HTMLSpanElement | undefined = $state();
	const bubbleId = `help-${Math.random().toString(36).slice(2, 9)}`;

	function close(refocus = false) {
		open = false;
		if (refocus) button?.focus();
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			// Don't let the Escape also close an enclosing dialog.
			e.stopPropagation();
			e.preventDefault();
			close(true);
		}
	}

	function onFocusOut(e: FocusEvent) {
		if (open && root && !root.contains(e.relatedTarget as Node | null)) open = false;
	}

	$effect(() => {
		if (!open) return;
		const onDoc = (e: PointerEvent) => {
			if (root && !root.contains(e.target as Node)) open = false;
		};
		document.addEventListener('pointerdown', onDoc);
		return () => document.removeEventListener('pointerdown', onDoc);
	});

	// Keep the bubble on screen (phones): nudge it back inside an 8 px margin.
	$effect(() => {
		if (!open) {
			shift = 0;
			return;
		}
		tick().then(() => {
			if (!bubble) return;
			const r = bubble.getBoundingClientRect();
			const margin = 8;
			const vw = document.documentElement.clientWidth;
			if (r.right > vw - margin) shift = vw - margin - r.right;
			else if (r.left < margin) shift = margin - r.left;
		});
	});
</script>

{#if entry}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<span class="helptip" bind:this={root} onkeydown={onKeydown} onfocusout={onFocusOut}>
		<button
			type="button"
			class="tip-btn"
			bind:this={button}
			aria-label={label ?? `About ${entry.term}`}
			aria-expanded={open}
			aria-controls={bubbleId}
			aria-describedby={open ? bubbleId : undefined}
			onclick={() => (open = !open)}
		>
			<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
				<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.4" />
				<circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
				<path d="M8 7.2v4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
			</svg>
		</button>
		<span id={bubbleId} class="live" role="status" aria-live="polite">
			{#if open}
				<span class="bubble" bind:this={bubble} style:--shift="{shift}px">
					<strong class="term">{entry.term}</strong>
					<span class="short">{entry.short}</span>
					{#if entry.units}<span class="units">Units: {entry.units}</span>{/if}
					<a class="more" href="{base}/help#{entry.id}">More in the glossary</a>
				</span>
			{/if}
		</span>
	</span>
{/if}

<style>
	.helptip {
		position: relative;
		display: inline-flex;
		vertical-align: middle;
	}
	/* 24×24 target (WCAG 2.2 SC 2.5.8) around a 16 px icon. */
	.tip-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.tip-btn:hover,
	.tip-btn[aria-expanded='true'] {
		color: var(--accent);
		background: var(--accent-soft);
	}
	.bubble {
		position: absolute;
		top: calc(100% + 6px);
		left: 50%;
		transform: translateX(calc(-50% + var(--shift, 0px)));
		z-index: 40;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		width: max-content;
		max-width: min(20rem, calc(100vw - 2 * var(--gutter)));
		padding: 0.6rem 0.75rem;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.14);
		font-size: 0.85rem;
		font-weight: 400;
		line-height: 1.4;
		text-align: left;
		white-space: normal;
		text-transform: none;
	}
	.term {
		font-weight: 600;
	}
	.units {
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	.more {
		font-size: 0.8rem;
		text-decoration: underline;
	}
</style>
