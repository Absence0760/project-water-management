// What an applicant (the `contributor` role, 044/045, roadmap WP-3.3) sees
// of the published baseline their application applies to: D2's recommended
// default, **pending the client** (docs/roadmap/step-3-licensing.md § 11,
// docs/scenarios.md § Applications). Pure: the server rebuilds the full base
// (loadPublishedRunInput) and projects it here before anything leaves.
// The projection lives in the engine (scenario/applicant.ts), so a pack's
// reproduction bundle derives an application's mask offline the same way;
// re-exported here for the backend's callers.
//
//  - settings: in full. They are catchment-wide (climate, calibration, EWR),
//    and an op on one is a baseline assumption the assessor sees in red.
//  - the applicant's own nodes (their farm links) and every gauge (public
//    infrastructure, as a farmer sees them): in full;
//  - every other node: its id, kind, place in the network and order, so a
//    new dam can be placed below it, and the river's bed losses below it
//    (engine ≥ 1.75.0), under an anonymous name ("Farm 3",
//    "Water user 1"); every number zeroed and every list emptied, so no other
//    farm's area, dam, crops, demand or boreholes leave the server;
//  - crops, crop areas, transfers, land cover, boreholes, demand objects and
//    registered volumes: only those on their own nodes (a transfer's other
//    end is an anonymised node).
export { applicationMask, projectBaseForApplicant, type ApplicantBase } from '@water-management/engine';
