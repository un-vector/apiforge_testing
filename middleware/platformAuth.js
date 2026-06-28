const jwt = require('jsonwebtoken');

// Middleware: protects platform dashboard routes.
// Reads JWT from HttpOnly cookie set at platform login.
function requirePlatformAuth(req, res, next) {
  const token = req.cookies && req.cookies.platform_token;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.platformUser = decoded; // { id, username, email }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// Middleware: optionally attach platform user if token exists (no hard block).
function attachPlatformUser(req, res, next) {
  const token = req.cookies && req.cookies.platform_token;
  if (token) {
    try {
      req.platformUser = jwt.verify(token, process.env.JWT_SECRET);
    } catch (_) {
      // invalid token — just ignore
    }
  }
  next();
}

module.exports = { requirePlatformAuth, attachPlatformUser };
