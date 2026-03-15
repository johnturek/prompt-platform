require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const http = require('http');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const multer = require('multer');
const { stringify } = require('csv-stringify/sync');

// ============ LOGGER ============
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        process.env.NODE_ENV === 'production'
            ? winston.format.json()
            : winston.format.combine(winston.format.colorize(), winston.format.simple())
    ),
    transports: [new winston.transports.Console()]
});

// ============ RATE LIMITERS ============
const globalLimiter = rateLimit({ windowMs: 60_000, max: 200, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, message: { error: 'Too many login attempts, try again later' } });
const apiLimiter  = rateLimit({ windowMs: 60_000, max: 60, message: { error: 'Rate limit exceeded' } });

// multer (in-memory, CSV import only)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1_000_000 } });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Database setup
const DB_PATH = process.env.DB_PATH || '/data/prompt.db';
const db = new Database(DB_PATH);
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

    CREATE TABLE IF NOT EXISTS prompt_flags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_id INTEGER NOT NULL UNIQUE,
        reason TEXT,
        flagged_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (prompt_id) REFERENCES prompts(id)
    );
`);

// Create default admin user
const adminHash = bcrypt.hashSync('CSADemo2026!', 10);
try {
    db.prepare('INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('admin', adminHash, 'admin');
} catch (e) {}

// ============ MIDDLEWARE ============
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(globalLimiter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// Health endpoint (before auth middleware)
app.get('/health', (req, res) => {
    try {
        db.prepare('SELECT 1').get();
        res.json({ status: 'ok', uptime: process.uptime(), ts: new Date().toISOString() });
    } catch (e) {
        res.status(503).json({ status: 'error', message: e.message });
    }
});

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

// Personal join shortlink — used by per-attendee QR codes on printed cards
app.get('/j/:joinCode', (req, res) => {
    const attendee = db.prepare('SELECT a.*, e.code as event_code, e.name as event_name FROM attendees a JOIN events e ON a.event_id = e.id WHERE a.join_code = ?').get(req.params.joinCode?.toUpperCase());
    if (!attendee) return res.send(getHomePage('Invalid join link. Please check your card.'));
    db.prepare('UPDATE attendees SET joined_at = CURRENT_TIMESTAMP WHERE id = ?').run(attendee.id);
    req.session.attendee = attendee;
    res.redirect('/participate/' + attendee.event_code);
});

// Participant experience
app.get('/participate/:code', requireParticipant, (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.redirect('/');
    if (event.status === 'closed') return res.send(getEventClosedPage(event));

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
app.post('/api/prompts', apiLimiter, requireParticipant, (req, res) => {
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
app.post('/api/vote/:promptId', apiLimiter, requireParticipant, (req, res) => {
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

app.post('/login', loginLimiter, (req, res) => {
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

// Toggle event status (draft / active / closed)
app.post('/admin/events/:code/status', requireAdmin, (req, res) => {
    const { status } = req.body;
    if (!['draft', 'active', 'closed'].includes(status)) return res.redirect('/admin/events/' + req.params.code);
    db.prepare('UPDATE events SET status = ? WHERE code = ?').run(status, req.params.code);
    logger.info({ msg: 'Event status changed', code: req.params.code, status });
    res.redirect('/admin/events/' + req.params.code);
});

// Print attendee cards (one QR-coded card per attendee)
app.get('/admin/events/:code/print-cards', requireAdmin, async (req, res) => {
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

// Live stats API (used by admin event page to show real-time join counts)
app.get('/api/events/:code/stats', requireAdmin, (req, res) => {
    const event = db.prepare('SELECT id FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.status(404).json({ error: 'Not found' });
    const total    = db.prepare('SELECT COUNT(*) as c FROM attendees WHERE event_id = ?').get(event.id).c;
    const joined   = db.prepare('SELECT COUNT(*) as c FROM attendees WHERE event_id = ? AND joined_at IS NOT NULL').get(event.id).c;
    const prompts  = db.prepare('SELECT COUNT(*) as c FROM prompts WHERE event_id = ?').get(event.id).c;
    const votes    = db.prepare('SELECT COALESCE(SUM(votes),0) as c FROM prompts WHERE event_id = ?').get(event.id).c;
    res.json({ total, joined, prompts, votes });
});


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

// Generate prompts using Azure OpenAI (or mock mode)
async function generateOrgPrompts(orgName) {
    // Mock mode: return sample prompts without calling Azure OpenAI
    if (process.env.MOCK_AI === 'true') {
        logger.info({ msg: 'Mock AI mode — returning sample prompts', org: orgName });
        return [
            { text: `Draft a briefing memo summarizing ${orgName}'s top priorities for the quarter using Copilot in Word.`, category: 'Writing', app: 'Word' },
            { text: `Analyze our budget data and highlight variances over 10% using Copilot in Excel.`, category: 'Analysis', app: 'Excel' },
            { text: `Summarize the last 30 days of emails related to ${orgName} policy updates using Copilot in Outlook.`, category: 'Communication', app: 'Outlook' },
            { text: `Create a status-update presentation for leadership covering milestones and risks using Copilot in PowerPoint.`, category: 'Planning', app: 'PowerPoint' },
            { text: `Generate meeting notes and action items from our last all-hands using Copilot in Teams.`, category: 'Communication', app: 'Teams' },
            { text: `Build a project tracking template for ${orgName} tasks with automated status formulas using Copilot in Excel.`, category: 'Data', app: 'Excel' },
            { text: `Write a plain-language summary of the latest regulatory guidance relevant to ${orgName} using Copilot in Word.`, category: 'Writing', app: 'Word' },
            { text: `Identify recurring themes in employee feedback survey responses for ${orgName} using Copilot.`, category: 'Analysis', app: 'General' },
        ];
    }

    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
    // Validate env vars and normalize endpoint
    if (!endpoint) throw new Error('Missing AZURE_OPENAI_ENDPOINT environment variable');
    if (!apiKey) throw new Error('Missing AZURE_OPENAI_KEY environment variable');
    if (!deployment) throw new Error('Missing AZURE_OPENAI_DEPLOYMENT environment variable');

    const endpointUrl = endpoint.replace(/\/+$/, '');

    const response = await fetch(`${endpointUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`, {
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

    const orgFilter = req.query.org ? decodeURIComponent(req.query.org) : null;
    const mode = req.query.mode === 'leaderboard' ? 'leaderboard' : 'default';

    const orgClause = orgFilter ? 'AND o.name = ?' : '';
    const orgArgs   = orgFilter ? [event.id, orgFilter] : [event.id];

    const prompts = db.prepare(`
        SELECT p.*, o.name as org_name, a.name as submitter_name, a.org as submitter_org
        FROM prompts p
        LEFT JOIN orgs o ON p.org_id = o.id
        LEFT JOIN attendees a ON p.submitted_by = a.id
        WHERE p.event_id = ? ${orgClause}
        ORDER BY p.created_at DESC
        LIMIT 50
    `).all(...orgArgs);

    const topPrompts = db.prepare(`
        SELECT p.*, o.name as org_name
        FROM prompts p
        LEFT JOIN orgs o ON p.org_id = o.id
        WHERE p.event_id = ? ${orgClause}
        ORDER BY p.votes DESC
        LIMIT 10
    `).all(...orgArgs);

    res.send(getLiveWallPage(event, prompts, topPrompts, { orgFilter, mode }));
});

