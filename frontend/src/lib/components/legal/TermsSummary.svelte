<!-- i18n-section: terms-summary -->
<script lang="ts">
	// The main points of the terms of use, in a bordered box (termsSummary.ts),
	// in the reader's language: above the sign-up button and on the
	// re-acceptance notice. The Terms themselves stay English, which the last
	// line says whenever the page is in another language.
	//
	// `contained` (the sign-up form, issue #162): the points sit in their own
	// scroll box under the heading, so the form fits the window instead of the
	// page scrolling. It gives up height only when it has to: on a wide screen
	// the sign-up card (AuthCard `fit`) lets it grow to its full height when the
	// window has room, and shrinks it to fit when it hasn't; on a phone it is at
	// most 12rem. While the points overflow, the box is a focusable, named group
	// (the app's scroll-region watcher, $lib/a11y/scrollRegions), so the arrow
	// keys scroll it; a fade at its foot says there is more below, and a
	// "Read the full terms" link sits beside the heading, always in view.
	import { i18n, t } from '$lib/i18n/locale.svelte';
	import { SUMMARY_LANGUAGE_NOTE, SUMMARY_POINTS, SUMMARY_TITLE } from './termsSummary';

	let {
		id = 'terms-summary',
		contained = false,
		termsHref = '/terms'
	}: {
		id?: string;
		contained?: boolean;
		/** The Terms page ("Read the full terms", when contained): the caller's `{base}/terms`. */
		termsHref?: string;
	} = $props();

	let scroller: HTMLDivElement | undefined = $state();
	/** Points below the box's foot: shows the fade. */
	let more = $state(false);
	const measure = () => {
		if (scroller) more = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 1;
	};
	$effect(() => {
		if (!scroller) return;
		const sizes = new ResizeObserver(measure);
		sizes.observe(scroller);
		if (scroller.firstElementChild) sizes.observe(scroller.firstElementChild);
		measure();
		return () => sizes.disconnect();
	});
</script>

{#snippet points()}
	<ul>
		{#each SUMMARY_POINTS as point (point)}<li>{t(point)}</li>{/each}
	</ul>
	{#if i18n.locale !== 'en'}<p class="lang">{t(SUMMARY_LANGUAGE_NOTE)}</p>{/if}
{/snippet}

<section class="summary" class:contained class:fit-shrink={contained} aria-labelledby="{id}-h" data-terms-summary>
	{#if contained}
		<div class="head">
			<h2 id="{id}-h">{t(SUMMARY_TITLE)}</h2>
			<a class="full" href={termsHref}>{t('Read the full terms')}</a>
		</div>
		<div class="scroll-wrap" class:more>
			<div class="scroll" data-scroll-region bind:this={scroller} onscroll={measure}>
				{@render points()}
			</div>
		</div>
	{:else}
		<h2 id="{id}-h">{t(SUMMARY_TITLE)}</h2>
		{@render points()}
	{/if}
</section>

<style>
	.summary {
		margin: 0 0 0.75rem;
		padding: 0.75rem 0.9rem;
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent);
		border-radius: var(--radius);
		background: var(--surface);
		font-size: 1rem;
		color: var(--text);
	}
	h2 {
		margin: 0 0 0.35rem;
		font-size: 1rem;
		font-weight: 600;
	}
	ul {
		margin: 0;
		padding-left: 1.1rem;
	}
	li + li {
		margin-top: 0.3rem;
	}
	.lang {
		margin: 0.5rem 0 0;
		font-size: 1rem;
		color: var(--text-2);
	}
	/* Contained: the heading with the link beside it (under it when they don't
	   fit one line), then the points' scroll box, the only part that shrinks. */
	.contained {
		display: flex;
		flex-direction: column;
		/* Never shorter than the heading and about three lines of points: they stay readable in place. */
		min-height: 7.5rem;
	}
	.head {
		flex: none;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0 1rem;
		margin: 0 0 0.35rem;
	}
	.head h2 {
		margin: 0;
	}
	.scroll-wrap {
		position: relative;
		display: flex;
		flex-direction: column;
		flex: 0 1 auto;
		min-height: 0;
	}
	.scroll {
		flex: 0 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		/* Room for the focus ring inside the box's border. */
		padding: 2px 4px 2px 2px;
		margin: -2px -4px -2px -2px;
	}
	/* The scroll cue: the last line fades into the box while there is more below. */
	.scroll-wrap::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 2.25rem;
		background: linear-gradient(to bottom, transparent, var(--surface));
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.15s;
	}
	.scroll-wrap.more::after {
		opacity: 1;
	}
	@media (prefers-reduced-motion: reduce) {
		.scroll-wrap::after {
			transition: none;
		}
	}
	.full {
		text-decoration: underline;
	}
	@media (max-width: 900px) {
		.scroll {
			max-height: 12rem;
		}
	}
</style>
