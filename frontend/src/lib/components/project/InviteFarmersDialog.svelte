<script lang="ts">
	// "Invite farmers" (WP-2.2): one farmer by email with their farms, or many
	// from a CSV (email,farm,language, one farm per row), pasted or uploaded.
	// The CSV is previewed first: the server works out every row's outcome
	// (added / invited / error) in a dry run that writes and mails nothing,
	// and only then does "Send" do it for real. Owners only (the panel hides
	// the button from everyone else).
	import { api, type BulkFarmerResult, type FarmerEntry, type InviteLocale } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { LANGUAGES } from '$lib/i18n/state.svelte';
	import { bulkSummary, farmNames, outcomeText, parseFarmerCsv, toggleFarm, type CsvFarmerRow, type FarmOption } from './farmers';

	let {
		open = $bindable(false),
		projectId,
		farms,
		ondone
	}: {
		open?: boolean;
		projectId: string;
		/** The project's farm nodes, in network-table order. */
		farms: FarmOption[];
		/** Something changed: `entry` is the one farmer or invite (single mode), `message` what to announce. */
		ondone: (message: string, entry?: FarmerEntry) => void;
	} = $props();

	let mode = $state<'single' | 'csv'>('single');
	let error = $state<string | null>(null);
	let busy = $state(false);

	// Single mode.
	let email = $state('');
	let picked = $state<string[]>([]);
	let locale = $state<InviteLocale>('en');

	// CSV mode.
	let csv = $state('');
	let fileName = $state<string | null>(null);
	let problems = $state<string[]>([]);
	let rows = $state<CsvFarmerRow[]>([]);
	let results = $state<BulkFarmerResult[] | null>(null);
	/** True while `results` is the dry run's preview, false once sent. */
	let preview = $state(true);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	// Opening the dialog starts fresh.
	$effect(() => {
		if (open) {
			error = null;
			results = null;
			problems = [];
		}
	});

	function csvChanged() {
		results = null;
		problems = [];
	}

	async function pickFile(file: File | undefined) {
		if (!file) return;
		fileName = file.name;
		csv = await file.text();
		csvChanged();
	}

	async function submitSingle() {
		busy = true;
		error = null;
		try {
			const r = await api.farmers.add(projectId, email.trim(), picked, locale);
			if (r.invited) {
				ondone(`Invitation sent to ${r.invite.email} for ${farmNames(r.invite, farms).join(', ')}.`, r.invite);
			} else {
				ondone(`${r.farmer.displayName} added as a farmer on ${farmNames(r.farmer, farms).join(', ')}.`, r.farmer);
			}
			email = '';
			picked = [];
			locale = 'en';
			open = false;
		} catch (e) {
			error = msg(e);
		} finally {
			busy = false;
		}
	}

	async function previewCsv() {
		error = null;
		const parsed = parseFarmerCsv(csv);
		problems = parsed.problems;
		rows = parsed.rows;
		results = null;
		if (problems.length) return;
		busy = true;
		try {
			results = await api.farmers.bulk(projectId, rows.map(({ line: _line, ...r }) => r), true);
			preview = true;
		} catch (e) {
			error = msg(e);
		} finally {
			busy = false;
		}
	}

	async function sendCsv() {
		busy = true;
		error = null;
		try {
			results = await api.farmers.bulk(projectId, rows.map(({ line: _line, ...r }) => r), false);
			preview = false;
			ondone(`Farmer invitations: ${bulkSummary(results, false)}.`);
		} catch (e) {
			error = msg(e);
		} finally {
			busy = false;
		}
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		if (mode === 'single') void submitSingle();
		else if (!results) void previewCsv();
		else if (preview) void sendCsv();
	}

	const sendable = $derived(!!results && preview && results.some((r) => r.status !== 'error'));
</script>

