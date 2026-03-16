const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');
const { stringify } = require('csv-stringify/sync');
const db = require('../db');
const { generateCode } = require('../utils');
const { requireAdmin } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/limiters');
const { generateOrgPrompts } = require('../services/ai');
const logger = require('../logger');
const getLoginPage = require('../views/auth');
const getAdminPage = require('../views/admin/dashboard');
const getEventDetailPage = require('../views/admin/event-detail');
const getPrintCardsPage = require('../views/admin/print-cards');
const getUsersPage = require('../views/admin/users');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1_000_000 } });

router.get('/login', (req, res) => {
    res.send(getLoginPage());
});

router.post('/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.send(getLoginPage('Username and password required'));
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).slice(0, 64));
    
    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
        logger.warn({ msg: 'Failed login', username, ip: req.ip });
        return res.send(getLoginPage('Invalid credentials'));
    }
    
    logger.info({ msg: 'Admin login', username: user.username });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.redirect('/admin');
});

router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

router.get('/admin', requireAdmin, (req, res) => {
    const events = db.prepare('SELECT e.*, (SELECT COUNT(*) FROM attendees WHERE event_id = e.id) as attendee_count, (SELECT COUNT(*) FROM prompts WHERE event_id = e.id) as prompt_count FROM events e ORDER BY created_at DESC').all();
    res.send(getAdminPage(events, req.session.user));
});

router.post('/admin/events', requireAdmin, (req, res) => {
    const { name, date } = req.body;
    const code = generateCode(6);
    
    db.prepare('INSERT INTO events (code, name, date, created_by, status) VALUES (?, ?, ?, ?, ?)').run(code, name, date, req.session.user.username, 'draft');
    
    res.redirect('/admin');
});

router.get('/admin/events/:code', requireAdmin, async (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.redirect('/admin');
    
    const attendees = db.prepare('SELECT * FROM attendees WHERE event_id = ? ORDER BY org, name').all(event.id);
    const orgs = db.prepare('SELECT * FROM orgs WHERE event_id = ?').all(event.id);
    const prompts = db.prepare('SELECT p.*, o.name as org_name FROM prompts p LEFT JOIN orgs o ON p.org_id = o.id WHERE p.event_id = ? ORDER BY votes DESC').all(event.id);
    
    const joinUrl = `https://prompt.turek.in/join/${event.code}`;
    const qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 300, margin: 2 });
    
    res.send(getEventDetailPage(event, attendees, orgs, prompts, qrDataUrl));
});

