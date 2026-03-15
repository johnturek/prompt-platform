const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireParticipant, requireAdmin } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/limiters');

module.exports = function(io) {
    router.post('/api/prompts', apiLimiter, requireParticipant, (req, res) => {
        const { text, app: appType, eventId } = req.body;
        const attendee = req.session.attendee;
        
        if (!text || text.trim().length < 10) {
            return res.status(400).json({ error: 'Prompt must be at least 10 characters' });
        }
        
        const org = db.prepare('SELECT id FROM orgs WHERE event_id = ? AND name = ?').get(eventId, attendee.org);
        
        const result = db.prepare('INSERT INTO prompts (event_id, org_id, text, app, source, submitted_by) VALUES (?, ?, ?, ?, ?, ?)').run(eventId, org?.id, text.trim(), appType || 'General', 'submitted', attendee.id);
        
        const prompt = db.prepare('SELECT p.*, o.name as org_name FROM prompts p LEFT JOIN orgs o ON p.org_id = o.id WHERE p.id = ?').get(result.lastInsertRowid);
        
        io.to('event-' + eventId).emit('new-prompt', { ...prompt, submitter_name: attendee.name, submitter_org: attendee.org, vote_count: 0 });
        
        res.json({ success: true, prompt });
    });

    router.post('/api/vote/:promptId', apiLimiter, requireParticipant, (req, res) => {
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

    router.delete('/api/vote/:promptId', requireParticipant, (req, res) => {
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

    router.get('/api/events/:code/stats', requireAdmin, (req, res) => {
        const event = db.prepare('SELECT id FROM events WHERE code = ?').get(req.params.code);
        if (!event) return res.status(404).json({ error: 'Not found' });
        const total    = db.prepare('SELECT COUNT(*) as c FROM attendees WHERE event_id = ?').get(event.id).c;
        const joined   = db.prepare('SELECT COUNT(*) as c FROM attendees WHERE event_id = ? AND joined_at IS NOT NULL').get(event.id).c;
        const prompts  = db.prepare('SELECT COUNT(*) as c FROM prompts WHERE event_id = ?').get(event.id).c;
        const votes    = db.prepare('SELECT COALESCE(SUM(votes),0) as c FROM prompts WHERE event_id = ?').get(event.id).c;
        res.json({ total, joined, prompts, votes });
    });

    return router;
};
