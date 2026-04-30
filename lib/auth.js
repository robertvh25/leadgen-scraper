// lib/auth.js - Login/sessie management
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// In-memory session store (sessies zijn weg na restart, dat is OK voor 1-user systeem)
const sessions = new Map();

// Username + hashed password worden uit env vars geladen bij eerste use
let adminUsername = null;
let adminPasswordHash = null;
let initialized = false;

function init() {
  if (initialized) return;
  adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const plainPassword = process.env.ADMIN_PASSWORD;

  if (!plainPassword) {
    console.warn('⚠ Geen ADMIN_PASSWORD ingesteld! Login werkt niet. Stel in via Coolify env vars.');
    initialized = true;
    return;
  }

  // Hash het wachtwoord (bcrypt rondes = 10)
  adminPasswordHash = bcrypt.hashSync(plainPassword, 10);
  initialized = true;
  console.log(`✓ Auth geïnitialiseerd voor user: ${adminUsername}`);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function login(username, password) {
  init();
  if (!adminPasswordHash) {
    throw new Error('ADMIN_PASSWORD niet ingesteld op server');
  }
  if (username !== adminUsername) {
    throw new Error('Ongeldige inloggegevens');
  }
  const valid = await bcrypt.compare(password, adminPasswordHash);
  if (!valid) {
    throw new Error('Ongeldige inloggegevens');
  }

  const token = generateToken();
  const expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 dagen
  sessions.set(token, { username, expiresAt });

  // Cleanup oude sessies
  cleanupSessions();

  return { token, username, expiresAt };
}

function logout(token) {
  sessions.delete(token);
}

function validateSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt < now) sessions.delete(token);
  }
}

// Middleware voor protected routes
function requireAuth(req, res, next) {
  init();
  // Skip auth als geen wachtwoord ingesteld (dev mode)
  if (!adminPasswordHash) {
    return next();
  }

  const token = req.cookies?.session;
  const session = validateSession(token);

  if (!session) {
    // Voor API requests: 401
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Niet ingelogd' });
    }
    // Voor browser requests: redirect naar login
    return res.redirect('/login.html');
  }

  req.session = session;
  next();
}

function requireAuthAPI(req, res, next) {
  init();
  if (!adminPasswordHash) return next();

  const token = req.cookies?.session;
  const session = validateSession(token);
  if (!session) return res.status(401).json({ error: 'Niet ingelogd' });

  req.session = session;
  next();
}

function isAuthEnabled() {
  init();
  return !!adminPasswordHash;
}

module.exports = {
  init,
  login,
  logout,
  validateSession,
  requireAuth,
  requireAuthAPI,
  isAuthEnabled,
};
