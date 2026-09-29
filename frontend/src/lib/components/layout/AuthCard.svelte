<!-- i18n-section: auth -->
<script lang="ts" module>
	import { tick } from 'svelte';

	/**
	 * Focus the card's title once the page has swapped its content for another
	 * state ("Check your email", "Your password has been changed"…): the
	 * control that was focused (the submit button) is gone, and focus would
	 * otherwise fall back to the page's start.
	 */
	export async function focusAuthTitle(): Promise<void> {
		await tick();
		document.querySelector<HTMLElement>('.auth h1')?.focus();
	}
</script>

<script lang="ts">
	// Split sign-in / register layout: a navy brand panel with the catchment
	// illustration on the left (a short band on phones), the form on the right.
	// The language switch (WP-2.5) sits above the form: the sign-in pages are
	// the first thing an invited farmer sees.
	import type { Snippet } from 'svelte';
	import { base } from '$app/paths';
	import LanguageSwitch from '$lib/i18n/LanguageSwitch.svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import BrandMark from './BrandMark.svelte';
	import CatchmentScene from './CatchmentScene.svelte';

	let {
		title,
		subtitle,
		children,
		footer,
		legal = true,
		fit = false
	}: {
		title: string;
		subtitle?: string;
		children: Snippet;
		footer?: Snippet;
		/** The Privacy notice and Terms of use links under the form; the sign-up page names them in its own sentence instead. */
		legal?: boolean;
		/**
		 * On a wide screen, fit the card to the window instead of letting the page
		 * scroll: the form is a column whose `.fit-shrink` element (the sign-up
		 * form's contained terms summary) gives up height first. Past its own
		 * minimum the page scrolls after all. Phones scroll the page as usual.
		 */
		fit?: boolean;
	} = $props();
</script>

