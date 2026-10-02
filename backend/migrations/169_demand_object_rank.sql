-- 169_demand_object_rank — a demand object's rank within its priority class
-- (engine 1.64.0, issue #343, docs/model.md §2.7f).
--
-- A demand object's priority only placed it against its unit's crops
-- (first / shared / last), so two objects before the crops always shared pro
-- rata: two municipalities whose licences differ in seniority couldn't be
-- ordered. The rank orders the objects within 'first' and within 'last':
-- rank 1 is supplied before rank 2, equal ranks share pro rata. Together the
-- class and the rank give the unit's numbered supply order (crops included),
-- which the node form shows and edits. A 'shared' object always shares with
-- the crops, so the engine ignores a rank on it.
--
-- NULL = rank 1: every object saved before it, so every saved model runs
-- bit-identically (first / shared / last are positions 1 / 2 / 3, the crops
-- at 2). The column is the "expand" half; nothing needs a contract, since
-- the priority class stays the class and the rank only refines it.
--
-- A column on an existing project table (088): its RLS policies, the
-- same-project trigger and the grant to water_app already cover it, and it
-- adds no foreign key.

ALTER TABLE demand_object
	ADD COLUMN priority_rank smallint
		CONSTRAINT demand_object_priority_rank_range CHECK (priority_rank IS NULL OR priority_rank BETWEEN 1 AND 99);

COMMENT ON COLUMN demand_object.priority_rank IS
	'Rank within its priority class (first / last): 1 is supplied before 2, equal ranks share pro rata; ignored on a shared object. NULL = 1, as every object saved before it. Engine >= 1.64.0, docs/model.md 2.7f.';
