import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth, loginLimiter } from '../middleware/security.js';
import { registerUser, authenticateUser, changePassword } from '../services/AuthService.js';
import { AppError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const router = Router();

function valErr(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Validation failed', details: errors.array().map((e) => e.msg) });
    return true;
  }
  return false;
}

const registerRules = [
  body('username').trim().isLength({ min: 3, max: 32 }).matches(/^[a-zA-Z0-9_-]+$/),
  body('password').isLength({ min: 10, max: 128 }).matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])/),
  body('inviteCode').optional().isLength({ max: 64 }),
];

const loginRules = [
  body('username').trim().isLength({ min: 3, max: 32 }),
  body('password').isLength({ min: 1, max: 128 }),
  body('totpCode').optional().isLength({ min: 6, max: 6 }).isNumeric(),
];

// POST /api/auth/register
router.post('/register', loginLimiter, registerRules, async (req, res, next) => {
  if (valErr(req, res)) return;
  try {
    const { user, token } = await registerUser(
      req.body.username,
      req.body.password,
      req.body.inviteCode,
      req.ip,
    );
    res.cookie('vk_token', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 86400000,
    });
    res.status(201).json({ message: 'Account created', user, token });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    logger.error(`Registration error: ${err.message}`);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', loginLimiter, loginRules, async (req, res, next) => {
  if (valErr(req, res)) return;
  try {
    const result = await authenticateUser(req.body.username, req.body.password, req.body.totpCode);
    if (result.requires2FA) return res.json({ requires2FA: true });
    res.cookie('vk_token', result.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 86400000,
    });
    res.json({ message: 'Login successful', user: result.user, token: result.token });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    logger.error(`Login error: ${err.message}`);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', (_req, res) => {
  res.clearCookie('vk_token');
  res.json({ message: 'Logged out' });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password
router.post(
  '/change-password',
  requireAuth,
  [body('currentPassword').isLength({ min: 1 }), body('newPassword').isLength({ min: 10, max: 128 })],
  async (req, res, next) => {
    if (valErr(req, res)) return;
    try {
      await changePassword(
        req.user.id,
        req.user.username,
        req.body.currentPassword,
        req.body.newPassword,
        req.ip,
      );
      res.clearCookie('vk_token');
      res.json({ message: 'Password changed. Please log in again.' });
    } catch (err) {
      if (err instanceof AppError) return next(err);
      res.status(500).json({ error: 'Password change failed' });
    }
  },
);

export default router;
