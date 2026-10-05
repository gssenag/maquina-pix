/**
 * Máquina Pix — Ledger de dupla entrada com hash encadeado.
 * Regra: toda transação afeta DOIS lados (caixa físico da máquina vs saldo digital no PSP).
 * Nada é apagado; erros são lançados como lançamento reverso (estorno).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'ledger.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

function load() {
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db.entries = db.entries || [];
    return db;
  } catch {
    return { entries: [] };
  }
}

function save(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function entryHash(entry) {
  const { hash, ...rest } = entry;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

/**
 * Registra um lançamento.
 * deltas: { cash: +-cents, digital: +-cents }
 * meta: { sessionId, endToEndId, note }
 */
function post(type, deltas, meta = {}) {
  const db = load();
  const prev = db.entries.length ? db.entries[db.entries.length - 1].hash : null;
  const entry = {
    id: db.entries.length + 1,
    ts: new Date().toISOString(),
    type,
    cash: deltas.cash || 0,
    digital: deltas.digital || 0,
    meta,
    prevHash: prev,
  };
  entry.hash = entryHash(entry);
  db.entries.push(entry);
  save(db);
  return entry;
}

function balances() {
  const db = load();
  const cash = db.entries.reduce((s, e) => s + e.cash, 0);
  const digital = db.entries.reduce((s, e) => s + e.digital, 0);
  return { cashCents: cash, digitalCents: digital };
}

function all() {
  return load().entries;
}

module.exports = { post, balances, all };
