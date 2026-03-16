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

module.exports = { requireAdmin, requireParticipant };
