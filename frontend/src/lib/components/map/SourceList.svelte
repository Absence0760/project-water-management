<!--
	The files imported onto the map (issue #326 E5): name, feature count, when
	and by whom, and the file's SHA-256 cut to 12 characters (the full hash is
	the tooltip and what Copy puts on the clipboard), so it no longer wraps on
	a phone. In the upload sheet, and for everyone in Every feature.
-->
<script lang="ts">
	import type { MapSource } from '$lib/api';
	import { fmtDate } from '$lib/format/number';
	import { shortHash } from './mapList';

	let { sources }: { sources: MapSource[] } = $props();

	let copied = $state<string | null>(null);
	let failed = $state<string | null>(null);
	async function copy(s: MapSource) {
		failed = null;
		try {
			await navigator.clipboard.writeText(s.sha256);
			copied = s.id;
		} catch {
			copied = null;
			failed = s.id;
		}
	}
</script>

<ul class="sources" data-testid="map-sources">
	{#each sources as s (s.id)}
		<li>
			<span><strong>{s.fileName}</strong> · {s.features} feature{s.features === 1 ? '' : 's'} · {fmtDate(s.importedAt, true)}{s.importedBy ? ` by ${s.importedBy}` : ''}</span>
			<span class="hash">
				<span class="small muted">SHA-256</span>
				<code title={s.sha256} data-testid="map-source-hash">{shortHash(s.sha256)}…</code>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => copy(s)}>
					Copy<span class="visually-hidden"> the SHA-256 of {s.fileName}</span>
				</button>
				<span class="small muted" role="status">{copied === s.id ? 'Copied' : failed === s.id ? 'Couldn’t copy: select it from the tooltip' : ''}</span>
			</span>
		</li>
	{/each}
</ul>

<style>
	.sources {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.6rem;
	}
	li {
		display: grid;
		gap: 0.15rem;
		overflow-wrap: anywhere;
	}
	.hash {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
	}
	code {
		font-size: 0.85rem;
	}
</style>
