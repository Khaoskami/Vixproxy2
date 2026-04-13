import db from '../models/database.js';

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required' });
    return res.redirect('/login');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.is_banned) { req.session.destroy(); return res.redirect('/login'); }
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!['admin','superadmin'].includes(req.user.role)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Admin access required' });
      return res.redirect('/dashboard');
    }
    next();
  });
}

export function requireSuperadmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'superadmin') {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Superadmin access required' });
      return res.redirect('/dashboard');
    }
    next();
  });
}

export function requireProxyKey(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const key = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!key || !key.startsWith('vix_')) return res.status(401).json({ error: 'Missing or invalid proxy key' });

  const proxyKey = db.prepare(`
    SELECT pk.*, u.role as user_role, u.is_banned, u.requests_used_today, u.daily_request_limit, u.last_reset_at as user_reset_at
    FROM proxy_keys pk JOIN users u ON pk.user_id = u.id
    WHERE pk.key_value = ? AND pk.status = 'active'
  `).get(key);

  if (!proxyKey) return res.status(401).json({ error: 'Invalid proxy key' });
  if (proxyKey.is_banned) return res.status(403).json({ error: 'Account banned' });
  if (proxyKey.expires_at && proxyKey.expires_at < Math.floor(Date.now()/1000)) return res.status(403).json({ error: 'Proxy key expired' });

  const now = Math.floor(Date.now()/1000);
  if (!proxyKey.last_reset_at || (now - proxyKey.last_reset_at) > 86400) {
    db.prepare('UPDATE proxy_keys SET daily_used = 0, last_reset_at = unixepoch() WHERE id = ?').run(proxyKey.id);
    proxyKey.daily_used = 0;
  }
  if (!proxyKey.user_reset_at || (now - proxyKey.user_reset_at) > 86400) {
    db.prepare('UPDATE users SET requests_used_today = 0, last_reset_at = unixepoch() WHERE id = ?').run(proxyKey.user_id);
    proxyKey.requests_used_today = 0;
  }
  if (proxyKey.daily_used >= proxyKey.daily_limit) return res.status(429).json({ error: 'Daily proxy key limit reached' });
  if (proxyKey.requests_used_today >= proxyKey.daily_request_limit) return res.status(429).json({ error: 'Daily user limit reached' });

  req.proxyKey = proxyKey;
  next();
}