<Dialog bind:open title="Invite farmers" wide>
	<form id="invite-farmers-form" onsubmit={submit} aria-busy={busy}>
		<fieldset class="modes">
			<legend class="visually-hidden">How many farmers</legend>
			<label class="check"><input type="radio" name="invite-mode" value="single" bind:group={mode} /> One farmer</label>
			<label class="check"><input type="radio" name="invite-mode" value="csv" bind:group={mode} /> Several, from a CSV</label>
		</fieldset>

		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

		{#if mode === 'single'}
			<p class="muted small">
				Someone with an account is added straight away. Anyone else gets an email to create one; they see their hydrological unit once they
				accept.
			</p>
			<div class="field">
				<label for="invite-farmer-email">Email</label>
				<input id="invite-farmer-email" type="email" required autocomplete="off" placeholder="farmer@example.com" bind:value={email} />
			</div>
			<fieldset class="farms">
				<legend>Their hydrological units</legend>
				{#each farms as farm (farm.id)}
					<label class="check">
						<input type="checkbox" checked={picked.includes(farm.id)} onchange={() => (picked = toggleFarm(picked, farm.id, farms))} />
						{farm.name}
					</label>
				{/each}
			</fieldset>
			<div class="field">
				<label for="invite-farmer-lang">Email language</label>
				<select id="invite-farmer-lang" bind:value={locale}>
					{#each LANGUAGES as l (l.code)}<option value={l.code} lang={l.code}>{l.name}</option>{/each}
				</select>
			</div>
		{:else}
			<p class="muted small" id="invite-csv-help">
				One hydrological unit per row: <code>email,farm,language</code>. The <code>farm</code> column is the hydrological unit’s name on the Network tab (capitals don’t
				matter); language is a code ({#each LANGUAGES as l, i (l.code)}{i ? ', ' : ''}<code>{l.code}</code>{/each}) or the language’s
				name, English if left out. A farmer with two hydrological units gets two rows and one
				email. At most 200 rows.
			</p>
			<div class="field">
				<label for="invite-csv">Paste the CSV</label>
				<textarea
					id="invite-csv"
					rows="6"
					spellcheck="false"
					aria-describedby="invite-csv-help"
					placeholder={'email,farm,language\nfarmer@example.com,' + (farms[0]?.name ?? 'Hydrological unit name') + ',en'}
					bind:value={csv}
					oninput={csvChanged}
				></textarea>
			</div>
			<div class="field">
				<label for="invite-csv-file">…or upload a .csv file</label>
				<input id="invite-csv-file" type="file" accept=".csv,text/csv,text/plain" onchange={(e) => pickFile(e.currentTarget.files?.[0])} />
				{#if fileName}<span class="muted small">Read {fileName}.</span>{/if}
			</div>
			{#if problems.length}
				<div class="alert alert-error" role="alert">
					{#each problems as p (p)}<p>{p}</p>{/each}
				</div>
			{/if}
			{#if results}
				<section class="results" aria-labelledby="invite-results-h">
					<h3 id="invite-results-h">{preview ? 'Preview' : 'Done'}: {bulkSummary(results, preview)}</h3>
					{#if preview}<p class="muted small">Nothing has been sent yet. Fix any errors in the CSV and preview again, or send the rest.</p>{/if}
					<div class="table-wrap">
						<table class="data">
							<thead>
								<tr>
									<th scope="col">Line</th>
									<th scope="col">Email</th>
									<th scope="col">Farm</th>
									<th scope="col">{preview ? 'What will happen' : 'Result'}</th>
								</tr>
							</thead>
							<tbody>
								{#each results as r (r.row)}
									<tr class:error={r.status === 'error'}>
										<td class="num">{rows[r.row]?.line ?? r.row + 1}</td>
										<th scope="row">{r.email || '–'}</th>
										<td>{r.farm || '–'}</td>
										<td>
											{#if r.status === 'error'}<span class="badge badge-warn">Error</span>{/if}
											{outcomeText(r, preview)}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</section>
			{/if}
		{/if}
	</form>

	{#snippet actions()}
		{#if mode === 'csv' && results && !preview}
			<button type="button" class="btn btn-primary" onclick={() => (open = false)}>Close</button>
		{:else}
			<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
			{#if mode === 'single'}
				<button type="submit" form="invite-farmers-form" class="btn btn-primary" disabled={busy || !email.trim() || picked.length === 0}>
					{busy ? 'Inviting…' : 'Invite farmer'}
				</button>
			{:else if results}
				<button type="button" class="btn" disabled={busy} onclick={previewCsv}>Preview again</button>
				<button type="submit" form="invite-farmers-form" class="btn btn-primary" disabled={busy || !sendable}>
					{busy ? 'Sending…' : 'Send'}
				</button>
			{:else}
				<button type="submit" form="invite-farmers-form" class="btn btn-primary" disabled={busy || !csv.trim()}>
					{busy ? 'Checking…' : 'Preview'}
				</button>
			{/if}
		{/if}
	{/snippet}
</Dialog>

<style>
	.modes,
	.farms {
		border: 0;
		margin: 0 0 0.75rem;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
	}
	.farms legend {
		font-size: 0.85rem;
		color: var(--text-2);
		margin-bottom: 0.25rem;
		padding: 0;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 24px;
	}
	textarea {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85rem;
	}
	.results h3 {
		margin: 0.75rem 0 0.25rem;
		font-size: 0.95rem;
	}
	.results tr.error td,
	.results tr.error th {
		color: var(--text);
	}
	.num {
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.alert p {
		margin: 0;
	}
</style>
