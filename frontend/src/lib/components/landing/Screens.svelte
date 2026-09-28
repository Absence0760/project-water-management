<!-- i18n-section: landing.screens -->
<script lang="ts">
	// The real product (issue #57): screens captured from the app itself on the
	// invented example catchments, never mockups, so they can't drift. The
	// laptop shows a catchment's Summary; the phone, overlapping it, the farm
	// view a farmer sees. They rise into view once, the phone a beat after the
	// laptop, with a slight parallax; still under reduced motion.
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import { ART } from './art.generated';
	import Shot from './Shot.svelte';

	const screens = ART.screens;
	let el: HTMLElement | undefined = $state();
	let seen = $state(false);
	// Hidden to rise in only once the script runs: the prerendered page shows them.
	let armed = $state(false);

	onMount(() => {
		if (!el) return;
		armed = true;
		const io = new IntersectionObserver(([e]) => {
			if (e?.isIntersecting) {
				seen = true;
				io.disconnect();
			}
		}, { threshold: 0.2 });
		io.observe(el);
		return () => io.disconnect();
	});
</script>

<section class="screens" aria-labelledby="screens-title" bind:this={el} class:armed class:seen>
	<header class="head">
		<h2 id="screens-title">{t('What you get')}</h2>
		<p>{t('Screens from the app itself.')}</p>
	</header>
	<div class="devices">
		<div class="laptop">
			<Shot name="laptop" {...screens.laptop} widths={[800, 1600]} sizes="(max-width: 760px) 100vw, 60vw" alt={t('A catchment’s Summary: the ecological reserve, supply to each hydrological unit and the dams today.')} />
		</div>
		<div class="phone">
			<Shot name="phone" {...screens.phone} widths={[217, 434]} sizes="(max-width: 760px) 40vw, 16vw" alt={t('A farmer’s view of their own hydrological unit on a phone: their dam, their supply and any restriction.')} />
		</div>
	</div>
	<p class="caption">{t('The farmer sees their own share on their phone, in English or Afrikaans.')}</p>
	<div class="cards">
		<figure class="card">
			<Shot name="network" {...screens.network} widths={[640, 1280]} sizes="(max-width: 760px) 100vw, 45vw" alt={t('The network: hydrological units, dams and gauges on the river, upstream to downstream.')} />
			<figcaption><strong>{t('The network')}</strong> {t('Hydrological units, dams, transfers and gauges on the river, from the headwaters to the outlet.')}</figcaption>
		</figure>
		<figure class="card">
			<Shot name="river" {...screens.river} widths={[640, 1280]} sizes="(max-width: 760px) 100vw, 45vw" alt={t('The river against its ecological reserve, day by day, with the days below it marked.')} />
			<figcaption><strong>{t('River and reserve')}</strong> {t('Flow at every gauge against the reserve, and which hydrological units’ use it falls short by.')}</figcaption>
		</figure>
	</div>
</section>

<style>
	.head {
		max-width: 42rem;
		margin-bottom: 2rem;
	}
	h2 {
		margin: 0 0 0.75rem;
		font-family: var(--font-display);
		font-size: clamp(1.75rem, 3.2vw, 2.25rem);
		letter-spacing: -0.015em;
	}
	.head p {
		margin: 0;
		color: var(--text-2);
		line-height: 1.6;
	}
	.devices {
		position: relative;
		padding-right: 12%;
	}
	.laptop {
		filter: drop-shadow(0 18px 30px rgb(16 42 67 / 0.18));
	}
	.phone {
		position: absolute;
		right: 2%;
		bottom: -6%;
		width: 22%;
		filter: drop-shadow(0 14px 24px rgb(16 42 67 / 0.28));
	}
	.caption {
		margin: 3rem 0 2.5rem;
		text-align: center;
		color: var(--text-2);
	}
	.cards {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
	}
	.card {
		margin: 0;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
	}
	.card figcaption {
		padding: 0.9rem 1rem 1rem;
		line-height: 1.5;
		color: var(--text-2);
	}
	.card strong {
		display: block;
		margin-bottom: 0.2rem;
		color: var(--text);
		font-family: var(--font-display);
	}
	@media (prefers-reduced-motion: no-preference) {
		.armed .laptop,
		.armed .phone {
			opacity: 0;
			translate: 0 24px;
			transition:
				opacity 400ms ease-out,
				translate 400ms ease-out;
		}
		.armed .phone {
			transition-delay: 150ms;
		}
		.armed.seen .laptop,
		.armed.seen .phone {
			opacity: 1;
			translate: 0 0;
		}
		@supports (animation-timeline: view()) {
			.phone {
				animation: drift linear both;
				animation-timeline: view();
			}
		}
	}
	@keyframes drift {
		from {
			transform: translateY(12px);
		}
		to {
			transform: translateY(-12px);
		}
	}
	@media (max-width: 760px) {
		.devices {
			padding-right: 18%;
		}
		.phone {
			width: 34%;
			right: 0;
		}
		.cards {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
