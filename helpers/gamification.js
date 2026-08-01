const db = require('../config/db');

// Helper function to allocate XP, handle level-ups, check badge unlocks, and log transactions
const rewardXp = async (studentId, xpAmount, sourceType, sourceId) => {
    try {
        // 1. Fetch current XP
        let statsRes = await db.query(
            'SELECT xp, level, daily_streak FROM student_gamification WHERE student_id = $1',
            [studentId]
        );

        if (statsRes.rows.length === 0) {
            await db.query(
                'INSERT INTO student_gamification (student_id, xp, level, daily_streak) VALUES ($1, 0, 1, 0)',
                [studentId]
            );
            statsRes = { rows: [{ xp: 0, level: 1, daily_streak: 0 }] };
        }

        const currentXp = statsRes.rows[0].xp;
        const currentLevel = statsRes.rows[0].level;
        const dailyStreak = statsRes.rows[0].daily_streak || 0;

        const newXp = currentXp + xpAmount;
        // Level is calculated as floors of XP/1000 + 1
        const newLevel = Math.floor(newXp / 1000) + 1;

        // 2. Update student_gamification
        await db.query(
            'UPDATE student_gamification SET xp = $1, level = $2 WHERE student_id = $3',
            [newXp, newLevel, studentId]
        );

        // Update users table in parallel to stay synchronized
        await db.query(
            'UPDATE users SET xp = $1, level = $2 WHERE id = $3',
            [newXp, newLevel, studentId]
        );

        // 3. Log transaction
        await db.query(
            'INSERT INTO xp_transactions (student_id, amount, source_type, source_id) VALUES ($1, $2, $3, $4)',
            [studentId, xpAmount, sourceType, sourceId || null]
        );

        // 4. Check for badge unlocks based on criteria
        const badgeDefinitions = await db.query('SELECT * FROM badge_definitions');
        for (const badge of badgeDefinitions.rows) {
            let matchesCriteria = false;
            if (badge.criteria_type === 'xp' && newXp >= badge.criteria_value) {
                matchesCriteria = true;
            } else if (badge.criteria_type === 'level' && newLevel >= badge.criteria_value) {
                matchesCriteria = true;
            } else if (badge.criteria_type === 'streak' && dailyStreak >= badge.criteria_value) {
                matchesCriteria = true;
            }

            if (matchesCriteria) {
                // Check if already unlocked
                const checkUnlocked = await db.query(
                    'SELECT * FROM student_badges WHERE student_id = $1 AND badge_id = $2',
                    [studentId, badge.id]
                );
                if (checkUnlocked.rows.length === 0) {
                    await db.query(
                        'INSERT INTO student_badges (student_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                        [studentId, badge.id]
                    );
                }
            }
        }

        console.log(`Rewarded student ${studentId} with +${xpAmount} XP. Level: ${newLevel}.`);
    } catch (err) {
        console.error('rewardXp Helper Error:', err);
    }
};

module.exports = {
    rewardXp
};
