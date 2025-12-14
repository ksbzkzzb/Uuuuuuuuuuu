const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('./database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Middleware to verify admin token
const verifyAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied' });

    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
        req.user = verified;
        next();
    } catch (err) {
        res.status(400).json({ error: 'Invalid token' });
    }
};

// Admin login
router.post('/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await dbGet('SELECT * FROM admin_users WHERE username = ?', [username]);
        
        if (!user) return res.status(400).json({ error: 'User not found' });
        
        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(400).json({ error: 'Invalid password' });
        
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            process.env.JWT_SECRET || 'your-secret-key',
            { expiresIn: '24h' }
        );
        
        res.json({ success: true, token, user: { username: user.username, role: user.role } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create coupons (Admin only)
router.post('/admin/coupons', verifyAdmin, async (req, res) => {
    try {
        const { prefix = "LIKES", count = 1, likes_count, expires_days, created_by } = req.body;
        
        const coupons = [];
        for (let i = 0; i < count; i++) {
            let code;
            let isUnique = false;
            
            while (!isUnique) {
                code = generateCouponCode(prefix);
                const existing = await dbGet('SELECT id FROM coupons WHERE code = ?', [code]);
                if (!existing) isUnique = true;
            }
            
            let expires_at = null;
            if (expires_days) {
                expires_at = new Date(Date.now() + expires_days * 24 * 60 * 60 * 1000).toISOString();
            }
            
            await dbRun(
                'INSERT INTO coupons (code, likes_count, expires_at, created_by) VALUES (?, ?, ?, ?)',
                [code, likes_count, expires_at, created_by || req.user.username]
            );
            
            coupons.push({ code, likes_count, expires_at });
        }
        
        res.json({
            success: true,
            message: `Created ${coupons.length} coupon(s)`,
            coupons: coupons.map(c => c.code)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all coupons (Admin only)
router.get('/admin/coupons', verifyAdmin, async (req, res) => {
    try {
        const coupons = await dbAll(`
            SELECT 
                c.*,
                COUNT(t.id) as used_times,
                GROUP_CONCAT(t.account_id) as used_accounts
            FROM coupons c
            LEFT JOIN transactions t ON c.id = t.coupon_id
            GROUP BY c.id
            ORDER BY c.created_at DESC
        `);
        
        res.json({ success: true, coupons });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check coupon validity
router.get('/check-coupon', async (req, res) => {
    try {
        const { code } = req.query;
        if (!code) return res.json({ valid: false, message: 'Coupon code required' });
        
        const coupon = await dbGet(`
            SELECT * FROM coupons 
            WHERE code = ? AND status = 'active' 
            AND (expires_at IS NULL OR expires_at > datetime('now'))
        `, [code]);
        
        if (!coupon) {
            return res.json({ 
                valid: false, 
                message: 'Invalid or expired coupon' 
            });
        }
        
        res.json({
            valid: true,
            likes: coupon.likes_count,
            expires_at: coupon.expires_at,
            created_at: coupon.created_at
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Use coupon
router.post('/use-coupon', async (req, res) => {
    try {
        const { code, account_id, region, user_id } = req.body;
        
        // Start transaction
        const coupon = await dbGet(`
            SELECT * FROM coupons 
            WHERE code = ? AND status = 'active' 
            AND (expires_at IS NULL OR expires_at > datetime('now'))
            FOR UPDATE
        `, [code]);
        
        if (!coupon) {
            return res.json({ success: false, message: 'Invalid or expired coupon' });
        }
        
        // Mark coupon as used
        await dbRun(
            `UPDATE coupons SET status = 'used', used_at = datetime('now'), used_by = ? WHERE id = ?`,
            [user_id || 'anonymous', coupon.id]
        );
        
        // Record transaction
        await dbRun(
            `INSERT INTO transactions (coupon_id, account_id, likes_sent, region, user_id) 
             VALUES (?, ?, ?, ?, ?)`,
            [coupon.id, account_id, coupon.likes_count, region, user_id || 'anonymous']
        );
        
        // Here you would integrate with Free Fire API to send likes
        // For now, we'll simulate success
        
        res.json({
            success: true,
            message: `Successfully sent ${coupon.likes_count} likes to account ${account_id}`,
            coupon_balance: 0,
            transaction_id: Date.now()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get player info (simulated - replace with real API)
router.get('/info', async (req, res) => {
    try {
        const { id } = req.query;
        
        // This is simulated data - replace with actual Free Fire API
        const player = {
            id: id,
            nickname: `Player_${id.slice(0, 5)}`,
            region: 'ME',
            level: Math.floor(Math.random() * 70) + 1,
            liked: Math.floor(Math.random() * 1000),
            avatar: 'default',
            banner: 'default'
        };
        
        res.json({ success: true, player });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// System status
router.get('/status', (req, res) => {
    res.json({ 
        updating: false,
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Generate coupon code helper
function generateCouponCode(prefix) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = prefix + '-';
    
    for (let part = 0; part < 3; part++) {
        for (let i = 0; i < 4; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        if (part < 2) code += '-';
    }
    
    return code;
}

module.exports = router;
