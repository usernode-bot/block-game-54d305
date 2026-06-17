const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

const PUBLIC_API_PATHS = new Set(['/health']);

function authMiddleware(req, res, next) {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }

  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

module.exports = { authMiddleware, PUBLIC_API_PATHS };
