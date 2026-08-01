const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../config/db');
const { verifyToken, authorizeRoles } = require('../authMiddleware');

const router = express.Router();

const ensureSchoolAssociated = (req, res, next) => {
    if (!req.user || !req.user.school_id) {
        return res.status(403).json({ error: 'Akses ditolak. Akun Anda tidak terasosiasi dengan sekolah mana pun.' });
    }
    next();
};

// 1. Get School Stats (GET /api/headmaster/stats)
router.get('/stats', verifyToken, ensureSchoolAssociated, authorizeRoles('headmaster'), async (req, res) => {
    const schoolId = req.user.school_id;

    try {
        const teachersRes = await db.query(
            "SELECT COUNT(*) FROM users WHERE role = 'teacher' AND school_id = $1",
            [schoolId]
        );
        const studentsRes = await db.query(
            "SELECT COUNT(*) FROM users WHERE role = 'student' AND school_id = $1",
            [schoolId]
        );
        const coursesRes = await db.query(
            `SELECT COUNT(DISTINCT cs.id) 
             FROM class_subjects cs 
             JOIN classes c ON cs.class_id = c.id 
             WHERE c.school_id = $1`,
            [schoolId]
        );

        return res.json({
            totalTeachers: parseInt(teachersRes.rows[0].count, 10) || 0,
            totalStudents: parseInt(studentsRes.rows[0].count, 10) || 0,
            totalCourses: parseInt(coursesRes.rows[0].count, 10) || 0
        });
    } catch (err) {
        console.error('Get Headmaster Stats Error:', err);
        return res.status(500).json({ error: `Gagal mengambil statistik sekolah: ${err.message}` });
    }
});

// 2. Get Teachers List (GET /api/headmaster/teachers)
router.get('/teachers', verifyToken, ensureSchoolAssociated, authorizeRoles('headmaster'), async (req, res) => {
    const schoolId = req.user.school_id;

    try {
        const result = await db.query(
            "SELECT id, name, username, email, nip FROM users WHERE role = 'teacher' AND school_id = $1 ORDER BY name ASC",
            [schoolId]
        );
        return res.json(result.rows);
    } catch (err) {
        console.error('Get Teachers List Error:', err);
        return res.status(500).json({ error: `Gagal mengambil daftar guru: ${err.message}` });
    }
});

