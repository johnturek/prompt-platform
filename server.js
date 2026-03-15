const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const http = require('http');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Database setup
const db = new Database('/data/prompt.db');
db.pragma('journal_mode = WAL');

// Initialize tables
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        date TEXT,
        created_by TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'draft'
    );
    
    CREATE TABLE IF NOT EXISTS attendees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        email TEXT,
        org TEXT NOT NULL,
        role TEXT,
        join_code TEXT UNIQUE NOT NULL,
        joined_at TEXT,
        FOREIGN KEY (event_id) REFERENCES events(id)
    );
    
    CREATE TABLE IF NOT EXISTS orgs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        research_data TEXT,
        researched_at TEXT,
        FOREIGN KEY (event_id) REFERENCES events(id),
        UNIQUE(event_id, name)
    );
    
    CREATE TABLE IF NOT EXISTS prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        org_id INTEGER,
        text TEXT NOT NULL,
        category TEXT,
        app TEXT,
        source TEXT DEFAULT 'submitted',
        submitted_by INTEGER,
        votes INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (event_id) REFERENCES events(id),
        FOREIGN KEY (org_id) REFERENCES orgs(id)
    );
    
    CREATE TABLE IF NOT EXISTS votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_id INTEGER NOT NULL,
        attendee_id INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (prompt_id) REFERENCES prompts(id),
        FOREIGN KEY (attendee_id) REFERENCES attendees(id),
        UNIQUE(prompt_id, attendee_id)
    );
