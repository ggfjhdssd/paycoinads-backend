const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

const app = express();

// ==================== Trust Proxy ====================
app.set('trust proxy', 1);

// ==================== Security & Middlewares ====================
app.use(helmet());
// CORS — allow Vercel frontend + open for Telegram WebApp
app.use(cors({
    origin: [
        'https://paycoinads-frontend.vercel.app',
        'https://paycoinads-telegram-app.vercel.app',
        'http://localhost:3000'
    ],
    methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'],
    allowedHeaders: ['Content-Type','X-Telegram-Init-Data','Authorization'],
    credentials: true
}));
app.options('*', cors());
app.use(express.json({ limit: '15mb' })); // Allow large base64 screenshots for VIP purchase

// ==================== HTML Escape Function ====================
function escapeHTML(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\*/g, '&#42;')
        .replace(/_/g, '&#95;')
        .replace(/\[/g, '&#91;')
        .replace(/\]/g, '&#93;')
        .replace(/\(/g, '&#40;')
        .replace(/\)/g, '&#41;');
}

// ==================== Profile Images Array ====================
const DEFAULT_PHOTO = 'https://raw.githubusercontent.com/ggfjhdssd/paycoinads-telegram-app/main/public/images/fa6a539141b9eeae723f551b9d67b875.jpg';
const PROFILE_IMAGES = [
    'https://raw.githubusercontent.com/ggfjhdssd/paycoinads-telegram-app/main/public/images/fa6a539141b9eeae723f551b9d67b875.jpg',
    'https://raw.githubusercontent.com/ggfjhdssd/paycoinads-telegram-app/main/public/images/df0dc02ae9f245b580f060ddf3abdc85.jpg',
    'https://raw.githubusercontent.com/ggfjhdssd/paycoinads-telegram-app/main/public/images/bea9c880a09e1900ee04041881465993.jpg',
    'https://raw.githubusercontent.com/ggfjhdssd/paycoinads-telegram-app/main/public/images/a06d1ec553144a0a6056926cacc222b9.jpg',
];

// ==================== Valid Task IDs ====================
const VALID_TASK_IDS = ['task1', 'task2', 'task3', 'task4', 'task5', 'task6', 'task7'];

// ==================== Rate Limiting ====================
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 150,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.connection.remoteAddress
});
app.use('/api/', apiLimiter);

const claimLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Too many clicks. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.tgUser?.id?.toString() || req.headers['x-forwarded-for']?.split(',')[0] || req.ip
});

// ==================== MongoDB Connection (Optimized) ====================
let cachedDb = null;
let connectionPromise = null;

async function connectToDatabase() {
    if (cachedDb && mongoose.connection.readyState === 1) {
        console.log('✅ Using cached database connection');
        return cachedDb;
    }

    if (connectionPromise) {
        console.log('⏳ Waiting for existing connection attempt...');
        return connectionPromise;
    }

    console.log('🔄 Connecting to MongoDB...');
    console.log('MongoDB URI exists:', !!process.env.MONGODB_URI);
    
    if (!process.env.MONGODB_URI) {
        throw new Error('MONGODB_URI is not defined in environment variables');
    }
    
    connectionPromise = mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 60000,
        connectTimeoutMS: 30000,
        maxPoolSize: 5,
        minPoolSize: 1,
    }).then((connection) => {
        cachedDb = connection;
        connectionPromise = null;
        console.log('✅ MongoDB connected successfully');
        return connection;
    }).catch((err) => {
        connectionPromise = null;
        console.error('❌ MongoDB connection error:', err.message);
        console.error('Full error details:', err);
        throw err;
    });

    return connectionPromise;
}

// ==================== Health Check Endpoint ====================
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        time: new Date().toISOString(),
        env: {
            mongoUri: process.env.MONGODB_URI ? 'exists' : 'missing',
            botToken: process.env.BOT_TOKEN ? 'exists' : 'missing',
            adminId: process.env.ADMIN_ID ? 'exists' : 'missing',
            renderBotUrl: process.env.RENDER_BOT_URL ? 'exists' : 'missing'
        }
    });
});

// ==================== MongoDB Models ====================
const configSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed
});
const Config = mongoose.model('Config', configSchema);

// ==================== User Schema with isBypassed field ====================
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
    isBypassed: { type: Boolean, default: false }, // NEW: VIP Bypass
    spinTickets: { type: Number, default: 1 },
    adWatchCount: { type: Number, default: 0 },
    lastAdWatch: { type: Number, default: 0 },
    adCooldownEndTime: { type: Number, default: 0 },
    vipMode: { type: Boolean, default: false },
    vipExpiry: { type: Date, default: null },
    lastTaskReset: { type: Number, default: 0 }, // timestamp of last global task reset
    gameSession: {
        active: { type: Boolean, default: false },
        startTime: { type: Number, default: 0 },
        tempScore: { type: Number, default: 0 }
    }
});
const User = mongoose.model('User', userSchema);

