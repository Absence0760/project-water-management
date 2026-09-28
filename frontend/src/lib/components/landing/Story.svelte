<!-- i18n-section: landing.story -->
<script lang="ts">
	// "From rainfall to river" (issue #57): the diorama stays pinned while five
	// steps scroll past; each lights its part of the scene (Diorama's `step`)
	// and shows a real chart from the example run (data.generated.ts, the
	// engine on the invented Kleinberg catchment). The step in the middle of
	// the screen is the lit one (IntersectionObserver). The steps also fade in
	// on scroll where the browser has scroll-driven animations; under reduced
	// motion the scene switches without transitions. On a phone the scene
	// isn't pinned: each step is read with its chart.
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import Diorama, { type StepId } from './Diorama.svelte';
	import MiniChart from './MiniChart.svelte';
	import { ART } from './art.generated';
	import { DATA } from './data.generated';
	import { fmt } from './format';

	const s = DATA.story;
	/** The scene's height over its width, for centring the pinned scene in the window. */
	const ratio = ART.hero.height / ART.hero.width;
	const peak = (v: readonly number[]) => Math.max(...v);
	const rainTotal = s.rain.reduce((a, b) => a + b, 0);
	const farmShort = s.farm.supplied.filter((v, i) => v < s.farm.demand[i]! - 1e-9).length;
	const farmShare = (s.farm.supplied.reduce((a, b) => a + b, 0) / s.farm.demand.reduce((a, b) => a + b, 0)) * 100;
	const damLow = Math.min(...s.dam.pctFull);

	let active = $state<StepId>('rain');
	const steps: StepId[] = ['rain', 'runoff', 'dams', 'farms', 'river'];
	const els: Partial<Record<StepId, HTMLElement>> = {};

	onMount(() => {
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) if (e.isIntersecting) active = (e.target as HTMLElement).dataset.step as StepId;
			},
			{ rootMargin: '-45% 0px -45% 0px' }
		);
		for (const id of steps) if (els[id]) io.observe(els[id]!);
		return () => io.disconnect();
	});
</script>

