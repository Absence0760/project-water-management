<!-- i18n-section: share.pack -->
<script lang="ts">
	// An evidence pack link's page (WP-3.15, the pack half; 128_pack_share_notes;
	// docs/ui.md § Share page): an issued licensing evidence pack, read-only,
	// for someone outside the project. What the verify page shows (its
	// standing, code, hashes and signers), and while it stands the Reserve at
	// each EWR site, the river's rows of its change table and the paired
	// change by month, all from the pack's own frozen report. Once withdrawn
	// or superseded it says so, and why or which version replaced it, and
	// shows no figure. Public comments as on an application's link
	// (./ShareComments.svelte), while the pack stands. Every word is in
	// ./pack.ts, ./ShareComments.svelte or t() here.
	import { base } from '$app/paths';
	import type { SharePack } from '$lib/api/types';
	import { t } from '$lib/i18n/locale.svelte';
	import { bandLine, monthRows, packSiteRows, packStatusLine, rowChange, rowLabel, rowValue, signerLine, standingNote, successorCode } from './pack';
	import ShareComments from './ShareComments.svelte';
	import { shareCaveat } from './share';

	let { view, token }: { view: SharePack; token: string } = $props();

	const v = $derived(view.verify);
	const fig = $derived(view.figures);
	const application = $derived(view.pack.mode === 'application');
	const standing = $derived(standingNote(v));
	const successor = $derived(successorCode(v));
	const sites = $derived(fig ? packSiteRows(fig.river, application) : []);
	const months = $derived(fig?.byMonth ? monthRows(fig.byMonth) : []);
	/** Comments are open only while the pack stands (the server holds the rule: issued, with a live link). */
	const open = $derived(v.status === 'issued');

</script>

<div class="head">
	<h1>{view.pack.title}</h1>
	<p class="sub">{t('Licensing evidence pack, version {version}, shared read-only', { version: view.pack.version })}</p>
	<p class="dates" data-testid="share-pack-status" data-status={v.status}>{packStatusLine(v)}</p>
	<p class="caveat" data-testid="share-caveat">{shareCaveat()}</p>
</div>

