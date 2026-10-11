<script lang="ts">
	// Per-project API keys (WP-2.9, docs/ui.md § API keys): the owner makes a
	// key for a logger gateway or a script, copies it once (only its hash is
	// kept, so it can't be shown again), sees when each was last used, and
	// revokes one. Owners only: SettingsTab renders this for an owner, and the
	// API answers anyone else 403.
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { onMount } from 'svelte';
	import { PUBLIC_API_URL } from '$env/static/public';
	import { api, API_KEY_NAME_MAX, type ApiKey, type ApiKeySeries } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import FormatHelp from '$lib/components/common/FormatHelp.svelte';
	import { apiBase, curlExample, INGEST_FORMAT, DEFAULT_KEY_EXPIRY_DAYS, KEY_EXPIRY_CHOICES, KEY_STATE_WORD, keyRow, revokeKeyQuestion, seriesText, sortKeys } from './apiKeys';

	let { projectId }: { projectId: string } = $props();

	let keys = $state<ApiKey[]>([]);
	let series = $state<ApiKeySeries[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);

	let name = $state('');
	let days = $state<number>(DEFAULT_KEY_EXPIRY_DAYS);
	let limit = $state(false);
	let picked = $state<string[]>([]);
	let creating = $state(false);
	/** The key just made: its secret is shown this once. */
	let fresh = $state<{ id: string; name: string; secret: string; series: ApiKeySeries | null } | null>(null);
	let copied = $state('');
	let secretInput: HTMLInputElement | undefined = $state();

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const seriesKey = (s: ApiKeySeries) => `${s.kind}\u0000${s.name}`;
	const rows = $derived(sortKeys(keys).map((k) => keyRow(k)));
	const today = new Date().toISOString().slice(0, 10);
	const curl = $derived(curlExample(apiBase(PUBLIC_API_URL, typeof location === 'undefined' ? '' : location.origin), fresh?.series ?? null, today));

	async function load() {
		loading = true;
		loadError = null;
		try {
			const [list, all] = await Promise.all([api.apiKeys.list(projectId), api.series.list(projectId)]);
			keys = list;
			series = all.map((s) => ({ kind: s.kind, name: s.name }));
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function create(e: SubmitEvent) {
		e.preventDefault();
		if (limit && picked.length === 0) {
			error = 'Pick at least one series, or let the key write any series.';
			return;
		}
		creating = true;
		error = null;
		copied = '';
		try {
			const allowedSeries = limit ? series.filter((s) => picked.includes(seriesKey(s))) : null;
			const { key, secret } = await api.apiKeys.create(projectId, { name: name.trim(), allowedSeries, expiresInDays: days || null });
			keys = [key, ...keys];
			fresh = { id: key.id, name: key.name, secret, series: allowedSeries?.[0] ?? null };
			name = '';
			picked = [];
			limit = false;
		} catch (err) {
			error = msg(err);
		} finally {
			creating = false;
		}
	}

	async function copy(text: string, what: string, select?: HTMLInputElement) {
		try {
			await navigator.clipboard.writeText(text);
			copied = `${what} copied.`;
		} catch {
			// No clipboard permission: select it so the owner can copy it themselves.
			select?.select();
			copied = `Couldn’t copy automatically.${select ? ' It is selected: copy it with your keyboard or menu.' : ''}`;
		}
	}

	async function revoke(id: string, keyName: string) {
		if (!(await confirmDialog({ title: 'Revoke this API key?', message: revokeKeyQuestion(keyName), confirmLabel: 'Revoke key', danger: true }))) return;
		busy = id;
		error = null;
		try {
			await api.apiKeys.revoke(projectId, id);
			if (fresh?.id === id) fresh = null;
			keys = await api.apiKeys.list(projectId);
		} catch (err) {
			error = msg(err);
		} finally {
			busy = null;
		}
	}
</script>

<section class="panel" id="set-api-keys" aria-labelledby="api-keys-h-t">
	<div class="panel-head">
		<h2 id="api-keys-h"><span id="api-keys-h-t">API keys</span> <HelpTip key="api-key" label="About API keys" /></h2>
	</div>
	<p class="muted small intro">
		A key lets a logger gateway or a script add daily readings to this project’s series without signing in. It can write series, and nothing
		else: it can’t read the model, runs or members. Each request with it shows in History under the key’s name.
	</p>
	<FormatHelp summary="Expected format of a request" format={INGEST_FORMAT} />
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

	<form class="add" aria-label="Make an API key" onsubmit={create}>
		<div class="row">
			<div class="field grow">
				<label for="key-name">Name</label>
				<input id="key-name" required maxlength={API_KEY_NAME_MAX} placeholder="Weir logger gateway" bind:value={name} />
			</div>
			<div class="field">
				<label for="key-days">Works for</label>
				<select id="key-days" bind:value={days}>
					{#each KEY_EXPIRY_CHOICES as c (c.days)}<option value={c.days}>{c.label}</option>{/each}
				</select>
			</div>
		</div>
		<fieldset class="series">
			<legend>What it may write</legend>
			<label class="choice"><input type="radio" name="key-limit" value={false} bind:group={limit} /> Any series of this project</label>
			<label class="choice"><input type="radio" name="key-limit" value={true} bind:group={limit} disabled={series.length === 0} /> Only these series</label>
			{#if limit}
				<div class="picks">
					{#each series as s (seriesKey(s))}
						<label class="choice"><input type="checkbox" value={seriesKey(s)} bind:group={picked} /> {seriesText(s)}</label>
					{/each}
				</div>
			{/if}
		</fieldset>
		<div>
			<button class="btn btn-primary" type="submit" disabled={creating || !name.trim()}>{creating ? 'Making…' : 'Make key'}</button>
		</div>
	</form>

	{#if fresh}
		<div class="fresh" role="group" aria-labelledby="fresh-key-h">
			<p id="fresh-key-h" class="fresh-h">Key “{fresh.name}”</p>
			<p class="muted small">Copy it now: it won’t be shown again. Anyone with it can add data to this project until you revoke it.</p>
			<div class="copy-row">
				<label for="key-secret" class="visually-hidden">The new key</label>
				<input id="key-secret" readonly value={fresh.secret} bind:this={secretInput} onfocus={(e) => e.currentTarget.select()} />
				<button type="button" class="btn" onclick={() => copy(fresh!.secret, 'Key', secretInput)}>Copy</button>
			</div>
			<p class="muted small example-h">Try it: set <code>WM_INGEST_KEY</code> to the key, then</p>
			<pre class="example" aria-label="Example request">{curl}</pre>
			<button type="button" class="btn btn-sm" onclick={() => copy(curl, 'Example')}>Copy example</button>
			<p class="copied" role="status" aria-live="polite">{copied}</p>
		</div>
	{/if}

	<LoadState {loading} error={loadError} retry={load} empty={keys.length === 0} emptyText="No API keys yet.">
		<div class="table-wrap">
			<table class="data">
				<thead>
					<tr>
						<th scope="col">Key</th>
						<th scope="col">Writes</th>
						<th scope="col">Made</th>
						<th scope="col">Ends</th>
						<th scope="col">Last used</th>
						<th scope="col"><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.id)}
						<tr class:dead={r.state !== 'live'}>
							<th scope="row">
								{r.name}
								<span class="prefix">{r.shown}</span>
								<span class="state {r.state}">{KEY_STATE_WORD[r.state]}</span>
							</th>
							<td>{r.series}</td>
							<td>{r.created}</td>
							<td>{r.ends}</td>
							<td>{r.lastUsed}</td>
							<td class="act">
								{#if r.canRevoke}
									<button type="button" class="btn btn-sm btn-danger" disabled={busy === r.id} onclick={() => revoke(r.id, r.name)} aria-label="Revoke {r.name}">Revoke</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</LoadState>
</section>

<style>
	.intro {
		margin: -0.25rem 0 0.75rem;
		max-width: 80ch;
	}
	.add {
		margin-bottom: 0.75rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 0.75rem;
	}
	.grow {
		flex: 1 1 16rem;
	}
	.grow input {
		width: 100%;
	}
	.series {
		margin: 0 0 0.75rem;
		padding: 0;
		border: 0;
	}
	.series legend {
		font-weight: 600;
		font-size: 0.85rem;
		margin-bottom: 0.25rem;
	}
	/* Each row at least 24 px tall, so stacked radios and checkboxes sit 24 px
	   apart (WCAG 2.2 target size, 2.5.8, spacing exception). */
	.choice {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 24px;
		font-weight: 400;
		margin: 0.15rem 0;
	}
	.picks {
		margin: 0.25rem 0 0 1.5rem;
	}
	.fresh {
		margin-bottom: 0.75rem;
		padding: 0.75rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		background: var(--accent-soft);
	}
	.fresh-h {
		margin: 0 0 0.25rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.fresh .small {
		margin: 0 0 0.5rem;
	}
	.copy-row {
		display: flex;
		gap: 0.5rem;
	}
	.copy-row input {
		flex: 1 1 auto;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: 0.8rem;
	}
	.example-h {
		margin-top: 0.75rem !important;
	}
	.example {
		margin: 0 0 0.5rem;
		padding: 0.5rem;
		overflow-x: auto;
		font-size: 0.75rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.copied {
		margin: 0.35rem 0 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.copied:empty {
		margin: 0;
	}
	.prefix {
		display: block;
		font-weight: 400;
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.state {
		display: block;
		font-weight: 400;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.state.live {
		color: var(--success);
	}
	tr.dead th,
	tr.dead td {
		color: var(--text-muted);
	}
	.act {
		text-align: right;
		white-space: nowrap;
	}
</style>
