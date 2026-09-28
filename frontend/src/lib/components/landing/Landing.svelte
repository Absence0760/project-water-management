<!-- i18n-section: landing -->
<script lang="ts">
	// The public landing page (issue #57; docs/ui.md § Landing page): what the
	// app is, who it's for and why, for a signed-out visitor to `/` and at
	// /welcome (prerendered, for crawlers and link previews). One idea runs
	// through it: follow the water, from rain on the ridges to the river at
	// the outlet. Outside the app shell, like the sign-in pages. Its own chunk:
	// no workspace, no chart library, no engine. The art is generated
	// (`pnpm gen:landing-art`); every figure comes from an invented example
	// catchment (never client data), named as an example where it is shown.
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import BrandMark from '$lib/components/layout/BrandMark.svelte';
	import LanguageSwitch from '$lib/i18n/LanguageSwitch.svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import { LANDING_PATH } from '$lib/auth/session.svelte';
	import Audiences from './Audiences.svelte';
	import Hero from './Hero.svelte';
	import HowItWorks from './HowItWorks.svelte';
	import RiverDivider from './RiverDivider.svelte';
	import Screens from './Screens.svelte';
	import Story from './Story.svelte';
	import Trust from './Trust.svelte';
	import WhatIf from './WhatIf.svelte';

	// Absolute URLs for the link-preview tags, resolved against the page:
	// `base` is relative ('.') while prerendering and absolute in the browser.
	const abs = (path: string) => new URL(`${base}${path}`, page.url).href;
	const title = $derived(t('Water Management: daily water balance for a catchment'));
	const description = $derived(
		t('Model a catchment day by day, from rainfall to river: what each farm is supplied, what its dam holds, and whether the river keeps its ecological reserve.')
	);
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={abs(LANDING_PATH)} />
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="Water Management" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={abs(LANDING_PATH)} />
	<meta property="og:image" content={abs('/landing/og.jpg')} />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content={t('An illustrated catchment at dusk, with the words: Every drop in the catchment, accounted for.')} />
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<div class="landing" style:--contours="url({base}/landing/contours.svg)">
	<header class="top">
		<a class="lockup" href="{base}/" aria-label={t('Water Management, home')}>
			<BrandMark size={32} />
			<span>Water Management</span>
		</a>
		<nav class="nav" aria-label={t('Account')}>
			<LanguageSwitch compact />
			<a class="btn" href="{base}/login">{t('Sign in')}</a>
		</nav>
	</header>

	<main class="page-body">
		<div class="contours" aria-hidden="true"></div>
		<div class="wrap">
			<Hero />
			<RiverDivider />
			<Story />
			<RiverDivider />
			<WhatIf />
			<RiverDivider />
			<Screens />
			<RiverDivider />
			<Audiences />
			<RiverDivider />
			<HowItWorks />
			<RiverDivider />
			<Trust />
			<section class="closing" aria-labelledby="closing-title">
				<h2 id="closing-title">{t('See your catchment day by day.')}</h2>
				<div class="actions">
					<a class="btn btn-primary btn-lg" href="{base}/register">{t('Create an account')}</a>
					<a class="btn btn-lg" href="{base}/login">{t('Sign in')}</a>
				</div>
			</section>
		</div>
	</main>

	<footer class="foot">
		<div class="contours" aria-hidden="true"></div>
		<div class="wrap foot-row">
			<span class="lockup small"><BrandMark size={24} /><span>Water Management</span></span>
			<nav aria-label={t('Footer')}>
				<a href="{base}/login">{t('Sign in')}</a>
				<a href="{base}/register">{t('Create an account')}</a>
				<a href="{base}/privacy">{t('Privacy notice')}</a>
				<a href="{base}/terms">{t('Terms of use')}</a>
				<a href="{base}/methods">{t('How the model is checked')}</a>
			</nav>
		</div>
	</footer>
</div>

<style>
	/* The reserved scrollbar gutter takes the root background: match the page. */
	:global(html:has(.landing)) {
		background: var(--bg);
	}
	.landing {
		--wrap: 1200px;
		min-height: 100vh;
		background: var(--bg);
		color: var(--text);
		overflow-x: clip;
	}
	.wrap {
		position: relative;
		max-width: var(--wrap);
		margin-inline: auto;
		padding-inline: clamp(var(--gutter), 4vw, 3rem);
	}
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		max-width: var(--wrap);
		margin-inline: auto;
		padding: 1rem clamp(var(--gutter), 4vw, 3rem);
	}
	.lockup {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		color: var(--text);
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 1.1rem;
		text-decoration: none;
	}
	.lockup.small {
		font-size: 0.95rem;
	}
	.nav {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.75rem;
	}
	/* A touch-sized target at every width, level with the language pair beside it. */
	.nav .btn {
		min-height: var(--tap);
	}
	.page-body {
		position: relative;
		display: block;
	}
	/* The contour texture: the diorama's own terrain, at a few per cent, drifting a pixel or two. */
	.contours {
		position: absolute;
		inset: 0 0 auto;
		height: min(100vh, 900px);
		background: var(--text);
		mask: var(--contours) center top / max(1500px, 100%) auto no-repeat;
		-webkit-mask: var(--contours) center top / max(1500px, 100%) auto no-repeat;
		opacity: 0.05;
		pointer-events: none;
	}
	@media (prefers-reduced-motion: no-preference) {
		.contours {
			animation: drift 40s ease-in-out infinite alternate;
		}
	}
	@keyframes drift {
		to {
			translate: 2px -2px;
		}
	}
	/* The first river under the hero sits close to it, so the story starts on the first screen. */
	.wrap :global(.hero + .divider) {
		margin-block: clamp(1rem, 2vw, 1.5rem) clamp(2rem, 4vw, 3.5rem);
	}
	.closing {
		--focus: var(--brand-panel-focus);
		margin-top: clamp(3rem, 7vw, 5.5rem);
		padding: clamp(2rem, 5vw, 3.5rem);
		border: 1px solid var(--brand-panel);
		border-radius: 16px;
		background: var(--brand-panel);
		color: var(--brand-panel-text);
		text-align: center;
	}
	.closing h2 {
		margin: 0 0 1.5rem;
		font-family: var(--font-display);
		font-size: clamp(1.75rem, 3.2vw, 2.25rem);
		letter-spacing: -0.015em;
	}
	.closing .actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.75rem;
	}
	.closing .btn:not(.btn-primary) {
		border-color: var(--brand-panel-line);
		background: transparent;
		color: var(--brand-panel-text);
	}
	.btn-lg {
		min-height: 48px;
		padding-inline: 1.4rem;
		font-size: 1rem;
	}
	.foot {
		position: relative;
		margin-top: clamp(3rem, 7vw, 5rem);
		padding-block: 2.5rem 3rem;
		border-top: 1px solid var(--border);
		overflow: hidden;
	}
	.foot .contours {
		height: 100%;
		mask-position: center bottom;
		-webkit-mask-position: center bottom;
	}
	.foot-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1rem 2rem;
	}
	.foot nav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.25rem;
	}
	@media (prefers-color-scheme: dark) {
		.closing {
			border-color: var(--border);
		}
	}
	/* A phone's header: the mark alone (the link keeps its name), the language pair and Sign in on one line. */
	@media (max-width: 420px) {
		.top .lockup span {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
	}

</style>
