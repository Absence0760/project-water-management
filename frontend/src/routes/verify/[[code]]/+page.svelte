<script lang="ts">
	// The public verify page of an evidence pack (WP-3.14, issue #71; docs/ui.md
	// § Verify, docs/evidence-pack.md § Verification): /verify/<short code or
	// full manifest hash> (bare /verify asks for a code), printed on every page of an issued pack. Signed out
	// or in, it shows exactly what GET /verify/:code returns (status, version,
	// issue date, catchment, engine, methodology, the errata the pack recorded
	// and, apart, those found since issue for its runs' engines, signers with their
	// register links as the report prints them, the newer version, a
	// withdrawal's reason) and nothing else; a code that answers nothing is
	// "not found", whatever the reason. "Check a PDF or manifest" hashes a
	// chosen file in the browser (WebCrypto SHA-256) and compares it with the
	// recorded hashes: the file is never uploaded. English only, like the
	// methods and legal pages: its readers are licensing assessors (ui.md §
	// Language). Everything shown is text (Svelte escapes it); the register
	// links are the engine's fixed URLs, never the database's.
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { packShortCode, parsePackCode, registrationBody, registrationLine } from '@water-management/engine';
	import { api, ApiError, type PackVerification } from '$lib/api';
	import BrandMark from '$lib/components/layout/BrandMark.svelte';
	import PackBadge from '$lib/components/packs/PackBadge.svelte';
	import { checkableAccept, checkableFiles, checkFile, errataFoundSinceNote, latestOnly, lookUpCode, type FileCheck } from '$lib/components/packs/pack';
	import { registrationHeading, SIGNOFF_KIND_LABEL } from '$lib/components/liability/signoffForm';
	import { fmtDate } from '$lib/format/number';

	const code = $derived(page.params.code ?? '');
	let v = $state.raw<PackVerification | null>(null);
	let status = $state<'loading' | 'found' | 'not-found' | 'error' | 'no-code'>('loading');
	let error = $state('');

	// Each navigation starts a lookup; only the latest one's answer is shown (a slow first one can't overwrite it).
	const latest = latestOnly();
	async function load(c: string) {
		const current = latest.begin();
		status = 'loading';
		v = null;
		check = null;
		const r = await lookUpCode(c, parsePackCode, api.verify, (e) => e instanceof ApiError && e.status === 404);
		if (!current()) return;
		if (r.status === 'found') v = r.v;
		if (r.status === 'error') error = r.error;
		status = r.status;
	}
	$effect(() => {
		const c = code;
		untrack(() => load(c));
	});

	// --- another code ---
	let typed = $state('');
	const typedOk = $derived(parsePackCode(typed) !== null);
	function lookUp(e: SubmitEvent) {
		e.preventDefault();
		if (typedOk) goto(`${base}/verify/${encodeURIComponent(typed.trim())}`);
	}

	// --- check a file, in the browser ---
	let check = $state<(FileCheck & { name: string }) | null>(null);
	let checking = $state(false);
	let dragging = $state(false);
	async function checkOne(file: File | undefined) {
		if (!file || !v) return;
		const of = v;
		checking = true;
		check = null;
		try {
			const r = { ...(await checkFile(new Uint8Array(await file.arrayBuffer()), of)), name: file.name };
			// Checked against the pack still shown: a navigation meanwhile drops it.
			if (v === of) check = r;
		} finally {
			checking = false;
		}
	}
	function drop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		checkOne(e.dataTransfer?.files[0]);
	}

	const since = $derived(v ? errataFoundSinceNote(v) : null);
	const successorCode = $derived(v?.successorSha256 ? packShortCode(v.successorSha256) : null);
</script>

