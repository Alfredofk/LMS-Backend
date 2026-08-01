const express = require('express');
const db = require('../config/db');
const { verifyToken } = require('../authMiddleware');

const router = express.Router();

// Helper to ensure school is associated
const ensureSchoolAssociated = (req, res, next) => {
    if (!req.user || !req.user.school_id) {
        return res.status(403).json({ error: 'Akses ditolak. Akun Anda tidak terasosiasi dengan sekolah.' });
    }
    next();
};

// 1. Get List of Notifications (GET /api/notifications)
router.get('/', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const schoolId = req.user.school_id;
    const userId = req.user.id;

    try {
        // Fetch user-specific notifications and general school-wide notifications
        const query = `
            SELECT id, title, message, type, link_path AS "linkPath", is_read AS "isRead", created_at AS "createdAt"
            FROM notifications
            WHERE school_id = $1 AND (user_id = $2 OR user_id IS NULL)
            ORDER BY created_at DESC
            LIMIT 50
        `;
        const result = await db.query(query, [schoolId, userId]);
        return res.json(result.rows);
    } catch (err) {
        console.error('Get Notifications Error:', err);
        return res.status(500).json({ error: `Gagal mengambil notifikasi: ${err.message}` });
    }
});

// 2. Mark All Notifications as Read (PUT /api/notifications/read-all)
// Put this BEFORE the /:id/read route to avoid path variable matching conflicts
router.put('/read-all', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const schoolId = req.user.school_id;
    const userId = req.user.id;

    try {
        const query = `
            UPDATE notifications
            SET is_read = TRUE
            WHERE school_id = $1 AND (user_id = $2 OR user_id IS NULL)
            RETURNING id
        `;
        const result = await db.query(query, [schoolId, userId]);
        return res.json({ message: 'Semua notifikasi ditandai sebagai terbaca.', count: result.rows.length });
    } catch (err) {
        console.error('Mark All Read Notifications Error:', err);
        return res.status(500).json({ error: `Gagal menandai semua terbaca: ${err.message}` });
    }
});

// 3. Mark Notification as Read (PUT /api/notifications/:id/read)
router.put('/:id/read', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    try {
        const query = `
            UPDATE notifications
            SET is_read = TRUE
            WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)
            RETURNING id
        `;
        const result = await db.query(query, [id, userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Notifikasi tidak ditemukan atau Anda tidak memiliki akses.' });
        }
        return res.json({ message: 'Notifikasi ditandai sebagai terbaca.', id });
    } catch (err) {
        console.error('Mark Read Notification Error:', err);
        return res.status(500).json({ error: `Gagal menandai terbaca: ${err.message}` });
    }
});

// 4. Delete Notification (DELETE /api/notifications/:id)
router.delete('/:id', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    try {
        const query = `
            DELETE FROM notifications
            WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)
            RETURNING id
        `;
        const result = await db.query(query, [id, userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Notifikasi tidak ditemukan.' });
        }
        return res.json({ message: 'Notifikasi berhasil dihapus.', id });
    } catch (err) {
        console.error('Delete Notification Error:', err);
        return res.status(500).json({ error: `Gagal menghapus notifikasi: ${err.message}` });
    }
});

module.exports = router;