const withdrawalSchema = new mongoose.Schema({
    userId: { type: Number, required: true },
    amount: { type: Number, required: true },
    method: { type: String, enum: ['kpay', 'wavepay', 'binance'], required: true },
    accountDetails: { type: String, required: true },
    status: { type: String, enum: ['pending', 'completed', 'rejected'], default: 'pending' },
    rejectReason: { type: String, default: null },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// ==================== VIP Purchase Schema ====================
const vipPurchaseSchema = new mongoose.Schema({
    userId: { type: Number, required: true },
    username: String,
    firstName: String,
    amount: { type: Number, default: 5000 },
    paymentMethod: { type: String, enum: ['kpay', 'wave'] },
    screenshotData: { type: String }, // base64 screenshot
    status: { type: String, enum: ['pending', 'confirmed', 'rejected'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});
// 7-day TTL for pending records (confirmed ones kept 30 days)
vipPurchaseSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
const VipPurchase = mongoose.model('VipPurchase', vipPurchaseSchema);

// ==================== Default Configuration ====================
const DEFAULT_CONFIG = {
    REFERRAL_REWARD: 50,
    DAILY_REWARD: 24,
    TASK_REWARD: 40,
    HOME_TASK_REWARD: 45,
    MIN_WITHDRAWAL: parseInt(process.env.MIN_WITHDRAWAL) || 100000,
    TASK_COOLDOWN: 15 * 60 * 1000, // 15 minutes
    DAILY_COOLDOWN: 24 * 60 * 60 * 1000,
    CHANNEL_URL: 'https://t.me/PayCoinADS',
    MAINTENANCE_MODE: false,
    MAINTENANCE_MESSAGE: 'Site is under maintenance. Please check back later.'
};

async function getConfig(key) {
    let cfg = await Config.findOne({ key });
    if (!cfg) {
        cfg = new Config({ key, value: DEFAULT_CONFIG[key] });
        await cfg.save();
    }
    return cfg.value;
}

async function setConfig(key, value) {
    await Config.updateOne({ key }, { value }, { upsert: true });
}

async function initConfigFromEnv() {
    try {
        const envOverrides = { MIN_WITHDRAWAL: process.env.MIN_WITHDRAWAL };
        for (const [key, envValue] of Object.entries(envOverrides)) {
            if (envValue !== undefined && DEFAULT_CONFIG.hasOwnProperty(key)) {
                const existing = await Config.findOne({ key });
                if (!existing) {
                    const numValue = isNaN(envValue) ? envValue : parseInt(envValue);
                    await setConfig(key, numValue);
                    console.log(`✅ Initialized ${key} = ${numValue} from environment`);
                }
            }
        }
    } catch (err) {
        console.error('❌ Config initialization error:', err);
    }
}

// ==================== Helper Functions ====================
function validateTelegramData(initData) {
    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!initData || !BOT_TOKEN) return null;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        return calculatedHash === hash ? Object.fromEntries(params) : null;
    } catch (err) {
        console.error('Validation error:', err);
        return null;
    }
}

async function authMiddleware(req, res, next) {
    if (req.headers['x-telegram-init-data'] === 'bot') {
        req.isBot = true;
        return next();
    }

    const initData = req.headers['x-telegram-init-data'];
    if (!initData) return res.status(401).json({ error: 'Missing init data' });
    const userData = validateTelegramData(initData);
    if (!userData || !userData.user) return res.status(403).json({ error: 'Invalid init data' });
    try {
        req.tgUser = JSON.parse(userData.user);
        next();
    } catch (err) {
        console.error('Error parsing user data:', err);
        return res.status(403).json({ error: 'Invalid user data' });
    }
}

async function adminMiddleware(req, res, next) {
    if (req.isBot) {
        return next();
    }
    await authMiddleware(req, res, (err) => {
        if (err) return;
        if (!isAdmin(req.tgUser.id)) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
}

// ==================== UPDATED: maintenanceCheck with Bypass ====================
async function maintenanceCheck(req, res, next) {
    const maintenance = await getConfig('MAINTENANCE_MODE');
    
    // If maintenance mode is off, proceed
    if (!maintenance) {
        return next();
    }
    
    // Check if user is admin
    if (req.tgUser && isAdmin(req.tgUser.id)) {
        return next();
    }
    
    // Check if user has bypass permission
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (user && user.isBypassed) {
            console.log(`🚀 User ${req.tgUser.id} bypassed maintenance mode`);
            return next();
        }
    } catch (err) {
        console.error('Error checking bypass status:', err);
    }
    
    // Otherwise, show maintenance message
    const message = await getConfig('MAINTENANCE_MESSAGE');
    return res.status(503).json({ error: message || 'Maintenance mode' });
}

function isAdmin(userId) {
    const ADMIN_ID = parseInt(process.env.ADMIN_ID);
    return Number(userId) === Number(ADMIN_ID);
}

async function getOrCreateUser(tgUser, referrerId = null) {
    let user = await User.findOne({ userId: tgUser.id });
    
    if (!user) {
        // Create new user
        user = new User({
            userId: tgUser.id,
            username: tgUser.username || '',
            firstName: tgUser.first_name || '',
            lastName: tgUser.last_name || '',
            photoUrl: DEFAULT_PHOTO,
            coins: 0,
            dailyLastClaim: 0,
            tasks: new Map(),
            videoTasks: new Map(),
            dailyVideoCount: 0,
            lastVideoDate: null,
            referredBy: referrerId ? parseInt(referrerId) : null,
            referralCount: 0,
            unclaimedReferrals: 0,
            createdAt: Date.now(),
            banned: false,
            isBypassed: false, // NEW: default false
            spinTickets: 1,
            adWatchCount: 0,
            lastAdWatch: 0,
            adCooldownEndTime: 0,
            vipMode: false,
            vipExpiry: null,
            lastTaskReset: 0,
            gameSession: { active: false, startTime: 0, tempScore: 0 }
        });
        await user.save();
        console.log(`✅ New user created: ${tgUser.id}`);

        if (referrerId && parseInt(referrerId) !== tgUser.id) {
            const referrer = await User.findOne({ userId: parseInt(referrerId) });
            if (referrer) {
                referrer.coins += 50;
                referrer.referralCount += 1;
                referrer.unclaimedReferrals += 1;
                await referrer.save();
                console.log(`✅ Referrer ${referrer.userId} got +50 coins, referral count: ${referrer.referralCount}`);

                if (process.env.RENDER_BOT_URL) {
                    axios.post(`${process.env.RENDER_BOT_URL}/referral-notify`, {
                        referrerId: referrer.userId,
                        newUserId: tgUser.id
                    }, { timeout: 5000 }).catch(err => {
                        console.error('Failed to send referral notification:', err.message);
                    });
                }
            }
        }

        if (process.env.RENDER_BOT_URL) {
            axios.post(`${process.env.RENDER_BOT_URL}/fetch-photo`, {
                userId: tgUser.id
            }, {
                headers: { 'X-Telegram-Init-Data': 'bot' },
                timeout: 5000
            }).catch(err => console.error('Failed to trigger photo fetch:', err.message));
        }
    } else {
        // Update existing user info
        let updated = false;
        if (tgUser.username && user.username !== tgUser.username) {
            user.username = tgUser.username;
            updated = true;
        }
        if (tgUser.first_name && user.firstName !== tgUser.first_name) {
            user.firstName = tgUser.first_name;
            updated = true;
        }
        if (tgUser.last_name && user.lastName !== tgUser.last_name) {
            user.lastName = tgUser.last_name;
            updated = true;
        }
        if (updated) {
            await user.save();
            console.log(`🔄 Updated user ${tgUser.id}`);
        }
    }
    return user;
}

async function notifyBot(endpoint, data) {
    const RENDER_BOT_URL = process.env.RENDER_BOT_URL;
    if (!RENDER_BOT_URL) {
        console.warn('⚠️ RENDER_BOT_URL not set, skipping bot notification');
        return;
    }
    try {
        await axios.post(`${RENDER_BOT_URL}${endpoint}`, {
            ...data,
            adminId: parseInt(process.env.ADMIN_ID)
        }, {
            timeout: 5000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log(`✅ Bot notified: ${endpoint}`);
    } catch (err) {
        console.error(`❌ Failed to notify bot (${endpoint}):`, err.message);
    }
}

// ==================== UPDATED: VPN CHECK API with Bypass ====================
app.get('/api/check-vpn', async (req, res) => {
    try {
        // Get client IP
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                         req.socket.remoteAddress || 
                         req.connection.remoteAddress;
        
        // Get user ID from headers if available
        const initData = req.headers['x-telegram-init-data'];
        let userId = null;
        let isAdminUser = false;
        let isBypassedUser = false;
        
        if (initData && initData !== 'bot') {
            try {
                const userData = validateTelegramData(initData);
                if (userData && userData.user) {
                    const tgUser = JSON.parse(userData.user);
                    userId = tgUser.id;
                    isAdminUser = isAdmin(userId);
                    
                    // Check if user has bypass permission
                    if (!isAdminUser) {
                        const user = await User.findOne({ userId: userId });
                        isBypassedUser = user && user.isBypassed;
                    }
                }
            } catch (e) {
                console.error('Error parsing user data in VPN check:', e);
            }
        }

        // Admin bypass
        if (isAdminUser) {
            return res.json({
                allowed: true,
                country: 'Admin',
                isAdmin: true,
                isBypassed: false,
                message: 'Admin access granted'
            });
        }
        
        // VIP Bypass
        if (isBypassedUser) {
            console.log(`🚀 User ${userId} bypassed VPN check`);
            return res.json({
                allowed: true,
                country: 'Bypassed',
                isAdmin: false,
                isBypassed: true,
                message: 'VIP Bypass active'
            });
        }

        // Query IP-API.com
        const response = await axios.get(`http://ip-api.com/json/${clientIp}`, {
            timeout: 5000
        });

        const data = response.data;
        
        if (data.status === 'success') {
            const allowed = data.countryCode === 'SG' || data.countryCode === 'US';
            return res.json({
                allowed: allowed,
                country: data.country,
                countryCode: data.countryCode,
                isAdmin: false,
                isBypassed: false,
                message: allowed ? 'Access granted' : 'Only Singapore or United States VPN allowed'
            });
        } else {
            // Fallback - allow if we can't determine
            return res.json({
                allowed: true,
                country: 'Unknown',
                isAdmin: false,
                isBypassed: false,
                message: 'Could not verify location - access granted'
            });
        }
    } catch (error) {
        console.error('VPN check error:', error);
        // Fallback - allow on error
        res.json({
            allowed: true,
            country: 'Error',
            isAdmin: false,
            isBypassed: false,
            message: 'Error checking location - access granted'
        });
    }
});

// ==================== NEW: Toggle Bypass Status ====================
app.post('/api/admin/users/:userId/toggle-bypass', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        
        const user = await User.findOne({ userId: targetId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Toggle the bypass status
        user.isBypassed = !user.isBypassed;
        await user.save();
        
        console.log(`🚀 User ${targetId} bypass toggled to ${user.isBypassed}`);
        
        res.json({ 
            success: true, 
            isBypassed: user.isBypassed,
            message: user.isBypassed ? 'Bypass enabled' : 'Bypass disabled'
        });
    } catch (err) {
        console.error('❌ Error toggling bypass:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== User Info ====================
app.get('/api/user', authMiddleware, maintenanceCheck, async (req, res) => {
    try {
        await connectToDatabase();
        
        // Extract start_param from initData
        const initData = req.headers['x-telegram-init-data'];
        let referrerId = null;
        
        if (initData && initData !== 'bot') {
            const params = new URLSearchParams(initData);
            const startParam = params.get('start_param');
            if (startParam) {
                const match = startParam.match(/\d+/);
                if (match) {
                    referrerId = parseInt(match[0]);
                    console.log(`📎 Found referrer ID from start_param: ${referrerId}`);
                }
            }
        }
        
        const user = await getOrCreateUser(req.tgUser, referrerId);
        if (user.banned) return res.status(403).json({ error: 'Your account is banned' });

        const displayName = user.username || user.firstName || `User${user.userId}`;

        res.json({
            userId: user.userId,
            username: displayName,
            firstName: user.firstName,
            lastName: user.lastName,
            photoUrl: user.photoUrl,
            coins: user.coins,
            dailyLastClaim: user.dailyLastClaim,
            tasks: Object.fromEntries(user.tasks),
            dailyVideoCount: user.dailyVideoCount,
            lastVideoDate: user.lastVideoDate,
            referralCount: user.referralCount,
            unclaimedReferrals: user.unclaimedReferrals,
            createdAt: user.createdAt,
            banned: user.banned,
            isBypassed: user.isBypassed, // NEW: send to frontend
            spinTickets: user.spinTickets,
            adWatchCount: user.adWatchCount,
            lastAdWatch: user.lastAdWatch,
            adCooldownEndTime: user.adCooldownEndTime,
            vipMode: user.vipMode || false,
            vipExpiry: user.vipExpiry || null,
            lastTaskReset: user.lastTaskReset || 0
        });
    } catch (err) {
        console.error('❌ Error in /api/user:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== Daily Claim ====================
app.post('/api/claim/daily', authMiddleware, maintenanceCheck, claimLimiter, async (req, res) => {
    try {
        await connectToDatabase();
        const user = await getOrCreateUser(req.tgUser);
        if (user.banned) return res.status(403).json({ error: 'Banned' });

        const now = Date.now();
        const cooldown = await getConfig('DAILY_COOLDOWN');
        if (now - user.dailyLastClaim < cooldown) {
            return res.status(400).json({ error: 'Not ready', remaining: cooldown - (now - user.dailyLastClaim) });
        }

        const reward = await getConfig('DAILY_REWARD');
        user.coins += reward;
        user.dailyLastClaim = now;
        await user.save();

        res.json({ coins: user.coins, dailyLastClaim: user.dailyLastClaim });
    } catch (err) {
        console.error('❌ Error in /api/claim/daily:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== Task Claim ====================
app.post('/api/claim/task/:taskId', authMiddleware, maintenanceCheck, claimLimiter, async (req, res) => {
    try {
        await connectToDatabase();
        const { taskId } = req.params;
        if (!VALID_TASK_IDS.includes(taskId)) return res.status(400).json({ error: 'Invalid task ID' });

        const user = await getOrCreateUser(req.tgUser);
        if (user.banned) return res.status(403).json({ error: 'Banned' });

        const now = Date.now();
        const cooldown = await getConfig('TASK_COOLDOWN');
        const lastClaim = user.tasks.get(taskId) || 0;
        // Grace buffer of 5 seconds to account for frontend/backend clock drift
        const GRACE_MS = 5000;
        if (now - lastClaim < cooldown - GRACE_MS) {
            return res.status(400).json({ error: 'Not ready', remaining: cooldown - (now - lastClaim) });
        }

        const reward = await getConfig('TASK_REWARD');
        user.coins += reward;
        user.tasks.set(taskId, now);
        await user.save();

        res.json({ coins: user.coins, tasks: Object.fromEntries(user.tasks) });
    } catch (err) {
        console.error('❌ Error in /api/claim/task:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== Adsgram Reward Endpoint ====================
app.get('/api/adsgram-reward', async (req, res) => {
    try {
        await connectToDatabase();
        const { userId, type, taskId } = req.query;

        if (!userId || !type) {
            return res.status(400).send('Missing userId or type parameter');
        }

        const userIdNum = parseInt(userId);
        if (isNaN(userIdNum)) {
            return res.status(400).send('Invalid userId');
        }

        const user = await User.findOne({ userId: userIdNum });
        if (!user) {
            console.warn(`⚠️ User not found for userId: ${userIdNum}`);
            return res.status(404).send('User not found');
        }

        const now = Date.now();
        let reward = 0;
        let cooldownTime = 0;

        if (type === 'daily') {
            cooldownTime = await getConfig('DAILY_COOLDOWN');
            if (now - (user.dailyLastClaim || 0) < cooldownTime) {
                return res.status(400).send('Daily check-in is on cooldown');
            }
            reward = await getConfig('DAILY_REWARD');
            user.dailyLastClaim = now;
        } else if (type === 'task') {
            if (!taskId || !VALID_TASK_IDS.includes(taskId)) {
                return res.status(400).send('Invalid task ID');
            }
            cooldownTime = await getConfig('TASK_COOLDOWN');
            const lastClaim = user.tasks.get(taskId) || 0;
            // Grace buffer of 5 seconds to account for frontend/backend clock drift
            // and the time the user spends watching the ad after the pre-check passes.
            const GRACE_MS = 5000;
            if (now - lastClaim < cooldownTime - GRACE_MS) {
                return res.status(400).send('Task is on cooldown');
            }
            // Use HOME_TASK_REWARD if request comes from home tab
            const source = req.query.source || '';
            if (source === 'home') {
                reward = await getConfig('HOME_TASK_REWARD');
            } else {
                reward = await getConfig('TASK_REWARD');
            }
            user.tasks.set(taskId, now);
        } else {
            return res.status(400).send('Invalid reward type');
        }

        user.coins += reward;
        await user.save();

        console.log(`✅ User ${userIdNum} rewarded with ${reward} coins for ${type} ${taskId || ''}. New balance: ${user.coins}`);
        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Error in /api/adsgram-reward:', error);
        res.status(500).send('Internal Server Error');
    }
});

// ==================== Withdrawal ====================
app.post('/api/withdraw', authMiddleware, maintenanceCheck, claimLimiter, async (req, res) => {
    try {
        await connectToDatabase();
        const { method, accountDetails, accountName, amount } = req.body;
        if (!method || !accountDetails || !amount) return res.status(400).json({ error: 'Missing fields' });
        if (!['kpay', 'wavepay', 'binance'].includes(method)) return res.status(400).json({ error: 'Invalid payment method' });

        const withdrawalAmount = Number(amount);
        if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

        const minWithdraw = await getConfig('MIN_WITHDRAWAL');
        if (withdrawalAmount < minWithdraw) return res.status(400).json({ error: `Minimum withdrawal is ${minWithdraw} coins` });

        const user = await getOrCreateUser(req.tgUser);
        if (user.banned) return res.status(403).json({ error: 'Banned' });
        if (user.coins < withdrawalAmount) return res.status(400).json({ error: 'Insufficient balance' });

        user.coins -= withdrawalAmount;
        await user.save();

        const fullAccountDetails = `${accountDetails} ${accountName ? `(${accountName})` : ''}`;
        const withdrawal = new Withdrawal({
            userId: user.userId,
            amount: withdrawalAmount,
            method,
            accountDetails: fullAccountDetails
        });
        await withdrawal.save();

        res.json({ success: true, remainingCoins: user.coins });
    } catch (err) {
        console.error('❌ Error in /api/withdraw:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== LEADERBOARD (Top 5 by Coins) ====================
app.get('/api/leaderboard', async (req, res) => {
    try {
        await connectToDatabase();
        const users = await User.find({ banned: false })
            .sort({ coins: -1 })
            .limit(5)
            .select('userId username firstName photoUrl coins')
            .lean();

        const leaderboard = users.map((user, index) => {
            let name = user.username || user.firstName;
            if (!name) {
                const userIdStr = user.userId.toString();
                name = `User${userIdStr.slice(-4)}`;
            }
            return {
                rank: index + 1,
                name: name,
                photo: user.photoUrl || null,
                totalCoins: user.coins
            };
        });

        res.json(leaderboard);
    } catch (err) {
        console.error('❌ Error in /api/leaderboard:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== TOP REFERRERS ====================
app.get('/api/top-referrers', async (req, res) => {
    try {
        await connectToDatabase();
        const users = await User.find({ banned: false })
            .sort({ referralCount: -1 })
            .limit(5)
            .select('userId username firstName photoUrl referralCount')
            .lean();

        const formatted = users.map(u => ({
            userId: u.userId,
            username: u.username || u.firstName || `User${u.userId}`,
            firstName: u.firstName,
            photoUrl: u.photoUrl,
            referralCount: u.referralCount
        }));

        res.json(formatted);
    } catch (err) {
        console.error('❌ Error in /api/top-referrers:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== GALAXY ADMIN ROUTES ====================

// Broadcast
app.post('/api/admin/broadcast', adminMiddleware, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message || message.trim() === '') {
            return res.status(400).json({ error: 'Message is required' });
        }
        await notifyBot('/broadcast', { message });
        res.json({ success: true, message: 'Broadcast started. Check bot logs for progress.' });
    } catch (err) {
        console.error('❌ Error in /api/admin/broadcast:', err);
        res.status(500).json({ error: 'Failed to start broadcast: ' + err.message });
    }
});

// Get settings
app.get('/api/admin/settings', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const settings = await Config.find();
        const settingsObj = {};
        settings.forEach(s => { settingsObj[s.key] = s.value; });
        res.json(settingsObj);
    } catch (err) {
        console.error('❌ Error in /api/admin/settings:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Update settings
app.post('/api/admin/settings', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const updates = req.body;
        for (const [key, value] of Object.entries(updates)) {
            await setConfig(key, value);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error in /api/admin/settings:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Get withdrawals
app.get('/api/admin/withdrawals', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const { status, page = 1, limit = 20 } = req.query;
        const filter = {};
        if (status) filter.status = status;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const withdrawals = await Withdrawal.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));
        const total = await Withdrawal.countDocuments(filter);
        res.json({ withdrawals, total, page, limit });
    } catch (err) {
        console.error('❌ Error in /api/admin/withdrawals:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Approve withdrawal
app.post('/api/admin/withdrawals/:id/approve', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const withdrawal = await Withdrawal.findById(req.params.id);
        if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
        if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Withdrawal already processed' });

        withdrawal.status = 'completed';
        await withdrawal.save();

        await notifyBot('/withdrawal-notify', {
            userId: withdrawal.userId,
            amount: withdrawal.amount,
            method: withdrawal.method,
            status: 'completed'
        });

        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error in approve withdrawal:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Reject withdrawal with reason
app.post('/api/admin/withdrawals/:id/reject', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const { reason } = req.body;
        const withdrawal = await Withdrawal.findById(req.params.id);
        if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
        if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Withdrawal already processed' });

        await User.updateOne({ userId: withdrawal.userId }, { $inc: { coins: withdrawal.amount } });

        withdrawal.status = 'rejected';
        withdrawal.rejectReason = reason || null;
        await withdrawal.save();

        await notifyBot('/withdrawal-notify', {
            userId: withdrawal.userId,
            amount: withdrawal.amount,
            method: withdrawal.method,
            status: 'rejected',
            reason: reason || 'No reason provided'
        });

        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error in reject withdrawal:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Ban user
app.post('/api/admin/users/:userId/ban', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        await User.updateOne({ userId: targetId }, { banned: true });
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error banning user:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Unban user
app.post('/api/admin/users/:userId/unban', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        await User.updateOne({ userId: targetId }, { banned: false });
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error unbanning user:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Edit coins (add/subtract)
app.post('/api/admin/users/:userId/coins', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        const { delta } = req.body;
        if (typeof delta !== 'number') return res.status(400).json({ error: 'Delta must be a number' });

        const user = await User.findOneAndUpdate(
            { userId: targetId },
            { $inc: { coins: delta } },
            { new: true }
        );
        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({ success: true, newCoins: user.coins });
    } catch (err) {
        console.error('❌ Error adjusting coins:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Edit referral count
app.post('/api/admin/users/:userId/referral', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        const { delta } = req.body;
        if (typeof delta !== 'number') return res.status(400).json({ error: 'Delta must be a number' });

        const user = await User.findOneAndUpdate(
            { userId: targetId },
            { $inc: { referralCount: delta } },
            { new: true }
        );
        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({ success: true, newReferralCount: user.referralCount });
    } catch (err) {
        console.error('❌ Error adjusting referral count:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Reset tasks
app.post('/api/admin/users/:userId/tasks/reset', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        const user = await User.findOneAndUpdate(
            { userId: targetId },
            { $set: { tasks: {} } },
            { new: true }
        );
        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error resetting tasks:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Update user photo (bot only)
app.post('/api/admin/users/:userId/photo', async (req, res) => {
    if (req.headers['x-telegram-init-data'] !== 'bot') {
        return res.status(403).json({ error: 'Forbidden' });
    }

    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        const { photoUrl } = req.body;

        await User.updateOne(
            { userId: targetId },
            { $set: { photoUrl: photoUrl || DEFAULT_PHOTO } }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error updating user photo:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Get admin stats
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const totalUsers = await User.countDocuments();
        const bannedUsers = await User.countDocuments({ banned: true });
        const totalWithdrawals = await Withdrawal.countDocuments();
        const pendingWithdrawals = await Withdrawal.countDocuments({ status: 'pending' });
        const completedWithdrawals = await Withdrawal.countDocuments({ status: 'completed' });

        const coinsResult = await User.aggregate([{ $group: { _id: null, total: { $sum: "$coins" } } }]);
        const totalCoins = coinsResult.length > 0 ? coinsResult[0].total : 0;

        const payoutResult = await Withdrawal.aggregate([
            { $match: { status: 'completed' } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        const totalPayout = payoutResult.length > 0 ? payoutResult[0].total : 0;

        res.json({
            totalUsers,
            bannedUsers,
            totalWithdrawals,
            pendingWithdrawals,
            completedWithdrawals,
            totalCoins,
            totalPayout
        });
    } catch (err) {
        console.error('❌ Error in /api/admin/stats:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== UPDATED: Get all users with isBypassed field ====================
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const users = await User.find().sort({ createdAt: -1 }).limit(1000);
        const userList = users.map(u => ({
            userId: u.userId,
            username: u.username || u.firstName || `User${u.userId}`,
            firstName: u.firstName,
            lastName: u.lastName,
            photoUrl: u.photoUrl,
            coins: u.coins,
            dailyLastClaim: u.dailyLastClaim,
            tasks: Object.fromEntries(u.tasks),
            videoTasks: u.videoTasks ? Object.fromEntries(u.videoTasks) : {},
            dailyVideoCount: u.dailyVideoCount,
            lastVideoDate: u.lastVideoDate,
            referralCount: u.referralCount,
            unclaimedReferrals: u.unclaimedReferrals,
            createdAt: u.createdAt,
            banned: u.banned,
            isBypassed: u.isBypassed,
            spinTickets: u.spinTickets,
            adWatchCount: u.adWatchCount,
            lastAdWatch: u.lastAdWatch,
            adCooldownEndTime: u.adCooldownEndTime,
            vipMode: u.vipMode || false,
            vipExpiry: u.vipExpiry || null,
            lastTaskReset: u.lastTaskReset || 0
        }));
        console.log(`✅ Bot fetched ${users.length} users`);
        res.json({ users: userList, total: users.length });
    } catch (err) {
        console.error('❌ Error in /api/admin/users:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== MOUNT EARN ROUTES ====================
console.log('📦 Loading earn routes from ../routes/earn...');
try {
    const earnRouter = require('../routes/earn');
    console.log('✅ earn.js loaded successfully');
    app.use('/api/earn', authMiddleware, maintenanceCheck, earnRouter);
    console.log('✅ Earn routes mounted at /api/earn');
} catch (err) {
    console.error('❌ Failed to load earn.js:', err.message);
}

// ==================== MOUNT GAME ROUTES ====================
console.log('📦 Loading game routes from ../routes/games...');
try {
    const gameRouter = require('../routes/games');
    console.log('✅ games.js loaded successfully');
    app.use('/api/games', authMiddleware, maintenanceCheck, gameRouter);
    console.log('✅ Game routes mounted at /api/games');
} catch (err) {
    console.error('❌ Failed to load games.js:', err.message);
}

// ==================== Initialize ====================
connectToDatabase()
    .then(async () => {
        console.log('✅ Database connected. API is ready.');
        await initConfigFromEnv();
        // Setup TTL indexes for MongoDB free tier cleanup
        try {
            // Withdrawals: 30 days TTL
            await mongoose.connection.collection('withdrawals').createIndex(
                { createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30, background: true }
            );
            // VIP Purchases: 30 days TTL
            await mongoose.connection.collection('vippurchases').createIndex(
                { createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30, background: true }
            );
            // Auto-cleanup users inactive for 30 days (via lastSeen field if added later)
            console.log('✅ TTL indexes created successfully');
        } catch(e) {
            console.log('⚠️ TTL index setup:', e.message);
        }
    })
    .catch(err => {
        console.error('❌ Initialization error:', err);
    });

// ==================== VIP Purchase Submit ====================
app.post('/api/vip/purchase', authMiddleware, maintenanceCheck, async (req, res) => {
    try {
        await connectToDatabase();
        const { screenshotData, paymentMethod } = req.body;
        if (!screenshotData || !paymentMethod) {
            return res.status(400).json({ error: 'Missing screenshot or payment method' });
        }
        if (!['kpay', 'wave'].includes(paymentMethod)) {
            return res.status(400).json({ error: 'Invalid payment method' });
        }

        const user = await getOrCreateUser(req.tgUser);
        if (user.banned) return res.status(403).json({ error: 'Banned' });

        // Check if already has active VIP
        if (user.vipMode && user.vipExpiry && new Date(user.vipExpiry) > new Date()) {
            return res.status(400).json({ error: 'VIP mode is already active' });
        }

        // Check pending purchase
        const existing = await VipPurchase.findOne({ userId: user.userId, status: 'pending' });
        if (existing) {
            return res.status(400).json({ error: 'Pending purchase already exists. Please wait for admin confirmation.' });
        }

        const purchase = new VipPurchase({
            userId: user.userId,
            username: user.username,
            firstName: user.firstName,
            amount: 5000,
            paymentMethod,
            screenshotData,
            status: 'pending'
        });
        await purchase.save();

        // Notify admin via bot
        const methodName = paymentMethod === 'kpay' ? 'KPay' : 'Wave Pay';
        const userName = user.username ? `@${user.username}` : (user.firstName || `User${user.userId}`);
        if (process.env.RENDER_BOT_URL) {
            axios.post(`${process.env.RENDER_BOT_URL}/vip-purchase-notify`, {
                purchaseId: purchase._id.toString(),
                userId: user.userId,
                userName,
                amount: 5000,
                paymentMethod: methodName,
                screenshotData
            }, { timeout: 10000 }).catch(err => {
                console.error('Failed to notify bot of VIP purchase:', err.message);
            });
        }

        res.json({ success: true, message: 'Purchase request submitted. Admin will confirm shortly.' });
    } catch (err) {
        console.error('❌ Error in /api/vip/purchase:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== VIP Mode Toggle (User side) ====================
app.post('/api/vip/toggle', authMiddleware, maintenanceCheck, async (req, res) => {
    try {
        await connectToDatabase();
        const user = await getOrCreateUser(req.tgUser);
        if (user.banned) return res.status(403).json({ error: 'Banned' });

        // Check VIP expiry
        const now = new Date();
        if (!user.vipMode && (!user.vipExpiry || new Date(user.vipExpiry) <= now)) {
            return res.status(403).json({ error: 'VIP not active. Please purchase VIP first.' });
        }

        // If expired, auto-disable
        if (user.vipExpiry && new Date(user.vipExpiry) <= now) {
            user.vipMode = false;
            user.vipExpiry = null;
            await user.save();
            return res.status(403).json({ error: 'VIP has expired. Please renew.' });
        }

        user.vipMode = !user.vipMode;
        await user.save();

        res.json({ success: true, vipMode: user.vipMode, vipExpiry: user.vipExpiry });
    } catch (err) {
        console.error('❌ Error in /api/vip/toggle:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== VIP Status Check ====================
app.get('/api/vip/status', authMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const now = new Date();
        // Auto-expire check
        if (user.vipMode && user.vipExpiry && new Date(user.vipExpiry) <= now) {
            user.vipMode = false;
            await user.save();
            // Notify bot to send expiry message
            if (process.env.RENDER_BOT_URL) {
                axios.post(`${process.env.RENDER_BOT_URL}/vip-expired-notify`, {
                    userId: user.userId
                }, { timeout: 5000 }).catch(() => {});
            }
        }

        res.json({
            vipMode: user.vipMode || false,
            vipExpiry: user.vipExpiry || null,
            isExpired: user.vipExpiry ? new Date(user.vipExpiry) <= now : true
        });
    } catch (err) {
        console.error('❌ Error in /api/vip/status:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== Admin: Confirm VIP Purchase ====================
app.post('/api/admin/vip/:purchaseId/confirm', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const purchase = await VipPurchase.findById(req.params.purchaseId);
        if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
        if (purchase.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

        purchase.status = 'confirmed';
        await purchase.save();

        // Set VIP mode for user - 30 days
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + 30);

        await User.updateOne(
            { userId: purchase.userId },
            { vipMode: true, vipExpiry: expiry }
        );

        // Notify user via bot
        if (process.env.RENDER_BOT_URL) {
            axios.post(`${process.env.RENDER_BOT_URL}/vip-confirmed-notify`, {
                userId: purchase.userId,
                expiry: expiry.toISOString()
            }, { timeout: 5000 }).catch(() => {});
        }

        res.json({ success: true, message: 'VIP confirmed for 30 days', expiry });
    } catch (err) {
        console.error('❌ Error confirming VIP:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== Admin: Reject VIP Purchase ====================
app.post('/api/admin/vip/:purchaseId/reject', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const purchase = await VipPurchase.findById(req.params.purchaseId);
        if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
        if (purchase.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

        purchase.status = 'rejected';
        await purchase.save();

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== Admin: Get VIP Purchases ====================
app.get('/api/admin/vip/purchases', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const purchases = await VipPurchase.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(50);
        res.json({ purchases });
    } catch (err) {
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== Admin: Set VIP for User Manually ====================
app.post('/api/admin/users/:userId/vip', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        const { enable } = req.body;

        const user = await User.findOne({ userId: targetId });
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (enable) {
            const expiry = new Date();
            expiry.setDate(expiry.getDate() + 30);
            user.vipMode = true;
            user.vipExpiry = expiry;
        } else {
            user.vipMode = false;
            user.vipExpiry = null;
        }
        await user.save();

        // Notify user via bot if enabling
        if (enable && process.env.RENDER_BOT_URL) {
            axios.post(`${process.env.RENDER_BOT_URL}/vip-confirmed-notify`, {
                userId: user.userId,
                expiry: user.vipExpiry?.toISOString()
            }, { timeout: 5000 }).catch(() => {});
        }

        res.json({ success: true, vipMode: user.vipMode, vipExpiry: user.vipExpiry });
    } catch (err) {
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== User: Global Reset All Tasks ====================
// Regular users: 20-min cooldown | VIP users: 10-min cooldown (auto-called by frontend)
app.post('/api/user/reset-tasks', authMiddleware, maintenanceCheck, async (req, res) => {
    try {
        await connectToDatabase();
        const user = await getOrCreateUser(req.tgUser);
        if (user.banned) return res.status(403).json({ error: 'Banned' });

        const now = Date.now();
        const isVip = user.vipMode && user.vipExpiry && new Date(user.vipExpiry) > new Date();
        const cooldownMs = isVip ? 10 * 60 * 1000 : 20 * 60 * 1000;
        const lastReset = user.lastTaskReset || 0;
        const GRACE_MS = 5000;

        if (now - lastReset < cooldownMs - GRACE_MS) {
            return res.status(400).json({
                error: 'Cooldown not elapsed',
                remaining: cooldownMs - (now - lastReset),
                cooldownMs
            });
        }

        // Reset home tasks (tasks map — task1 to task4)
        user.tasks = new Map();
        user.markModified('tasks');

        // Reset earn tasks (videoTasks map — task1 to task7)
        const EARN_TASK_IDS = ['task1','task2','task3','task4','task5','task6','task7'];
        if (!user.videoTasks) user.videoTasks = new Map();
        EARN_TASK_IDS.forEach(tid => {
            user.videoTasks.set(tid, { count: 0, lastClaim: 0, firstClaimTime: 0 });
        });
        user.markModified('videoTasks');

        user.lastTaskReset = now;
        await user.save();

        console.log(`🔄 User ${req.tgUser.id} reset ALL tasks (VIP: ${isVip}). cooldown: ${cooldownMs/60000}min`);
        res.json({ success: true, lastTaskReset: now, cooldownMs, isVip });
    } catch (err) {
        console.error('❌ Error in /api/user/reset-tasks:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

module.exports = app;
