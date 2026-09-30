<script lang="ts">
	// An evidence pack's status as a badge (WP-3.14): the word, with the tone
	// repeating it (never the colour alone). The Applications list, the
	// Application panel, the evidence report's pack list, the pack view and
	// the verify page use it.
	import type { PackStatus } from '$lib/api';
	import { PACK_STATUS_LABEL, PACK_STATUS_TONE } from './pack';

	let { status, version = null }: { status: PackStatus; version?: number | null } = $props();
</script>

<span class="pack-badge tone-{PACK_STATUS_TONE[status]}" data-testid="pack-badge" data-status={status}
	>{version === null ? '' : `v${version} `}{PACK_STATUS_LABEL[status]}</span
>

<style>
	.pack-badge {
		display: inline-block;
		padding: 0.05rem 0.5rem;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		font-size: 0.8rem;
		font-weight: 600;
		line-height: 1.4;
		background: var(--surface-2);
		color: var(--text-2);
		white-space: nowrap;
	}
	.tone-awaiting {
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--text);
	}
	.tone-good {
		background: var(--success-soft);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
		color: var(--success);
	}
	.tone-mixed {
		background: var(--warning-soft);
		border-color: color-mix(in srgb, var(--warning) 40%, transparent);
		color: var(--warning);
	}
	.tone-bad {
		background: var(--danger-soft);
		border-color: color-mix(in srgb, var(--danger) 40%, transparent);
		color: var(--danger);
	}
	@media print {
		.pack-badge {
			color: #000;
			background: none;
			border-color: #000;
		}
	}
</style>
