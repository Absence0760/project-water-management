<script lang="ts">
	// One app screen on the landing page (issue #57): captured from the app on
	// the example catchments by `pnpm gen:landing-art` (e2e/art/), light and
	// dark, AVIF with a WebP fallback. The dark capture shows in dark mode.
	import { base } from '$app/paths';

	let {
		name,
		width,
		height,
		widths,
		sizes,
		alt
	}: { name: string; width: number; height: number; widths: readonly number[]; sizes: string; alt: string } = $props();

	const set = (theme: 'light' | 'dark', type: 'avif' | 'webp') => widths.map((w) => `${base}/landing/screen-${name}-${theme}-${w}.${type} ${w}w`).join(', ');
</script>

<picture>
	<source type="image/avif" media="(prefers-color-scheme: dark)" srcset={set('dark', 'avif')} {sizes} />
	<source type="image/webp" media="(prefers-color-scheme: dark)" srcset={set('dark', 'webp')} {sizes} />
	<source type="image/avif" srcset={set('light', 'avif')} {sizes} />
	<img src="{base}/landing/screen-{name}-light-{widths[0]}.webp" srcset={set('light', 'webp')} {sizes} {width} {height} {alt} loading="lazy" decoding="async" />
</picture>

<style>
	picture,
	img {
		display: block;
		width: 100%;
		height: auto;
	}
</style>
