const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

// ==================== Define User Schema ====================
const DEFAULT_PHOTO = 'https://raw.githubusercontent.com/ggfjhdssd/paycoinads-telegram-app/main/public/images/fa6a539141b9eeae723f551b9d67b875.jpg';

const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    username: String,
    firstName: String,
    lastName: String,
    photoUrl: { type: String, default: DEFAULT_PHOTO },
    coins: { type: Number, default: 0 },
    dailyLastClaim: { type: Number, default: 0 },
    tasks: { type: Map, of: Number, default: {} },
    videoTasks: { type: Map, of: {
        count: Number,
        lastClaim: Number,
        date: Number
    }, default: {} },
    dailyVideoCount: { type: Number, default: 0 },
    lastVideoDate: { type: Date, default: null },
    referredBy: { type: Number, default: null },
    referralCount: { type: Number, default: 0 },
    unclaimedReferrals: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    banned: { type: Boolean, default: false },
    spinTickets: { type: Number, default: 1 },
    adWatchCount: { type: Number, default: 0 },
    lastAdWatch: { type: Number, default: 0 },
    adCooldownEndTime: { type: Number, default: 0 },
    gameSession: {
        active: { type: Boolean, default: false },
        startTime: { type: Number, default: 0 },
        tempScore: { type: Number, default: 0 }
    }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);

// ==================== Spin Wheel Prizes ====================
const PRIZES = [
    { name: '200 coins', value: 200, type: 'coin', probability: 2 },
    { name: '20 coins', value: 20, type: 'coin', probability: 23 },
    { name: '15 coins', value: 15, type: 'coin', probability: 10 },
    { name: 'Try Again', value: 0, type: 'tryagain', probability: 20 },
    { name: 'Free Spin', value: 1, type: 'freespin', probability: 5 },
    { name: '100 coins', value: 100, type: 'coin', probability: 5 },
    { name: '50 coins', value: 50, type: 'coin', probability: 10 },
    { name: '30 coins', value: 30, type: 'coin', probability: 25 }
];

// ==================== Constants ====================
const TWO_HOURS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
const THREE_SECONDS = 3000;

