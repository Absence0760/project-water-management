<script lang="ts">
	// The Confluence mark (source: brand/src/mark.svg). Decorative next to the
	// "Water Management" wordmark, so hidden from assistive tech.
	let { size = 24 }: { size?: number } = $props();
</script>

<svg viewBox="0 0 120 120" width={size} height={size} aria-hidden="true" focusable="false">
	<path d="M60 8C60 8 22 50 22 76a38 38 0 0 0 76 0C98 50 60 8 60 8Z" fill="var(--brand-teal)" />
	<g fill="none" stroke="#e8f4f2" stroke-width={size < 32 ? 7 : 4.5} stroke-linecap="round" stroke-linejoin="round">
		{#if size < 32}
			<path d="M60 104V76L42 54" />
			<path d="M60 76 80 52" />
		{:else}
			<path d="M60 104V74L44 56 38 40" />
			<path d="M44 56 54 40" />
			<path d="M60 74 76 54 74 36" />
			<path d="M76 54 86 46" />
		{/if}
	</g>
	<circle cx="60" cy="104" r={size < 32 ? 8 : 5} fill="var(--brand-ochre)" />
</svg>
