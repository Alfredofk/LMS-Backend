-- The national Subject catalog (ticket 08, owner's decision 2026-09-24).
--
-- It used to come from prisma/seed.js, which is missing and which the owner chose
-- not to restore. The list is the seed's own (git blob 318dfe6c67), unchanged:
-- data every school shares, so it rides with the schema instead of a seed.
--
-- schoolId NULL is what makes a row national (shared/prisma.js CATALOG_MODELS).
-- Fixed ids keep the rows recognisable. ON CONFLICT against the partial index
-- Subject_national_catalog_code_unique makes a second run add nothing.
INSERT INTO "Subject" ("id", "schoolId", "code", "name", "createdAt", "updatedAt") VALUES
    ('national-pai',  NULL, 'PAI',  'Pendidikan Agama dan Budi Pekerti',           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-ppkn', NULL, 'PPKN', 'Pendidikan Pancasila',                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-bind', NULL, 'BIND', 'Bahasa Indonesia',                            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-mtk',  NULL, 'MTK',  'Matematika',                                  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-ipas', NULL, 'IPAS', 'Ilmu Pengetahuan Alam dan Sosial',            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-ipa',  NULL, 'IPA',  'Ilmu Pengetahuan Alam',                       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-ips',  NULL, 'IPS',  'Ilmu Pengetahuan Sosial',                     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-bing', NULL, 'BING', 'Bahasa Inggris',                              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-pjok', NULL, 'PJOK', 'Pendidikan Jasmani, Olahraga, dan Kesehatan', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-seni', NULL, 'SENI', 'Seni Budaya',                                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-info', NULL, 'INFO', 'Informatika',                                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-pkwu', NULL, 'PKWU', 'Prakarya dan Kewirausahaan',                  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-sej',  NULL, 'SEJ',  'Sejarah',                                     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-fis',  NULL, 'FIS',  'Fisika',                                      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-kim',  NULL, 'KIM',  'Kimia',                                       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-bio',  NULL, 'BIO',  'Biologi',                                     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-eko',  NULL, 'EKO',  'Ekonomi',                                     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('national-geo',  NULL, 'GEO',  'Geografi',                                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") WHERE "schoolId" IS NULL DO NOTHING;
