const express = require('express');
const cors = require('cors');
require('dotenv').config();
const db = require('./config/db');
const { verifyToken, authorizeRoles } = require('./authMiddleware');

const app = express();
const PORT = process.env.PORT || 5000;

// Database Migration: Sync autoincrement sequences on startup
const runMigrations = async () => {
    try {
        await db.query(`
            SELECT setval('academic_years_id_seq', COALESCE((SELECT MAX(id)+1 FROM academic_years), 1), false);
            SELECT setval('classes_id_seq', COALESCE((SELECT MAX(id)+1 FROM classes), 1), false);
            SELECT setval('subjects_id_seq', COALESCE((SELECT MAX(id)+1 FROM subjects), 1), false);
            SELECT setval('class_subjects_id_seq', COALESCE((SELECT MAX(id)+1 FROM class_subjects), 1), false);
            SELECT setval('sessions_id_seq', COALESCE((SELECT MAX(id)+1 FROM sessions), 1), false);
            SELECT setval('materials_id_seq', COALESCE((SELECT MAX(id)+1 FROM materials), 1), false);
            SELECT setval('assessments_id_seq', COALESCE((SELECT MAX(id)+1 FROM assessments), 1), false);
            SELECT setval('assessment_submissions_id_seq', COALESCE((SELECT MAX(id)+1 FROM assessment_submissions), 1), false);
            SELECT setval('attendances_id_seq', COALESCE((SELECT MAX(id)+1 FROM attendances), 1), false);
        `);
        console.log('Sinkronisasi sequence autoincrement database sukses.');
    } catch (err) {
        console.error('Sinkronisasi sequence gagal:', err);
    }
};
runMigrations();

// Global Middlewares
app.use(cors());
app.use(express.json());

// Public API Health check
app.get('/', (req, res) => {
    res.send('LMS Backend API (Modular)');
});

// ==========================================
// MOUNT MODULAR API ROUTERS
// ==========================================
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/courses'));         // Handles /courses, /materials, /assignments
app.use('/api/gradebook', require('./routes/gradebook'));
app.use('/api', require('./routes/gamification'));    // Handles stats, leaderboard, and gamification profile
app.use('/api/protests', require('./routes/protests'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/homeroom', require('./routes/homeroom'));
app.use('/api/headmaster', require('./routes/headmaster'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/assessment', require('./routes/assessment'));

// Protected Demo Dashboard placeholder endpoint
app.get('/api/teacher/dashboard', verifyToken, authorizeRoles('teacher'), (req, res) => {
    return res.json({
        message: 'Selamat datang di Dashboard Guru Terproteksi!',
        user: req.user
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});
