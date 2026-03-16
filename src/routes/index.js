const attendeeRouter = require('./attendee');
const apiRouterFactory = require('./api');
const adminRouter = require('./admin');
const wallRouter = require('./wall');
const db = require('../db');

module.exports = function registerRoutes(app, io) {
    app.get('/health', (req, res) => {
        try {
            db.prepare('SELECT 1').get();
            res.json({ status: 'ok', uptime: process.uptime(), ts: new Date().toISOString(), build: process.env.BUILD_SHA || 'dev' });
        } catch (e) {
            res.status(503).json({ status: 'error', message: e.message });
        }
    });

    app.use(attendeeRouter);
    app.use(apiRouterFactory(io));
    app.use(adminRouter);
    app.use(wallRouter);
};
