<!-- i18n-section: landing.scene -->
<script lang="ts" module>
	export type StepId = 'rain' | 'runoff' | 'dams' | 'farms' | 'river';
</script>

<script lang="ts">
	// The landing page's catchment (issue #57): the Blender render
	// (scripts/landing-art/diorama.py; day in light mode, dusk in dark) with an
	// SVG layer over it, drawn from where the render's rivers, dams, clouds and
	// gauge fall (ART.overlay, projected through the render's camera), so the
	// motion sits on the picture. Two uses:
	//   hero   one ~10 s loop, then a rest: rain over the ridges, a pulse of
	//          water down the rivers, the dams filling. Only while on screen
	//          and the tab is visible; off under reduced motion, and when the
	//          page's pause button (Hero) sets `paused` (WCAG 2.2.2: it runs
	//          longer than 5 s). The gauge's tag never moves: it is text to
	//          read, so it shows the whole time.
	//   story  no loop; `step` lights its part of the scene (the rain, the
	//          slopes and streams, the dams, the farms, the river below).
	// Before the script runs, and under reduced motion, it is the loop's last
	// frame: the dams full, the rivers lit, the tag shown.
	import { onMount, type Snippet } from 'svelte';
	import { base } from '$app/paths';
	import { t } from '$lib/i18n/locale.svelte';
	import { ART } from './art.generated';

	let {
		mode,
		step = null,
		priority = false,
		paused = false,
		canMove = $bindable(false),
		tag
	}: {
		mode: 'hero' | 'story';
		step?: StepId | null;
		priority?: boolean;
		/** The visitor stopped the hero's loop: it shows its still frame. */
		paused?: boolean;
		/** Out: the hero may move (motion allowed and the script running), so a pause button means something. */
		canMove?: boolean;
		tag?: Snippet;
	} = $props();

	const { hero, overlay } = ART;
	// viewBox units: 1000 across, the picture's own shape.
	const VW = 1000;
	const VH = Math.round((VW * hero.height) / hero.width);
	const xy = (p: readonly number[]) => `${((p[0]! * VW) / 100).toFixed(1)} ${((p[1]! * VH) / 100).toFixed(1)}`;
	const line = (pts: readonly (readonly number[])[]) => 'M' + pts.map(xy).join(' L');
	const ring = (pts: readonly (readonly number[])[]) => line(pts) + ' Z';
	const at = (p: readonly number[]) => ({ x: (p[0]! * VW) / 100, y: (p[1]! * VH) / 100 });

	const river = line(overlay.river);
	const tributary = line(overlay.tributary);
	const reach = line(overlay.reach);
	const dams = Object.values(overlay.dams).map(ring);

	// A few dozen rain streaks under each cloud, falling to the ridge below it.
	const rain = overlay.clouds.flatMap((cloud, c) => {
		const from = at(cloud);
		const to = at(overlay.ridges[c]!);
		return Array.from({ length: 9 }, (_, k) => {
			const spread = ((k * 37) % 9) / 8 - 0.5;
			return { x: from.x + spread * 70, y: from.y + 18, dx: to.x - from.x - 12, dy: to.y - from.y - 18, delay: ((k * 0.29 + c * 0.41) % 1.4).toFixed(2) };
		});
	});

	const srcset = (mode: 'day' | 'dusk', type: 'avif' | 'webp') => hero.widths.map((w) => `${base}/landing/hero-${mode}-${w}.${type} ${w}w`).join(', ');
	const sizes = '(max-width: 760px) 140vw, 56vw';

	let root: HTMLElement | undefined = $state();
	let img: HTMLImageElement | undefined = $state();
	// The blur-up sits behind the render, whose sky is transparent: drop it once
	// the render is in, or it shows round the block as a halo.
	let loaded = $state(false);
	// A listener, not an onload attribute: server-rendered, that would be an
	// inline handler the CSP blocks (infra/scripts/check-csp.mjs refuses it).
	onMount(() => {
		if (!img) return;
		if (img.complete && img.naturalWidth) loaded = true;
		const done = () => (loaded = true);
		img.addEventListener('load', done);
		return () => img?.removeEventListener('load', done);
	});
	/** The loop runs: motion allowed and not paused, the scene on screen, the tab visible. */
	let onScreen = $state(false);
	const motion = $derived(canMove && !paused);
	const playing = $derived(motion && onScreen);

	onMount(() => {
		if (mode !== 'hero' || !root) return;
		const reduce = matchMedia('(prefers-reduced-motion: reduce)');
		let visible = false;
		const update = () => {
			canMove = !reduce.matches;
			onScreen = visible && document.visibilityState === 'visible';
		};
		const io = new IntersectionObserver(([e]) => {
			visible = !!e?.isIntersecting;
			update();
		});
		io.observe(root);
		document.addEventListener('visibilitychange', update);
		reduce.addEventListener('change', update);
		update();
		return () => {
			io.disconnect();
			document.removeEventListener('visibilitychange', update);
			reduce.removeEventListener('change', update);
		};
	});
