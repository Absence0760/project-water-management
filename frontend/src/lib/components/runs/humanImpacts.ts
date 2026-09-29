// Land cover, groundwater and other users' tables: a separate chunk (HumanImpactTables.svelte),
// drawn by RunSummaryView. A plain module rather than RunSummaryView's `<script module>`, so the
// printable report can load it before it says it is ready: Vite's dependency scan can't see a
// .svelte file's named exports, and failed on the import.
export const loadHumanImpacts = () => import('./HumanImpactTables.svelte');
