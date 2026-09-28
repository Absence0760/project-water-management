<!-- i18n-section: landing.hero -->
<script lang="ts">
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { t } from '$lib/i18n/locale.svelte';
	import Diorama from './Diorama.svelte';
	import { DATA } from './data.generated';
	import { fmt } from './format';

	/**
	 * Sign in morphs the diorama into the sign-in panel's scene (a View
	 * Transition; AuthCard's art carries the same name) where the browser has
	 * them and motion is allowed; otherwise it's an ordinary link.
	 */
	function signIn(e: MouseEvent) {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
		const start = (document as Document & { startViewTransition?: (update: () => Promise<void>) => unknown }).startViewTransition;
		if (!start || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		e.preventDefault();
		start.call(document, () => goto(`${base}/login`));
	}
</script>

<section class="hero" aria-labelledby="landing-title">
	<div class="copy">
		<p class="kicker">{t('Catchment water balance')}</p>
		<h1 id="landing-title">{t('Every drop in the catchment, accounted for.')}</h1>
		<p class="lede">
			{t('Model a catchment day by day, from rainfall to river: what each hydrological unit is supplied, what its dam holds, and whether the river keeps its ecological reserve.')}
		</p>
		<div class="actions">
			<a class="btn btn-primary btn-lg" href="{base}/login" onclick={signIn}>{t('Sign in')}</a>
			<a class="btn btn-lg" href="{base}/register">{t('Create an account')}</a>
		</div>
	</div>
	<div class="art">
		<Diorama mode="hero" priority>
			{#snippet tag()}
				<span class="gauge-tag">
					<strong>{t('Reserve met on {pct} % of days', { pct: fmt(DATA.hero.reserveMetPct) })}</strong>
					<span>{t('Example catchment, {years} years', { years: DATA.hero.years })}</span>
				</span>
			{/snippet}
		</Diorama>
	</div>
</section>

<style>
	.hero {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
		align-items: center;
		gap: clamp(1.5rem, 4vw, 4rem);
		/* Tight below: the story's heading shows on the first screen at 1440 × 960 (landing.spec.ts). */
		padding-block: clamp(1.5rem, 3.5vw, 3rem) clamp(1rem, 2vw, 1.5rem);
	}
	.kicker {
		margin: 0 0 1rem;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 0.85rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--accent);
	}
	h1 {
		margin: 0 0 1.25rem;
		font-family: var(--font-display);
		font-size: clamp(2.25rem, 4.6vw, 3.5rem);
		line-height: 1.06;
		letter-spacing: -0.02em;
		text-wrap: balance;
	}
	.lede {
		margin: 0 0 2rem;
		max-width: 34rem;
		font-size: 1.125rem;
		line-height: 1.6;
		color: var(--text-2);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.btn-lg {
		min-height: 48px;
		padding-inline: 1.4rem;
		font-size: 1rem;
	}
	.art {
		view-transition-name: catchment-scene;
		min-width: 0;
	}
	.gauge-tag {
		display: grid;
		gap: 0.1rem;
		padding: 0.45rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: 0 6px 18px rgb(0 0 0 / 0.14);
		font-size: 0.8rem;
		line-height: 1.3;
		white-space: nowrap;
	}
	.gauge-tag strong {
		font-variant-numeric: tabular-nums;
	}
	.gauge-tag span {
		color: var(--text-muted);
	}
	@media (max-width: 760px) {
		.hero {
			grid-template-columns: minmax(0, 1fr);
			padding-top: 1.5rem;
		}
		/* A phone shows the lower valley: the river, the dam below and the outlet. */
		.art {
			order: 2;
			overflow: hidden;
			aspect-ratio: 4 / 3;
			border-radius: 12px;
			margin-inline: calc(-1 * var(--gutter));
		}
		.art :global(.crop) {
			width: 150%;
			margin-left: -8%;
			margin-top: -14%;
		}
	}
</style>
