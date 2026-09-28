<script lang="ts">
	// "Published by the WUA on 12 Jan 2024. Data up to 10 Jan 2024." on every
	// farm screen, amber with a clock icon when stale (design §2, §6.1).
	import type { DatesLine } from './cards';

	let { line }: { line: DatesLine } = $props();
</script>

<p class="dates" class:stale={line.stale}>
	{#if line.stale}
		<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9" /><path d="M12 7 V12 L15 14" /></svg>
	{/if}
	<span>{line.text}</span>
</p>
