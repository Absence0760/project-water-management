<!-- i18n-section: landing.trust -->
<script lang="ts">
	// Why trust it (issue #57): plain statements, no borrowed logos (no CHIRPS or
	// DWS marks: trademarks, and no implied endorsement), and three figures from
	// the example catchment, named as its, that count up once in view (still
	// under reduced motion, and the final figure before the script runs). The
	// last is the one that earns trust: how closely the example's fitted model
	// follows its weir's measured flow (the run's calibration NSE, from the
	// engine: backend/scripts/landing-data.ts). No link to the engine audit:
	// docs/design/landing-art.md says why.
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import { DATA } from './data.generated';
	import { fmt } from './format';

	const FIGURES = [
		{ value: DATA.hero.years, digits: 0, label: () => t('years of daily water balance') },
		{ value: DATA.hero.days, digits: 0, label: () => t('days in one run') },
		{ value: DATA.hero.calibrationNse, digits: 2, label: () => t('fit to the weir’s measured flow (NSE, where 1 is perfect)') }
	];
	const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
	let shown = $state(FIGURES.map((f) => f.value));
	let el: HTMLElement | undefined = $state();

	onMount(() => {
		if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		let frame = 0;
		const io = new IntersectionObserver(([e]) => {
			if (!e?.isIntersecting) return;
			io.disconnect();
			const start = performance.now();
			const tick = (now: number) => {
				const k = Math.min(1, (now - start) / 900);
				const ease = 1 - (1 - k) ** 3;
				shown = FIGURES.map((f) => round(f.value * ease, f.digits));
				if (k < 1) frame = requestAnimationFrame(tick);
			};
			frame = requestAnimationFrame(tick);
		}, { threshold: 0.5 });
		shown = FIGURES.map(() => 0);
		io.observe(el);
		return () => {
			io.disconnect();
			cancelAnimationFrame(frame);
		};
	});
</script>

<section class="trust" aria-labelledby="trust-title">
	<h2 id="trust-title">{t('Why trust it')}</h2>
	<ul class="points">
		<li>{t('The engine is judged against documented hydrology, not against a spreadsheet, and every place it departs from the workbook is written down.')}</li>
		<li>{t('Every run can be reproduced, and every change has an audit trail.')}</li>
		<li>{t('Each project is private to its members, enforced by the database itself (row-level security).')}</li>
		<li>{t('Daily data from CHIRPS rainfall and the DWS gauges.')}</li>
	</ul>
	<p class="figures-head">{t('In the example catchment')}</p>
	<dl class="figures" bind:this={el}>
		{#each FIGURES as f, i (i)}
			<div>
				<dt>{f.label()}</dt>
				<!-- The count-up is for the eye; assistive tech gets the figure itself. -->
				<dd><span aria-hidden="true">{fmt(shown[i]!, f.digits)}</span><span class="visually-hidden">{fmt(f.value, f.digits)}</span></dd>
			</div>
		{/each}
	</dl>
</section>

<style>
	h2 {
		margin: 0 0 1.5rem;
		font-family: var(--font-display);
		font-size: clamp(1.75rem, 3.2vw, 2.25rem);
		letter-spacing: -0.015em;
	}
	.points {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem 2rem;
		margin: 0 0 2.5rem;
		padding: 0;
		list-style: none;
	}
	.points li {
		position: relative;
		padding-left: 1.75rem;
		line-height: 1.55;
		color: var(--text-2);
	}
	.points li::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0.35em;
		width: 0.8rem;
		height: 0.8rem;
		border: 2px solid var(--brand-outlet);
		border-radius: 50% 50% 50% 0;
		rotate: -45deg;
	}
	.figures-head {
		margin: 0 0 0.75rem;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 0.85rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.figures {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1rem;
		margin: 0;
	}
	.figures div {
		display: flex;
		flex-direction: column-reverse;
		gap: 0.25rem;
		padding: 1rem 1.25rem;
		border-left: 3px solid var(--brand-outlet);
	}
	dt {
		color: var(--text-muted);
	}
	dd {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(2rem, 4vw, 2.75rem);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	@media (max-width: 760px) {
		.points,
		.figures {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
