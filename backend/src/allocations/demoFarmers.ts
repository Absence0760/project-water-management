// The demo registered users the example seeds hold their registered volumes
// under (docs/run-locally.md § The showcase, § The licence comparison map),
// and the ones an editor loads onto a project's units through the app
// (./demo.ts, POST /projects/:id/allocations/demo; docs/allocations.md §
// Demo registered users):
// placeholder names, each marked "(invented)" as every seeded holder is, so
// none can be read as a real person's registration. The repo is public:
// never put a real farmer's, farm's or company's name here.
const NAMES = [
	'Jim Bean',
	'Joe Bloggs',
	'Jack Daniels',
	'Jane Doe',
	'Piet Pompies',
	'Sarel Seemsaadjie',
	'Joe Soap',
	'Tannie Sannie',
	'Johnny Walker',
	'Jan Rap',
	'John Citizen',
	'Mary Major',
	'Fred Nerk',
	'Klaas Kleinboer',
	'Bettie Boontjies',
	'Danie Droogland',
	'Lettie Lusern',
	'Willem Waterkant'
] as const;

/** The demo registered users, each name marked "(invented)". */
export const DEMO_FARMERS: readonly string[] = NAMES.map((n) => `${n} (invented)`);