// WebSocket handling
io.on('connection', (socket) => {
    socket.on('join-event', (eventId) => {
        socket.join('event-' + eventId);
    });
});

// Export prompts – JSON (default) or CSV via ?format=csv
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

// Bulk import attendees from CSV upload
app.post('/admin/events/:code/import', requireAdmin, upload.single('csvfile'), (req, res) => {
    const event = db.prepare('SELECT id FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const lines = req.file.buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
    // Expect header: name,org,role,email
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

// Flag prompt
app.post('/admin/prompts/:id/flag', requireAdmin, (req, res) => {
    const promptId = parseInt(req.params.id);
    const { reason } = req.body;
    db.prepare('INSERT OR REPLACE INTO prompt_flags (prompt_id, reason) VALUES (?, ?)').run(promptId, reason || null);
    res.json({ success: true });
});

// Unflag / delete prompt
app.delete('/admin/prompts/:id', requireAdmin, (req, res) => {
    const promptId = parseInt(req.params.id);
    db.prepare('DELETE FROM prompt_flags WHERE prompt_id = ?').run(promptId);
    db.prepare('DELETE FROM votes WHERE prompt_id = ?').run(promptId);
    db.prepare('DELETE FROM prompts WHERE id = ?').run(promptId);
    res.json({ success: true });
});

// ============ USER MANAGEMENT ============
app.get('/admin/users', requireAdmin, (req, res) => {
    const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all();
    res.send(getUsersPage(users, req.session.user));
});

app.post('/admin/users', requireAdmin, (req, res) => {
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

app.post('/admin/users/password', requireAdmin, (req, res) => {
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

app.delete('/admin/users/:id', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id);
    if (userId === req.session.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE role = ?').get('admin').c;
    if (count <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    res.json({ success: true });
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
        <div>👤 ${user.username} | <a href="/admin/users">Users</a> | <a href="/logout">Logout</a></div>
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

    const statusColors = { draft: '#fef3c7|#92400e', active: '#d1fae5|#065f46', closed: '#fee2e2|#991b1b' };
    const [statusBg, statusFg] = (statusColors[event.status] || statusColors.draft).split('|');

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
        .actions a.secondary, .actions button.secondary { background: #6b7280; }
        .actions a.purple, .actions button.purple { background: #7c3aed; }
        .actions a.green, .actions button.green { background: #059669; }
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
        .del-btn { background: none; border: none; cursor: pointer; font-size: 1rem; opacity: 0.5; }
        .del-btn:hover { opacity: 1; }
        .status-badge { display: inline-block; padding: 0.3rem 0.8rem; border-radius: 12px; font-size: 0.85rem; font-weight: 700; }
        .controls-row { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin-top: 0.75rem; }
        .stat-pill { background: #f0f4ff; border-radius: 8px; padding: 0.4rem 0.9rem; font-size: 0.9rem; font-weight: 600; color: #1e40af; }
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

            <!-- Event Controls (full width) -->
            <div class="card full-width">
                <h2>⚙️ Event Controls</h2>
                <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">
                    <span class="status-badge" style="background:${statusBg};color:${statusFg}">
                        ${event.status === 'active' ? '🟢' : event.status === 'closed' ? '🔴' : '🟡'} ${event.status.toUpperCase()}
                    </span>
                    <span class="stat-pill" id="statJoined">👥 -- / ${attendees.length} joined</span>
                    <span class="stat-pill" id="statPrompts">💬 ${prompts.length} prompts</span>
                    <span class="stat-pill" id="statVotes">❤️ -- votes</span>
                </div>
                <div class="controls-row" style="margin-top:1rem">
                    ${event.status !== 'active'  ? `<form method="POST" action="/admin/events/${event.code}/status" style="display:inline"><input type="hidden" name="status" value="active"><button class="actions green" style="padding:0.5rem 1.25rem;border-radius:6px;font-size:0.9rem;cursor:pointer">🟢 Open Event</button></form>` : ''}
                    ${event.status !== 'closed'  ? `<form method="POST" action="/admin/events/${event.code}/status" style="display:inline"><input type="hidden" name="status" value="closed"><button class="actions secondary" style="padding:0.5rem 1.25rem;border-radius:6px;font-size:0.9rem;cursor:pointer">🔴 Close Event</button></form>` : ''}
                    ${event.status !== 'draft'   ? `<form method="POST" action="/admin/events/${event.code}/status" style="display:inline"><input type="hidden" name="status" value="draft"><button class="actions secondary" style="padding:0.5rem 1.25rem;border-radius:6px;font-size:0.9rem;cursor:pointer;background:#d97706">🟡 Back to Draft</button></form>` : ''}
                </div>
                <div class="controls-row">
                    <strong style="font-size:0.85rem;color:#666">🖥️ Project:</strong>
                    <a href="/wall/${event.code}" target="_blank" class="actions" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem;text-decoration:none">📺 Live Wall</a>
                    <a href="/wall/${event.code}?mode=leaderboard" target="_blank" class="actions purple" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem;text-decoration:none">🏆 Leaderboard</a>
                    ${orgList.map(o => `<a href="/wall/${event.code}?org=${encodeURIComponent(o)}" target="_blank" class="actions secondary" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem;text-decoration:none">🏢 ${o}</a>`).join('')}
                </div>
                <div class="controls-row">
                    <strong style="font-size:0.85rem;color:#666">📤 Export:</strong>
                    <a href="/admin/events/${event.code}/export" class="actions secondary" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem;text-decoration:none">📥 JSON</a>
                    <a href="/admin/events/${event.code}/export?format=csv" class="actions secondary" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem;text-decoration:none">📊 CSV</a>
                    <button onclick="copyTopPrompts()" class="actions secondary" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem">📋 Copy Top Prompts</button>
                    <a href="/admin/events/${event.code}/print-cards" target="_blank" class="actions secondary" style="padding:0.4rem 0.9rem;border-radius:6px;font-size:0.85rem;text-decoration:none">🖨️ Print Cards</a>
                </div>
            </div>

            <div class="card qr-section">
                <h2>📱 Join QR Code</h2>
                <img src="${qrDataUrl}" alt="QR Code">
                <div class="code">${event.code}</div>
                <div class="url">prompt.turek.in/join/${event.code}</div>
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
                <form id="importForm" enctype="multipart/form-data" style="margin-bottom:1rem">
                    <div class="form-row" style="align-items:center">
                        <label style="font-size:0.85rem;color:#666">Bulk import CSV (name,org,role,email):</label>
                        <input type="file" name="csvfile" accept=".csv" required style="flex:1;border:none;padding:0">
                        <button type="button" onclick="importCSV()">📥 Import</button>
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
                        <thead><tr><th>Prompt</th><th>Org</th><th>App</th><th>Source</th><th>Votes</th><th></th></tr></thead>
                        <tbody>
                            ${prompts.slice(0, 50).map(p => `
                                <tr>
                                    <td style="max-width:400px">${p.text.substring(0, 100)}${p.text.length > 100 ? '...' : ''}</td>
                                    <td>${p.org_name || '-'}</td>
                                    <td>${p.app || '-'}</td>
                                    <td>${p.source}</td>
                                    <td>${p.votes}</td>
                                    <td><button class="del-btn" onclick="deletePrompt(${p.id}, this)">🗑️</button></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                ` : '<p style="color:#666">No prompts yet</p>'}
            </div>
        </div>
    </div>
    <script>
        // Live stats polling
        async function refreshStats() {
            try {
                const data = await fetch('/api/events/${event.code}/stats').then(r => r.json());
                document.getElementById('statJoined').textContent = '👥 ' + data.joined + ' / ' + data.total + ' joined';
                document.getElementById('statPrompts').textContent = '💬 ' + data.prompts + ' prompts';
                document.getElementById('statVotes').textContent = '❤️ ' + data.votes + ' votes';
            } catch(e) {}
        }
        refreshStats();
        setInterval(refreshStats, 10000);

        async function copyTopPrompts() {
            try {
                const data = await fetch('/admin/events/${event.code}/export').then(r => r.json());
                const top = data.slice(0, 10);
                const text = top.map((p, i) => \`\${i+1}. [\${p.app || 'General'}] \${p.text}\`).join('\\n\\n');
                await navigator.clipboard.writeText(text);
                alert('Top ' + top.length + ' prompts copied to clipboard!');
            } catch(e) { alert('Copy failed'); }
        }

        async function researchOrg(orgName) {
            const btn = event.target;
            btn.disabled = true;
            btn.textContent = 'Researching...';
            try {
                const res = await fetch('/admin/events/${event.code}/research/' + orgName, { method: 'POST' });
                const data = await res.json();
                if (res.ok) { alert('Generated ' + data.promptCount + ' prompts!'); location.reload(); }
                else { alert('Error: ' + data.error); btn.disabled = false; btn.textContent = '🔬 Research & Generate'; }
            } catch (e) { alert('Network error'); btn.disabled = false; btn.textContent = '🔬 Research & Generate'; }
        }

        async function deletePrompt(id, btn) {
            if (!confirm('Delete this prompt? This cannot be undone.')) return;
            const res = await fetch('/admin/prompts/' + id, { method: 'DELETE' });
            if (res.ok) btn.closest('tr').remove();
            else alert('Failed to delete');
        }

        async function importCSV() {
            const form = document.getElementById('importForm');
            const fd = new FormData(form);
            const res = await fetch('/admin/events/${event.code}/import', { method: 'POST', body: fd });
            const data = await res.json();
            if (res.ok) { alert('Imported ' + data.added + ' attendees, skipped ' + data.skipped); location.reload(); }
            else alert('Import error: ' + data.error);
        }
    </script>
</body>
</html>`;
}

function getUsersPage(users, currentUser) {
    const userRows = users.map(u => `
        <tr>
            <td>${u.username}</td>
            <td><span class="status status-${u.role}">${u.role}</span></td>
            <td>${u.created_at}</td>
            <td>${u.id !== currentUser.id ? `<button onclick="deleteUser(${u.id}, this)">🗑️</button>` : '<span style="color:#999">you</span>'}</td>
        </tr>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>User Management - Prompt-a-thon</title>
    <style>
        :root { --primary: #0078d4; --bg: #f5f5f5; --card: #ffffff; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); }
        .header { background: var(--card); padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e0e0e0; }
        .container { max-width: 800px; margin: 0 auto; padding: 2rem; }
        .card { background: var(--card); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .card h2 { margin-bottom: 1rem; font-size: 1.1rem; }
        .form-row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
        .form-row input, .form-row select { flex: 1; min-width: 120px; padding: 0.6rem; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 0.95rem; }
        .form-row button { padding: 0.6rem 1.25rem; background: var(--primary); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e0e0e0; }
        th { font-weight: 600; color: #666; font-size: 0.85rem; }
        .status { padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.8rem; font-weight: 600; }
        .status-admin { background: #dbeafe; color: #1e40af; }
        .status-viewer { background: #f3f4f6; color: #374151; }
        .alert { padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.95rem; }
        .alert-error { background: #fef2f2; color: #dc2626; }
        .alert-success { background: #d1fae5; color: #065f46; }
        .back { font-size: 0.9rem; color: #666; text-decoration: none; }
    </style>
</head>
<body>
    <div class="header">
        <h1>👥 User Management</h1>
        <div><a href="/admin" class="back">← Back to Admin</a> | <a href="/logout">Logout</a></div>
    </div>
    <div class="container">
        ${new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('error') ? '' : ''}
        <div class="card">
            <h2>➕ Add Admin User</h2>
            <form method="POST" action="/admin/users">
                <div class="form-row">
                    <input type="text" name="username" placeholder="Username" required>
                    <input type="password" name="password" placeholder="Password (min 8 chars)" required minlength="8">
                    <select name="role"><option value="admin">Admin</option><option value="viewer">Viewer</option></select>
                    <button type="submit">Add User</button>
                </div>
            </form>
        </div>

        <div class="card">
            <h2>🔑 Change Your Password</h2>
            <form method="POST" action="/admin/users/password">
                <div class="form-row">
                    <input type="password" name="current_password" placeholder="Current password" required>
                    <input type="password" name="new_password" placeholder="New password (min 8 chars)" required minlength="8">
                    <input type="password" name="confirm_password" placeholder="Confirm new password" required>
                    <button type="submit">Update</button>
                </div>
            </form>
        </div>

        <div class="card">
            <h2>👤 Users (${users.length})</h2>
            <table>
                <thead><tr><th>Username</th><th>Role</th><th>Created</th><th></th></tr></thead>
                <tbody>${userRows}</tbody>
            </table>
        </div>
    </div>
    <script>
        // Show flash messages from query string
        const params = new URLSearchParams(location.search);
        if (params.get('error')) {
            const div = document.createElement('div');
            div.className = 'alert alert-error';
            div.textContent = decodeURIComponent(params.get('error'));
            document.querySelector('.container').prepend(div);
        }
        if (params.get('success')) {
            const div = document.createElement('div');
            div.className = 'alert alert-success';
            div.textContent = decodeURIComponent(params.get('success'));
            document.querySelector('.container').prepend(div);
        }
        async function deleteUser(id, btn) {
            if (!confirm('Delete this user?')) return;
            const res = await fetch('/admin/users/' + id, { method: 'DELETE' });
            const data = await res.json();
            if (res.ok) btn.closest('tr').remove();
            else alert(data.error);
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
        .app-filter { display: flex; gap: 0.5rem; flex-wrap: wrap; padding: 0.75rem 0 0.25rem; }
        .filter-chip { padding: 0.35rem 0.9rem; border: 2px solid #e0e0e0; background: white; border-radius: 20px; cursor: pointer; font-size: 0.8rem; font-weight: 600; transition: all 0.15s; }
        .filter-chip.active { background: var(--primary); color: white; border-color: var(--primary); }
        .filter-chip:hover:not(.active) { border-color: var(--primary); color: var(--primary); }
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
        <!-- App filter chips -->
        <div class="app-filter">
            <button class="filter-chip active" onclick="filterApp('all', this)">All</button>
            <button class="filter-chip" onclick="filterApp('Word', this)">📝 Word</button>
            <button class="filter-chip" onclick="filterApp('Excel', this)">📊 Excel</button>
            <button class="filter-chip" onclick="filterApp('PowerPoint', this)">📑 PowerPoint</button>
            <button class="filter-chip" onclick="filterApp('Outlook', this)">📧 Outlook</button>
            <button class="filter-chip" onclick="filterApp('Teams', this)">💬 Teams</button>
            <button class="filter-chip" onclick="filterApp('General', this)">✨ General</button>
        </div>
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

        function filterApp(app, chip) {
            document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            document.querySelectorAll('.prompt-card').forEach(card => {
                const badge = card.querySelector('.app-badge');
                card.style.display = (app === 'all' || (badge && badge.textContent.trim() === app)) ? '' : 'none';
            });
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

function getLiveWallPage(event, prompts, topPrompts, options = {}) {
    const { orgFilter = null, mode = 'default' } = options;
    const subtitle = orgFilter ? `🏢 ${orgFilter}` : '';
    const isLeaderboard = mode === 'leaderboard';

    if (isLeaderboard) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🏆 Top Prompts — ${event.name}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); color: white; min-height: 100vh; padding: 2rem; }
        h1 { text-align: center; font-size: 2.5rem; margin-bottom: 0.5rem; background: linear-gradient(135deg, #fbbf24, #f472b6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .subtitle { text-align: center; color: rgba(255,255,255,0.6); margin-bottom: 2rem; font-size: 1.1rem; }
        .leaderboard { max-width: 900px; margin: 0 auto; }
        .entry { display: flex; gap: 1.25rem; align-items: flex-start; background: rgba(255,255,255,0.07); border-radius: 14px; padding: 1.25rem 1.5rem; margin-bottom: 1rem; backdrop-filter: blur(6px); transition: background 0.3s; }
        .entry.top1 { background: rgba(251,191,36,0.18); border: 1px solid rgba(251,191,36,0.4); }
        .entry.top2 { background: rgba(148,163,184,0.15); border: 1px solid rgba(148,163,184,0.3); }
        .entry.top3 { background: rgba(217,119,6,0.15); border: 1px solid rgba(217,119,6,0.3); }
        .rank { font-size: 2rem; font-weight: 900; min-width: 2.5rem; text-align: center; }
        .rank.r1 { color: #fbbf24; }
        .rank.r2 { color: #94a3b8; }
        .rank.r3 { color: #d97706; }
        .body { flex: 1; }
        .prompt-text { font-size: 1.15rem; line-height: 1.5; margin-bottom: 0.5rem; }
        .meta { display: flex; gap: 1rem; font-size: 0.85rem; opacity: 0.65; }
        .votes { font-size: 1.5rem; font-weight: 800; color: #f472b6; min-width: 3rem; text-align: right; align-self: center; }
        .empty { text-align: center; padding: 4rem; opacity: 0.5; font-size: 1.2rem; }
    </style>
</head>
<body>
    <h1>🏆 Top Prompts</h1>
    <div class="subtitle">${event.name}${orgFilter ? ' · ' + orgFilter : ''}</div>
    <div class="leaderboard" id="board">
        ${topPrompts.length ? topPrompts.map((p, i) => `
            <div class="entry ${i===0?'top1':i===1?'top2':i===2?'top3':''}" data-id="${p.id}">
                <div class="rank ${i===0?'r1':i===1?'r2':i===2?'r3':''}">${i===0?'🥇':i===1?'🥈':i===2?'🥉':'#'+(i+1)}</div>
                <div class="body">
                    <div class="prompt-text">${p.text}</div>
                    <div class="meta">
                        ${p.org_name ? `<span>🏢 ${p.org_name}</span>` : ''}
                        ${p.app ? `<span>${p.app}</span>` : ''}
                    </div>
                </div>
                <div class="votes" id="v${p.id}">❤️ ${p.votes||0}</div>
            </div>
        `).join('') : '<div class="empty">No prompts yet</div>'}
    </div>
    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        socket.emit('join-event', ${event.id});
        const voteCounts = {${topPrompts.map(p => `${p.id}:${p.votes||0}`).join(',')}};
        socket.on('vote-update', ({ promptId, votes }) => {
            voteCounts[promptId] = votes;
            const el = document.getElementById('v' + promptId);
            if (el) el.textContent = '❤️ ' + votes;
        });
    </script>
</body>
</html>`;
    }

    // Default wall mode
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
        .header-right { display: flex; gap: 2rem; align-items: center; }
        .stats { display: flex; gap: 2rem; }
        .stat { text-align: center; }
        .stat-value { font-size: 2.5rem; font-weight: bold; }
        .stat-label { font-size: 0.9rem; opacity: 0.7; }
        .filter-tag { background: rgba(124,58,237,0.4); border: 1px solid rgba(124,58,237,0.6); border-radius: 20px; padding: 0.3rem 0.9rem; font-size: 0.85rem; }
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
        .top-votes { color: #f472b6; font-weight: bold; white-space: nowrap; }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h1>🎯 ${event.name}</h1>
            ${subtitle ? `<div class="filter-tag">${subtitle}</div>` : ''}
        </div>
        <div class="header-right">
            <div class="stats">
                <div class="stat">
                    <div class="stat-value" id="promptCount">${prompts.length}</div>
                    <div class="stat-label">Prompts</div>
                </div>
                <div class="stat">
                    <div class="stat-value" id="voteCount">${prompts.reduce((s, p) => s + (p.votes || 0), 0)}</div>
                    <div class="stat-label">Votes</div>
                </div>
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
            <div id="topList">
                ${topPrompts.map((p, i) => `
                    <div class="top-prompt" data-id="${p.id}">
                        <div class="rank ${i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : ''}">#${i + 1}</div>
                        <div class="top-prompt-text">${p.text.substring(0, 80)}${p.text.length > 80 ? '...' : ''}</div>
                        <div class="top-votes" id="tv${p.id}">❤️ ${p.votes || 0}</div>
                    </div>
                `).join('')}
            </div>
        </div>
    </div>
    
    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        socket.emit('join-event', ${event.id});

        // Track per-prompt votes to compute accurate total (fixes counter drift)
        const promptVotes = {${prompts.map(p => `${p.id}:${p.votes||0}`).join(',')}};

        socket.on('new-prompt', (prompt) => {
            promptVotes[prompt.id] = 0;
            const feed = document.getElementById('feedScroll');
            const item = document.createElement('div');
            item.className = 'prompt-item';
            item.innerHTML = \`
                <div class="prompt-text">\${prompt.text}</div>
                <div class="prompt-meta">
                    \${prompt.submitter_name ? \`<span>👤 \${prompt.submitter_name}</span>\` : ''}
                    <span class="prompt-org">🏢 \${prompt.org_name || prompt.submitter_org || 'General'}</span>
                    <span class="prompt-votes">❤️ 0</span>
                </div>
            \`;
            feed.insertBefore(item, feed.firstChild);
            document.getElementById('promptCount').textContent = parseInt(document.getElementById('promptCount').textContent) + 1;
        });

        socket.on('vote-update', ({ promptId, votes }) => {
            const prev = promptVotes[promptId] || 0;
            promptVotes[promptId] = votes;
            const delta = votes - prev;
            const totalEl = document.getElementById('voteCount');
            totalEl.textContent = parseInt(totalEl.textContent) + delta;
            // Update leaderboard entry if visible
            const tvEl = document.getElementById('tv' + promptId);
            if (tvEl) tvEl.textContent = '❤️ ' + votes;
        });
    </script>
</body>
</html>`;
}

// ============ ERROR HANDLER ============

function getEventClosedPage(event) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Workshop Ended - ${event.name}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .card { background: white; border-radius: 20px; padding: 3rem; max-width: 480px; width: 90%; text-align: center; box-shadow: 0 30px 60px rgba(0,0,0,0.25); }
        .icon { font-size: 4rem; margin-bottom: 1rem; }
        h1 { font-size: 1.75rem; margin-bottom: 0.75rem; color: #1e293b; }
        p { color: #64748b; line-height: 1.6; margin-bottom: 1.5rem; }
        .event-name { font-weight: 700; color: #7c3aed; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">🎉</div>
        <h1>Thanks for participating!</h1>
        <p>The <span class="event-name">${event.name}</span> workshop has ended. Your prompts and votes have been recorded.</p>
        <p style="font-size:0.9rem;color:#94a3b8">Ask your facilitator to share the results!</p>
    </div>
</body>
</html>`;
}

function getPrintCardsPage(event, cards) {
    const cardHtml = cards.map(a => `
        <div class="card">
            <div class="event-name">${event.name}</div>
            <div class="attendee-name">${a.name}</div>
            <div class="attendee-org">${a.org}${a.role ? ' · ' + a.role : ''}</div>
            <img src="${a.qr}" alt="QR code" class="qr">
            <div class="join-code">${a.join_code}</div>
            <div class="instructions">Scan QR or go to prompt.turek.in and enter your code</div>
        </div>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Attendee Cards — ${event.name}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', sans-serif; background: #f5f5f5; padding: 1rem; }
        .controls { text-align: center; padding: 1rem; margin-bottom: 1rem; }
        .controls button { padding: 0.75rem 2rem; background: #0078d4; color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; margin-right: 0.5rem; }
        .controls button.secondary { background: #6b7280; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; max-width: 1100px; margin: 0 auto; }
        .card { background: white; border-radius: 12px; padding: 1.25rem; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border: 2px solid #e0e0e0; page-break-inside: avoid; }
        .event-name { font-size: 0.7rem; color: #888; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0.5rem; }
        .attendee-name { font-size: 1.2rem; font-weight: 700; color: #1e293b; margin-bottom: 0.25rem; }
        .attendee-org { font-size: 0.85rem; color: #7c3aed; font-weight: 600; margin-bottom: 0.75rem; }
        .qr { width: 150px; height: 150px; border-radius: 8px; margin-bottom: 0.75rem; }
        .join-code { font-size: 1.5rem; font-weight: 900; letter-spacing: 0.2em; color: #0078d4; margin-bottom: 0.4rem; font-family: monospace; }
        .instructions { font-size: 0.7rem; color: #94a3b8; line-height: 1.4; }
        @media print {
            body { background: white; padding: 0; }
            .controls { display: none; }
            .grid { gap: 0.5rem; }
            .card { box-shadow: none; border: 1px solid #ccc; }
        }
    </style>
</head>
<body>
    <div class="controls">
        <button onclick="window.print()">🖨️ Print Cards</button>
        <button class="secondary" onclick="window.close()">✕ Close</button>
        <span style="margin-left:1rem;color:#666;font-size:0.9rem">${cards.length} cards · ${event.name}</span>
    </div>
    <div class="grid">
        ${cardHtml || '<p style="text-align:center;color:#666;padding:3rem">No attendees added yet.</p>'}
    </div>
</body>
</html>`;
}

app.use((err, req, res, next) => {
    logger.error({ msg: 'Unhandled error', err: err.message, stack: err.stack, url: req.url });
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info(`Prompt-a-thon Platform running on port ${PORT}`, { env: process.env.NODE_ENV || 'development' });
});
