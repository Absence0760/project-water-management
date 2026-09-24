<script lang="ts">
	// The /help landing picture: an illustrated catchment (Blender render,
	// bin/gen-help-art.sh) with numbered stops that follow the water from rain
	// to the outlet. The numbered list beside it is the full text; the
	// markers on the picture repeat it for pointer users, so they are out of
	// the tab order and hidden from screen readers (the list is the same
	// thing, once). Clicking a marker lights its stop; hovering or focusing a
	// stop lights its marker.
	import { base } from '$app/paths';
	import { helpFor } from '$lib/help/content';
	import { guideFor, inline } from '$lib/help/guides';
	import { TOUR, TOUR_IMAGE, TOUR_SPOTS, type TourStopId } from '$lib/help/tour';

	let selected = $state<TourStopId | null>(null);
	const uid = $props.id();

	// A click on the picture lights that stop's text and brings it into view.
	function pick(id: TourStopId) {
		selected = id;
		document.getElementById(`${uid}-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}
</script>

{#snippet rich(text: string)}
	{#each inline(text) as part, i (i)}
		{#if part.kind === 'strong'}<strong>{part.text}</strong>
		{:else if part.kind === 'term'}<a href="{base}/help/glossary#{part.id}">{part.text}</a>
		{:else if part.kind === 'guide'}<a href="{base}/help/guides/{part.id}">{part.text}</a>
		{:else}{part.text}{/if}
	{/each}
{/snippet}

<div class="tour">
	<div class="picture">
		<img
			src="{base}/help/catchment-1600.webp"
			srcset="{base}/help/catchment-800.webp 800w, {base}/help/catchment-1600.webp 1600w"
			sizes="(min-width: 64rem) 52rem, 100vw"
			width={TOUR_IMAGE.width}
			height={TOUR_IMAGE.height}
			alt="An illustrated catchment, cut out of the ground like a block. Rain falls from clouds over the mountains at the back, with the sun beside them. A river runs down the valley to a weir and gauging hut at the front edge; a tributary from the left passes through a farm dam. A pipeline carries water from that dam across the river to a second dam. An orchard and a vineyard are irrigated from the dams, and there is a farmhouse near the river."
		/>
		<div class="markers" aria-hidden="true">
			{#each TOUR as stop, i (stop.id)}
				<button
					type="button"
					tabindex="-1"
					class="marker"
					class:on={selected === stop.id}
					style:left="{TOUR_SPOTS[stop.id].x}%"
					style:top="{TOUR_SPOTS[stop.id].y}%"
					onclick={() => pick(stop.id)}>{i + 1}</button
				>
			{/each}
		</div>
	</div>

	<ol class="stops">
		{#each TOUR as stop, i (stop.id)}
			{@const guide = guideFor(stop.guide)}
			<!-- Hover or focus a stop to light its marker on the picture. -->
			<li
				id="{uid}-{stop.id}"
				class:on={selected === stop.id}
				onmouseenter={() => (selected = stop.id)}
				onfocusin={() => (selected = stop.id)}
			>
				<span class="num" aria-hidden="true">{i + 1}</span>
				<div>
					<h3>{stop.title}</h3>
					<p>{@render rich(stop.text)}</p>
					{#if guide}<a class="more" href="{base}/help/guides/{guide.id}">{guide.title} →</a>{/if}
				</div>
			</li>
		{/each}
	</ol>
</div>

<style>
	.picture {
		position: relative;
		max-width: 52rem;
		margin: 0 auto;
	}
	img {
		display: block;
		width: 100%;
		height: auto;
	}
	.marker {
		position: absolute;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		padding: 0;
		transform: translate(-50%, -50%);
		border: 2px solid #fff;
		border-radius: 50%;
		/* Fixed colours: the markers sit on the picture, not on the page theme. */
		background: #102a43;
		box-shadow: 0 1px 4px rgb(0 0 0 / 0.35);
		color: #fff;
		font-size: 0.8rem;
		font-weight: 700;
		cursor: pointer;
		transition: transform 0.15s ease;
	}
	.marker:hover,
	.marker.on {
		background: #0b6e8a;
		transform: translate(-50%, -50%) scale(1.2);
		box-shadow:
			0 0 0 5px rgb(11 110 138 / 0.3),
			0 1px 4px rgb(0 0 0 / 0.35);
	}
	@media (max-width: 30rem) {
		.marker {
			width: 22px;
			height: 22px;
			font-size: 0.7rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.marker {
			transition: none;
		}
	}
	/* The stops: numbered like the markers, two columns on wide screens,
	   numbered down each column (1–4, 5–8) so the order reads naturally. */
	.stops {
		display: grid;
		gap: 0.25rem 2rem;
		margin: 1.25rem 0 0;
		padding: 0;
		list-style: none;
	}
	@media (min-width: 48rem) {
		.stops {
			grid-template-rows: repeat(4, auto);
			grid-auto-flow: column;
			grid-template-columns: 1fr 1fr;
		}
	}
	.stops li {
		display: flex;
		gap: 0.75rem;
		padding: 0.7rem 0.6rem;
		border-radius: var(--radius);
		transition: background 0.15s ease;
	}
	.stops li.on {
		background: var(--accent-soft);
	}
	@media (prefers-reduced-motion: reduce) {
		.stops li {
			transition: none;
		}
	}
	.num {
		display: grid;
		flex: none;
		place-items: center;
		width: 1.6rem;
		height: 1.6rem;
		margin-top: 0.05rem;
		border-radius: 50%;
		background: var(--text);
		color: var(--bg);
		font-size: 0.78rem;
		font-weight: 700;
	}
	.on .num {
		background: var(--accent);
		color: var(--accent-contrast);
	}
	h3 {
		margin: 0.1rem 0 0.2rem;
		font-size: 0.98rem;
	}
	.stops p {
		margin: 0 0 0.3rem;
		color: var(--text-2);
		font-size: 0.9rem;
		line-height: 1.5;
	}
	.more {
		font-size: 0.85rem;
		font-weight: 600;
	}
</style>
