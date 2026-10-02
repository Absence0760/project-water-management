<script lang="ts">
	// The data sources and their credits: the third-party data the service
	// serves or reads, and the notice each licence asks for (the legal
	// notice docs/maps.md § Sources names). The texts are
	// lib/components/legal/dataCredits.ts, checked against the licences as
	// read in docs/maps.md. Linked from the legal pages' footer, the landing
	// page's footer, Terms §9 and the map's attribution while a credited
	// layer is drawn. A notice, not part
	// of the terms: changing it asks no one to accept anything again.
	import { base } from '$app/paths';
	import LegalPage from '$lib/components/legal/LegalPage.svelte';
	import { DATA_CREDITS, licencesReadLine, readDay } from '$lib/components/legal/dataCredits';

	const sections = [{ id: 'about', label: 'About these credits' }, ...DATA_CREDITS.map((c, i) => ({ id: c.id, label: `${i + 1}. ${c.name}` }))];
</script>

<LegalPage
	title="Data sources and credits"
	description="The third-party data Water Management uses, the licence each is used under, and the credit each licence asks for."
	effective={licencesReadLine()}
	{sections}
>
	<h2 id="about">About these credits</h2>
	<p>
		Water Management draws on data published by others. Each dataset below is used under its publisher’s licence, and each credit
		is worded as that licence asks. The data is provided as its publishers provide it; how the service treats data from others is
		in section 9 of the <a href="{base}/terms#third-party">terms of use</a>. A deployment uses only the datasets its operator has
		loaded, so a project may never show some of them.
	</p>

	{#each DATA_CREDITS as c, i (c.id)}
		<h2 id={c.id}>{i + 1}. {c.name}</h2>
		<p><strong>Used for:</strong> {c.usedFor}</p>
		<p><strong>Published by:</strong> {c.publisher}</p>
		<p><strong>Licence:</strong> <a href={c.licenceUrl} rel="external">{c.licence}</a> (read on {readDay(c.read)})</p>
		{#each c.statements as s (s)}
			<blockquote class="credit">{s}</blockquote>
		{/each}
		{#if c.citation}<p class="cite"><strong>Cite as:</strong> {c.citation}</p>{/if}
	{/each}
</LegalPage>

<style>
	/* A citation can end in a long DOI link, which must wrap on a phone. */
	.cite {
		overflow-wrap: anywhere;
	}
	.credit {
		margin: 0.5rem 0 1rem;
		padding: 0.5rem 0.9rem;
		border-left: 3px solid var(--border);
		max-width: 68ch;
		overflow-wrap: anywhere;
	}
</style>
