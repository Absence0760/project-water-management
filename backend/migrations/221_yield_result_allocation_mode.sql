-- 221_yield_result_allocation_mode — a yield records the allocation mode it ran with (issue #523 G1c).
--
-- A yield on a run or scenario that caps use at, or scales demand to, the
-- registered volumes (settings.allocationMode 'cap' or 'fullAllocation')
-- carries the capped use of the units above its dam, so a viewer kept from
-- the volumes gets it without its points (#523 I, yield/store.ts
-- yieldsOnCapOrFull). Until now a scenario's yield was judged by the
-- scenario's current state (its allocationMode op, or its base run's mode):
-- an editor who ran a yield with a cap op and then dropped the op turned it
-- into one served whole. From here the yield job writes the mode of the input
-- it ran on into `allocation_mode`, and the gate reads that.
--
-- Rows from before this have NULL (unknown). The gate judges those
-- conservatively: one on a run by the run's own stored mode (a run's input
-- never changes, so that is the mode it ran with), one on a scenario as
-- capped (withheld), since the scenario may have changed since. No backfill:
-- a scenario's mode at the time can't be recovered.
--
-- A new column of yield_result: the table's existing grants (SELECT, INSERT,
-- DELETE to water_app, 040) and policies (040, 045, 096) cover it. The yield
-- job writes it; the API doesn't serve it.
ALTER TABLE yield_result ADD COLUMN allocation_mode text
	CHECK (allocation_mode IN ('none', 'cap', 'fullAllocation'));
COMMENT ON COLUMN yield_result.allocation_mode IS
	'The settings.allocationMode of the input the yield ran on (221): none, cap or fullAllocation. NULL = a result from before 221, mode unknown (the API withholds a scenario''s from a viewer kept from the volumes).';
