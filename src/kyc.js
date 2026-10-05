/**
 * KYC/AML — controle de clientes do kiosk.
 * Limite diário de depósito por CPF + blocklist.
 * Na produção real, os valores alimentam o compliance do PSP (Celcoin).
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'kyc.json');
fs.mkdirSync(DIR, { recursive: true });
const DAILY_LIMIT_CENTS = parseInt(process.env.KYC_DAILY_LIMIT || '200000', 10); // R$2.000/dia

function norm(cpf) {
  return (cpf || '').replace(/\D/g, '');
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    d.clients = d.clients || {};
    return d;
  } catch {
    return { clients: {} };
  }
}

function save(d) {
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getClient(clients, k) {
  const c = clients[k];
  if (!c) return { name: null, used: 0 };
  if (c.usedDate !== today()) return { ...c, used: 0 }; // virou o dia: zera
  return c;
}

/** Verifica se o cliente pode depositar. Retorna {ok, reason, used, limit} */
function check(cpf) {
  const k = norm(cpf);
  if (k.length !== 11) return { ok: false, reason: 'CPF inválido (11 dígitos)' };
  const d = load();
  const c = getClient(d.clients, k);
  if (c.blocked) return { ok: false, reason: 'CLIENTE BLOQUEADO', used: c.used, limit: DAILY_LIMIT_CENTS };
  if (c.used >= DAILY_LIMIT_CENTS)
    return { ok: false, reason: 'LIMITE DIÁRIO EXCEDIDO', used: c.used, limit: DAILY_LIMIT_CENTS };
  return { ok: true, used: c.used, limit: DAILY_LIMIT_CENTS, name: c.name };
}

/** Registra o depósito confirmado (chamado só no webhook LIQUIDADA) */
function registerDeposit(cpf, name, cents) {
  const k = norm(cpf);
  const d = load();
  const c = getClient(d.clients, k);
  d.clients[k] = {
    name: name || c.name || null,
    used: (c.used || 0) + cents,
    usedDate: today(),
    blocked: c.blocked || false,
    last: new Date().toISOString(),
  };
  save(d);
  return d.clients[k];
}

/** Bloqueia/desbloqueia cliente (suspeita de lavagem, golpe etc.) */
function setBlocked(cpf, blocked) {
  const k = norm(cpf);
  const d = load();
  const c = getClient(d.clients, k);
  d.clients[k] = { ...c, used: c.used || 0, usedDate: today(), blocked };
  save(d);
  return d.clients[k];
}

/** Lista pro painel */
function list() {
  const d = load();
  return Object.entries(d.clients).map(([cpf, c]) => ({
    cpf: cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.***.$3-$4'),
    name: c.name,
    usedToday: getClient(d.clients, cpf).used,
    blocked: !!c.blocked,
    last: c.last,
  }));
}

module.exports = { check, registerDeposit, setBlocked, list, DAILY_LIMIT_CENTS };
