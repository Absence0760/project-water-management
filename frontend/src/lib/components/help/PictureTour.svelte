<script lang="ts">
	// A help illustration with numbered stops: the picture (one shot of the
	// Blender scene, $lib/help/pictures) with numbered markers, and under it
	// the numbered list of stops, which is the full text. The markers are a
	// pointer shortcut for the same list, so they are out of the tab order and
	// hidden from screen readers. Clicking a marker lights its stop and brings
	// it into view; hovering or focusing a stop lights its marker.
	//
	// A stop with `more` has a "Show more" button that opens it in place,
	// across the full width: key points beside a close-up of that part of the
	// scene, or a diagram.
	import { base } from '$app/paths';
	import Diagram from '$lib/components/help/Diagram.svelte';
	import RichText from '$lib/components/help/RichText.svelte';
	import { guideFor, type PictureStop } from '$lib/help/guides';
	import { SHOTS, SHOT_ALT, pictureSrc, pictureSrcset, type ShotId } from '$lib/help/pictures';

	let {
		shot,
		stops,
		sizes = '(min-width: 64rem) 52rem, 100vw',
		columns = 2
	}: { shot: ShotId; stops: PictureStop[]; sizes?: string; columns?: 1 | 2 } = $props();

	const uid = $props.id();
	const pic = $derived(SHOTS[shot]);
	let selected = $state<string | null>(null);
	let expanded = $state<Record<string, boolean>>({});

	function pick(spot: string) {
		selected = spot;
		document.getElementById(`${uid}-${spot}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}
</script>

<div class="tour">
	<div class="picture">
		<img
			src="{base}{pictureSrc(shot)}"
			srcset={pictureSrcset(shot, base)}
			{sizes}
			width={pic.width}
			height={pic.height}
			alt={SHOT_ALT[shot]}
		/>
		<div class="markers" aria-hidden="true">
			{#each stops as stop, i (stop.spot)}
				{@const at = pic.spots[stop.spot]}
				{#if at}
					<button
						type="button"
						tabindex="-1"
						class="marker"
						class:on={selected === stop.spot}
						style:left="{at.x}%"
						style:top="{at.y}%"
						onclick={() => pick(stop.spot)}>{i + 1}</button
					>
				{/if}
			{/each}
		</div>
	</div>

	<ol class="stops" class:two={columns === 2}>
		{#each stops as stop, i (stop.spot)}
			{@const guide = stop.guide ? guideFor(stop.guide) : undefined}
			{@const open = !!expanded[stop.spot]}
			<!-- Hover or focus a stop to light its marker on the picture. -->
			<li
				id="{uid}-{stop.spot}"
				class:on={selected === stop.spot}
				class:open
				onmouseenter={() => (selected = stop.spot)}
				onfocusin={() => (selected = stop.spot)}
			>
				<span class="num" aria-hidden="true">{i + 1}</span>
				<div class="body">
					<h3>{stop.title}</h3>
					<p><RichText text={stop.text} /></p>
					{#if stop.more}
						<div id="{uid}-{stop.spot}-more" class="more" hidden={!open}>
							<div class="more-grid" class:with-pic={stop.more.shot}>
								{#if stop.more.shot}
									<img
										class="closeup"
										src="{base}{pictureSrc(stop.more.shot, SHOTS[stop.more.shot].width / 2)}"
										srcset={pictureSrcset(stop.more.shot, base)}
										sizes="(min-width: 64rem) 22rem, 100vw"
										width={SHOTS[stop.more.shot].width}
										height={SHOTS[stop.more.shot].height}
										alt={SHOT_ALT[stop.more.shot]}
										loading="lazy"
									/>
								{/if}
								<ul class="points">
									{#each stop.more.points as point, j (j)}<li><RichText text={point} /></li>{/each}
								</ul>
							</div>
							{#if stop.more.diagram && open}
								<Diagram id={stop.more.diagram} caption="" />
							{/if}
						</div>
					{/if}
					<p class="actions">
						{#if stop.more}
							<button
								type="button"
								class="toggle"
								aria-expanded={open}
								aria-controls="{uid}-{stop.spot}-more"
								aria-label="{open ? 'Show less' : 'Show more'}: {stop.title}"
								onclick={() => (expanded[stop.spot] = !open)}>{open ? 'Show less' : 'Show more'}</button
							>
						{/if}
						{#if guide}<a href="{base}/help/guides/{guide.id}">{guide.title} →</a>{/if}
					</p>
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
	.picture img {
		display: block;
		width: 100%;
		height: auto;
		border-radius: var(--radius);
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
	/* The stops, numbered like the markers. Two columns on wide screens,
	   in reading order (1 2 / 3 4 …); an opened stop takes the full width. */
	.stops {
		display: grid;
		gap: 0.25rem 2rem;
		margin: 1.25rem 0 0;
		padding: 0;
		list-style: none;
	}
	@media (min-width: 48rem) {
		.stops.two {
			grid-template-columns: 1fr 1fr;
		}
		.stops.two > li.open {
			grid-column: 1 / -1;
		}
	}
	.stops > li {
		display: flex;
		gap: 0.75rem;
		padding: 0.7rem 0.6rem;
		border-radius: var(--radius);
		transition: background 0.15s ease;
	}
	.stops > li.on {
		background: var(--accent-soft);
	}
	.stops > li.open {
		background: var(--surface);
		border: 1px solid var(--border);
	}
	@media (prefers-reduced-motion: reduce) {
		.marker,
		.stops > li {
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
	.body {
		min-width: 0;
		flex: 1;
	}
	h3 {
		margin: 0.1rem 0 0.2rem;
		font-size: 0.98rem;
	}
	.body > p {
		margin: 0 0 0.3rem;
		color: var(--text-2);
		font-size: 0.9rem;
		line-height: 1.5;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 1rem;
		font-size: 0.85rem;
		font-weight: 600;
	}
	.toggle {
		min-height: 24px;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font: inherit;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.more {
		margin: 0.6rem 0 0.5rem;
	}
	.more-grid {
		display: grid;
		gap: 0.75rem 1.25rem;
		align-items: start;
	}
	@media (min-width: 48rem) {
		.more-grid.with-pic {
			grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
		}
	}
	.closeup {
		display: block;
		width: 100%;
		height: auto;
		border-radius: var(--radius);
	}
	.points {
		margin: 0;
		padding-left: 1.1rem;
		color: var(--text-2);
		font-size: 0.9rem;
		line-height: 1.5;
	}
	.points li + li {
		margin-top: 0.35rem;
	}
</style>
