const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

function openDb(file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'docforge.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      subscription_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      html TEXT NOT NULL,
      css TEXT NOT NULL DEFAULT '',
      sample_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS templates_account ON templates(account_id);
    CREATE TABLE IF NOT EXISTS usage (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      renders INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, month)
    );
    CREATE TABLE IF NOT EXISTS recovery_tokens (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
  `);
  // Additive migrations; ALTER fails harmlessly once the column exists.
  for (const sql of [
    "ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    'ALTER TABLE accounts ADD COLUMN source TEXT',
  ]) {
    try { db.exec(sql); } catch { /* already migrated */ }
  }
  return db;
}

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');
const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
const currentMonth = () => new Date().toISOString().slice(0, 7);

class Store {
  constructor(db) {
    this.db = db;
  }

  createAccount(email, { source = null } = {}) {
    const apiKey = `df_live_${crypto.randomBytes(24).toString('base64url')}`;
    const id = newId('acc');
    const src = typeof source === 'string' && source.trim() ? source.trim().slice(0, 100) : null;
    this.db
      .prepare('INSERT INTO accounts (id, email, key_hash, key_prefix, source) VALUES (?, ?, ?, ?, ?)')
      .run(id, email, hashKey(apiKey), apiKey.slice(0, 12), src);
    return { id, email, apiKey, plan: 'free', source: src };
  }

  accountById(id) {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  }

  setStatus(accountId, status) {
    if (!['active', 'suspended'].includes(status)) throw new Error(`invalid status: ${status}`);
    return this.db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, accountId).changes === 1;
  }

  // Returns the raw token for the email link; only its sha256 is stored.
  createRecoveryToken(accountId, ttlMs = 30 * 60 * 1000) {
    const token = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    this.db.prepare('DELETE FROM recovery_tokens WHERE expires_at < ?').run(now);
    this.db
      .prepare('INSERT INTO recovery_tokens (token_hash, account_id, expires_at) VALUES (?, ?, ?)')
      .run(hashKey(token), accountId, now + ttlMs);
    return token;
  }

  // True when a recovery token was issued for this account within the last
  // cooldownMs; used to cap recovery mails per account regardless of source IP.
  recentRecovery(accountId, ttlMs = 30 * 60 * 1000, cooldownMs = 10 * 60 * 1000) {
    return !!this.db
      .prepare('SELECT 1 FROM recovery_tokens WHERE account_id = ? AND expires_at > ?')
      .get(accountId, Date.now() + ttlMs - cooldownMs);
  }

  // Permanently removes an account and everything tied to it. Hosted
  // output:'url' files are not linked to accounts and expire after 24h.
  deleteAccount(accountId) {
    this.db.exec('BEGIN');
    try {
      for (const t of ['templates', 'usage', 'recovery_tokens']) {
        this.db.prepare(`DELETE FROM ${t} WHERE account_id = ?`).run(accountId);
      }
      const r = this.db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
      this.db.exec('COMMIT');
      return r.changes > 0;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // Single use: the row is deleted whether or not it has expired.
  consumeRecoveryToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const h = hashKey(token);
    const row = this.db.prepare('SELECT account_id, expires_at FROM recovery_tokens WHERE token_hash = ?').get(h);
    if (!row) return null;
    this.db.prepare('DELETE FROM recovery_tokens WHERE token_hash = ?').run(h);
    return row.expires_at >= Date.now() ? row.account_id : null;
  }

  // Online backup to <dir>/docforge-YYYY-MM-DD.db, keeping the newest 7.
  snapshot(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `docforge-${new Date().toISOString().slice(0, 10)}.db`);
    fs.rmSync(file, { force: true });
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const old = fs.readdirSync(dir).filter((f) => /^docforge-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(7);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    return file;
  }

  rotateKey(accountId) {
    const apiKey = `df_live_${crypto.randomBytes(24).toString('base64url')}`;
    this.db
      .prepare('UPDATE accounts SET key_hash = ?, key_prefix = ? WHERE id = ?')
      .run(hashKey(apiKey), apiKey.slice(0, 12), accountId);
    return apiKey;
  }

  accountByKey(apiKey) {
    return this.db.prepare('SELECT * FROM accounts WHERE key_hash = ?').get(hashKey(apiKey));
  }

  accountByEmail(email) {
    return this.db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
  }

  setPlan(accountId, plan, subscriptionId = null) {
    this.db
      .prepare('UPDATE accounts SET plan = ?, subscription_id = COALESCE(?, subscription_id) WHERE id = ?')
      .run(plan, subscriptionId, accountId);
  }

  usage(accountId, month = currentMonth()) {
    const row = this.db
      .prepare('SELECT renders FROM usage WHERE account_id = ? AND month = ?')
      .get(accountId, month);
    return row ? row.renders : 0;
  }

  // Reserves one render atomically; returns false once the limit is reached,
  // so concurrent requests cannot overshoot the quota.
  reserveRender(accountId, limit, month = currentMonth()) {
    this.db
      .prepare('INSERT OR IGNORE INTO usage (account_id, month, renders) VALUES (?, ?, 0)')
      .run(accountId, month);
    const res = this.db
      .prepare('UPDATE usage SET renders = renders + 1 WHERE account_id = ? AND month = ? AND renders < ?')
      .run(accountId, month, limit);
    return res.changes === 1;
  }

  releaseRender(accountId, month = currentMonth()) {
    this.db
      .prepare('UPDATE usage SET renders = MAX(renders - 1, 0) WHERE account_id = ? AND month = ?')
      .run(accountId, month);
  }

  listTemplates(accountId) {
    return this.db
      .prepare('SELECT id, name, created_at, updated_at FROM templates WHERE account_id = ? ORDER BY created_at')
      .all(accountId);
  }

  countTemplates(accountId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM templates WHERE account_id = ?').get(accountId).n;
  }

  getTemplate(accountId, id) {
    const row = this.db.prepare('SELECT * FROM templates WHERE account_id = ? AND id = ?').get(accountId, id);
    if (row) row.sample_data = JSON.parse(row.sample_data);
    return row;
  }

  createTemplate(accountId, { name, html, css = '', sampleData = {} }) {
    const id = newId('tpl');
    this.db
      .prepare('INSERT INTO templates (id, account_id, name, html, css, sample_data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, accountId, name, html, css, JSON.stringify(sampleData));
    return this.getTemplate(accountId, id);
  }

  updateTemplate(accountId, id, { name, html, css, sampleData }) {
    const existing = this.getTemplate(accountId, id);
    if (!existing) return null;
    this.db
      .prepare(
        "UPDATE templates SET name = ?, html = ?, css = ?, sample_data = ?, updated_at = datetime('now') WHERE id = ? AND account_id = ?"
      )
      .run(
        name ?? existing.name,
        html ?? existing.html,
        css ?? existing.css,
        JSON.stringify(sampleData ?? existing.sample_data),
        id,
        accountId
      );
    return this.getTemplate(accountId, id);
  }

  deleteTemplate(accountId, id) {
    return this.db.prepare('DELETE FROM templates WHERE account_id = ? AND id = ?').run(accountId, id).changes === 1;
  }
}

module.exports = { openDb, Store, currentMonth };