// ==================== Spin Wheel Routes ====================
router.get('/tickets', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ tickets: user.spinTickets });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/spin', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.spinTickets < 1) return res.status(400).json({ error: 'No tickets left' });

        const rand = Math.random() * 100;
        let cumulative = 0;
        let selectedPrize = null;
        let selectedIndex = -1;
        
        for (let i = 0; i < PRIZES.length; i++) {
            cumulative += PRIZES[i].probability;
            if (rand < cumulative) {
                selectedPrize = PRIZES[i];
                selectedIndex = i;
                break;
            }
        }

        user.spinTickets -= 1;
        if (selectedPrize.type === 'coin') {
            user.coins += selectedPrize.value;
        } else if (selectedPrize.type === 'freespin') {
            user.spinTickets += 1;
        }

        await user.save();
        res.json({
            prize: selectedPrize.name,
            prizeIndex: selectedIndex,
            type: selectedPrize.type,
            value: selectedPrize.value,
            newCoins: user.coins,
            newTickets: user.spinTickets
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== POST /api/games/watch-ad ====================
router.post('/watch-ad', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const now = Date.now();

        // 1. STRICT Cooldown Check - Cooldown ရှိရင် ချက်ချင်း Block
        if (user.adCooldownEndTime && user.adCooldownEndTime > now) {
            return res.status(400).json({ 
                error: 'Cooldown active', 
                cooldownEndTime: user.adCooldownEndTime 
            });
        }

        // 2. Limit Check - ၅ ကြိမ်ပြည့်နေရင် ထပ်မကြည့်ရ
        if (user.adWatchCount >= 5) {
            return res.status(400).json({ error: 'You have already watched 5 ads. Please claim your ticket first.' });
        }

        // 3. 3-second cooldown between ads
        if (user.lastAdWatch && (now - user.lastAdWatch) < THREE_SECONDS) {
            const remainingMs = THREE_SECONDS - (now - user.lastAdWatch);
            const remainingSec = Math.ceil(remainingMs / 1000);
            return res.status(400).json({ 
                error: `Please wait ${remainingSec} seconds between ads.`,
                remaining: remainingSec
            });
        }

        // Increment ad watch count
        user.adWatchCount += 1;
        user.lastAdWatch = now;

        await user.save();

        res.json({
            adWatchCount: user.adWatchCount,
            tickets: user.spinTickets,
            cooldownEndTime: user.adCooldownEndTime,
            lastAdWatch: user.lastAdWatch,
            message: 'Ad watched successfully'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== POST /api/games/claim-ticket ====================
router.post('/claim-ticket', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const now = Date.now();

        // Cannot claim if already in cooldown
        if (user.adCooldownEndTime && user.adCooldownEndTime > now) {
            return res.status(400).json({ error: 'You are already in cooldown period.' });
        }

        // Must have watched at least 5 ads
        if (user.adWatchCount < 5) {
            return res.status(400).json({ error: 'You need to watch 5 ads first.' });
        }

        // Give 1 spin ticket
        user.spinTickets += 1;

        // Reset adWatchCount to 0
        user.adWatchCount = 0;

        // Set 2-hour cooldown (STRICT)
        user.adCooldownEndTime = now + TWO_HOURS;

        await user.save();

        res.json({
            success: true,
            tickets: user.spinTickets,
            adWatchCount: user.adWatchCount,
            cooldownEndTime: user.adCooldownEndTime,
            message: 'Ticket claimed! 2-hour cooldown started.'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== GET /api/games/ad-status ====================
router.get('/ad-status', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const now = Date.now();

        res.json({
            adWatchCount: user.adWatchCount,
            dailyLimit: 5,
            lastAdWatch: user.lastAdWatch,
            cooldownEndTime: user.adCooldownEndTime || 0,
            tickets: user.spinTickets,
            serverTime: now // Frontend က ဒါကိုသုံးပြီး sync လုပ်နိုင်တယ်
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== GET /api/games/invite-status ====================
router.get('/invite-status', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const claimableTickets = Math.floor(user.unclaimedReferrals / 5);
        const remainingForNext = 5 - (user.unclaimedReferrals % 5);
        res.json({
            referralCount: user.referralCount,
            unclaimedReferrals: user.unclaimedReferrals,
            claimableTickets: claimableTickets,
            remainingForNext: remainingForNext,
            tickets: user.spinTickets,
            message: claimableTickets > 0 
                ? `You have ${claimableTickets} ticket${claimableTickets > 1 ? 's' : ''} to claim!`
                : `Invite ${remainingForNext} more friend${remainingForNext !== 1 ? 's' : ''} for a ticket.`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== POST /api/games/claim-referral-ticket ====================
router.post('/claim-referral-ticket', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.unclaimedReferrals < 5) {
            return res.status(400).json({ error: 'Not enough unclaimed referrals. Need at least 5.' });
        }

        // Give one ticket
        user.spinTickets += 1;
        // Reduce unclaimedReferrals by 5
        user.unclaimedReferrals -= 5;

        await user.save();

        res.json({
            success: true,
            tickets: user.spinTickets,
            unclaimedReferrals: user.unclaimedReferrals,
            message: 'Ticket claimed!'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== Coin Clicker Routes ====================
const GAME_ENTRY_FEE = 50;   
const GAME_MAX_WIN = 100;

router.post('/coin-start', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.coins < GAME_ENTRY_FEE) {
            return res.status(400).json({ error: 'Insufficient coins' });
        }
        user.coins -= GAME_ENTRY_FEE;
        user.gameSession = { active: true, startTime: Date.now(), tempScore: 0 };
        await user.save();
        res.json({ success: true, newBalance: user.coins });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/coin-end', async (req, res) => {
    try {
        const { earnedCoins } = req.body;
        if (typeof earnedCoins !== 'number' || earnedCoins < 0 || earnedCoins > GAME_MAX_WIN) {
            return res.status(400).json({ error: 'Invalid earned coins' });
        }
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user || !user.gameSession.active) return res.status(400).json({ error: 'No active session' });
        user.coins += earnedCoins;
        user.gameSession.active = false;
        await user.save();
        res.json({ success: true, newBalance: user.coins });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
