require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const http = require('http');
const helmet = require('helmet');
const logger = require('./src/logger');
const { globalLimiter } = require('./src/middleware/limiters');
const registerRoutes = require('./src/routes/index');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

io.on('connection', (socket) => {
    socket.on('join-event', (eventId) => {
        socket.join('event-' + eventId);
    });
});

registerRoutes(app, io);

app.use((err, req, res, next) => {
    logger.error({ msg: 'Unhandled error', err: err.message, stack: err.stack, url: req.url });
    res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info(`Prompt-a-thon Platform running on port ${PORT}`, { env: process.env.NODE_ENV || 'development' });
});
