import bcrypt from 'bcryptjs';
import readline from 'readline';
import db from '../models/database.js';
import { generateId } from './crypto.js';

async function prompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));
  const username = (await ask('Username: ')).trim();
  const password = (await ask('Password: ')).trim();
  rl.close();
  return { username, password };
}

async function main() {
  console.log('\n=== VixProxy Superadmin Setup ===\n');
  let username = (process.env.SEED_ADMIN_USER || '').trim();
  let password = (process.env.SEED_ADMIN_PASS || '').trim();
  if (!username || !password) {
    ({ username, password } = await prompt());
  } else {
    console.log(`(using SEED_ADMIN_USER / SEED_ADMIN_PASS env vars)`);
  }
  if (!username || password.length < 8) {
    console.error('Username required, password 8+ chars');
    process.exit(1);
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  const hash = await bcrypt.hash(password, 12);
  if (existing) {
    db.prepare("UPDATE users SET role = 'superadmin', password_hash = ?, updated_at = unixepoch() WHERE username = ?").run(hash, username);
    console.log(`\n✓ ${username} upgraded to superadmin`);
  } else {
    db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, 'superadmin', unixepoch(), unixepoch())`).run(generateId(), username, hash);
    console.log(`\n✓ Superadmin created: ${username}`);
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
