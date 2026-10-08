<script module lang="ts">
	// The tips' text ($lib/help/tips: term, short text, units, field keys) is
	// its own chunk, fetched when the first HelpTip module loads instead of
	// bundled into every page with a tooltip, so it never delays a page's first
	// render. Only the tips: the glossary's long text ($lib/help/articles) is
	// for the /help pages (lib/help/content.test.ts keeps it out of here).
	// Shared by every HelpTip; a failed fetch is forgotten so the next mount
	// retries.
	import type { HelpTipText } from '$lib/help/types';

	let help: Promise<(key: string) => HelpTipText | undefined> | undefined;
	function loadHelp() {
		help ??= import('$lib/help/tips').then(
			(m) => m.tipFor,
			(err: unknown) => {
				help = undefined;
				throw err;
			}
		);
		return help;
	}
	loadHelp().catch(() => {});
</script>

<script lang="ts">
	// ⓘ toggletip for a field or term: <HelpTip key="node.damCapacityM3" />.
	// Keys are field keys or glossary ids from $lib/help/tips (the full list
	// is helpFieldKeys()); the text loads on demand (see the module script).
	// A button, not a hover tooltip, so it works with the keyboard and on touch:
	// click/Enter/Space toggles, Escape closes and keeps focus on the button,
	// clicking or tabbing away closes. The text lives in a polite live region
	// so screen readers announce it when it opens: aria-live alone, not
	// role="status", since a status is a page's own message ("Saved."), and
	// every form with a tip would otherwise hold a second, empty one beside it.
	//
	// The bubble is a manual popover, so it renders in the browser's top layer:
	// no scroll container (tables scroll sideways) can clip it and no sticky
	// header can paint over it. It is placed with fixed coordinates from the
	// button's rect, below it or above when there's no room, and follows it on
	// scroll and resize.
	import { tick } from 'svelte';
	import { base } from '$app/paths';
	import { glossaryPath } from '$lib/help/glossaryLinks';
	import { SHOTS, TIP_PICTURES, pictureSrc } from '$lib/help/pictures';

	let { key, label }: { key: string; label?: string } = $props();

	// Until the help text arrives the tip renders nothing, as for an unknown key.
	let tipFor = $state<((key: string) => HelpTipText | undefined) | null>(null);
	loadHelp().then(
		(fn) => (tipFor = fn),
		() => {}
	);
	const entry = $derived(tipFor?.(key));
	// A close-up of that part of the help illustration, for terms that have
	// one, with a ring on the term's own feature. Decorative (alt=""): the
	// bubble is a live region, and its text already says what the picture shows.
	const picture = $derived(entry ? TIP_PICTURES[entry.id] : undefined);
	const shot = $derived(picture?.shot);
	const ring = $derived(picture?.spot && shot ? SHOTS[shot].spots[picture.spot] : undefined);
	let open = $state(false);
	let pos = $state({ top: 0, left: 0 });
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

	// Show it in the top layer and keep it next to the button, on screen.
	function place() {
		if (!button || !bubble) return;
		const b = button.getBoundingClientRect();
		const w = bubble.offsetWidth;
		const h = bubble.offsetHeight;
		const margin = 8;
		const gap = 6;
		const vw = document.documentElement.clientWidth;
		const vh = document.documentElement.clientHeight;
		const left = Math.min(Math.max(b.left + b.width / 2 - w / 2, margin), Math.max(vw - margin - w, margin));
		const below = b.bottom + gap;
		const top = below + h > vh - margin && b.top - gap - h >= margin ? b.top - gap - h : below;
		pos = { top, left };
	}

	$effect(() => {
		if (!open) return;
		let alive = true;
		tick().then(() => {
			if (!alive || !bubble) return;
			bubble.showPopover();
			place();
		});
		window.addEventListener('scroll', place, true);
		window.addEventListener('resize', place);
		return () => {
			alive = false;
			window.removeEventListener('scroll', place, true);
			window.removeEventListener('resize', place);
		};
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
		<span id={bubbleId} class="live" aria-live="polite">
			{#if open}
				<span class="bubble" class:pictured={shot} popover="manual" bind:this={bubble} style:top="{pos.top}px" style:left="{pos.left}px">
					{#if shot}
						<span class="pic">
							<img
								src="{base}{pictureSrc(shot, SHOTS[shot].width / 2)}"
								width={SHOTS[shot].width / 2}
								height={SHOTS[shot].height / 2}
								alt=""
							/>
							{#if ring}<span class="ring" aria-hidden="true" style:left="{ring.x}%" style:top="{ring.y}%"></span>{/if}
						</span>
					{/if}
					<strong class="term">{entry.term}</strong>
					<span class="short">{entry.short}</span>
					{#if entry.units}<span class="units">Units: {entry.units}</span>{/if}
					<a class="more" href="{base}{glossaryPath(entry)}">More in the glossary</a>
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
		position: fixed;
		inset: auto;
		margin: 0;
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
	/* With a picture: a fixed width, so the picture and text wrap to it. */
	.bubble.pictured {
		width: min(20rem, calc(100vw - 2 * var(--gutter)));
	}
	.pic {
		position: relative;
		display: block;
		width: calc(100% + 1.5rem);
		margin: -0.6rem -0.75rem 0.2rem;
		border-radius: var(--radius) var(--radius) 0 0;
		border-bottom: 1px solid var(--border);
		overflow: hidden;
	}
	.pic img {
		display: block;
		width: 100%;
		max-width: none;
		height: auto;
	}
	/* The term's own feature on the picture: a ring that reads on light and dark
	   scenery (white stroke over a dark halo). */
	.ring {
		position: absolute;
		width: 2rem;
		height: 2rem;
		transform: translate(-50%, -50%);
		border: 3px solid #fff;
		border-radius: 50%;
		box-shadow:
			0 0 0 2px rgb(0 0 0 / 0.55),
			inset 0 0 0 2px rgb(0 0 0 / 0.35);
		animation: ring-in 0.5s ease-out;
	}
	@keyframes ring-in {
		from {
			transform: translate(-50%, -50%) scale(1.8);
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.ring {
			animation: none;
		}
	}
	/* Author styles beat the UA's popover hiding rule, so restate it. */
	.bubble:not(:popover-open) {
		display: none;
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
