<script lang="ts">
	// The Outlet mark (source: brand/src/mark.svg): farm nodes draining to one
	// gauge. Decorative next to the "Water Management" wordmark, so hidden from
	// assistive tech. Colours follow the theme tokens so it works in dark mode.
	let { size = 24 }: { size?: number } = $props();
	const small = $derived(size < 32);
</script>

<svg viewBox="0 0 120 120" width={size} height={size} aria-hidden="true" focusable="false">
	<g stroke="var(--brand-node)" stroke-width={small ? 8 : 4.5} stroke-linecap="round">
		{#if small}
			<path d="M26 22 60 86" />
			<path d="M94 28 60 86" />
		{:else}
			<path d="M22 24 40 50" />
			<path d="M58 16 40 50" />
			<path d="M40 50 60 88" />
			<path d="M96 30 78 60" />
			<path d="M78 60 60 88" />
		{/if}
	</g>
	<circle cx="60" cy={small ? 86 : 88} r={small ? 26 : 27} fill="none" stroke="var(--brand-outlet)" stroke-width="2.5" opacity="0.35" />
	<circle cx="60" cy={small ? 86 : 88} r="18.5" fill="none" stroke="var(--brand-outlet)" stroke-width="2.5" opacity="0.65" />
	{#if small}
		<circle cx="26" cy="22" r="11" fill="var(--brand-node)" />
		<circle cx="94" cy="28" r="11" fill="var(--brand-node)" />
	{:else}
		<circle cx="22" cy="24" r="7.5" fill="var(--brand-node)" />
		<circle cx="58" cy="16" r="7.5" fill="var(--brand-node)" />
		<circle cx="40" cy="50" r="7.5" fill="var(--brand-node)" />
		<circle cx="96" cy="30" r="7.5" fill="var(--brand-node)" />
		<circle cx="78" cy="60" r="7.5" fill="var(--brand-node)" />
	{/if}
	<circle cx="60" cy={small ? 86 : 88} r={small ? 14 : 11} fill="var(--brand-outlet)" />
</svg>