<section class="story" aria-labelledby="story-title">
	<header class="head">
		<h2 id="story-title">{t('From rainfall to river')}</h2>
		<p class="intro">
			{t('What the model works out for every day of the record, one step at a time. The charts are the {year} water year of an example catchment, by week.', { year: s.waterYear })}
		</p>
	</header>
	<div class="body" style:--scene-h-per-w={ratio.toFixed(4)}>
		<div class="pin">
			<Diorama mode="story" step={active} />
		</div>
		<ol class="steps">
			<li data-step="rain" bind:this={els.rain} class:on={active === 'rain'}>
				<p class="n">1</p>
				<h3>{t('Rain on the mountains')}</h3>
				<p>{t('Daily rainfall from the catchment’s own gauges, with CHIRPS satellite estimates to fill the gaps and check them.')}</p>
				<MiniChart
					kind="bars"
					tone="rain"
					values={s.rain}
					unit={t('mm a week')}
					label={t('Rainfall')}
					summary={t('{total} mm over the year; the wettest week {peak} mm.', { total: fmt(rainTotal), peak: fmt(peak(s.rain)) })}
				/>
			</li>
			<li data-step="runoff" bind:this={els.runoff} class:on={active === 'runoff'}>
				<p class="n">2</p>
				<h3>{t('Runoff from the slopes')}</h3>
				<p>{t('A rainfall–runoff model (GR4J or Pitman), calibrated against the weir’s record, turns rain into the streams’ flow.')}</p>
				<MiniChart
					kind="line"
					values={s.runoff}
					unit="m³/s"
					label={t('Natural runoff')}
					summary={t('Highest in winter: {peak} m³/s in the wettest week.', { peak: fmt(peak(s.runoff), 2) })}
				/>
			</li>
			<li data-step="dams" bind:this={els.dams} class:on={active === 'dams'}>
				<p class="n">3</p>
				<h3>{t('Dams fill and draw down')}</h3>
				<p>{t('Each farm dam catches its share of the flow, loses some to evaporation and seepage, and spills when it is full.')}</p>
				<MiniChart
					kind="line"
					values={s.dam.pctFull}
					ref={100}
					max={110}
					unit={t('% full')}
					label={t('{dam} dam', { dam: s.dam.name })}
					againstLabel={t('Full')}
					summary={t('Full through winter, down to {low} % by the end of summer.', { low: fmt(damLow) })}
				/>
			</li>
			<li data-step="farms" bind:this={els.farms} class:on={active === 'farms'}>
				<p class="n">4</p>
				<h3>{t('Hydrological units take their share')}</h3>
				<p>{t('Crops need water by the month. The model supplies what the dam and the river can give, and counts the days a hydrological unit runs short.')}</p>
				<MiniChart
					kind="pair"
					values={s.farm.supplied}
					against={s.farm.demand}
					unit={t('m³ a day')}
					label={t('Supplied to {farm}', { farm: s.farm.name })}
					againstLabel={t('Needed')}
					summary={t('{share} % of what it needed over the year; short in {weeks} weeks (shaded).', { share: fmt(farmShare), weeks: farmShort })}
				/>
			</li>
			<li data-step="river" bind:this={els.river} class:on={active === 'river'}>
				<p class="n">5</p>
				<h3>{t('The river below')}</h3>
				<p>{t('What is left reaches the outlet. Every day, the model checks it against the ecological reserve the river needs.')}</p>
				<MiniChart
					kind="pair"
					scale="sqrt"
					values={s.river.flow}
					against={s.river.reserve}
					unit={t('m³/s, on a square-root scale')}
					label={t('Flow at the outlet')}
					againstLabel={t('Reserve')}
					summary={t('Below the reserve in {weeks} of 52 weeks (shaded), mostly in summer.', { weeks: s.river.weeksBelow })}
				/>
			</li>
		</ol>
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
		line-height: 1.15;
		letter-spacing: -0.015em;
	}
	.intro {
		margin: 0;
		font-size: 1.05rem;
		line-height: 1.6;
		color: var(--text-2);
	}
	.body {
		--gap: clamp(1.5rem, 4vw, 3.5rem);
		display: grid;
		grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
		gap: var(--gap);
		align-items: start;
		/* The pin's offset reads the grid's width (cqw). */
		container: story-body / inline-size;
	}
	/* Stuck in the middle of the window: half the window less half the scene's
	   height (its column is 7/12 of the grid less the gap), never above 1rem, so
	   its top is always on screen however short the window (landing.spec.ts). */
	.pin {
		position: sticky;
		top: max(1rem, calc(50vh - (100cqw - var(--gap)) * 7 / 12 * var(--scene-h-per-w) / 2));
	}
	.steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 18vh;
		padding-block: 8vh 20vh;
	}
	.steps li {
		padding: 1.25rem 1.25rem 1rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
		/* The lit step is marked by its edge, never by fading the others: faded text fails contrast. */
		box-shadow: inset 3px 0 0 transparent;
		transition:
			box-shadow 300ms ease-out,
			border-color 300ms ease-out;
	}
	.steps li.on {
		border-color: var(--border-strong);
		box-shadow:
			inset 3px 0 0 var(--brand-outlet),
			0 8px 24px rgb(16 42 67 / 0.08);
	}
	.n {
		margin: 0 0 0.35rem;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 0.85rem;
		color: var(--accent);
	}
	h3 {
		margin: 0 0 0.4rem;
		font-family: var(--font-display);
		font-size: 1.2rem;
	}
	.steps li > p:not(.n) {
		margin: 0 0 1rem;
		line-height: 1.55;
		color: var(--text-2);
	}
	@supports (animation-timeline: view()) {
		@media (prefers-reduced-motion: no-preference) {
			.steps li {
				animation: rise linear both;
				animation-timeline: view();
				animation-range: entry 0% entry 60%;
			}
		}
	}
	@keyframes rise {
		from {
			translate: 0 24px;
		}
		to {
			translate: 0 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.steps li {
			transition: none;
		}
	}
	@media (max-width: 760px) {
		.body {
			grid-template-columns: minmax(0, 1fr);
		}
		.pin {
			position: static;
		}
		.steps {
			gap: 1rem;
			padding-block: 0;
		}
	}
</style>
