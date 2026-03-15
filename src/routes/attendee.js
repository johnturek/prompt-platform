const express = require('express');
const router = express.Router();
const db = require('../db');
const getHomePage = require('../views/home');
const getEventJoinPage = require('../views/join');
const getParticipatePage = require('../views/participate');
const getEventClosedPage = require('../views/closed');
const { requireParticipant } = require('../middleware/auth');

router.get('/', (req, res) => {
    res.send(getHomePage());
});

router.get('/join/:eventCode', (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE code = ?').get(req.params.eventCode.toUpperCase());
    if (!event) {
        return res.send(getHomePage('Event not found. Please check the QR code or event code.'));
    }
    
    const attendees = db.prepare('SELECT id, name, org FROM attendees WHERE event_id = ? ORDER BY org, name').all(event.id);
    res.send(getEventJoinPage(event, attendees));
});

router.post('/join/:eventCode', (req, res) => {
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

router.post('/join', (req, res) => {
    const { joinCode } = req.body;
    const attendee = db.prepare('SELECT a.*, e.code as event_code, e.name as event_name FROM attendees a JOIN events e ON a.event_id = e.id WHERE a.join_code = ?').get(joinCode?.toUpperCase());
    
    if (!attendee) {
        return res.send(getHomePage('Invalid join code. Please check and try again.'));
    }
    
    db.prepare('UPDATE attendees SET joined_at = CURRENT_TIMESTAMP WHERE id = ?').run(attendee.id);
    
    req.session.attendee = attendee;
    res.redirect('/participate/' + attendee.event_code);
});

router.get('/j/:joinCode', (req, res) => {
    const attendee = db.prepare('SELECT a.*, e.code as event_code, e.name as event_name FROM attendees a JOIN events e ON a.event_id = e.id WHERE a.join_code = ?').get(req.params.joinCode?.toUpperCase());
    if (!attendee) return res.send(getHomePage('Invalid join link. Please check your card.'));
    db.prepare('UPDATE attendees SET joined_at = CURRENT_TIMESTAMP WHERE id = ?').run(attendee.id);
    req.session.attendee = attendee;
    res.redirect('/participate/' + attendee.event_code);
});

router.get('/participate/:code', requireParticipant, (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE code = ?').get(req.params.code);
    if (!event) return res.redirect('/');
    if (event.status === 'closed') return res.send(getEventClosedPage(event));

    const attendee = req.session.attendee;
    const org = db.prepare('SELECT * FROM orgs WHERE event_id = ? AND name = ?').get(event.id, attendee.org);
    
    const orgPrompts = org ? db.prepare('SELECT p.*, (SELECT COUNT(*) FROM votes WHERE prompt_id = p.id) as vote_count FROM prompts p WHERE p.org_id = ? ORDER BY vote_count DESC').all(org.id) : [];
    
    const allPrompts = db.prepare('SELECT p.*, o.name as org_name, (SELECT COUNT(*) FROM votes WHERE prompt_id = p.id) as vote_count FROM prompts p LEFT JOIN orgs o ON p.org_id = o.id WHERE p.event_id = ? ORDER BY vote_count DESC').all(event.id);
    
    const userVotes = db.prepare('SELECT prompt_id FROM votes WHERE attendee_id = ?').all(attendee.id).map(v => v.prompt_id);
    
    res.send(getParticipatePage(event, attendee, orgPrompts, allPrompts, userVotes));
});

module.exports = router;