`);

// Create default admin user
const adminHash = bcrypt.hashSync('CSADemo2026!', 10);
try {
    db.prepare('INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('admin', adminHash, 'admin');
} catch (e) {}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Auth middleware
function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.redirect('/login');
    }
    next();
}

function requireParticipant(req, res, next) {
    if (!req.session.attendee) {
        return res.redirect('/');
    }
    next();
}

// Generate random codes
function generateCode(length = 6) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// ============ ROUTES ============

// Home / Join page
app.get('/', (req, res) => {
    res.send(getHomePage());
});

// Join event via QR code (event-level join page)
app.get('/join/:eventCode', (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE code = ?').get(req.params.eventCode.toUpperCase());
    if (!event) {
        return res.send(getHomePage('Event not found. Please check the QR code or event code.'));
    }
    
    const attendees = db.prepare('SELECT id, name, org FROM attendees WHERE event_id = ? ORDER BY org, name').all(event.id);
    res.send(getEventJoinPage(event, attendees));
});

// Join as specific attendee from event page
app.post('/join/:eventCode', (req, res) => {
    const { attendeeId } = req.body;
    const event = db.prepare('SELECT * FROM events WHERE code = ?').get(req.params.eventCode.toUpperCase());
    
    if (!event) {
        return res.send(getHomePage('Event not found.'));
    }
    
    const attendee = db.prepare('SELECT a.*, e.code as event_code, e.name as event_name FROM attendees a JOIN events e ON a.event_id = e.id WHERE a.id = ? AND a.event_id = ?').get(attendeeId, event.id);
    
    if (!attendee) {
        return res.redirect('/join/' + req.params.eventCode + '?error=not_found');
    }
    
    db.prepare('UPDATE attendees SET joined_at = CURRENT_TIMESTAMP WHERE id = ?').run(attendee.id);
    req.session.attendee = attendee;
    res.redirect('/participate/' + attendee.event_code);
});

// Join event with personal code
app.post('/join', (req, res) => {
    const { joinCode } = req.body;
    const attendee = db.prepare('SELECT a.*, e.code as event_code, e.name as event_name FROM attendees a JOIN events e ON a.event_id = e.id WHERE a.join_code = ?').get(joinCode?.toUpperCase());
    
    if (!attendee) {
        return res.send(getHomePage('Invalid join code. Please check and try again.'));
    }
    
    // Mark as joined
    db.prepare('UPDATE attendees SET joined_at = CURRENT_TIMESTAMP WHERE id = ?').run(attendee.id);
    
    req.session.attendee = attendee;
    res.redirect('/participate/' + attendee.event_code);
});

// Participant experience
app.get('/participate/:code', requireParticipant, (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.redirect('/');
    
    const attendee = req.session.attendee;
    const org = db.prepare('SELECT * FROM orgs WHERE event_id = ? AND name = ?').get(event.id, attendee.org);
    
    // Get org-specific prompts
    const orgPrompts = org ? db.prepare('SELECT p.*, (SELECT COUNT(*) FROM votes WHERE prompt_id = p.id) as vote_count FROM prompts p WHERE p.org_id = ? ORDER BY vote_count DESC').all(org.id) : [];
    
    // Get all event prompts
    const allPrompts = db.prepare('SELECT p.*, o.name as org_name, (SELECT COUNT(*) FROM votes WHERE prompt_id = p.id) as vote_count FROM prompts p LEFT JOIN orgs o ON p.org_id = o.id WHERE p.event_id = ? ORDER BY vote_count DESC').all(event.id);
    
    // Check which prompts this user voted for
    const userVotes = db.prepare('SELECT prompt_id FROM votes WHERE attendee_id = ?').all(attendee.id).map(v => v.prompt_id);
    
    res.send(getParticipatePage(event, attendee, orgPrompts, allPrompts, userVotes));
});

// Submit prompt
app.post('/api/prompts', requireParticipant, (req, res) => {
    const { text, app: appType, eventId } = req.body;
    const attendee = req.session.attendee;
    
    if (!text || text.trim().length < 10) {
        return res.status(400).json({ error: 'Prompt must be at least 10 characters' });
    }
    
    const org = db.prepare('SELECT id FROM orgs WHERE event_id = ? AND name = ?').get(eventId, attendee.org);
    
    const result = db.prepare('INSERT INTO prompts (event_id, org_id, text, app, source, submitted_by) VALUES (?, ?, ?, ?, ?, ?)').run(eventId, org?.id, text.trim(), appType || 'General', 'submitted', attendee.id);
    
    const prompt = db.prepare('SELECT p.*, o.name as org_name FROM prompts p LEFT JOIN orgs o ON p.org_id = o.id WHERE p.id = ?').get(result.lastInsertRowid);
    
    // Broadcast to live wall
    io.to('event-' + eventId).emit('new-prompt', { ...prompt, submitter_name: attendee.name, submitter_org: attendee.org, vote_count: 0 });
    
    res.json({ success: true, prompt });
});

// Vote
app.post('/api/vote/:promptId', requireParticipant, (req, res) => {
    const promptId = parseInt(req.params.promptId);
    const attendeeId = req.session.attendee.id;
    
    try {
        db.prepare('INSERT INTO votes (prompt_id, attendee_id) VALUES (?, ?)').run(promptId, attendeeId);
        db.prepare('UPDATE prompts SET votes = votes + 1 WHERE id = ?').run(promptId);
        
        const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(promptId);
        io.to('event-' + prompt.event_id).emit('vote-update', { promptId, votes: prompt.votes + 1 });
        
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: 'Already voted' });
    }
});

// Unvote
app.delete('/api/vote/:promptId', requireParticipant, (req, res) => {
    const promptId = parseInt(req.params.promptId);
    const attendeeId = req.session.attendee.id;
    
    const result = db.prepare('DELETE FROM votes WHERE prompt_id = ? AND attendee_id = ?').run(promptId, attendeeId);
    if (result.changes > 0) {
        db.prepare('UPDATE prompts SET votes = votes - 1 WHERE id = ?').run(promptId);
        const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(promptId);
        io.to('event-' + prompt.event_id).emit('vote-update', { promptId, votes: prompt.votes - 1 });
    }
    
    res.json({ success: true });
});

// ============ ADMIN ROUTES ============

app.get('/login', (req, res) => {
    res.send(getLoginPage());
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.send(getLoginPage('Invalid credentials'));
    }
    
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.redirect('/admin');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/admin', requireAdmin, (req, res) => {
    const events = db.prepare('SELECT e.*, (SELECT COUNT(*) FROM attendees WHERE event_id = e.id) as attendee_count, (SELECT COUNT(*) FROM prompts WHERE event_id = e.id) as prompt_count FROM events e ORDER BY created_at DESC').all();
    res.send(getAdminPage(events, req.session.user));
});

// Create event
app.post('/admin/events', requireAdmin, (req, res) => {
    const { name, date } = req.body;
    const code = generateCode(6);
    
    db.prepare('INSERT INTO events (code, name, date, created_by, status) VALUES (?, ?, ?, ?, ?)').run(code, name, date, req.session.user.username, 'draft');
    
    res.redirect('/admin');
});

// Event detail
app.get('/admin/events/:code', requireAdmin, async (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.redirect('/admin');
    
    const attendees = db.prepare('SELECT * FROM attendees WHERE event_id = ? ORDER BY org, name').all(event.id);
    const orgs = db.prepare('SELECT * FROM orgs WHERE event_id = ?').all(event.id);
    const prompts = db.prepare('SELECT p.*, o.name as org_name FROM prompts p LEFT JOIN orgs o ON p.org_id = o.id WHERE p.event_id = ? ORDER BY votes DESC').all(event.id);
    
    // Generate QR code
    const joinUrl = `https://prompt.turek.in/join/${event.code}`;
    const qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 300, margin: 2 });
    
    res.send(getEventDetailPage(event, attendees, orgs, prompts, qrDataUrl));
});

