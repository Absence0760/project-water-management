<!-- i18n-section: farm.whoDecides -->
<script lang="ts">
	// "Who decides about your farm's information" (POPIA s18(1)(b);
	// 168_team_privacy_contact; Privacy §2): the organisation responsible for
	// the catchment's information, and the person or office its members and
	// farmers ask about it, as the team's owners set it on the team's settings.
	// From the farm pages' menu. Without a contact it says to ask the WUA, and
	// links the privacy notice either way.
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, type ProjectPrivacyContact } from '$lib/api';
	import FarmShell from '$lib/components/farm/FarmShell.svelte';
	import FarmSkeleton from '$lib/components/farm/FarmSkeleton.svelte';
	import FarmStatus from '$lib/components/farm/FarmStatus.svelte';
	import { classify } from '$lib/components/farm/load';
	import { t } from '$lib/i18n/locale.svelte';

	const projectId = $derived(page.params.projectId ?? '');
	let info = $state<ProjectPrivacyContact | null>(null);
	/** The farm pages' states (FarmPage): a failure offers Try again, a contact line after the second; 403/404 is "removed". */
	let failed = $state<{ kind: 'removed' | 'error'; offline: boolean; attempts: number } | null>(null);
	let failures = 0;
	let generation = 0;

	function load(id: string) {
		const mine = ++generation;
		info = null;
		failed = null;
		api.farm
			.privacyContact(id)
			.then((r) => {
				if (mine !== generation) return;
				failures = 0;
				info = r;
			})
			.catch((err) => {
				if (mine !== generation) return;
				const why = classify(err);
				failed = why === 'removed' ? { kind: 'removed', offline: false, attempts: 1 } : { kind: 'error', offline: why === 'offline', attempts: ++failures };
			});
	}
	$effect(() => {
		const id = projectId;
		failures = 0;
		load(id);
		return () => {
			generation++;
		};
	});

	const title = $derived(t('Who decides about your farm’s information'));
</script>

<svelte:head><title>{t('{page} · My hydrological unit', { page: title })}</title></svelte:head>

<FarmShell {projectId} back={{ href: `${base}/farm/${encodeURIComponent(projectId)}`, label: t('My hydrological unit') }} busy={!info && !failed}>
	{#if failed?.kind === 'removed'}
		<FarmStatus kind="removed" />
	{:else if failed}
		<FarmStatus kind="error" offline={failed.offline} attempts={failed.attempts} retry={() => load(projectId)} />
	{:else}
		<h1>{title}</h1>
		{#if !info}
			<!-- The card's own height, so nothing shifts when it arrives (FarmSkeleton). -->
			<FarmSkeleton heights={[220]} />
		{:else}
			<section class="card" aria-labelledby="wd-h" data-ready="true">
				{#if info.contact}
					<h2 id="wd-h">{info.contact.organisation}</h2>
					<p>{t('{organisation} decides what is done with your farm’s information in this catchment. Ask them first about it, or to see, correct or delete it:', { organisation: info.contact.organisation })}</p>
					<p class="contact">
						<strong>{info.contact.name}</strong><br />
						<a href="mailto:{info.contact.email}">{info.contact.email}</a>
						{#if info.contact.postal}<br /><span class="postal">{info.contact.postal}</span>{/if}
					</p>
				{:else}
					<h2 id="wd-h">{info.wuaName ?? t('Your WUA')}</h2>
					<p>{t('The organisation that runs this catchment decides what is done with your farm’s information. It hasn’t added a contact here yet: ask the person who invited you, or your WUA.')}</p>
				{/if}
				<p>{t('We run the app for them. How we handle your information, and how to ask us:')} <a href="{base}/privacy#roles">{t('Privacy notice')}</a></p>
			</section>
		{/if}
	{/if}
</FarmShell>

<style>
	.contact {
		overflow-wrap: anywhere;
	}
	.postal {
		white-space: pre-line;
	}
</style>
