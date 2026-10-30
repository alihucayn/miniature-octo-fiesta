const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

function openDb(file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'docforge.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
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
  `);
  return db;
}

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');
const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
const currentMonth = () => new Date().toISOString().slice(0, 7);

class Store {
  constructor(db) {
    this.db = db;
  }

  createAccount(email) {
    const apiKey = `df_live_${crypto.randomBytes(24).toString('base64url')}`;
    const id = newId('acc');
    this.db
      .prepare('INSERT INTO accounts (id, email, key_hash, key_prefix) VALUES (?, ?, ?, ?)')
      .run(id, email, hashKey(apiKey), apiKey.slice(0, 12));
    return { id, email, apiKey, plan: 'free' };
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
