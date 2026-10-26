-- A Platform Admin's id is never empty (2026-10-26, governing-body ticket 08's follow-up).
--
-- Prisma's DSL cannot express a CHECK, so it is written by hand, as the partial indexes are.
-- A row put in by hand (Prisma Studio) with the id '' satisfied every foreign key to it, and
-- the code took '' for no admin at all: the Platform Admin's deactivation of a School read as
-- its Governing Body's. Blank ids made of spaces are refused too.
--
-- A database already holding such a row refuses this migration until the id is replaced:
-- UPDATE "PlatformAdmin" SET "id" = gen_random_uuid()::text WHERE btrim("id") = '';
-- Every foreign key to it is ON UPDATE CASCADE, so the rows naming it follow.

ALTER TABLE "PlatformAdmin" ADD CONSTRAINT "PlatformAdmin_id_not_empty" CHECK (btrim("id") <> '');
