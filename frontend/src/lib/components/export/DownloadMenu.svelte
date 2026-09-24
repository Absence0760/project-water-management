<script lang="ts">
	// "Download ▾" disclosure: a button that reveals a list of export links
	// (docs/api.md § Export). Each entry is fetched with the session cookie and
	// saved under the server's file name; errors (e.g. 413 too large) show inline.
	// Build `items` with the helpers in $lib/export (runDownloadItems, downloads.*).
	import { fetchDownload, saveBlob } from '$lib/export/download';
	import { menuPlacement, placementStyle } from '$lib/export/menuPosition';
	import type { DownloadItem } from '$lib/export/urls';

	let {
		items,
		label = 'Download',
		align = 'end'
	}: { items: DownloadItem[]; label?: string; align?: 'start' | 'end' } = $props();

	let open = $state(false);
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);
	let done = $state<string | null>(null);
	let root: HTMLDivElement | undefined = $state();
	let trigger: HTMLButtonElement | undefined = $state();
	let list: HTMLUListElement | undefined = $state();
	// Fixed to the viewport while open, so a scrolling table can't clip it (./menuPosition.ts).
	let listStyle = $state('');
	const listId = `dl-${Math.random().toString(36).slice(2, 9)}`;

	function close(focusTrigger = false) {
		open = false;
		if (focusTrigger) trigger?.focus();
	}

	async function get(item: DownloadItem) {
		busy = item.url;
		error = null;
		done = null;
		try {
			const { blob, filename } = await fetchDownload(item.url);
			saveBlob(blob, filename);
			done = `Downloaded ${filename}`;
			close(true);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = null;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			e.stopPropagation();
			close(true);
		}
	}

	// Close when focus or a click leaves the widget.
	function onFocusOut(e: FocusEvent) {
		if (open && root && !root.contains(e.relatedTarget as Node | null)) open = false;
	}
	$effect(() => {
		if (!open) return;
		const onDoc = (e: PointerEvent) => {
			if (root && !root.contains(e.target as Node)) open = false;
		};
		// A fixed list would drift from its button on scroll or resize: close it, as native menus do.
		// Scrolling the list itself is fine.
		const onScroll = (e: Event) => {
			if (!list?.contains(e.target as Node)) open = false;
		};
		const onResize = () => (open = false);
		document.addEventListener('pointerdown', onDoc);
		window.addEventListener('scroll', onScroll, { capture: true, passive: true });
		window.addEventListener('resize', onResize);
		return () => {
			document.removeEventListener('pointerdown', onDoc);
			window.removeEventListener('scroll', onScroll, { capture: true });
			window.removeEventListener('resize', onResize);
		};
	});

	function toggle() {
		if (!open && trigger) {
			const r = trigger.getBoundingClientRect();
			listStyle = placementStyle(menuPlacement(r, { width: document.documentElement.clientWidth, height: window.innerHeight }, align));
		}
		open = !open;
		error = null;
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="download" bind:this={root} onkeydown={onKeydown} onfocusout={onFocusOut}>
	<button
		type="button"
		class="btn btn-sm"
		bind:this={trigger}
		aria-expanded={open}
		aria-controls={listId}
		disabled={!items.length}
		onclick={toggle}
	>
		<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
			<path d="M8 2v8m0 0 3.2-3.2M8 10 4.8 6.8M3 13h10" stroke-linecap="round" stroke-linejoin="round" />
		</svg>
		{label}
		<span aria-hidden="true" class="caret">▾</span>
	</button>

	<ul id={listId} class="list" hidden={!open} style={listStyle} bind:this={list}>
		{#each items as item (item.url)}
			<li>
				<button type="button" class="item" onclick={() => get(item)} disabled={busy !== null} aria-busy={busy === item.url}>
					<span class="label">{item.label}{busy === item.url ? ' — preparing…' : ''}</span>
					{#if item.hint}<span class="hint">{item.hint}</span>{/if}
				</button>
			</li>
		{/each}
	</ul>

	<p class="msg" role="status" aria-live="polite">
		{#if error}<span class="err">{error}</span>{:else if done}<span class="visually-hidden">{done}</span>{/if}
	</p>
</div>

<style>
	.download {
		position: relative;
		display: inline-block;
	}
	.caret {
		font-size: 0.75em;
		color: var(--text-muted);
	}
	.list {
		/* top/bottom, left/right and max-height come from menuPlacement on open. */
		position: fixed;
		z-index: 30;
		min-width: 16rem;
		max-width: min(24rem, calc(100vw - 2 * var(--gutter)));
		overflow-y: auto;
		margin: 0;
		padding: 0.25rem;
		list-style: none;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.12);
	}
	.list[hidden] {
		display: none;
	}
	.item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		width: 100%;
		padding: 0.4rem 0.6rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.item:hover:not(:disabled),
	.item:focus-visible {
		background: var(--row-hover);
	}
	.item:disabled {
		cursor: progress;
		opacity: 0.7;
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.msg {
		margin: 0;
	}
	.err {
		display: block;
		margin-top: 0.3rem;
		max-width: 24rem;
		font-size: 0.85rem;
		color: var(--danger);
	}
</style>
