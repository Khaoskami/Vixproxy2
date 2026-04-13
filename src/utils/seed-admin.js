import bcrypt from 'bcryptjs';
import readline from 'readline';
import db from '../models/database.js';
import { generateId } from './crypto.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

async function main() {
  console.log('\n=== VixProxy Superadmin Setup ===\n');
  const username = (await ask('Username: ')).trim();
  const password = (await ask('Password: ')).trim();
  if (!username || password.length < 8) { console.error('Username required, password 8+ chars'); process.exit(1); }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  const hash = await bcrypt.hash(password, 12);
  if (existing) {
    db.prepare("UPDATE users SET role = 'superadmin', password_hash = ? WHERE username = ?").run(hash, username);
    console.log(`\n✓ ${username} upgraded to superadmin`);
  } else {
    db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, 'superadmin', unixepoch(), unixepoch())`).run(generateId(), username, hash);
    console.log(`\n✓ Superadmin created: ${username}`);
  }
  rl.close();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
