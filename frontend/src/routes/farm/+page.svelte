<!-- i18n-section: farm -->
<script lang="ts">
	// "Your farms" (docs/design/farmer-view.md §6.5 board 9): every farm linked
	// to this user, across projects, with its notice level, received % and dam
	// %. A farmer with one farm goes straight to its page. The root page sends
	// a user whose every membership is `farmer` here.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import type { FarmIndex, FarmView } from '@water-management/engine';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import FarmShell from '$lib/components/farm/FarmShell.svelte';
	import FarmNoticeGate from '$lib/components/farm/FarmNoticeGate.svelte';
	import FarmSkeleton from '$lib/components/farm/FarmSkeleton.svelte';
	import FarmStatus from '$lib/components/farm/FarmStatus.svelte';
	import { farmSummaryLine, farmsPrivacy, levelWord } from '$lib/components/farm/cards';
	import { t } from '$lib/i18n/locale.svelte';
	import { classify, farmHref } from '$lib/components/farm/load';
	import { readSaved } from '$lib/components/farm/savedCopy';

	interface Row {
		projectId: string;
		projectName: string;
		nodeId: string;
		name: string;
		several: boolean;
		publication: FarmIndex['publication'];
		view: FarmView | null;
	}

	let rows = $state<Row[] | null>(null);
	let hasOther = $state(false);
	let failed = $state<{ offline: boolean; attempts: number } | null>(null);
	/** Failed loads in a row: the error state adds a contact line after the second. */
	let failures = 0;

	async function load() {
		failed = null;
		rows = null;
		try {
			const projects = await api.projects.list();
			const mine = projects.filter((p) => p.role === 'farmer');
			hasOther = projects.length > mine.length;
			const indexes = await Promise.allSettled(mine.map((p) => api.farm.index(p.id)));
			// A project the farmer just lost (403/404) is left out; any other failure
			// with nothing to show is the error state, not "no farm linked".
			const failure = indexes.find((r) => r.status === 'rejected' && classify(r.reason) !== 'removed');
			const list: Row[] = [];
			indexes.forEach((r, i) => {
				if (r.status !== 'fulfilled') return;
				const ix = r.value;
				for (const f of ix.farms) {
					list.push({
						projectId: mine[i]!.id,
						projectName: ix.project.name,
						nodeId: f.nodeId,
						name: f.name,
						several: ix.farms.length > 1,
						publication: ix.publication,
						view: null
					});
				}
			});
			if (!list.length && failure) throw (failure as PromiseRejectedResult).reason;
			if (list.length === 1) {
				await goto(farmHref(base, list[0]!.projectId, list[0]!.nodeId, false), { replaceState: true });
				return;
			}
			failures = 0;
			rows = list;
			// The figures on each card: live when published, else the phone's saved copy.
			const user = session.user?.id ?? null;
			await Promise.all(
				list.map(async (row, i) => {
					if (!row.publication) return;
					const view = await api.farm.view(row.projectId, row.nodeId).catch(() =>
						user ? (readSaved(user, row.projectId, row.nodeId)?.view ?? null) : null
					);
					if (rows && rows[i]) rows[i]!.view = view;
				})
			);
		} catch (e) {
			failed = { offline: classify(e) === 'offline', attempts: ++failures };
		}
	}
	onMount(load);
</script>

<svelte:head><title>{t('{page} · My hydrological unit', { page: t('Your hydrological units') })}</title></svelte:head>

<FarmShell title={t('My hydrological units')} busy={rows == null && !failed}>
	{#if failed}
		<FarmStatus kind="error" offline={failed.offline} attempts={failed.attempts} retry={load} />
	{:else if rows == null}
		<FarmSkeleton />
	{:else if rows.length === 0}
		<h1>{t('Your hydrological units')}</h1>
		<p>{t('No hydrological unit is linked to your account yet. Your WUA links your hydrological unit to your account.')}</p>
		{#if hasOther}<a class="link" href="{base}/">{t('Your projects')}</a>{/if}
	{:else}
		<!-- "Before you look at your farm" first, until acknowledged: this list carries figures too. -->
		<FarmNoticeGate>
			<h1>{t('Your hydrological units')}</h1>
			<ul class="farms">
				{#each rows as r (r.projectId + '/' + r.nodeId)}
					<li>
						<a href={farmHref(base, r.projectId, r.nodeId, r.several)}>
							<span class="top">
								<strong>{r.name}</strong>
								{#if r.publication}<span class="level {r.publication.restriction.level}">{levelWord(r.publication.restriction.level)}</span>{/if}
							</span>
							<span class="sub">{r.projectName}</span>
							<span>{r.publication ? (r.view ? farmSummaryLine(r.view.farm) : '') : t('Not published yet')}</span>
						</a>
					</li>
				{/each}
			</ul>
			<p class="fine">{farmsPrivacy()}</p>
		</FarmNoticeGate>
	{/if}
</FarmShell>

<style>
	.farms {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.farms a {
		min-height: var(--tap);
		padding: 16px;
		border-radius: 8px;
		background: var(--surface);
		border: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 4px;
		color: var(--text);
		text-decoration: none;
	}
	.farms a:hover {
		border-color: var(--accent);
	}
	.top {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 8px;
		font-size: 17px;
	}
	.level {
		padding: 2px 10px;
		border-radius: 999px;
		font-size: 14px;
		font-weight: 600;
		border: 1px solid;
	}
	.level.advisory {
		color: var(--warning);
		background: var(--warning-soft);
	}
	.level.restricted {
		color: var(--danger);
		background: var(--danger-soft);
	}
	.level.none {
		color: var(--success);
		background: var(--success-soft);
	}
</style>
