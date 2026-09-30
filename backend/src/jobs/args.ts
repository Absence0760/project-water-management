// The local worker's command-line scope (worker.ts): `--project <id>`,
// repeatable, limits a `--once` tick's claim to those projects' jobs
// (runner.ts TickOptions.projectIds). Its own module so it can be tested
// without starting a worker.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids after each `--project` (undefined when there are none); refuses a missing or malformed one. */
export function projectArgs(argv: readonly string[]): string[] | undefined {
	const ids: string[] = [];
	argv.forEach((a, i) => {
		if (a !== '--project') return;
		const id = argv[i + 1];
		if (id === undefined || !UUID.test(id)) throw new Error(`--project needs a project id (a UUID), got ${id === undefined ? 'nothing' : JSON.stringify(id)}`);
		ids.push(id);
	});
	return ids.length ? ids : undefined;
}