router.post('/admin/events/:code/attendees', requireAdmin, (req, res) => {
    const { name, email, org, role } = req.body;
    const event = db.prepare('SELECT id FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    
    const joinCode = generateCode(8);
    
    db.prepare('INSERT OR IGNORE INTO orgs (event_id, name) VALUES (?, ?)').run(event.id, org);
    
    db.prepare('INSERT INTO attendees (event_id, name, email, org, role, join_code) VALUES (?, ?, ?, ?, ?, ?)').run(event.id, name, email, org, role, joinCode);
    
    res.redirect('/admin/events/' + req.params.code);
});

router.post('/admin/events/:code/orgs', requireAdmin, (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.redirect('/admin/events/' + req.params.code);
    const event = db.prepare('SELECT id FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.redirect('/admin');
    db.prepare('INSERT OR IGNORE INTO orgs (event_id, name) VALUES (?, ?)').run(event.id, name.trim());
    res.redirect('/admin/events/' + req.params.code);
});

router.delete('/admin/events/:code/orgs/:orgName', requireAdmin, (req, res) => {
    const orgName = decodeURIComponent(req.params.orgName);
    const event = db.prepare('SELECT id FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    db.prepare('DELETE FROM orgs WHERE event_id = ? AND name = ?').run(event.id, orgName);
    res.json({ ok: true });
});

router.post('/admin/events/:code/status', requireAdmin, (req, res) => {
    const { status } = req.body;
    if (!['draft', 'active', 'closed'].includes(status)) return res.redirect('/admin/events/' + req.params.code);
    db.prepare('UPDATE events SET status = ? WHERE code = ?').run(status, req.params.code);
    logger.info({ msg: 'Event status changed', code: req.params.code, status });
    res.redirect('/admin/events/' + req.params.code);
});

router.get('/admin/events/:code/print-cards', requireAdmin, async (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.redirect('/admin');
    const attendees = db.prepare('SELECT * FROM attendees WHERE event_id = ? ORDER BY org, name').all(event.id);
    const cards = await Promise.all(attendees.map(async (a) => {
        const url = `https://prompt.turek.in/j/${a.join_code}`;
        const qr = await QRCode.toDataURL(url, { width: 200, margin: 1 });
        return { ...a, qr };
    }));
    res.send(getPrintCardsPage(event, cards));
});

router.post('/admin/events/:code/research/:orgName', requireAdmin, async (req, res) => {
    const event = db.prepare('SELECT id FROM events WHERE code = ?').get(req.params.code);
    const orgName = decodeURIComponent(req.params.orgName);
    
    if (!event) return res.status(404).json({ error: 'Event not found' });
    
    let org = db.prepare('SELECT * FROM orgs WHERE event_id = ? AND name = ?').get(event.id, orgName);
    if (!org) {
        db.prepare('INSERT INTO orgs (event_id, name) VALUES (?, ?)').run(event.id, orgName);
        org = db.prepare('SELECT * FROM orgs WHERE event_id = ? AND name = ?').get(event.id, orgName);
    }
    
    try {
        const prompts = await generateOrgPrompts(orgName, req.body.guidance || '', req.body.count || 10, req.body.products || []);
        
        const insertPrompt = db.prepare('INSERT INTO prompts (event_id, org_id, text, category, app, source) VALUES (?, ?, ?, ?, ?, ?)');
        
        for (const p of prompts) {
            insertPrompt.run(event.id, org.id, p.text, p.category, p.app, 'generated');
        }
        
        db.prepare('UPDATE orgs SET research_data = ?, researched_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify({ promptCount: prompts.length }), org.id);
        
        res.json({ success: true, promptCount: prompts.length });
    } catch (e) {
        console.error('Research error:', e);
        res.status(500).json({ error: 'Failed to generate prompts: ' + e.message });
    }
});

router.get('/admin/events/:code/export', requireAdmin, (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.status(404).send('Event not found');
    
    const prompts = db.prepare(`
        SELECT p.text, p.category, p.app, p.source, p.votes, o.name as org, a.name as submitted_by
        FROM prompts p 
        LEFT JOIN orgs o ON p.org_id = o.id 
        LEFT JOIN attendees a ON p.submitted_by = a.id
        WHERE p.event_id = ? 
        ORDER BY p.votes DESC
    `).all(event.id);
    
    if (req.query.format === 'csv') {
        const csv = stringify(prompts, { header: true });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${event.code}-prompts.csv"`);
        return res.send(csv);
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${event.code}-prompts.json"`);
    res.send(JSON.stringify(prompts, null, 2));
});

router.post('/admin/events/:code/import', requireAdmin, upload.single('csvfile'), (req, res) => {
    const event = db.prepare('SELECT id FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const lines = req.file.buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
    const header = lines[0].toLowerCase().split(',').map(h => h.trim());
    const nameIdx = header.indexOf('name');
    const orgIdx  = header.indexOf('org');
    const roleIdx = header.indexOf('role');
    const emailIdx = header.indexOf('email');
    if (nameIdx === -1 || orgIdx === -1) return res.status(400).json({ error: 'CSV must have at least name,org columns' });

    let added = 0, skipped = 0;
    const insertOrg     = db.prepare('INSERT OR IGNORE INTO orgs (event_id, name) VALUES (?, ?)');
    const insertAttendee = db.prepare('INSERT OR IGNORE INTO attendees (event_id, name, email, org, role, join_code) VALUES (?, ?, ?, ?, ?, ?)');

    const importMany = db.transaction((rows) => {
        for (const row of rows) {
            const cols = row.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
            const name = cols[nameIdx]; const org = cols[orgIdx];
            if (!name || !org) { skipped++; continue; }
            const joinCode = generateCode(8);
            insertOrg.run(event.id, org);
            const result = insertAttendee.run(event.id, name, emailIdx >= 0 ? cols[emailIdx] : null, org, roleIdx >= 0 ? cols[roleIdx] : null, joinCode);
            if (result.changes) added++; else skipped++;
        }
    });
    importMany(lines.slice(1));
    logger.info({ msg: 'Bulk import', event: req.params.code, added, skipped });
    res.json({ success: true, added, skipped });
});

router.post('/admin/prompts/:id/flag', requireAdmin, (req, res) => {
    const promptId = parseInt(req.params.id);
    const { reason } = req.body;
    db.prepare('INSERT OR REPLACE INTO prompt_flags (prompt_id, reason) VALUES (?, ?)').run(promptId, reason || null);
    res.json({ success: true });
});

router.delete('/admin/prompts/:id', requireAdmin, (req, res) => {
    const promptId = parseInt(req.params.id);
    db.prepare('DELETE FROM prompt_flags WHERE prompt_id = ?').run(promptId);
    db.prepare('DELETE FROM votes WHERE prompt_id = ?').run(promptId);
    db.prepare('DELETE FROM prompts WHERE id = ?').run(promptId);
    res.json({ success: true });
});

router.get('/admin/users', requireAdmin, (req, res) => {
    const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all();
    res.send(getUsersPage(users, req.session.user));
});

router.post('/admin/users', requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password || password.length < 8) {
        return res.redirect('/admin/users?error=Username+and+password+(min+8+chars)+required');
    }
    const hash = bcrypt.hashSync(String(password), 12);
    try {
        db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
            String(username).slice(0, 64), hash, role === 'admin' ? 'admin' : 'viewer'
        );
    } catch (e) {
        return res.redirect('/admin/users?error=Username+already+exists');
    }
    res.redirect('/admin/users');
});

router.post('/admin/users/password', requireAdmin, (req, res) => {
    const { current_password, new_password, confirm_password } = req.body;
    if (new_password !== confirm_password) return res.redirect('/admin/users?error=Passwords+do+not+match');
    if (!new_password || new_password.length < 8) return res.redirect('/admin/users?error=New+password+must+be+at+least+8+chars');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    if (!bcrypt.compareSync(String(current_password), user.password_hash)) {
        return res.redirect('/admin/users?error=Current+password+incorrect');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(new_password), 12), user.id);
    logger.info({ msg: 'Password changed', username: user.username });
    res.redirect('/admin/users?success=Password+updated');
});

router.delete('/admin/users/:id', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id);
    if (userId === req.session.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE role = ?').get('admin').c;
    if (count <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    res.json({ success: true });
});

module.exports = router;
