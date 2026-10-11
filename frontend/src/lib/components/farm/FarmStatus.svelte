<!-- i18n-section: farm -->
<script lang="ts">
	// The farm pages' non-figure states (design §6.5, boards 6 and 7): no
	// publication yet, access removed, and the error with Try again (the
	// contact line after a second failure). No raw error text (CLAUDE.md rule 6).
	import { base } from '$app/paths';
	import { t } from '$lib/i18n/locale.svelte';
	import { contactText, stateText, stillFailing } from './cards';
	import { farmHref } from './load';

	let {
		kind,
		farmName = null,
		projectName = null,
		wuaName = null,
		offline = false,
		attempts = 1,
		title = null,
		retry,
		projectId = null,
		farms = []
	}: {
		kind: 'no-publication' | 'removed' | 'not-yours' | 'error';
		farmName?: string | null;
		projectName?: string | null;
		/** The WUA the contact lines name (project.wuaName); null says "your WUA". */
		wuaName?: string | null;
		offline?: boolean;
		attempts?: number;
		/** The error's title where the page isn't a farm's figures (who-decides); else "We couldn't load your hydrological unit". */
		title?: string | null;
		retry?: () => void;
		/** not-yours: the catchment, and the farmer's own units in it, to go to instead. */
		projectId?: string | null;
		farms?: { nodeId: string; name: string }[];
	} = $props();
</script>

{#if kind === 'error'}
	<div class="error" role="alert">
		<h1>{title ?? stateText('errorTitle')}</h1>
		<p>{stateText('errorText')}</p>
		{#if retry}<button type="button" class="btn btn-primary" onclick={retry}>{t('Try again')}</button>{/if}
		{#if attempts > 1}<p>{stillFailing(offline, wuaName)}</p>{/if}
	</div>
{:else if kind === 'removed'}
	<h1>{farmName ?? t('Your hydrological unit')}</h1>
	<p role="alert">{contactText('removed', wuaName)}</p>
	<a class="link" href="{base}/farm">{t('Your hydrological units')}</a>
{:else if kind === 'not-yours'}
	<!-- A link to a unit that isn't theirs, in a catchment they still see: say so without "no longer", and offer their own units here. -->
	<h1>{t('Your hydrological unit')}</h1>
	<p role="alert">{contactText('notYours', wuaName)}</p>
	{#if projectId && farms.length}
		<nav class="mine" aria-labelledby="mine-h">
			<h2 id="mine-h">{t('Your hydrological units in this catchment')}</h2>
			{#each farms as f (f.nodeId)}<a class="link" href={farmHref(base, projectId, f.nodeId, true)}>{f.name}</a>{/each}
		</nav>
	{/if}
	<a class="link" href="{base}/farm">{t('Your hydrological units')}</a>
{:else}
	<div>
		<h1>{farmName ?? t('Your hydrological unit')}</h1>
		{#if projectName}<p class="sub">{projectName}</p>{/if}
	</div>
	<section class="card empty" aria-labelledby="empty-h">
		<svg width="36" height="36" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3 C12 3 6 10 6 14 a6 6 0 0 0 12 0 C18 10 12 3 12 3 Z" /></svg>
		<h2 id="empty-h">{stateText('noPublication')}</h2>
		<p>{stateText('noPublicationText')}</p>
	</section>
	<p class="sub">{contactText('contact', wuaName)}</p>
{/if}

<style>
	.error {
		display: flex;
		flex-direction: column;
		gap: 12px;
		align-items: flex-start;
	}
	.error .btn {
		min-height: var(--tap);
		padding: 0 20px;
		font-size: 16px;
	}
	.empty {
		align-items: center;
		text-align: center;
		border-style: dashed;
		border-color: var(--border-strong);
		padding: 24px 16px;
		color: var(--text-2);
	}
	.empty h2 {
		color: var(--text);
	}
	.mine {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
	}
</style>
