const rateLimit = require('express-rate-limit');

const globalLimiter = rateLimit({ windowMs: 60_000, max: 200, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, message: { error: 'Too many login attempts, try again later' } });
const apiLimiter  = rateLimit({ windowMs: 60_000, max: 60, message: { error: 'Rate limit exceeded' } });

module.exports = { globalLimiter, loginLimiter, apiLimiter };
