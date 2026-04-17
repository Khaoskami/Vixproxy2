import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import config from '../config/index.js';
import { supabase } from '../models/supabase.js';
import { AppError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const SALT_ROUNDS = 12;

function signToken(userId, role) {
  return jwt.sign({ sub: userId, role }, config.jwt.secret, { expiresIn: config.jwt.expiry });
}

export async function registerUser(username, password, inviteCode, ip) {
  // Check username taken (case-insensitive)
  const { data: existing } = await supabase
    .from('vk_users')
    .select('id')
    .ilike('username', username)
    .maybeSingle();

  if (existing) throw new AppError('Username already taken', 409);

  let role = 'user';
  let tier = 'free';

  // Invite code is the only way to register as admin/superadmin.
  if (inviteCode) {
    const { data: invite } = await supabase
      .from('vk_invite_codes')
      .select('*')
      .eq('code', inviteCode)
      .eq('is_used', false)
      .maybeSingle();

    if (!invite) throw new AppError('Invalid or used invite code', 400);
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      throw new AppError('Invite code expired', 400);
    }
    role = invite.role;
    tier = role === 'superadmin' ? 'unlimited' : 'pro';
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const { data: user, error } = await supabase
    .from('vk_users')
    .insert({ username, password_hash: passwordHash, role, tier })
    .select('id, username, role, tier')
    .single();

  if (error) throw new AppError('Registration failed: ' + error.message, 500);

  // Initialize credits row
  await supabase.from('vk_credits').insert({ user_id: user.id });

  // Mark invite as used and link to this user
  if (inviteCode) {
    await supabase
      .from('vk_invite_codes')
      .update({ is_used: true, used_at: new Date().toISOString(), used_by: user.id })
      .eq('code', inviteCode);
  }

  logger.info(`User registered: ${username} [${role}] from ${ip}`);
  const token = signToken(user.id, user.role);
  return { user, token };
}

export async function authenticateUser(username, password, totpCode) {
  const { data: user, error } = await supabase
    .from('vk_users')
    .select('*')
    .ilike('username', username)
    .maybeSingle();

  if (error || !user) throw new AppError('Invalid credentials', 401);

  // Lockout check
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    throw new AppError(`Account locked. Try again in ${mins} minutes.`, 423);
  }

  if (!user.is_active) throw new AppError('Account disabled', 403);

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    const fails = (user.failed_logins || 0) + 1;
    const updates = { failed_logins: fails };
    if (fails >= 5) updates.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await supabase.from('vk_users').update(updates).eq('id', user.id);
    throw new AppError('Invalid credentials', 401);
  }

  // 2FA stub — not yet implemented end-to-end
  if (user.totp_enabled && !totpCode) {
    return { requires2FA: true };
  }

  await supabase
    .from('vk_users')
    .update({ failed_logins: 0, locked_until: null, last_login: new Date().toISOString() })
    .eq('id', user.id);

  const token = signToken(user.id, user.role);
  return {
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      tier: user.tier,
      totpEnabled: user.totp_enabled,
    },
    token,
  };
}

export async function changePassword(userId, username, currentPassword, newPassword, ip) {
  const { data: user } = await supabase
    .from('vk_users')
    .select('password_hash')
    .eq('id', userId)
    .maybeSingle();

  if (!user) throw new AppError('User not found', 404);

  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) throw new AppError('Current password incorrect', 401);

  const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await supabase
    .from('vk_users')
    .update({ password_hash: newHash, updated_at: new Date().toISOString() })
    .eq('id', userId);
  logger.info(`Password changed: ${username} from ${ip}`);
}

export function generateProxyKey() {
  const raw = 'vxk_' + crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 8) + '...' + raw.slice(-4);
  return { raw, hash, prefix };
}