<div class="auth" class:fit>

	<main class="side-form">
		<div class="form-box">
			<div class="top">
				<!-- Home: the landing page signed out, the projects signed in. -->
				<a class="lockup" href="{base}/" aria-label={t('Water Management, home')}>
					<BrandMark size={40} />
					<span>Water Management</span>
				</a>
				<LanguageSwitch compact />
			</div>
			<!-- tabindex -1: focusAuthTitle moves focus here when the page changes state. -->
			<h1 class:solo={!subtitle} tabindex="-1">{title}</h1>
			{#if subtitle}<p class="muted intro">{subtitle}</p>{/if}
			{@render children()}
			{#if footer}<div class="footer">{@render footer()}</div>{/if}
			{#if legal}
				<nav class="legal" aria-label={t('Legal')}>
					<a href="{base}/privacy">{t('Privacy notice')}</a>
					<a href="{base}/terms">{t('Terms of use')}</a>
				</nav>
			{/if}
		</div>
	</main>

	<!-- After the form in the DOM so the page's h1 comes first; shown on the left. -->
	<aside class="panel-brand" aria-label={t('About Water Management')}>
		<div class="art"><CatchmentScene /></div>
		<div class="copy">
			<p class="kicker">Water Management</p>
			<h2>{t('Catchment water balance, from rainfall to river.')}</h2>
			<ul>
				<li>{t('Model hydrological units, dams and transfers on a river network.')}</li>
				<li>{t('Run decades of daily flows in seconds.')}</li>
				<li>{t('Check the environmental flow requirement (EWR) against every hydrological unit’s use.')}</li>
			</ul>
		</div>
	</aside>
</div>

<style>
	/* The reserved scrollbar gutter (app.css) takes the root background:
	   match the form side so it doesn't show as a strip. */
	:global(html:has(.auth)) {
		background: var(--surface);
	}
	.auth {
		display: grid;
		grid-template-columns: minmax(0, 55fr) minmax(0, 45fr);
		min-height: 100vh;
		min-height: 100dvh;
	}
	.panel-brand {
		order: -1;
		overflow: hidden;
		background: #102a43;
		color: #d9e6f2;
		/* Keep the panel from pushing the form below the fold. */
		max-height: 100dvh;
		position: sticky;
		top: 0;
	}
	.art {
		position: absolute;
		inset: 0;
		/* The landing page's diorama carries the same name: Sign in there morphs it into this scene (landing/Hero.svelte). */
		view-transition-name: catchment-scene;
	}
	.copy {
		position: relative;
		max-width: 30rem;
		padding: clamp(1.5rem, 4vh, 4rem) clamp(1.5rem, 5vw, 4rem);
	}
	.kicker {
		margin: 0 0 0.75rem;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 1rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: #36c6e0;
	}
	.copy h2 {
		font-family: var(--font-display);
		font-size: clamp(1.6rem, 2.6vw, 2.25rem);
		line-height: 1.15;
		letter-spacing: -0.015em;
		color: #ffffff;
		margin: 0 0 1.25rem;
	}
	.copy ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.6rem;
		font-size: 1rem;
		color: #c5d3e1;
	}
	.copy li {
		position: relative;
		padding-left: 1.4rem;
	}
	.copy li::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0.45em;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #36c6e0;
	}
	/* The form starts on the brand copy's top line rather than centred, so the
	   title sits in the same place on every sign-in page and doesn't jump when
	   a message appears above the form (a wrong password, a sent link). */
	.side-form {
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: clamp(1.5rem, 4vh, 4rem) var(--gutter) 2.5rem;
		background: var(--surface);
	}
	.form-box {
		width: 100%;
		max-width: 380px;
	}
	.top {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		/* 1.5rem (was 2rem) and the 4vh top (was 6vh), issue #162: room for the sign-up form on a laptop's window. */
		margin-bottom: 1.5rem;
	}
	.lockup {
		text-decoration: none;
		border-radius: var(--radius);
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 1.35rem;
		letter-spacing: -0.01em;
		color: var(--brand-navy);
	}
	h1 {
		font-size: 1.75rem;
		margin-bottom: 0.35rem;
	}
	.intro {
		margin-bottom: 1.5rem;
	}
	/* No subtitle: keep the same gap before the first message or field. */
	h1.solo {
		margin-bottom: 1.25rem;
	}
	.form-box :global(form) {
		margin-top: 1.25rem;
	}
	.form-box :global(.field > input),
	.form-box :global(.pw input) {
		width: 100%;
		min-height: 42px;
		padding: 0.5rem 0.7rem;
		font-size: 1rem;
	}
	/* Inside the password field's own box (PasswordInput draws the border): the same 42 px overall. */
	.form-box :global(.pw input) {
		min-height: 40px;
	}
	.form-box :global(.field) {
		margin-bottom: 1rem;
	}
	/* The sign-in pages' small-text floor is 14 px (1rem of the 14 px root):
	   the app's own field labels (0.85rem) and hints (0.8rem) were 11–12 px on
	   the first screen a reduced-vision farmer meets. auth-pages.spec.ts
	   measures every visible text on these pages. */
	.form-box :global(.field > label),
	.form-box :global(.field > .label),
	.form-box :global(.hint) {
		font-size: 1rem;
	}
	/* Every action is a full-width button under the form (not the demo's small one). */
	.form-box :global(.btn:not(.btn-sm)) {
		width: 100%;
		justify-content: center;
		/* Long words (an address in "Sign out and accept as …", Afrikaans) wrap inside it. */
		white-space: normal;
		overflow-wrap: anywhere;
		text-align: center;
		min-height: 44px;
		margin-top: 0.5rem;
		font-size: 1rem;
	}
	.footer {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
		font-size: 1rem;
		color: var(--text-2);
	}
	.legal {
		display: flex;
		/* At 14 px, Afrikaans' two long words don't fit one 320 px row. */
		flex-wrap: wrap;
		gap: 0.25rem 1.25rem;
		margin-top: 0.75rem;
		font-size: 1rem;
	}
	.legal a {
		color: var(--text-muted);
		text-decoration: underline;
	}
	/* Sits in running text: underline so it isn't told apart by colour alone. */
	.footer :global(a) {
		text-decoration: underline;
		font-weight: 500;
	}
	/* fit: the form's column is at most the window's height, and only the
	   .fit-shrink element (with overflow of its own) shrinks to make it so. */
	@media (min-width: 901px) {
		.fit .side-form {
			height: 100vh;
			height: 100dvh;
			padding-bottom: 1rem;
		}
		/* Tighter below the title (above it stays as on every sign-in page, so the title doesn't move). */
		.fit .intro {
			margin-bottom: 1rem;
		}
		.fit .form-box > :global(form > :first-child) {
			margin-top: 0.75rem;
		}
		.fit .form-box :global(.field) {
			margin-bottom: 0.75rem;
		}
		.fit .footer {
			margin-top: 0.75rem;
			padding-top: 0.75rem;
		}
		.fit .form-box {
			display: flex;
			flex-direction: column;
			max-height: 100%;
		}
		.fit .form-box > :global(*) {
			flex: none;
		}
		/* The form's fields join the column itself: a nested box that shrank would
		   let its fields spill over the footer once the window is too short even
		   for the smallest summary, where they should push the page to scroll. */
		.fit .form-box > :global(form) {
			display: contents;
		}
		.fit .form-box > :global(form > *) {
			flex: none;
		}
		.fit .form-box > :global(form > .fit-shrink) {
			flex: 0 1 auto;
			margin-bottom: 0.5rem;
		}
	}
	@media (prefers-color-scheme: dark) {
		.panel-brand {
			background: #0c2135;
		}
		.lockup {
			color: var(--text);
		}
	}
	@media (max-width: 900px) {
		.auth {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto 1fr;
		}
		/* A short band: the form's title and first field stay in the top half
		   of a phone, above the keyboard. */
		.panel-brand {
			position: relative;
			/* 84 px: short enough that the longest form (sign-up under a dead
			   invitation, with its two password fields) fits a 390 × 844 phone. */
			height: 84px;
		}
		.copy {
			display: none;
		}
		.side-form {
			padding-top: 1.25rem;
		}
		.top {
			margin-bottom: 1.25rem;
		}
	}
</style>
