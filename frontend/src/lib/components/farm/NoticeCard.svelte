<script lang="ts">
	// The WUA's answer, first on the page (design §3 Q2, §6.1 item 3): the
	// published notice in the warning (advisory) or danger (restricted) fill,
	// with an icon and the level in words, or a loud "No restriction from the
	// WUA" in the success fill. Only this card uses those fills (§6.2).
	import type { NoticeVm } from './cards';
	import { NO_RESTRICTION } from './cards';

	let { notice }: { notice: NoticeVm | null } = $props();
</script>

{#if notice}
	<section id="notice" class="notice {notice.level}" aria-labelledby="notice-h">
		{#if notice.label}
			<div class="label">
				<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					{#if notice.level === 'restricted'}
						<circle cx="12" cy="12" r="9" /><path d="M7 12 H17" />
					{:else}
						<path d="M12 3 L22 20 H2 Z" /><path d="M12 10 V14" /><path d="M12 17.5 V17.6" />
					{/if}
				</svg>
				<span>{notice.label}</span>
			</div>
		{/if}
		<h2 id="notice-h">
			{#if !notice.label}
				<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 L22 20 H2 Z" /><path d="M12 10 V14" /></svg>
			{/if}
			{notice.heading}
		</h2>
		{#if notice.body}
			{#each notice.body.split('\n') as para, i (i)}<p>{para}</p>{/each}
		{/if}
		{#if notice.pctLine}<p>{notice.pctLine}</p>{/if}
		<p class="by">{notice.byline}</p>
	</section>
{:else}
	<section id="notice" class="notice none" aria-labelledby="notice-h">
		<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="9" /><path d="M7.5 12.5 L10.5 15.5 L16.5 9" /></svg>
		<h2 id="notice-h">{NO_RESTRICTION}</h2>
	</section>
{/if}

<style>
	.notice {
		padding: 16px;
		border-radius: 8px;
		border: 1px solid;
		display: flex;
		flex-direction: column;
		gap: 8px;
		scroll-margin-top: 72px;
	}
	.advisory {
		background: var(--warning-soft);
		border-color: var(--warning);
	}
	.restricted {
		background: var(--danger-soft);
		border-color: var(--danger);
	}
	.label {
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 600;
		font-size: 14px;
	}
	.advisory .label,
	.advisory h2 svg {
		color: var(--warning);
	}
	.restricted .label,
	.restricted h2 svg {
		color: var(--danger);
	}
	h2 {
		font-size: 19px;
		display: flex;
		gap: 8px;
		align-items: flex-start;
	}
	.by {
		font-size: 14px;
		color: var(--text-2);
	}
	.none {
		padding: 12px 16px;
		flex-direction: row;
		align-items: center;
		gap: 10px;
		background: var(--success-soft);
		border-color: var(--success);
		color: var(--success);
	}
	.none svg {
		flex-shrink: 0;
	}
	.none h2 {
		font-size: 17px;
		color: var(--success);
	}
</style>