<svelte:head>
	<title>{v ? `Evidence pack ${v.shortCode} · ${v.catchment} · ` : 'Verify an evidence pack · '}Water Management</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="verify">
	<header class="verify-header">
		<span class="brand"><BrandMark size={26} /><span class="names"><span class="title">Water Management</span><span class="tag">Evidence pack verification</span></span></span>
	</header>

	<main class="verify-main" data-verify-state={status} aria-busy={status === 'loading'}>
		{#if status === 'loading'}
			<p class="muted" role="status">Looking up the code…</p>
		{:else if status === 'no-code'}
			<section class="card" aria-labelledby="intro-h">
				<h1 id="intro-h">Verify an evidence pack</h1>
				<p>Every page of an issued licensing evidence pack prints its code. Type it below to see whether the pack still stands and who signed it.</p>
			</section>
		{:else if status === 'not-found'}
			<section class="card" aria-labelledby="nf-h" data-testid="verify-not-found">
				<h1 id="nf-h">No issued evidence pack has this code</h1>
				<p role="alert">
					Nothing answers for <span class="mono">{code}</span>. Check the code against the pack (12 characters, as <span class="mono">xxxx-xxxx-xxxx</span>, or the
					full 64-character manifest SHA-256). A pack that was never issued has no verify page.
				</p>
			</section>
		{:else if status === 'error'}
			<section class="card" aria-labelledby="err-h">
				<h1 id="err-h">Verify an evidence pack</h1>
				<p role="alert">The lookup failed just now: {error}</p>
				<button type="button" class="btn" onclick={() => load(code)}>Try again</button>
			</section>
		{:else if v}
			<section class="card" aria-labelledby="v-h" data-testid="verify-result" data-status={v.status}>
				<p class="eyebrow">Licensing evidence pack · {v.catchment}</p>
				<h1 id="v-h">
					<span class="mono">{v.shortCode}</span>
					<PackBadge status={v.status} version={v.version} />
				</h1>
				{#if v.status === 'issued'}
					<p class="verdict good" data-testid="verify-verdict">
						<strong>Issued and current.</strong> Version {v.version} was issued by this app on {fmtDate(v.issuedAt, true)} and has not been replaced or withdrawn.
					</p>
				{:else if v.status === 'superseded'}
					<p class="verdict amber" data-testid="verify-verdict">
						<strong>Superseded.</strong> Version {v.version} was issued on {fmtDate(v.issuedAt, true)}, and a newer version replaces it.
						{#if successorCode}<a href="{base}/verify/{successorCode}">Verify the newer version ({successorCode})</a>.{/if}
					</p>
				{:else}
					<p class="verdict bad" data-testid="verify-verdict">
						<strong>Withdrawn.</strong> Version {v.version} was issued on {fmtDate(v.issuedAt, true)} and later withdrawn. Don’t rely on it.
					</p>
					{#if v.withdrawnReason}<p class="reason" data-testid="verify-reason"><span class="label">Reason given:</span> {v.withdrawnReason}</p>{/if}
				{/if}

				<dl class="kv">
					<div><dt>Catchment</dt><dd>{v.catchment}</dd></div>
					<div><dt>Version</dt><dd>{v.version}</dd></div>
					<div><dt>Issued</dt><dd>{fmtDate(v.issuedAt, true)}</dd></div>
					<div><dt>Engine</dt><dd>{v.engineVersion}</dd></div>
					<div><dt>Report format</dt><dd>{v.reportVersion}</dd></div>
					<div>
						<dt>Methodology statement</dt>
						<dd>{v.methodology.version ?? 'not recorded'}{#if v.methodology.sha256}<span class="sub mono hash">SHA-256 {v.methodology.sha256}</span>{/if}</dd>
					</div>
					<div class="wide"><dt>Manifest SHA-256</dt><dd class="mono hash" data-testid="verify-manifest-sha">{v.manifestSha256}</dd></div>
					<div class="wide">
						<dt>PDF SHA-256</dt>
						<dd>{#if v.pdfSha256}<span class="mono hash">{v.pdfSha256}</span>{:else}<span class="muted">No server PDF recorded for this pack.</span>{/if}</dd>
					</div>
					<div class="wide">
						<dt>Reproduction bundle SHA-256</dt>
						<dd data-testid="verify-bundle-sha">
							{#if v.bundleSha256}<span class="mono hash">{v.bundleSha256}</span><span class="sub"
									>Anyone holding the bundle re-runs the pack’s model runs with <span class="mono">pnpm reproduce:pack</span> and the app’s source code.</span
								>{:else}<span class="muted">No reproduction bundle recorded for this pack.</span>{/if}
						</dd>
					</div>
				</dl>
			</section>

			<section class="card" aria-labelledby="signers-h">
				<h2 id="signers-h">Signed off by</h2>
				{#each v.signers as s, i (i)}
					{@const line = registrationLine(s.registrationBody, s.registrationCategory, s.registrationField, s.registrationNo)}
					{@const register = line ? registrationBody(s.registrationBody) : undefined}
					<dl class="kv signer" aria-label="Sign-off by {s.fullName}">
						<div><dt>Name</dt><dd>{s.fullName}</dd></div>
						<div><dt>Signed</dt><dd>{fmtDate(s.signedAt, true)}</dd></div>
						<div><dt>Signed as</dt><dd data-testid="verify-signer-kind">{SIGNOFF_KIND_LABEL[s.kind ?? 'specialist']}</dd></div>
						<div class="wide">
							<dt data-testid="verify-registration-heading">{registrationHeading(s.registrationCheck ?? null, (d) => fmtDate(d))}</dt>
							<dd>{line ?? `${s.registrationBody} ${s.registrationNo} (category and field not recorded)`}</dd>
						</div>
						{#if register}
							<div class="wide">
								<dt>Check it</dt>
								<dd>{register.registerName}: <a href={register.registerUrl} rel="noopener noreferrer" target="_blank">{register.registerUrl}</a></dd>
							</div>
						{/if}
					</dl>
				{:else}
					<p class="muted">No sign-off is recorded.</p>
				{/each}
				<p class="small muted">
					Registration details are each signer’s own declaration unless marked “checked against the register”: the project’s host checks them against the
					professional body’s register and records when and by whom; this app itself checks nothing. Check them there.
				</p>
			</section>

			<section class="card" aria-labelledby="errata-h">
				<h2 id="errata-h">Errata recorded in the pack</h2>
				{#if v.errata.length}
					<ul class="errata">{#each v.errata as e (e.id)}<li><strong>{e.id}</strong> {e.summary}</li>{/each}</ul>
				{:else}
					<p class="muted">None: no known bug was recorded for this engine when the pack was drafted.</p>
				{/if}
				<p class="small muted">The errata the pack recorded when it was drafted. The methods and their known limitations are on the <a href="{base}/methods">methods page</a>.</p>
				<div data-testid="verify-errata-since">
					<h3>{since?.heading}</h3>
					{#if v.errataFoundSince.length}
						<ul class="errata">{#each v.errataFoundSince as e (e.id)}<li><strong>{e.id}</strong> {e.summary}</li>{/each}</ul>
						<p class="small muted">{since?.note}</p>
					{:else}
						<p class="muted">None: no erratum has been found since issue for the engines this pack’s runs used.</p>
					{/if}
				</div>
			</section>

			<section class="card" aria-labelledby="check-h" data-testid="verify-check">
				<h2 id="check-h">Check a {checkableFiles(v)}</h2>
				<p>
					Choose or drop the pack’s {checkableFiles(v)}{v.pdfSha256 || v.bundleSha256 ? '' : ' (JSON)'}. It is hashed here, in your browser, with SHA-256 and compared with
					the hash recorded when the pack was issued. <strong>The file is never uploaded.</strong>
				</p>
				{#if !v.pdfSha256}<p class="small muted">No server PDF is recorded for this pack, so a PDF can’t be checked here; its manifest can.</p>{/if}
				<label class="drop" class:dragging ondragover={(e) => ((e.preventDefault(), (dragging = true)))} ondragleave={() => (dragging = false)} ondrop={drop}>
					<span>Drop a file here, or choose one</span>
					<input type="file" accept={checkableAccept(v)} onchange={(e) => checkOne(e.currentTarget.files?.[0])} data-testid="verify-file" />
				</label>
				<div aria-live="polite" data-testid="verify-check-result">
					{#if checking}
						<p class="muted">Hashing…</p>
					{:else if check}
						{#if check.result === 'no-match'}
							<p class="verdict bad"><strong>Doesn’t match.</strong> “{check.name}” is not this pack’s {checkableFiles(v)}: it has been changed, or it is another file.</p>
						{:else}
							<p class="verdict good">
								<strong>Matches.</strong> “{check.name}” is this pack’s {check.result === 'pdf' ? 'PDF' : check.result === 'bundle' ? 'reproduction bundle' : 'manifest'}, unchanged{check.result === 'manifest' && check.canonical
									? ' (compared in its canonical JSON form, as the hash is taken)'
									: ''}.
							</p>
						{/if}
						<p class="small muted">The file’s SHA-256: <span class="mono hash">{check.sha256}</span></p>
					{/if}
				</div>
			</section>

			<section class="card small" aria-labelledby="what-h">
				<h2 id="what-h">What this proves</h2>
				<p>
					That a pack with this manifest hash was issued by this app, who signed it, and whether it still stands. It doesn’t judge the evidence: the
					responsible authority does. It shows nothing but what the pack itself prints.
				</p>
			</section>
		{/if}

		<form class="card lookup" onsubmit={lookUp} aria-labelledby="lookup-h">
			<h2 id="lookup-h">Verify another pack</h2>
			<div class="row">
				<label for="verify-code">Code</label>
				<input id="verify-code" bind:value={typed} placeholder="xxxx-xxxx-xxxx" autocomplete="off" spellcheck="false" />
				<button type="submit" class="btn" disabled={!typedOk}>Verify</button>
			</div>
		</form>
		<p class="small muted legal"><a href="{base}/terms">Terms of use</a> · <a href="{base}/privacy">Privacy notice</a></p>
	</main>
</div>

<style>
	.verify {
		min-height: 100vh;
		background: var(--bg);
	}
	/* Every link here sits in running text or a value (the register's address): underlined, not colour alone (WCAG 1.4.1). */
	.verify-main a:not(:global(.btn)) {
		text-decoration: underline;
	}
	.verify-header {
		padding: 0.6rem var(--gutter, 1rem);
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}
	.names {
		display: flex;
		flex-direction: column;
		line-height: 1.15;
	}
	.title {
		font-weight: 700;
	}
	.tag {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.verify-main {
		max-width: 52rem;
		margin: 0 auto;
		padding: 1rem var(--gutter, 1rem) 2rem;
		display: grid;
		gap: 1rem;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		padding: 1rem 1.1rem;
	}
	.card > :first-child {
		margin-top: 0;
	}
	h1 {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		font-size: 1.5rem;
		margin: 0.15rem 0 0.6rem;
	}
	h2 {
		font-size: 1.1rem;
		margin: 0 0 0.5rem;
	}
	.eyebrow {
		margin: 0;
		font-size: 0.78rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.verdict {
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-strong);
		max-width: 72ch;
	}
	.verdict.good {
		border-color: var(--success);
		background: var(--success-soft);
	}
	.verdict.amber {
		border-color: var(--warning);
		background: var(--warning-soft);
	}
	.verdict.bad {
		border-color: var(--danger);
		background: var(--danger-soft);
	}
	.reason {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-width: 72ch;
	}
	.label {
		font-weight: 600;
	}
	.kv {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
		gap: 0.5rem 1rem;
		margin: 0.75rem 0 0;
	}
	.kv .wide {
		grid-column: 1 / -1;
	}
	.signer + .signer {
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}
	dt {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.sub {
		display: block;
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.mono {
		font-family: var(--font-mono);
	}
	.hash {
		font-size: 0.8rem;
		word-break: break-all;
	}
	.errata {
		padding-left: 1.2rem;
		margin: 0 0 0.5rem;
	}
	h3 {
		font-size: 1rem;
		margin: 0.75rem 0 0.35rem;
	}
	.drop {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1rem;
		border: 2px dashed var(--border-strong);
		border-radius: var(--radius);
		margin: 0.75rem 0;
	}
	.drop.dragging {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.lookup .row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.lookup input {
		font-family: var(--font-mono);
		min-width: 0;
		flex: 1 1 12rem;
		max-width: 20rem;
	}
	.legal {
		text-align: center;
	}
</style>
