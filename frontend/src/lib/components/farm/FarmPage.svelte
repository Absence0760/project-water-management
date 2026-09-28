<script lang="ts">
	// What every farm page (main, "Why?", dam) does around its figures: load
	// the farm (and again when the page becomes visible; never polled), the
	// preview banner, the saved-copy strip, and the loading, error, removed and
	// no-publication states (design §6.5, §9). The page renders its figures in
	// `children`, given the view.
	import { onMount, untrack, type Snippet } from 'svelte';
	import { base } from '$app/paths';
	import type { FarmView } from '@water-management/engine';
	import { previewBanner, savedStrip } from './cards';
	import FarmNoticeGate from './FarmNoticeGate.svelte';
	import FarmShell from './FarmShell.svelte';
	import FarmSkeleton from './FarmSkeleton.svelte';
	import FarmStatus from './FarmStatus.svelte';
	import type { FarmState } from './farmState.svelte';

	let {
		farm,
		projectId,
		asked,
		back = null,
		children
	}: {
		farm: FarmState;
		projectId: string;
		asked: string | null;
		back?: { href: string; label: string } | null;
		children: Snippet<[FarmView]>;
	} = $props();

	$effect(() => {
		const p = projectId;
		const n = asked;
		untrack(() => farm.load(p, n));
	});
	onMount(() => {
		const onVisible = () => {
			if (document.visibilityState === 'visible') farm.load(projectId, asked, { quiet: true, fresh: true });
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	});
	const retry = () => farm.load(projectId, asked, { fresh: true });

	const view = $derived(farm.phase.kind === 'ready' ? farm.view : null);
	const strip = $derived(
		view && farm.savedAt != null && (farm.offline || farm.updateFailed)
			? { text: savedStrip(farm.savedAt, farm.offline ? 'offline' : 'failed'), offline: farm.offline }
			: null
	);
	const preview = $derived(
		farm.preview && farm.farmName
			? { text: previewBanner(farm.farmName), href: `${base}/projects/${encodeURIComponent(projectId)}?tab=network` }
			: null
	);
</script>

<FarmShell {back} {preview} {strip} onretry={strip ? retry : undefined} busy={farm.phase.kind === 'loading'}>
	{#if farm.phase.kind === 'loading'}
		<FarmSkeleton />
	{:else if farm.phase.kind === 'error'}
		<FarmStatus kind="error" offline={farm.phase.offline} attempts={farm.phase.attempts} wuaName={farm.wuaName} {retry} />
	{:else if farm.phase.kind === 'removed'}
		<FarmStatus kind="removed" farmName={farm.farmName} wuaName={farm.wuaName} />
	{:else if farm.phase.kind === 'no-publication'}
		<FarmStatus kind="no-publication" farmName={farm.farmName} projectName={farm.projectName} wuaName={farm.wuaName} />
	{:else if view}
		<!-- "Before you look at your farm" instead of the figures, until acknowledged (FarmNoticeGate). -->
		<FarmNoticeGate preview={farm.preview}>{@render children(view)}</FarmNoticeGate>
	{/if}
</FarmShell>