{#if standing}
	<section class="card standing" aria-labelledby="standing-h" data-testid="share-pack-standing">
		<h2 id="standing-h">{v.status === 'withdrawn' ? t('This pack was withdrawn') : t('This pack was replaced')}</h2>
		<p role="status">{standing}</p>
		{#if v.status === 'withdrawn' && v.withdrawnReason}
			<p>{t('The reason given:')}</p>
			<p class="desc" data-testid="share-pack-reason">{v.withdrawnReason}</p>
		{/if}
		{#if successor}
			<p>{t('The version that replaced it has the code {code}.', { code: successor })} <a href="{base}/verify/{encodeURIComponent(successor)}">{t('Check it on the verify page')}</a></p>
		{/if}
	</section>
{/if}

<div class="cols">
	<div class="col">
		{#if fig}
			<section class="card" aria-labelledby="pk-ewr-h" data-testid="share-pack-ewr">
				<h2 id="pk-ewr-h">{t('The river’s ecological reserve')}</h2>
				<p class="sub">
					{application
						? t('Months the Reserve is met at each EWR site: the baseline beside this application, as the pack records them.')
						: t('Months the Reserve is met at each EWR site, as the pack records them.')}
				</p>
				<ul class="ewr">
					{#each sites as r, i (i)}
						<li class="ewr-site {r.trend}">
							<p class="place">{r.place}</p>
							<dl>
								<dt>{t('Baseline')}</dt>
								<dd>{r.base}</dd>
								{#if r.withApp !== null}
									<dt>{t('With this application')}</dt>
									<dd>{r.withApp}</dd>
								{/if}
							</dl>
							{#if r.change}<p class="change">{r.change}</p>{/if}
						</li>
					{:else}
						<li class="fine">{t('No EWR site has a Reserve rule table in this catchment.')}</li>
					{/each}
				</ul>
			</section>

			<section class="card" aria-labelledby="pk-rows-h" data-testid="share-pack-rows">
				<h2 id="pk-rows-h">{t('The river in figures')}</h2>
				<div class="table-scroll">
					<table class="numbers">
						<thead>
							<tr>
								<th scope="col"><span class="visually-hidden">{t('Figure')}</span></th>
								<th scope="col">{t('Baseline')}</th>
								{#if application}<th scope="col">{t('With this application')}</th><th scope="col">{t('Change')}</th>{/if}
							</tr>
						</thead>
						<tbody>
							{#each fig.rows as r, i (i)}
								<tr>
									<th scope="row">
										{rowLabel(r)}
										{#if r.notAssessed}<span class="fine block">{t('Not assessed')}</span>{/if}
										{#if application && bandLine(r.id, r.change?.band ?? null)}<span class="fine block">{bandLine(r.id, r.change?.band ?? null)}</span>{/if}
									</th>
									<td>{rowValue(r.id, r.baseline)}</td>
									{#if application}<td>{rowValue(r.id, r.application)}</td><td>{rowChange(r.id, r.change?.run ?? null)}</td>{/if}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if !fig.volumes}
					<p class="fine">{t('Flow volumes aren’t shown for this catchment: with so few hydrological units, or with a change to the shared baseline, they could reveal a hydrological unit’s water use.')}</p>
				{/if}
			</section>

			{#if application && months.length}
				<section class="card" aria-labelledby="pk-month-h">
					<h2 id="pk-month-h">{t('Days below the EWR by month')}</h2>
					<p class="sub">{t('The change this application makes to the days below the EWR at the outlet, each calendar month.')}</p>
					<div class="table-scroll">
						<table class="numbers">
							<thead>
								<tr><th scope="col">{t('Month')}</th><th scope="col">{t('Change')}</th></tr>
							</thead>
							<tbody>
								{#each months as m (m.month)}
									<tr><th scope="row">{m.month}{#if m.range}<span class="fine block">{m.range}</span>{/if}</th><td>{m.change}</td></tr>
								{/each}
							</tbody>
						</table>
					</div>
				</section>
			{/if}
		{/if}

		<section class="card" aria-labelledby="pk-check-h" data-testid="share-pack-check">
			<h2 id="pk-check-h">{t('Check this pack')}</h2>
			<p>{t('Its code is {code}. Anyone holding a copy of the pack can check it against this app on the verify page.', { code: view.pack.shortCode })}</p>
			<p><a href="{base}/verify/{encodeURIComponent(view.pack.shortCode)}" data-testid="share-pack-verify">{t('Open the verify page')}</a></p>
			<dl class="hashes">
				<dt>{t('Manifest SHA-256')}</dt>
				<dd class="mono">{v.manifestSha256}</dd>
				{#if v.pdfSha256}<dt>{t('PDF SHA-256')}</dt><dd class="mono">{v.pdfSha256}</dd>{/if}
				{#if v.bundleSha256}<dt>{t('Reproduction bundle SHA-256')}</dt><dd class="mono">{v.bundleSha256}</dd>{/if}
			</dl>
			{#if v.signers.length}
				<p>{t('Signed by:')}</p>
				<ul class="signers">
					{#each v.signers as s, i (i)}<li>{signerLine(s)}</li>{/each}
				</ul>
			{/if}
		</section>
	</div>

	<div class="col">
		<ShareComments {token} kind="pack" initial={view.comments} objection={view.objection} {open} closed={t('Commenting is closed: this pack no longer stands.')} />

		<section class="card" aria-labelledby="about-pk-h">
			<h2 id="about-pk-h">{t('About this page')}</h2>
			<p>{t('A licensing evidence pack: the model results an applicant attaches to a water-use licence application, signed by a registered professional and fixed once issued. This page shows part of it, read-only, and names no hydrological unit.')}</p>
			<p class="fine">{t('This link works until it expires or is withdrawn. If the pack is withdrawn or replaced, the link says so instead of showing its figures.')}</p>
			<p class="fine">{t('It is not a water-use authorisation, licence, allocation or restriction under the National Water Act: only the responsible authority and the Water User Association’s own notices decide those. Don’t rely on it alone for a decision.')}</p>
			<p class="fine legal-links"><a href="{base}/terms">{t('Terms of use')}</a> · <a href="{base}/privacy">{t('Privacy notice')}</a></p>
		</section>
	</div>
</div>

<style>
	.cols,
	.col {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}
	@container share (min-width: 860px) {
		.cols {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			align-items: start;
		}
	}
	.standing {
		border-left: 4px solid var(--danger);
	}
	.ewr,
	.signers {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 10px;
	}
	.ewr-site {
		border-left: 4px solid var(--border-strong);
		padding: 4px 0 4px 10px;
	}
	.ewr-site.worse {
		border-left-color: var(--danger);
	}
	.ewr-site.better {
		border-left-color: var(--success);
	}
	.place {
		font-weight: 600;
		margin: 0;
	}
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px 10px;
		margin: 4px 0;
	}
	dt {
		color: var(--text-2);
	}
	dd {
		margin: 0;
		min-width: 0;
	}
	.change {
		margin: 0;
		font-weight: 500;
	}
	.worse .change {
		color: var(--danger);
	}
	.hashes {
		grid-template-columns: 1fr;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	.block {
		display: block;
	}
	.desc,
	.body {
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.table-scroll {
		overflow-x: auto;
	}
</style>
