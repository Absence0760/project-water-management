-- 263_retire_ewr_split — engine 1.105.0 retires settings.ewrSplit (issue
-- #615; docs/model.md §2.5b, docs/engine-audit.md FM1). The EWR is split
-- between the units one way only, by each unit's natural MAR share, under
-- both flow generation methods, so the choice ('flowShare' or 'naturalMar',
-- engine 1.94.0, issue #553) has nothing left to choose.
--
-- Project settings only, following 064. Stored runs (model_run.inputs) keep
-- the value they ran with: their summaries say how their EWR was split, and
-- the run comparison reads the key there (engine compare.ts ewrSplitChange).
-- Scenario ops are left alone too: they are hashed (scenario.ops_sha256) and
-- a decided scenario's are immutable (052); the engine refuses a
-- settings.set on ewrSplit with a reason the scenario shows
-- (RETIRED_SETTINGS_PATHS).
--
-- The engine and the API drop the key from settings they read (engine
-- prepare.ts mergeSettings, backend projects/settings.ts mergeSettings);
-- this makes the stored rows say what runs. Data only: no table, policy or
-- grant changes.

UPDATE project
SET settings = settings - 'ewrSplit'
WHERE settings ? 'ewrSplit';