// 3. Create Teacher Account (POST /api/headmaster/teachers)
router.post('/teachers', verifyToken, ensureSchoolAssociated, authorizeRoles('headmaster'), async (req, res) => {
    const schoolId = req.user.school_id;
    const { name, email, password, nip } = req.body;

    if (!name || !email || !password || !nip) {
        return res.status(400).json({ error: 'Nama, email, password, dan NIP wajib diisi.' });
    }

    try {
        // Check duplicate email
        const checkEmail = await db.query("SELECT id FROM users WHERE email = $1", [email]);
        if (checkEmail.rows.length > 0) {
            return res.status(400).json({ error: 'Email sudah terdaftar.' });
        }

        // Check duplicate NIP
        const checkNip = await db.query("SELECT id FROM users WHERE nip = $1", [nip]);
        if (checkNip.rows.length > 0) {
            return res.status(400).json({ error: 'NIP sudah terdaftar.' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Derive username
        let username = email.split('@')[0];
        const checkUsername = await db.query("SELECT id FROM users WHERE username = $1", [username]);
        if (checkUsername.rows.length > 0) {
            username = `${username}_${Math.floor(1000 + Math.random() * 9000)}`;
        }

        const insertQuery = `
            INSERT INTO users (school_id, username, email, password_hash, name, role, nip)
            VALUES ($1, $2, $3, $4, $5, 'teacher', $6)
            RETURNING id, name, username, email, nip
        `;
        const result = await db.query(insertQuery, [schoolId, username, email, passwordHash, name, nip]);

        return res.status(201).json({
            message: 'Akun guru berhasil dibuat.',
            teacher: result.rows[0]
        });
    } catch (err) {
        console.error('Create Teacher Error:', err);
        return res.status(500).json({ error: `Gagal membuat akun guru: ${err.message}` });
    }
});

// 4. Delete Teacher Account (DELETE /api/headmaster/teachers/:id)
router.delete('/teachers/:id', verifyToken, ensureSchoolAssociated, authorizeRoles('headmaster'), async (req, res) => {
    const { id } = req.params;
    const schoolId = req.user.school_id;

    try {
        const result = await db.query(
            "DELETE FROM users WHERE id = $1 AND role = 'teacher' AND school_id = $2 RETURNING id",
            [id, schoolId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Guru tidak ditemukan atau tidak berwenang.' });
        }

        return res.json({ message: 'Akun guru berhasil dihapus.', id });
    } catch (err) {
        console.error('Delete Teacher Error:', err);
        return res.status(500).json({ error: `Gagal menghapus akun guru: ${err.message}` });
    }
});

// 5. Get Students List (GET /api/headmaster/students)
router.get('/students', verifyToken, ensureSchoolAssociated, authorizeRoles('headmaster'), async (req, res) => {
    const schoolId = req.user.school_id;

    try {
        const result = await db.query(
            "SELECT id, name, username, email, nis, xp, level FROM users WHERE role = 'student' AND school_id = $1 ORDER BY name ASC",
            [schoolId]
        );
        return res.json(result.rows);
    } catch (err) {
        console.error('Get Students List Error:', err);
        return res.status(500).json({ error: `Gagal mengambil daftar siswa: ${err.message}` });
    }
});

// 6. Create Student Account (POST /api/headmaster/students)
router.post('/students', verifyToken, ensureSchoolAssociated, authorizeRoles('headmaster'), async (req, res) => {
    const schoolId = req.user.school_id;
    const { name, email, password, nis } = req.body;

    if (!name || !email || !password || !nis) {
        return res.status(400).json({ error: 'Nama, email, password, dan NIS wajib diisi.' });
    }

    try {
        // Check duplicate email
        const checkEmail = await db.query("SELECT id FROM users WHERE email = $1", [email]);
        if (checkEmail.rows.length > 0) {
            return res.status(400).json({ error: 'Email sudah terdaftar.' });
        }

        // Check duplicate NIS
        const checkNis = await db.query("SELECT id FROM users WHERE nis = $1", [nis]);
        if (checkNis.rows.length > 0) {
            return res.status(400).json({ error: 'NIS sudah terdaftar.' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Derive username
        let username = email.split('@')[0];
        const checkUsername = await db.query("SELECT id FROM users WHERE username = $1", [username]);
        if (checkUsername.rows.length > 0) {
            username = `${username}_${Math.floor(1000 + Math.random() * 9000)}`;
        }

        // Insert user
        const insertQuery = `
            INSERT INTO users (school_id, username, email, password_hash, name, role, nis, xp, level)
            VALUES ($1, $2, $3, $4, $5, 'student', $6, 0, 1)
            RETURNING id, name, username, email, nis, xp, level
        `;
        const result = await db.query(insertQuery, [schoolId, username, email, passwordHash, name, nis]);
        const student = result.rows[0];

        // Also create initial student_gamification record
        await db.query(
            "INSERT INTO student_gamification (student_id, xp, level) VALUES ($1, 0, 1) ON CONFLICT DO NOTHING",
            [student.id]
        );

        return res.status(201).json({
            message: 'Akun siswa berhasil dibuat.',
            student
        });
    } catch (err) {
        console.error('Create Student Error:', err);
        return res.status(500).json({ error: `Gagal membuat akun siswa: ${err.message}` });
    }
});

// 7. Delete Student Account (DELETE /api/headmaster/students/:id)
router.delete('/students/:id', verifyToken, ensureSchoolAssociated, authorizeRoles('headmaster'), async (req, res) => {
    const { id } = req.params;
    const schoolId = req.user.school_id;

    try {
        const result = await db.query(
            "DELETE FROM users WHERE id = $1 AND role = 'student' AND school_id = $2 RETURNING id",
            [id, schoolId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Siswa tidak ditemukan atau tidak berwenang.' });
        }

        return res.json({ message: 'Akun siswa berhasil dihapus.', id });
    } catch (err) {
        console.error('Delete Student Error:', err);
        return res.status(500).json({ error: `Gagal menghapus akun siswa: ${err.message}` });
    }
});

module.exports = router;
