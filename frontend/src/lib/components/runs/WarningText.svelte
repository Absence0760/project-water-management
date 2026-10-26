<!--
	One run warning, with each place it names ("Model settings → Rain gaps",
	"Calibration → Plausibility checks") a link to that panel (warningText.ts,
	issue #586 D19). Without `placeHref` (the printable report) it is the plain
	words.
-->
<script lang="ts">
	import type { WarningPlace } from '@water-management/engine';
	import { warningParts } from './warningText';

	let { text, placeHref = null }: { text: string; placeHref?: ((place: WarningPlace) => string) | null } = $props();
	const parts = $derived(placeHref ? warningParts(text, placeHref) : [{ text }]);
</script>

{#each parts as p, i (i)}{#if p.href}<a href={p.href}>{p.text}</a>{:else}{p.text}{/if}{/each}