// Add attendee
app.post('/admin/events/:code/attendees', requireAdmin, (req, res) => {
    const { name, email, org, role } = req.body;
    const event = db.prepare('SELECT id FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    
    const joinCode = generateCode(8);
    
    // Ensure org exists
    db.prepare('INSERT OR IGNORE INTO orgs (event_id, name) VALUES (?, ?)').run(event.id, org);
    
    db.prepare('INSERT INTO attendees (event_id, name, email, org, role, join_code) VALUES (?, ?, ?, ?, ?, ?)').run(event.id, name, email, org, role, joinCode);
    
    res.redirect('/admin/events/' + req.params.code);
});

// Research org and generate prompts
app.post('/admin/events/:code/research/:orgName', requireAdmin, async (req, res) => {
    const event = db.prepare('SELECT id FROM events WHERE code = ?').get(req.params.code);
    const orgName = decodeURIComponent(req.params.orgName);
    
    if (!event) return res.status(404).json({ error: 'Event not found' });
    
    let org = db.prepare('SELECT * FROM orgs WHERE event_id = ? AND name = ?').get(event.id, orgName);
    if (!org) {
        db.prepare('INSERT INTO orgs (event_id, name) VALUES (?, ?)').run(event.id, orgName);
        org = db.prepare('SELECT * FROM orgs WHERE event_id = ? AND name = ?').get(event.id, orgName);
    }
    
    try {
        // Call Azure OpenAI to research and generate prompts
        const prompts = await generateOrgPrompts(orgName);
        
        // Store prompts
        const insertPrompt = db.prepare('INSERT INTO prompts (event_id, org_id, text, category, app, source) VALUES (?, ?, ?, ?, ?, ?)');
        
        for (const p of prompts) {
            insertPrompt.run(event.id, org.id, p.text, p.category, p.app, 'generated');
        }
        
        // Mark as researched
        db.prepare('UPDATE orgs SET research_data = ?, researched_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify({ promptCount: prompts.length }), org.id);
        
        res.json({ success: true, promptCount: prompts.length });
    } catch (e) {
        console.error('Research error:', e);
        res.status(500).json({ error: 'Failed to generate prompts: ' + e.message });
    }
});

// Generate prompts using Azure OpenAI
async function generateOrgPrompts(orgName) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
    
    const response = await fetch(`${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey
        },
        body: JSON.stringify({
            messages: [
                {
                    role: 'system',
                    content: `You are an expert at creating Microsoft Copilot prompts for government agencies. Generate practical, role-specific prompts that would help employees be more productive.

For each prompt, specify:
- text: The actual prompt text
- category: The work category (e.g., "Writing", "Analysis", "Communication", "Data", "Planning")
- app: The Microsoft app (Word, Excel, PowerPoint, Outlook, Teams, or General)

Return a JSON array of 8-10 prompts.`
                },
                {
                    role: 'user',
                    content: `Generate Microsoft Copilot prompts specifically tailored for employees at ${orgName}. Consider their mission, typical work tasks, and how AI could help them be more productive.

Return ONLY a valid JSON array like:
[{"text": "prompt text here", "category": "Writing", "app": "Word"}, ...]`
                }
            ],
            max_completion_tokens: 2000,
            
        })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
        throw new Error(data.error?.message || 'API request failed');
    }
    
    const content = data.choices[0].message.content;
    
    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = content;
    if (content.includes('```')) {
        jsonStr = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    
    return JSON.parse(jsonStr);
}

// Live wall
app.get('/wall/:code', (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.redirect('/');
    
    const prompts = db.prepare(`
        SELECT p.*, o.name as org_name, a.name as submitter_name, a.org as submitter_org
        FROM prompts p 
        LEFT JOIN orgs o ON p.org_id = o.id 
        LEFT JOIN attendees a ON p.submitted_by = a.id
        WHERE p.event_id = ? 
        ORDER BY p.created_at DESC 
        LIMIT 50
    `).all(event.id);
    
    const topPrompts = db.prepare(`
        SELECT p.*, o.name as org_name
        FROM prompts p 
        LEFT JOIN orgs o ON p.org_id = o.id 
        WHERE p.event_id = ? 
        ORDER BY p.votes DESC 
        LIMIT 10
    `).all(event.id);
    
    res.send(getLiveWallPage(event, prompts, topPrompts));
});

// WebSocket handling
io.on('connection', (socket) => {
    socket.on('join-event', (eventId) => {
        socket.join('event-' + eventId);
    });
});

// Export prompts
app.get('/admin/events/:code/export', requireAdmin, (req, res) => {
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
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${event.code}-prompts.json"`);
    res.send(JSON.stringify(prompts, null, 2));
});

// ============ PAGE TEMPLATES ============

function getHomePage(error = null) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Prompt-a-thon</title>
    <style>
        :root { --primary: #0078d4; --bg: #f5f5f5; --card: #ffffff; --text: #323130; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1rem; }
        .container { background: var(--card); border-radius: 16px; padding: 3rem; max-width: 400px; width: 100%; text-align: center; box-shadow: 0 25px 50px rgba(0,0,0,0.25); }
        h1 { font-size: 2rem; margin-bottom: 0.5rem; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        p { color: #666; margin-bottom: 2rem; }
        .join-form input { width: 100%; padding: 1rem; font-size: 1.5rem; text-align: center; border: 2px solid #e0e0e0; border-radius: 12px; margin-bottom: 1rem; text-transform: uppercase; letter-spacing: 0.3em; }
        .join-form input:focus { outline: none; border-color: var(--primary); }
        .join-form button { width: 100%; padding: 1rem; font-size: 1.1rem; background: var(--primary); color: white; border: none; border-radius: 12px; cursor: pointer; font-weight: 600; }
        .join-form button:hover { background: #106ebe; }
        .error { background: #fef2f2; color: #dc2626; padding: 0.75rem; border-radius: 8px; margin-bottom: 1rem; }
        .admin-link { margin-top: 2rem; font-size: 0.85rem; }
        .admin-link a { color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎯 Prompt-a-thon</h1>
        <p>Enter your join code to participate</p>
        ${error ? `<div class="error">${error}</div>` : ''}
        <form class="join-form" method="POST" action="/join">
            <input type="text" name="joinCode" placeholder="JOIN CODE" maxlength="8" required autofocus>
            <button type="submit">Join Event</button>
        </form>
        <div class="admin-link"><a href="/login">Admin Login</a></div>
    </div>
</body>
</html>`;
}

function getEventJoinPage(event, attendees) {
    const attendeesByOrg = {};
    attendees.forEach(a => {
        if (!attendeesByOrg[a.org]) attendeesByOrg[a.org] = [];
        attendeesByOrg[a.org].push(a);
    });
    
    const orgSections = Object.entries(attendeesByOrg).map(([org, members]) => `
        <div class="org-section">
            <h3>🏢 ${org}</h3>
            <div class="attendee-list">
                ${members.map(m => `
                    <button type="submit" name="attendeeId" value="${m.id}" class="attendee-btn">
                        👤 ${m.name}
                    </button>
                `).join('')}
            </div>
        </div>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Join ${event.name}</title>
    <style>
        :root { --primary: #0078d4; --bg: #f5f5f5; --card: #ffffff; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 1rem; }
        .container { max-width: 500px; margin: 0 auto; }
        .header { text-align: center; color: white; padding: 2rem 0; }
        .header h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
        .header p { opacity: 0.9; }
        .card { background: var(--card); border-radius: 16px; padding: 1.5rem; margin-bottom: 1rem; }
        .card h2 { font-size: 1.1rem; margin-bottom: 1rem; color: #333; }
        .org-section { margin-bottom: 1.5rem; }
        .org-section h3 { font-size: 0.9rem; color: #666; margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid #e0e0e0; }
        .attendee-list { display: flex; flex-direction: column; gap: 0.5rem; }
        .attendee-btn { width: 100%; padding: 1rem; background: #f8fafc; border: 2px solid #e2e8f0; border-radius: 12px; cursor: pointer; font-size: 1rem; text-align: left; transition: all 0.2s; }
        .attendee-btn:hover { border-color: var(--primary); background: #eff6ff; }
        .empty { text-align: center; padding: 2rem; color: #666; }
        .alt-join { text-align: center; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #e0e0e0; }
        .alt-join a { color: var(--primary); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎯 ${event.name}</h1>
            <p>Select your name to join</p>
        </div>
        
        <form method="POST" class="card">
            <h2>👋 Who are you?</h2>
            ${attendees.length ? orgSections : '<div class="empty">No attendees registered yet.<br>Contact the event organizer.</div>'}
        </form>
        
        <div class="card">
            <div class="alt-join">
                Have a personal join code? <a href="/">Enter it here</a>
            </div>
        </div>
    </div>
</body>
</html>`;
}

function getLoginPage(error = null) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Login - Prompt-a-thon</title>
    <style>
        :root { --primary: #0078d4; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: white; border-radius: 16px; padding: 2rem; max-width: 380px; width: 90%; }
        h1 { font-size: 1.5rem; margin-bottom: 1.5rem; text-align: center; }
        .error { background: #fef2f2; color: #dc2626; padding: 0.75rem; border-radius: 8px; margin-bottom: 1rem; }
        input { width: 100%; padding: 0.75rem; border: 2px solid #e0e0e0; border-radius: 8px; margin-bottom: 1rem; font-size: 1rem; }
        button { width: 100%; padding: 0.75rem; background: var(--primary); color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔐 Admin Login</h1>
        ${error ? `<div class="error">${error}</div>` : ''}
        <form method="POST" action="/login">
            <input type="text" name="username" placeholder="Username" required>
            <input type="password" name="password" placeholder="Password" required>
            <button type="submit">Login</button>
        </form>
    </div>
</body>
</html>`;
}

function getAdminPage(events, user) {
    const eventRows = events.map(e => `
        <tr>
            <td><a href="/admin/events/${e.code}">${e.name}</a></td>
            <td><code>${e.code}</code></td>
            <td>${e.date || '-'}</td>
            <td>${e.attendee_count}</td>
            <td>${e.prompt_count}</td>
            <td><span class="status status-${e.status}">${e.status}</span></td>
        </tr>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin - Prompt-a-thon</title>
    <style>
        :root { --primary: #0078d4; --bg: #f5f5f5; --card: #ffffff; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); min-height: 100vh; }
        .header { background: var(--card); padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e0e0e0; }
        .header h1 { font-size: 1.25rem; display: flex; align-items: center; gap: 0.5rem; }
        .container { max-width: 1000px; margin: 0 auto; padding: 2rem; }
        .card { background: var(--card); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .card h2 { margin-bottom: 1rem; font-size: 1.1rem; }
        .form-row { display: flex; gap: 1rem; margin-bottom: 1rem; }
        .form-row input { flex: 1; padding: 0.75rem; border: 2px solid #e0e0e0; border-radius: 8px; }
        .form-row button { padding: 0.75rem 1.5rem; background: var(--primary); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e0e0e0; }
        th { font-weight: 600; color: #666; font-size: 0.85rem; text-transform: uppercase; }
        td a { color: var(--primary); text-decoration: none; font-weight: 600; }
        code { background: #f0f0f0; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.9rem; }
        .status { padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.8rem; font-weight: 600; }
        .status-draft { background: #fef3c7; color: #92400e; }
        .status-active { background: #d1fae5; color: #065f46; }
        .empty { text-align: center; padding: 3rem; color: #666; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎯 Prompt-a-thon Admin</h1>
        <div>👤 ${user.username} | <a href="/logout">Logout</a></div>
    </div>
    <div class="container">
        <div class="card">
            <h2>➕ Create New Event</h2>
            <form method="POST" action="/admin/events">
                <div class="form-row">
                    <input type="text" name="name" placeholder="Event Name (e.g., DOJ Prompt-a-thon)" required>
                    <input type="date" name="date">
                    <button type="submit">Create Event</button>
                </div>
            </form>
        </div>
        
        <div class="card">
            <h2>📅 Events</h2>
            ${events.length ? `
                <table>
                    <thead>
                        <tr><th>Name</th><th>Code</th><th>Date</th><th>Attendees</th><th>Prompts</th><th>Status</th></tr>
                    </thead>
                    <tbody>${eventRows}</tbody>
                </table>
            ` : '<div class="empty">No events yet. Create one above!</div>'}
        </div>
    </div>
</body>
</html>`;
}

function getEventDetailPage(event, attendees, orgs, prompts, qrDataUrl) {
    const orgList = [...new Set(attendees.map(a => a.org))];
    
    const attendeeRows = attendees.map(a => `
        <tr>
            <td>${a.name}</td>
            <td>${a.org}</td>
            <td>${a.role || '-'}</td>
            <td><code>${a.join_code}</code></td>
            <td>${a.joined_at ? '✅' : '⏳'}</td>
        </tr>
    `).join('');
    
    const orgCards = orgList.map(orgName => {
        const org = orgs.find(o => o.name === orgName);
        const promptCount = prompts.filter(p => p.org_name === orgName).length;
        const isResearched = org?.researched_at;
        
        return `
            <div class="org-card">
                <div class="org-name">${orgName}</div>
                <div class="org-stats">${promptCount} prompts</div>
                ${isResearched 
                    ? '<span class="researched">✅ Researched</span>' 
                    : `<button class="research-btn" onclick="researchOrg('${encodeURIComponent(orgName)}')">🔬 Research & Generate</button>`
                }
            </div>
        `;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${event.name} - Prompt-a-thon</title>
    <style>
        :root { --primary: #0078d4; --bg: #f5f5f5; --card: #ffffff; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); }
        .header { background: var(--card); padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e0e0e0; }
        .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
        .card { background: var(--card); border-radius: 12px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .card h2 { margin-bottom: 1rem; font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem; }
        .qr-section { text-align: center; }
        .qr-section img { max-width: 200px; border: 4px solid #f0f0f0; border-radius: 12px; }
        .qr-section .code { font-size: 2rem; font-weight: bold; letter-spacing: 0.2em; color: var(--primary); margin: 1rem 0; }
        .qr-section .url { color: #666; font-size: 0.9rem; word-break: break-all; }
        .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; }
        .actions a, .actions button { padding: 0.5rem 1rem; background: var(--primary); color: white; text-decoration: none; border-radius: 6px; border: none; cursor: pointer; font-size: 0.9rem; }
        .actions a.secondary { background: #6b7280; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #e0e0e0; font-size: 0.9rem; }
        th { font-weight: 600; color: #666; }
        code { background: #f0f0f0; padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.8rem; }
        .form-row { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
        .form-row input { flex: 1; min-width: 120px; padding: 0.5rem; border: 2px solid #e0e0e0; border-radius: 6px; }
        .form-row button { padding: 0.5rem 1rem; background: var(--primary); color: white; border: none; border-radius: 6px; cursor: pointer; }
        .org-card { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem; background: #f9fafb; border-radius: 8px; margin-bottom: 0.5rem; }
        .org-name { font-weight: 600; }
        .org-stats { color: #666; font-size: 0.85rem; }
        .research-btn { padding: 0.4rem 0.8rem; background: #7c3aed; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
        .research-btn:disabled { background: #9ca3af; cursor: wait; }
        .researched { color: #059669; font-size: 0.85rem; }
        .full-width { grid-column: 1 / -1; }
        @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎯 ${event.name}</h1>
        <a href="/admin">← Back to Events</a>
    </div>
    <div class="container">
        <div class="grid">
            <div class="card qr-section">
                <h2>📱 Join QR Code</h2>
                <img src="${qrDataUrl}" alt="QR Code">
                <div class="code">${event.code}</div>
                <div class="url">prompt.turek.in/join/${event.code}</div>
                <div class="actions">
                    <a href="/wall/${event.code}" target="_blank">📺 Live Wall</a>
                    <a href="/admin/events/${event.code}/export" class="secondary">📥 Export</a>
                </div>
            </div>
            
            <div class="card">
                <h2>🏢 Organizations (${orgList.length})</h2>
                ${orgCards || '<p style="color:#666">Add attendees to see organizations</p>'}
            </div>
            
            <div class="card full-width">
                <h2>👥 Attendees (${attendees.length})</h2>
                <form method="POST" action="/admin/events/${event.code}/attendees">
                    <div class="form-row">
                        <input type="text" name="name" placeholder="Name" required>
                        <input type="text" name="org" placeholder="Organization" required>
                        <input type="text" name="role" placeholder="Role">
                        <input type="email" name="email" placeholder="Email">
                        <button type="submit">Add</button>
                    </div>
                </form>
                ${attendees.length ? `
                    <table>
                        <thead><tr><th>Name</th><th>Organization</th><th>Role</th><th>Join Code</th><th>Joined</th></tr></thead>
                        <tbody>${attendeeRows}</tbody>
                    </table>
                ` : ''}
            </div>
            
            <div class="card full-width">
                <h2>💬 Prompts (${prompts.length})</h2>
                ${prompts.length ? `
                    <table>
                        <thead><tr><th>Prompt</th><th>Org</th><th>App</th><th>Source</th><th>Votes</th></tr></thead>
                        <tbody>
                            ${prompts.slice(0, 20).map(p => `
                                <tr>
                                    <td style="max-width:400px">${p.text.substring(0, 100)}${p.text.length > 100 ? '...' : ''}</td>
                                    <td>${p.org_name || '-'}</td>
                                    <td>${p.app || '-'}</td>
                                    <td>${p.source}</td>
                                    <td>${p.votes}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                ` : '<p style="color:#666">No prompts yet</p>'}
            </div>
        </div>
    </div>
    <script>
        async function researchOrg(orgName) {
            const btn = event.target;
            btn.disabled = true;
            btn.textContent = 'Researching...';
            
            try {
                const res = await fetch('/admin/events/${event.code}/research/' + orgName, { method: 'POST' });
                const data = await res.json();
                if (res.ok) {
                    alert('Generated ' + data.promptCount + ' prompts!');
                    location.reload();
                } else {
                    alert('Error: ' + data.error);
                    btn.disabled = false;
                    btn.textContent = '🔬 Research & Generate';
                }
            } catch (e) {
                alert('Network error');
                btn.disabled = false;
                btn.textContent = '🔬 Research & Generate';
            }
        }
    </script>
</body>
</html>`;
}

function getParticipatePage(event, attendee, orgPrompts, allPrompts, userVotes) {
    const apps = ['Word', 'Excel', 'PowerPoint', 'Outlook', 'Teams', 'General'];
    
    const renderPrompt = (p, isOrg = false) => {
        const voted = userVotes.includes(p.id);
        return `
            <div class="prompt-card ${isOrg ? 'org-prompt' : ''}">
                <div class="prompt-text">${p.text}</div>
                <div class="prompt-meta">
                    <span class="app-badge">${p.app || 'General'}</span>
                    ${p.org_name && !isOrg ? `<span class="org-badge">${p.org_name}</span>` : ''}
                    ${p.source === 'generated' ? '<span class="gen-badge">🤖 AI</span>' : ''}
                </div>
                <div class="prompt-actions">
                    <button class="vote-btn ${voted ? 'voted' : ''}" onclick="toggleVote(${p.id}, this)">
                        ${voted ? '❤️' : '🤍'} <span class="vote-count">${p.vote_count || p.votes || 0}</span>
                    </button>
                    <button class="copy-btn" onclick="copyPrompt(this, \`${p.text.replace(/`/g, '\\`').replace(/\\/g, '\\\\')}\`)">📋 Copy</button>
                </div>
            </div>
        `;
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${event.name} - Prompt-a-thon</title>
    <style>
        :root { --primary: #0078d4; --bg: #f5f5f5; --card: #ffffff; --accent: #7c3aed; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); min-height: 100vh; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 1.5rem; text-align: center; }
        .header h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
        .welcome { font-size: 1rem; opacity: 0.9; }
        .tabs { display: flex; background: var(--card); border-bottom: 2px solid #e0e0e0; position: sticky; top: 0; z-index: 10; }
        .tab { flex: 1; padding: 1rem; text-align: center; cursor: pointer; font-weight: 600; border-bottom: 3px solid transparent; transition: all 0.2s; }
        .tab:hover { background: #f9fafb; }
        .tab.active { border-bottom-color: var(--primary); color: var(--primary); }
        .tab-count { background: #e0e0e0; padding: 0.15rem 0.5rem; border-radius: 10px; font-size: 0.8rem; margin-left: 0.5rem; }
        .tab.active .tab-count { background: var(--primary); color: white; }
        .container { max-width: 600px; margin: 0 auto; padding: 1rem; }
        .tab-panel { display: none; }
        .tab-panel.active { display: block; }
        .prompt-card { background: var(--card); border-radius: 12px; padding: 1rem; margin-bottom: 1rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .prompt-card.org-prompt { border-left: 4px solid var(--accent); }
        .prompt-text { font-size: 1rem; line-height: 1.5; margin-bottom: 0.75rem; }
        .prompt-meta { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
        .app-badge { background: #e0f2fe; color: #0369a1; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
        .org-badge { background: #f3e8ff; color: #7c3aed; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.75rem; }
        .gen-badge { background: #fef3c7; color: #92400e; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.75rem; }
        .prompt-actions { display: flex; gap: 0.5rem; }
        .vote-btn, .copy-btn { padding: 0.5rem 1rem; border: none; border-radius: 8px; cursor: pointer; font-size: 0.9rem; transition: all 0.2s; }
        .vote-btn { background: #f3f4f6; }
        .vote-btn.voted { background: #fef2f2; color: #dc2626; }
        .vote-btn:hover { transform: scale(1.05); }
        .copy-btn { background: #f3f4f6; }
        .copy-btn.copied { background: #d1fae5; color: #065f46; }
        .submit-card { background: var(--card); border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .submit-card h3 { margin-bottom: 1rem; font-size: 1rem; }
        .submit-card textarea { width: 100%; padding: 0.75rem; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 1rem; resize: vertical; min-height: 80px; font-family: inherit; }
        .submit-card textarea:focus { outline: none; border-color: var(--primary); }
        .submit-row { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
        .submit-row select { flex: 1; padding: 0.5rem; border: 2px solid #e0e0e0; border-radius: 8px; }
        .submit-row button { padding: 0.5rem 1.5rem; background: var(--primary); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
        .empty { text-align: center; padding: 2rem; color: #666; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎯 ${event.name}</h1>
        <div class="welcome">Welcome, <strong>${attendee.name}</strong> from <strong>${attendee.org}</strong></div>
    </div>
    
    <div class="tabs">
        <div class="tab active" onclick="switchTab('org')">⭐ For ${attendee.org}<span class="tab-count">${orgPrompts.length}</span></div>
        <div class="tab" onclick="switchTab('all')">📋 All Prompts<span class="tab-count">${allPrompts.length}</span></div>
    </div>
    
    <div class="container">
        <!-- Submit new prompt -->
        <div class="submit-card">
            <h3>💡 Share Your Prompt</h3>
            <textarea id="promptText" placeholder="Type a Copilot prompt that helps you or your colleagues..."></textarea>
            <div class="submit-row">
                <select id="promptApp">
                    ${apps.map(a => `<option value="${a}">${a}</option>`).join('')}
                </select>
                <button onclick="submitPrompt()">Submit</button>
            </div>
        </div>
        
        <!-- Org prompts -->
        <div class="tab-panel active" id="panel-org">
            ${orgPrompts.length ? orgPrompts.map(p => renderPrompt(p, true)).join('') : '<div class="empty">No prompts for your organization yet.<br>Check back soon!</div>'}
        </div>
        
        <!-- All prompts -->
        <div class="tab-panel" id="panel-all">
            ${allPrompts.length ? allPrompts.map(p => renderPrompt(p)).join('') : '<div class="empty">No prompts yet. Be the first!</div>'}
        </div>
    </div>
    
    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        socket.emit('join-event', ${event.id});
        
        function switchTab(tab) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            document.querySelector(\`.tab[onclick="switchTab('\${tab}')"]\`).classList.add('active');
            document.getElementById('panel-' + tab).classList.add('active');
        }
        
        async function toggleVote(promptId, btn) {
            const isVoted = btn.classList.contains('voted');
            const method = isVoted ? 'DELETE' : 'POST';
            
            try {
                const res = await fetch('/api/vote/' + promptId, { method, credentials: 'include' });
                if (res.ok) {
                    btn.classList.toggle('voted');
                    const countEl = btn.querySelector('.vote-count');
                    countEl.textContent = parseInt(countEl.textContent) + (isVoted ? -1 : 1);
                    btn.querySelector(':first-child').textContent = isVoted ? '🤍' : '❤️';
                }
            } catch (e) {
                console.error(e);
            }
        }
        
        function copyPrompt(btn, text) {
            navigator.clipboard.writeText(text);
            btn.classList.add('copied');
            btn.textContent = '✓ Copied';
            setTimeout(() => {
                btn.classList.remove('copied');
                btn.textContent = '📋 Copy';
            }, 2000);
        }
        
        async function submitPrompt() {
            const text = document.getElementById('promptText').value.trim();
            const app = document.getElementById('promptApp').value;
            
            if (text.length < 10) {
                alert('Please enter a longer prompt (at least 10 characters)');
                return;
            }
            
            try {
                const res = await fetch('/api/prompts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ text, app, eventId: ${event.id} })
                });
                
                if (res.ok) {
                    document.getElementById('promptText').value = '';
                    alert('Prompt submitted! 🎉');
                    location.reload();
                } else {
                    const data = await res.json();
                    alert(data.error || 'Failed to submit');
                }
            } catch (e) {
                alert('Network error');
            }
        }
        
        // Real-time updates
        socket.on('new-prompt', (prompt) => {
            console.log('New prompt:', prompt);
            // Could add dynamic UI update here
        });
        
        socket.on('vote-update', ({ promptId, votes }) => {
            document.querySelectorAll(\`.vote-btn\`).forEach(btn => {
                if (btn.onclick.toString().includes(promptId)) {
                    btn.querySelector('.vote-count').textContent = votes;
                }
            });
        });
    </script>
</body>
</html>`;
}

function getLiveWallPage(event, prompts, topPrompts) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Live Wall - ${event.name}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); color: white; min-height: 100vh; overflow: hidden; }
        .header { background: rgba(0,0,0,0.3); padding: 1.5rem 2rem; display: flex; justify-content: space-between; align-items: center; }
        .header h1 { font-size: 2rem; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .stats { display: flex; gap: 2rem; }
        .stat { text-align: center; }
        .stat-value { font-size: 2.5rem; font-weight: bold; }
        .stat-label { font-size: 0.9rem; opacity: 0.7; }
        .main { display: grid; grid-template-columns: 2fr 1fr; gap: 2rem; padding: 2rem; height: calc(100vh - 100px); }
        .feed { overflow: hidden; }
        .feed h2 { margin-bottom: 1rem; font-size: 1.25rem; opacity: 0.8; }
        .feed-scroll { height: calc(100% - 40px); overflow: hidden; }
        .prompt-item { background: rgba(255,255,255,0.1); border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; animation: slideIn 0.5s ease; backdrop-filter: blur(10px); }
        @keyframes slideIn { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
        .prompt-item.hot { border: 2px solid #f59e0b; }
        .prompt-text { font-size: 1.1rem; line-height: 1.5; margin-bottom: 0.75rem; }
        .prompt-meta { display: flex; gap: 1rem; font-size: 0.85rem; opacity: 0.7; }
        .prompt-org { color: #a78bfa; }
        .prompt-votes { color: #f472b6; }
        .leaderboard h2 { margin-bottom: 1rem; font-size: 1.25rem; opacity: 0.8; }
        .top-prompt { background: rgba(255,255,255,0.05); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; display: flex; gap: 1rem; align-items: flex-start; }
        .rank { font-size: 1.5rem; font-weight: bold; width: 40px; }
        .rank.gold { color: #fbbf24; }
        .rank.silver { color: #94a3b8; }
        .rank.bronze { color: #d97706; }
        .top-prompt-text { flex: 1; font-size: 0.95rem; line-height: 1.4; }
        .top-votes { color: #f472b6; font-weight: bold; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎯 ${event.name}</h1>
        <div class="stats">
            <div class="stat">
                <div class="stat-value" id="promptCount">${prompts.length}</div>
                <div class="stat-label">Prompts</div>
            </div>
            <div class="stat">
                <div class="stat-value" id="voteCount">${prompts.reduce((sum, p) => sum + (p.votes || 0), 0)}</div>
                <div class="stat-label">Votes</div>
            </div>
        </div>
    </div>
    
    <div class="main">
        <div class="feed">
            <h2>📢 Live Feed</h2>
            <div class="feed-scroll" id="feedScroll">
                ${prompts.map(p => `
                    <div class="prompt-item ${p.votes >= 3 ? 'hot' : ''}">
                        <div class="prompt-text">${p.text}</div>
                        <div class="prompt-meta">
                            ${p.submitter_name ? `<span>👤 ${p.submitter_name}</span>` : ''}
                            <span class="prompt-org">🏢 ${p.org_name || p.submitter_org || 'General'}</span>
                            <span class="prompt-votes">❤️ ${p.votes || 0}</span>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
        
        <div class="leaderboard">
            <h2>🏆 Top Prompts</h2>
            ${topPrompts.map((p, i) => `
                <div class="top-prompt">
                    <div class="rank ${i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : ''}">#${i + 1}</div>
                    <div class="top-prompt-text">${p.text.substring(0, 80)}${p.text.length > 80 ? '...' : ''}</div>
                    <div class="top-votes">❤️ ${p.votes || 0}</div>
                </div>
            `).join('')}
        </div>
    </div>
    
    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        socket.emit('join-event', ${event.id});
        
        socket.on('new-prompt', (prompt) => {
            const feed = document.getElementById('feedScroll');
            const item = document.createElement('div');
            item.className = 'prompt-item';
            item.innerHTML = \`
                <div class="prompt-text">\${prompt.text}</div>
                <div class="prompt-meta">
                    \${prompt.submitter_name ? \`<span>👤 \${prompt.submitter_name}</span>\` : ''}
                    <span class="prompt-org">🏢 \${prompt.org_name || prompt.submitter_org || 'General'}</span>
                    <span class="prompt-votes">❤️ \${prompt.vote_count || 0}</span>
                </div>
            \`;
            feed.insertBefore(item, feed.firstChild);
            
            // Update count
            const countEl = document.getElementById('promptCount');
            countEl.textContent = parseInt(countEl.textContent) + 1;
        });
        
        socket.on('vote-update', ({ promptId, votes }) => {
            const countEl = document.getElementById('voteCount');
            countEl.textContent = parseInt(countEl.textContent) + 1;
        });
    </script>
</body>
</html>`;
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Prompt-a-thon Platform running on port ${PORT}`);
});
