<!-- i18n-section: landing.audiences -->
<script lang="ts">
	// Who it's for (issue #57): the roadmap's four audiences (docs/roadmap/),
	// each with its drawn icon, which draws itself on when its card comes into view.
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import DrawnIcon from './DrawnIcon.svelte';

	let el: HTMLElement | undefined = $state();
	let seen = $state(false);
	// The icons wait undrawn only once the script runs: the prerendered page, and
	// a page whose script never runs, show them drawn (like Screens.svelte).
	let armed = $state(false);
	onMount(() => {
		if (!el) return;
		armed = true;
		const io = new IntersectionObserver(([e]) => {
			if (e?.isIntersecting) {
				seen = true;
				io.disconnect();
			}
		}, { threshold: 0.25 });
		io.observe(el);
		return () => io.disconnect();
	});
</script>

<section class="audiences" aria-labelledby="audiences-title" bind:this={el} data-armed={armed ? 'yes' : 'no'}>
	<h2 id="audiences-title">{t('Who it’s for')}</h2>
	<ul>
		<li>
			<DrawnIcon name="hydrologist" {armed} draw={seen} />
			<h3>{t('Consulting hydrologists')}</h3>
			<p>{t('Build and calibrate a catchment model, or import your b023 workbook. Run decades of daily flows in seconds and compare what-ifs.')}</p>
		</li>
		<li>
			<DrawnIcon name="association" {armed} draw={seen} />
			<h3>{t('Water user associations')}</h3>
			<p>{t('One shared model for the whole catchment: who is short this week, and what a restriction would do before you apply it.')}</p>
		</li>
		<li>
			<DrawnIcon name="licensing" {armed} draw={seen} />
			<h3>{t('Licence applicants and assessors')}</h3>
			<p>{t('Model a new dam or more hectares against the catchment as it is, with evidence an assessor can open and reproduce.')}</p>
		</li>
		<li>
			<DrawnIcon name="farmer" {armed} draw={seen} />
			<h3>{t('Farmers')}</h3>
			<p>{t('Your farm’s supply, your dam and any restriction, on your phone, in English or Afrikaans.')}</p>
		</li>
	</ul>
</section>

<style>
	h2 {
		margin: 0 0 1.75rem;
		font-family: var(--font-display);
		font-size: clamp(1.75rem, 3.2vw, 2.25rem);
		letter-spacing: -0.015em;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 1.25rem;
	}
	li {
		padding: 1.5rem 1.25rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
	}
	h3 {
		margin: 1rem 0 0.5rem;
		font-family: var(--font-display);
		font-size: 1.1rem;
	}
	p {
		margin: 0;
		line-height: 1.55;
		color: var(--text-2);
	}
	@media (max-width: 1100px) {
		ul {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 560px) {
		ul {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
