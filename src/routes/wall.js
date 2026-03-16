const express = require('express');
const router = express.Router();
const db = require('../db');
const getLiveWallPage = require('../views/wall');

router.get('/wall/:code', (req, res) => {
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

module.exports = router;
