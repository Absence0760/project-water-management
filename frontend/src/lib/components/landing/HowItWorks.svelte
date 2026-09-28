<!-- i18n-section: landing.how -->
<script lang="ts">
	import { t } from '$lib/i18n/locale.svelte';
</script>

<section class="how" aria-labelledby="how-title">
	<h2 id="how-title">{t('How it works')}</h2>
	<ol>
		<li>
			<h3>{t('Build the network')}</h3>
			<p>{t('Draw the farms, dams, transfers and gauges on the river, or import your b023 workbook as it is.')}</p>
		</li>
		<li>
			<h3>{t('Add the data')}</h3>
			<p>{t('Upload rainfall, flow and evaporation, or let the CHIRPS and DWS feeds keep them up to date every day.')}</p>
		</li>
		<li>
			<h3>{t('Run and compare')}</h3>
			<p>{t('Run the model, then try a what-if and see what it changes for each farm and for the river, in plain words.')}</p>
		</li>
	</ol>
</section>

<style>
	h2 {
		margin: 0 0 1.75rem;
		font-family: var(--font-display);
		font-size: clamp(1.75rem, 3.2vw, 2.25rem);
		letter-spacing: -0.015em;
	}
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 2rem;
		counter-reset: step;
	}
	li {
		counter-increment: step;
		position: relative;
		padding-top: 3.25rem;
	}
	li::before {
		content: counter(step);
		position: absolute;
		top: 0;
		left: 0;
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border: 1.75px solid var(--brand-outlet);
		border-radius: 50%;
		font-family: var(--font-display);
		font-weight: 600;
		color: var(--accent);
	}
	h3 {
		margin: 0 0 0.4rem;
		font-family: var(--font-display);
		font-size: 1.15rem;
	}
	p {
		margin: 0;
		line-height: 1.55;
		color: var(--text-2);
	}
	@media (max-width: 760px) {
		ol {
			grid-template-columns: minmax(0, 1fr);
			gap: 1.5rem;
		}
	}
</style>
