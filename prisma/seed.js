// Demo accounts, one per role (owner, 2026-09-27): a Platform Admin, and at one
// demo school a Principal, a Vice Principal, a Teacher, a Student and a Guardian of
// that Student. The Vice Principal (ticket 19) is a teacher too, as it always is.
//
// Minimal by the owner's choice: no academic year, class or subject. Add those
// through the app. The Guardian is linked to the Student all the same, because a
// Guardian's access comes from the link, not the role (ADR-0002).
//
// Safe to run again: every row is looked up first and only created when missing,
// and nothing existing is changed - save the demo Guardian's phone, filled in when
// still empty (ensureUser). `prisma migrate dev` and `migrate reset` run it
// too, because package.json registers it as the Prisma seed.
//
// The addresses are @demo.example (a reserved TLD, RFC 2606), NOT @example.test:
// cleanup-test-data.mjs removes every @example.test account and every school with
// "Probe" in its name, and these must survive it. The school name avoids "Probe"
// for the same reason. adminuji123@gmail.com is left alone.
//
// Seeding is not an approval, so no ApprovalAudit rows are written: the demo
// school was never decided by anyone.
import 'dotenv/config';
import crypto from 'node:crypto';

import { prisma } from '../src/shared/prisma.js';
import { runInSchool, runUnscoped } from '../src/shared/tenantContext.js';
import { hashPassword } from '../src/shared/auth.js';

const PASSWORD = 'Demo1234!';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Eight digits like a real NPSN, starting 0000 so it is plainly not one and can
// never block a real school from registering.
const SCHOOL = {
    npsn: '00000001',
    name: 'SMP Demo Nusantara',
    schoolType: 'SMP',
    durationYears: 3,
    city: 'Malang',
    latitude: -7.9666,
    longitude: 112.6326,
    timeZone: 'WIB',
};

const PEOPLE = {
    admin: { email: 'admin@demo.example', fullName: 'Admin Platform Demo' },
    principal: { email: 'kepala@demo.example', fullName: 'Kepala Sekolah Demo' },
    vice: { email: 'wakasek@demo.example', fullName: 'Wakil Kepala Sekolah Demo' },
    teacher: { email: 'guru@demo.example', fullName: 'Guru Demo' },
    student: { email: 'siswa@demo.example', fullName: 'Siswa Demo' },
    // A Guardian gives a phone number when they join (ticket 23); the demo one has one too.
    guardian: { email: 'wali@demo.example', fullName: 'Wali Murid Demo', phone: '081200000006' },
};

const schoolCode = () =>
    Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');

const created = [];
const note = (what) => created.push(what);

// A phone is filled in on an account that predates ticket 23 and still has none: a
// field that was missing, not a change. A number already there is never replaced.
async function ensureUser({ email, fullName, phone = null }, passwordHash) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
        if (phone && !existing.phone) {
            note(`phone for ${email}`);
            return prisma.user.update({ where: { id: existing.id }, data: { phone } });
        }
        return existing;
    }
    note(`user ${email}`);
    return prisma.user.create({
        data: { email, fullName, phone, passwordHash, emailVerifiedAt: new Date() },
    });
}

// An ACTIVE membership with its roles ACTIVE, inside the school's scope. A user
// who already belongs somewhere keeps that - one PENDING-or-ACTIVE membership per
// user is a database rule - and is reported rather than forced.
async function ensureMember(school, user, roles) {
    const held = await runUnscoped('seed: does this demo user belong anywhere', async () =>
        await prisma.schoolMembership.findFirst({
            where: { userId: user.id, status: { in: ['PENDING', 'ACTIVE'] } },
        })
    );
    if (held && held.schoolId !== school.id) {
        throw new Error(`${user.email} already belongs to another school; not touching it`);
    }
    if (held) return held;

    const now = new Date();
    return runInSchool(school.id, school.name, async () => {
        const membership = await prisma.schoolMembership.create({
            data: { userId: user.id, status: 'ACTIVE', approvedAt: now },
        });
        for (const role of roles) {
            await prisma.membershipRole.create({
                data: { membershipId: membership.id, role, status: 'ACTIVE', approvedAt: now },
            });
        }
        note(`${roles.join(' + ')} membership for ${user.email}`);
        return membership;
    });
}

