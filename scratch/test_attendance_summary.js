const db = require('../config/db');

const test = async () => {
    try {
        const studentId = 2; // Alfredo
        
        console.log('--- TEST 1: FETCH STUDENT ATTENDANCE SUMMARY ---');
        // A. Fetch student's gamification streak info (daily_streak)
        const streakRes = await db.query(
            `SELECT daily_streak AS "dailyStreak" 
             FROM student_gamification 
             WHERE student_id = $1 LIMIT 1`,
            [studentId]
        );
        const dailyStreak = streakRes.rows.length > 0 ? streakRes.rows[0].dailyStreak : 0;
        console.log('Daily Streak:', dailyStreak);

        // B. Fetch student's overall attendance history
        const historyRes = await db.query(
            `SELECT a.id, a.date::text AS "date", a.status, a.notes, a.created_at AS "createdAt",
                    s.name AS "subjectName", s.code AS "subjectCode"
             FROM attendances a
             JOIN class_subjects cs ON a.class_subject_id = cs.id
             JOIN subjects s ON cs.subject_id = s.id
             WHERE a.student_id = $1
             ORDER BY a.date DESC, a.created_at DESC`,
            [studentId]
        );
        const history = historyRes.rows;
        console.log(`Found ${history.length} attendance logs:`);
        console.table(history);

        // C. Calculate counts
        let hadir = 0;
        let izin = 0;
        let sakit = 0;
        let alpa = 0;

        history.forEach(row => {
            if (row.status === 'Hadir') hadir++;
            else if (row.status === 'Izin') izin++;
            else if (row.status === 'Sakit') sakit++;
            else if (row.status === 'Alpa') alpa++;
        });

        const total = history.length;
        const percentage = total > 0 ? Math.round((hadir / total) * 100) : 100;
        console.log('Summary Stats:', { total, hadir, izin, sakit, alpa, percentage });

        console.log('\nDATABASE QUERY VERIFIED SUCCESSFULLY!');
        process.exit(0);
    } catch (e) {
        console.error('Test failed:', e);
        process.exit(1);
    }
};

test();
