<script lang="ts">
	// The estimate line, before the first figure on every farm page (issue #47;
	// the CPA s49 research's R1): a callout at body size, not fine print, so a
	// farmer reads it before the numbers. The words are `disclaimer()`
	// (docs/legal/disclaimer-review.md § 3).
	import { disclaimer } from './cards';
</script>

<p class="estimate" role="note">
	<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 11 V16.5" /><path d="M12 7.5 V7.6" /></svg>
	<span>{disclaimer()}</span>
</p>

<style>
	.estimate {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		padding: 12px 14px;
		border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
		border-left: 3px solid var(--accent);
		border-radius: 8px;
		background: var(--accent-soft);
		color: var(--text-2);
		font-size: 16px;
		line-height: 1.45;
	}
	.estimate svg {
		flex-shrink: 0;
		margin-top: 2px;
		color: var(--accent);
	}
</style>