</script>

<div class="crop {mode}" bind:this={root}>
	<div
		class="scene"
		class:loaded
		data-motion={motion ? 'on' : 'off'}
		data-playing={playing ? 'yes' : 'no'}
		data-step={step ?? ''}
		style:--ph-day="url({hero.placeholder.day})"
		style:--ph-dusk="url({hero.placeholder.dusk})"
	>
		<picture>
			<source type="image/avif" media="(prefers-color-scheme: dark)" srcset={srcset('dusk', 'avif')} {sizes} />
			<source type="image/webp" media="(prefers-color-scheme: dark)" srcset={srcset('dusk', 'webp')} {sizes} />
			<source type="image/avif" srcset={srcset('day', 'avif')} {sizes} />
			<img
				src="{base}/landing/hero-day-1200.webp"
				srcset={srcset('day', 'webp')}
				{sizes}
				width={hero.width}
				height={hero.height}
				alt={t('An illustrated catchment: rain over the mountains, two farm dams, an orchard and a vineyard, and a river winding down to a gauging weir.')}
				decoding="async"
				bind:this={img}
				loading={priority ? 'eager' : 'lazy'}
				fetchpriority={priority ? 'high' : 'auto'}
			/>
		</picture>
		<svg class="layer" viewBox="0 0 {VW} {VH}" aria-hidden="true" focusable="false">
			<g class="rain">
				{#each rain as r, i (i)}
					<path d="M{r.x.toFixed(1)} {r.y.toFixed(1)} l-3 14" style:--dx="{r.dx.toFixed(1)}px" style:--dy="{r.dy.toFixed(1)}px" style:animation-delay="{r.delay}s" />
				{/each}
			</g>
			<g class="ridges">
				{#each overlay.ridges as p, i (i)}<circle cx={at(p).x} cy={at(p).y} r="16" />{/each}
			</g>
			<g class="slopes">
				{#each overlay.slopes as p, i (i)}<circle cx={at(p).x} cy={at(p).y} r="22" />{/each}
			</g>
			<g class="dams">
				{#each dams as d, i (i)}<path {d} />{/each}
			</g>
			<g class="streams">
				<path class="glow" d={tributary} pathLength="100" />
				<path class="glow" d={river} pathLength="100" />
				<path class="pulse" d={tributary} pathLength="100" />
				<path class="pulse" d={river} pathLength="100" />
			</g>
			<g class="farms">
				<circle class="short" cx={at(overlay.farms.orchard).x} cy={at(overlay.farms.orchard).y} r="30" />
				<circle cx={at(overlay.farms.vineyard).x} cy={at(overlay.farms.vineyard).y} r="34" />
			</g>
			<path class="reach" d={reach} />
			<g class="gauge" transform="translate({at(overlay.gauge).x} {at(overlay.gauge).y})">
				<circle r="9" />
				<path d="M0 0 L6 -5" />
			</g>
		</svg>
		{#if tag}
			<div class="tag" style:left="{overlay.gauge[0]}%" style:top="{overlay.gauge[1]}%">{@render tag()}</div>
		{/if}
	</div>
</div>

<style>
	.crop {
		position: relative;
		/* Kept out of view transitions' way unless the page names it (the hero → sign-in morph). */
		container-type: inline-size;
	}
	.scene {
		position: relative;
		aspect-ratio: var(--scene-ratio, auto);
		background: var(--ph-day) center / cover no-repeat;
		border-radius: 12px;
	}
	@media (prefers-color-scheme: dark) {
		.scene {
			background-image: var(--ph-dusk);
		}
	}
	.scene.loaded {
		background: none;
	}
	/* The placeholder is a 24 px picture scaled up: soft, and gone once the render is in. */
	.scene > picture,
	.scene img {
		display: block;
		width: 100%;
		height: auto;
	}
	.layer {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
		pointer-events: none;
		fill: none;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	/* ---- the still frame (no script, reduced motion, the story's resting state) ---- */
	.rain path {
		stroke: #bfe3ff;
		stroke-width: 1.6;
		opacity: 0;
	}
	.ridges circle,
	.slopes circle,
	.farms circle {
		fill: #7fd5e8;
		opacity: 0;
		transition: opacity 400ms ease-out;
	}
	.farms circle.short {
		fill: #f0a830;
	}
	.dams path {
		fill: #58c4f0;
		stroke: #d8f3ff;
		stroke-width: 2;
		opacity: 0.45;
		transform-box: fill-box;
		transform-origin: 50% 100%;
		transition: opacity 400ms ease-out;
	}
	.streams .glow {
		stroke: #8fe3ff;
		stroke-width: 9;
		/* The loop's rest (glow at 62–92 %), so starting the loop changes nothing. */
		opacity: 0.2;
	}
	.streams .pulse {
		stroke: #e6fbff;
		stroke-width: 3.5;
		stroke-dasharray: 14 100;
		stroke-dashoffset: 114;
	}
	.reach {
		stroke: #7fd5e8;
		stroke-width: 7;
		opacity: 0;
		transition: opacity 400ms ease-out;
	}
	.gauge circle {
		fill: #102a43;
		stroke: #e6fbff;
		stroke-width: 2;
	}
	.gauge path {
		stroke: #36c6e0;
		stroke-width: 2.5;
	}
	.tag {
		position: absolute;
		transform: translate(14px, -50%);
	}

	/* ---- hero: one loop of about 10 s, then a 4 s rest ----
	   Every 14 s loop starts 11.2 s in (80 %, inside the rest: the dams full, the
	   rivers lit, the needle settled), which is the still frame the
	   page shows before the script runs. So turning motion on changes nothing on
	   screen; the rest runs out and the next loop begins with the rain. */
	.hero [data-motion='on'] {
		--rest: -11.2s;
	}
	.hero [data-motion='on'] .rain {
		animation: rain-window 14s linear infinite;
		animation-delay: var(--rest);
	}
	.hero [data-motion='on'] .rain path {
		opacity: 0.85;
		animation: fall 1.4s linear infinite;
	}
	.hero [data-motion='on'] .streams .glow {
		animation: glow 14s ease-out infinite;
		animation-delay: var(--rest);
	}
	.hero [data-motion='on'] .streams .pulse {
		animation: pulse 14s cubic-bezier(0.4, 0, 0.6, 1) infinite;
		animation-delay: var(--rest);
	}
	.hero [data-motion='on'] .dams path {
		animation: fill 14s ease-out infinite;
		animation-delay: var(--rest);
	}
	.hero [data-motion='on'] .gauge path {
		transform-box: fill-box;
		transform-origin: 0 100%;
		animation: needle 14s ease-out infinite;
		animation-delay: var(--rest);
	}
	.hero [data-playing='no'] *,
	.hero [data-playing='no'] {
		animation-play-state: paused !important;
	}
	@keyframes rain-window {
		0%,
		40%,
		100% {
			opacity: 0;
		}
		4%,
		32% {
			opacity: 1;
		}
	}
	@keyframes fall {
		from {
			transform: translate(0, 0);
		}
		to {
			transform: translate(var(--dx), var(--dy));
		}
	}
	@keyframes pulse {
		0%,
		28% {
			stroke-dashoffset: 114;
		}
		66%,
		100% {
			stroke-dashoffset: 0;
		}
	}
	@keyframes glow {
		0%,
		30% {
			opacity: 0.06;
		}
		62%,
		92% {
			opacity: 0.2;
		}
		100% {
			opacity: 0.06;
		}
	}
	@keyframes fill {
		0%,
		52% {
			opacity: 0.1;
			transform: scaleY(0.35);
		}
		72%,
		92% {
			opacity: 0.45;
			transform: scaleY(1);
		}
		100% {
			opacity: 0.1;
			transform: scaleY(0.35);
		}
	}
	@keyframes needle {
		0%,
		66% {
			transform: rotate(-70deg);
		}
		76% {
			transform: rotate(8deg);
		}
		80%,
		100% {
			transform: rotate(0deg);
		}
	}
	/* ---- story: each step lights its part ---- */
	.story .dams path {
		opacity: 0.12;
	}
	.story .streams .pulse {
		opacity: 0;
	}
	.story .streams .glow {
		opacity: 0.08;
		transition:
			opacity 400ms ease-out,
			stroke-width 400ms ease-out;
	}
	.story [data-step='rain'] .ridges circle {
		opacity: 0.5;
	}
	.story [data-step='rain'] .rain path {
		opacity: 0.8;
	}
	.story [data-step='runoff'] .slopes circle {
		opacity: 0.35;
	}
	.story [data-step='runoff'] .streams .glow {
		opacity: 0.55;
		stroke-width: 12;
	}
	.story [data-step='dams'] .dams path {
		opacity: 0.75;
	}
	.story [data-step='farms'] .farms circle {
		opacity: 0.6;
	}
	.story [data-step='river'] .reach {
		opacity: 0.8;
	}
	@media (prefers-reduced-motion: reduce) {
		.ridges circle,
		.slopes circle,
		.farms circle,
		.dams path,
		.reach,
		.story .streams .glow {
			transition: none;
		}
	}
</style>