async function seed() {
    const passwordHash = await hashPassword(PASSWORD);

    const admin = await ensureUser(PEOPLE.admin, passwordHash);
    if (!(await prisma.platformAdmin.findUnique({ where: { userId: admin.id } }))) {
        await prisma.platformAdmin.create({ data: { userId: admin.id } });
        note('platform admin role');
    }

    const principal = await ensureUser(PEOPLE.principal, passwordHash);
    const vice = await ensureUser(PEOPLE.vice, passwordHash);
    const teacher = await ensureUser(PEOPLE.teacher, passwordHash);
    const student = await ensureUser(PEOPLE.student, passwordHash);
    const guardian = await ensureUser(PEOPLE.guardian, passwordHash);

    // The school, as an approved registration founds one, so the admin's screens
    // (keyed by registration) can reach it: deactivate, appoint a Principal.
    let school = await prisma.school.findUnique({ where: { npsn: SCHOOL.npsn } });
    if (!school) {
        const now = new Date();
        const adminRow = await prisma.platformAdmin.findUnique({ where: { userId: admin.id } });
        school = await prisma.school.create({ data: { ...SCHOOL, schoolCode: schoolCode() } });
        await prisma.schoolRegistration.create({
            data: {
                applicantUserId: principal.id,
                npsn: SCHOOL.npsn,
                schoolName: SCHOOL.name,
                schoolType: SCHOOL.schoolType,
                durationYears: SCHOOL.durationYears,
                city: SCHOOL.city,
                latitude: SCHOOL.latitude,
                longitude: SCHOOL.longitude,
                timeZone: SCHOOL.timeZone,
                applicantPhone: '081200000001',
                status: 'APPROVED',
                reviewedByAdminId: adminRow.id,
                reviewedAt: now,
                ktpVerifiedAt: now,
                createdSchoolId: school.id,
            },
        });
        note(`school ${SCHOOL.name} (NPSN ${SCHOOL.npsn})`);
    }

    await ensureMember(school, principal, ['PRINCIPAL']);
    const viceMembership = await ensureMember(school, vice, ['TEACHER', 'VICE_PRINCIPAL']);
    const teacherMembership = await ensureMember(school, teacher, ['TEACHER']);
    const studentMembership = await ensureMember(school, student, ['STUDENT']);
    const guardianMembership = await ensureMember(school, guardian, ['GUARDIAN']);

    await runInSchool(school.id, school.name, async () => {
        // Both teachers carry the profile approval would have written.
        const teachers = [
            [viceMembership, '197901012004011002'],
            [teacherMembership, '198001012005011001'],
        ];
        for (const [membership, nip] of teachers) {
            if (!(await prisma.teacherProfile.findFirst({ where: { membershipId: membership.id } }))) {
                await prisma.teacherProfile.create({ data: { membershipId: membership.id, nip } });
                note(`teacher profile (NIP ${nip})`);
            }
        }

        let profile = await prisma.studentProfile.findFirst({
            where: { membershipId: studentMembership.id },
        });
        if (!profile) {
            profile = await prisma.studentProfile.create({
                data: {
                    membershipId: studentMembership.id,
                    nisn: '0000000001',
                    birthDate: new Date('2013-05-01'),
                },
            });
            note('student profile (NISN 0000000001)');
        }

        const link = await prisma.guardianStudent.findFirst({
            where: { guardianMembershipId: guardianMembership.id, studentProfileId: profile.id },
        });
        if (!link) {
            await prisma.guardianStudent.create({
                data: {
                    guardianMembershipId: guardianMembership.id,
                    studentProfileId: profile.id,
                    relationship: 'Ibu',
                    status: 'ACTIVE',
                    approvedAt: new Date(),
                },
            });
            note('guardian link to the student');
        }
    });

    return school;
}

try {
    const school = await seed();

    console.log(created.length ? `\nCreated:\n  - ${created.join('\n  - ')}` : '\nNothing to create: the demo data is already there.');
    console.log(`\nDemo school: ${school.name}, School Code ${school.schoolCode}`);
    console.log(`Every demo account signs in with the password ${PASSWORD}:`);
    for (const [role, person] of Object.entries(PEOPLE)) {
        console.log(`  ${role.padEnd(10)} ${person.email}`);
    }
} catch (error) {
    console.error('Seed failed:', error.message);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
