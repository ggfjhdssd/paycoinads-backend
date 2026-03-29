const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// ==================== Task 7 ခု, maxCount=4, between-watch cooldown=1min, daily-reset=2hr ====================
// reward loaded dynamically from DB config (TASK_REWARD), default 40
const TASK_BASE = { maxCount: 4, watchCooldown: 60 * 1000, dailyCooldown: 2 * 60 * 60 * 1000 };
const VIDEO_TASK_LIMITS = {
    task1: { ...TASK_BASE, reward: 40, blockId: '23898' },
    task2: { ...TASK_BASE, reward: 40, blockId: '23919' },
    task3: { ...TASK_BASE, reward: 40, blockId: '24540' },
    task4: { ...TASK_BASE, reward: 40, blockId: '24541' },
    task5: { ...TASK_BASE, reward: 40, blockId: '24542' },
    task6: { ...TASK_BASE, reward: 40, blockId: '24543' },
    task7: { ...TASK_BASE, reward: 40, blockId: '24544' }
};

async function getEarnTaskReward() {
    try {
        const Config = mongoose.model('Config');
        const cfg = await Config.findOne({ key: 'TASK_REWARD' });
        return (cfg && typeof cfg.value === 'number') ? cfg.value : 40;
    } catch(e) { return 40; }
}

async function getHomeTaskReward() {
    try {
        const Config = mongoose.model('Config');
        const cfg = await Config.findOne({ key: 'HOME_TASK_REWARD' });
        return (cfg && typeof cfg.value === 'number') ? cfg.value : 45;
    } catch(e) { return 45; }
}

const VALID_TASK_IDS = Object.keys(VIDEO_TASK_LIMITS);

// ==================== Helper ====================
function getTodayStart() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

// ==================== GET /api/earn/tasks/status ====================
router.get('/tasks/status', async (req, res) => {
    try {
        if (!req.tgUser) return res.status(401).json({ error: 'User not authenticated' });
        const User = mongoose.model('User');
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const now = Date.now();
        const taskStatus = {};

        const liveReward = await getEarnTaskReward();
        for (const taskId of VALID_TASK_IDS) {
            const cfg = VIDEO_TASK_LIMITS[taskId];
            let taskData = user.videoTasks?.get(taskId) || { count: 0, lastClaim: 0, firstClaimTime: 0 };

            // 2hr daily reset: if firstClaimTime > 0 and 2hr passed, reset count
            if (taskData.firstClaimTime && taskData.firstClaimTime > 0) {
                if (now - taskData.firstClaimTime >= cfg.dailyCooldown) {
                    taskData = { count: 0, lastClaim: 0, firstClaimTime: 0 };
                }
            }

            // time until daily reset
            let dailyResetIn = 0;
            if (taskData.firstClaimTime && taskData.firstClaimTime > 0 && taskData.count >= cfg.maxCount) {
                dailyResetIn = Math.max(0, cfg.dailyCooldown - (now - taskData.firstClaimTime));
            }

            // between-watch cooldown (1 min after each watch)
            const watchCooldownRemaining = taskData.lastClaim
                ? Math.max(0, cfg.watchCooldown - (now - taskData.lastClaim))
                : 0;

            taskStatus[taskId] = {
                currentCount: taskData.count,
                maxCount: cfg.maxCount,
                reward: liveReward,
                blockId: cfg.blockId,
                lastClaim: taskData.lastClaim,
                firstClaimTime: taskData.firstClaimTime || 0,
                watchCooldownRemaining,    // ms until next watch allowed (1 min)
                dailyResetIn,             // ms until 0/4 resets (2hr from first claim)
                canClaim: taskData.count < cfg.maxCount && watchCooldownRemaining === 0
            };
        }

        res.json({ success: true, tasks: taskStatus });
    } catch (err) {
        console.error('❌ Error in /api/earn/tasks/status:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== POST /api/earn/video ====================
router.post('/video', async (req, res) => {
    try {
        if (!req.tgUser) return res.status(401).json({ error: 'User not authenticated' });

        const { taskId, amount } = req.body;
        if (!taskId || !VALID_TASK_IDS.includes(taskId)) return res.status(400).json({ error: 'Invalid task ID' });

        const cfg = VIDEO_TASK_LIMITS[taskId];
        const liveReward = await getEarnTaskReward();
        if (amount !== liveReward) return res.status(400).json({ error: 'Invalid reward amount' });

        const User = mongoose.model('User');
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.banned) return res.status(403).json({ error: 'Your account is banned' });

        if (!user.videoTasks) user.videoTasks = new Map();

        const now = Date.now();
        let taskData = user.videoTasks.get(taskId) || { count: 0, lastClaim: 0, firstClaimTime: 0 };

        // 2hr daily reset check
        if (taskData.firstClaimTime && taskData.firstClaimTime > 0) {
            if (now - taskData.firstClaimTime >= cfg.dailyCooldown) {
                taskData = { count: 0, lastClaim: 0, firstClaimTime: 0 };
            }
        }

        // Check maxCount
        if (taskData.count >= cfg.maxCount) {
            const resetIn = Math.max(0, cfg.dailyCooldown - (now - taskData.firstClaimTime));
            return res.status(400).json({ error: 'Daily limit reached', resetIn, taskId });
        }

        // Check 1 min between-watch cooldown
        if (taskData.lastClaim && now - taskData.lastClaim < cfg.watchCooldown) {
            const remaining = Math.ceil((cfg.watchCooldown - (now - taskData.lastClaim)) / 1000);
            return res.status(400).json({ error: 'Cooldown period', remaining, taskId });
        }

        // Update
        taskData.count += 1;
        taskData.lastClaim = now;
        if (!taskData.firstClaimTime || taskData.firstClaimTime === 0) {
            taskData.firstClaimTime = now; // record first claim time for 2hr reset
        }

        user.videoTasks.set(taskId, taskData);
        user.coins += liveReward;
        await user.save();

        console.log(`✅ User ${req.tgUser.id} earned ${liveReward} coins from ${taskId} (${taskData.count}/${cfg.maxCount}). Total: ${user.coins}`);

        res.json({
            success: true,
            newCoins: user.coins,
            taskId,
            currentCount: taskData.count,
            maxCount: cfg.maxCount,
            reward: liveReward,
            lastClaim: taskData.lastClaim,
            firstClaimTime: taskData.firstClaimTime
        });
    } catch (err) {
        console.error('❌ Error in /api/earn/video:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

console.log('✅ earn.js router loaded successfully');
module.exports = router;
