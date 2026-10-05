/**
 * Adaptador PSP — três modos, controlados por env:
 *
 *   PSP=stub            (padrão) → simulação local, tudo falso, zero rede
 *   PSP=celcoin                   → sandbox REAL da Celcoin (https://sandbox.openfinance.celcoin.dev)
 *   PSP=mercadopago               → API do Mercado Pago (Pix cash-in + checkout de cartão)
 *
 * Credenciais Celcoin (env):
 *   CELCOIN_CLIENT_ID, CELCOIN_CLIENT_SECRET  → OAuth (token dura 2400s)
 *   CELCOIN_PIX_KEY                            → chave Pix recebedora da conta BaaS
 *
 * Credenciais Mercado Pago (env):
 *   MP_ACCESS_TOKEN      → token de teste (TEST-...) ou de produção (APP_USR-...)
 *   MP_WEBHOOK_SECRET    → chave secreta do webhook (painel de developers → webhooks)
 *   MP_BASE_URL          → default https://api.mercadopago.com (trocar só em teste)
 *   MP_NOTIFICATION_URL  → URL pública do webhook (https://SEU-DOMINIO/webhook/mercadopago)
 *
 * Taxas de serviço (percentual sobre o valor do saque — a RECEITA do agente):
 *   FEE_PIX_PCT          → default 1 (%)  |  FEE_CARD_PCT → default 3 (%)
 *   CARD_MAX_CENTS       → teto por operação de cartão (default R$500)
 *   CARD_ALLOW_CREDIT=1  → libera crédito no checkout (default: só débito)
 *
 * IMPORTANTE (Mercado Pago): não existe API pública de ENVIO de Pix/boleto/recarga.
 * No modo mercadopago, DEPÓSITO/BOLETO/RECARGA são manuais (ASSISTED=1):
 * o operador faz no app do MP e confirma no painel do agente.
 */
const crypto = require('crypto');

const PSP = process.env.PSP || 'stub';

// ---------- Taxas de serviço (receita do agente) ----------
const FEE_PIX_PCT = parseFloat(process.env.FEE_PIX_PCT || '1');
const FEE_CARD_PCT = parseFloat(process.env.FEE_CARD_PCT || '3');
const CARD_MAX_CENTS = parseInt(process.env.CARD_MAX_CENTS || '50000', 10);
const CARD_ALLOW_CREDIT = process.env.CARD_ALLOW_CREDIT === '1';

// ---------- Credenciais sandbox públicas Celcoin (docs: "Credenciais de acesso") ----------
const BASE = process.env.CELCOIN_BASE_URL || 'https://sandbox.openfinance.celcoin.dev';
const CLIENT_ID = process.env.CELCOIN_CLIENT_ID || '41b44ab9a56440.teste.celcoinapi.v5';
const CLIENT_SECRET = process.env.CELCOIN_CLIENT_SECRET || 'e9d15cde33024c1494de7480e69b7a18c09d7cd25a8446839b3be82a56a044a3';
const PIX_KEY = process.env.CELCOIN_PIX_KEY || 'testepix@celcoin.com.br';

// ---------- Mercado Pago ----------
const MP_BASE = process.env.MP_BASE_URL || 'https://api.mercadopago.com';
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
const MP_NOTIFICATION_URL = process.env.MP_NOTIFICATION_URL || '';

async function mpFetch(method, path, payload) {
  if (!MP_TOKEN) {
    const e = new Error('MP_ACCESS_TOKEN não configurado — crie um aplicativo em mercadopago.com.br/developers e gere o token');
    e.needsCredentials = true;
    throw e;
  }
  const r = await fetch(`${MP_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${MP_TOKEN}`,
      'Content-Type': 'application/json',
      ...(payload ? { 'X-Idempotency-Key': crypto.randomUUID() } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`Mercado Pago ${path}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j;
}

// ---------- Token OAuth Celcoin com cache (validade 2400s, renova aos 2200s) ----------
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'client_credentials',
    client_secret: CLIENT_SECRET,
  });
  const r = await fetch(`${BASE}/v5/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`Celcoin token falhou: HTTP ${r.status}`);
  const j = await r.json();
  tokenCache = { token: j.access_token, expiresAt: Date.now() + 2200 * 1000 };
  return j.access_token;
}

async function celcoinPOST(path, payload) {
  const token = await getToken();
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.status && j.status >= 400)) {
    const err = j.error ? `${j.error.errorCode}: ${j.error.message}` : JSON.stringify(j).slice(0, 200);
    throw new Error(`Celcoin ${path}: ${err}`);
  }
  return j;
}

// ---------- Cobrança Pix (cash-in QR — usado no SAQUE) ----------
// totalCents = amountCents + taxa de serviço (é o que o cliente paga).
async function createCharge({ amountCents, totalCents, sessionId }) {
  const total = totalCents || amountCents;
  if (PSP === 'celcoin') {
    const j = await celcoinPOST('/pix/v1/brcode/dynamic', {
      key: PIX_KEY,
      amount: (total / 100).toFixed(2),
      merchant: {
        merchantCategoryCode: '5651',
        postalCode: process.env.CELCOIN_CEP || '06519435',
        city: process.env.CELCOIN_CIDADE || 'barueri',
        name: 'Maquina Pix',
      },
      expiration: 600,
      clientRequestId: `mpx-${sessionId}`,
      payerQuestion: 'Saque Maquina Pix',
    });
    const b = j.body || {};
    const emv = b.body && b.body.dynamicBRCodeData ? b.body.dynamicBRCodeData.emvqrcps : null;
    return {
      txid: String(b.transactionId || sessionId),
      transactionIdentification: b.transactionIdentification || null,
      qrText: emv,
      status: b.status || 'ATIVA',
      provider: 'celcoin-sandbox',
    };
  }
  if (PSP === 'mercadopago') {
    // Pix direto na conta Mercado Pago do agente. external_reference = sessionId
    // liga o pagamento à sessão; o webhook /webhook/mercadopago fecha o ciclo.
    const j = await mpFetch('POST', '/v1/payments', {
      transaction_amount: Number((total / 100).toFixed(2)),
      description: 'Saque Maquina Pix',
      payment_method_id: 'pix',
      external_reference: sessionId,
      date_of_expiration: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      // MP exige payer preenchido mesmo pra Pix sem conta de cliente cadastrada.
      payer: {
        email: process.env.MP_PAYER_EMAIL || `cliente-${sessionId}@maquinapix.app`,
      },
    });
    const td = (j.point_of_interaction && j.point_of_interaction.transaction_data) || {};
    return {
      txid: String(j.id),
      qrText: td.qr_code || null,
      qrImage: td.qr_code_base64 || null, // base64 pronto pra colar num <img>
      status: j.status || 'pending',
      provider: 'mercadopago',
    };
  }
  // STUB
  const txid = `TX-${sessionId}-${Date.now()}`;
  return {
    txid,
    qrText: `00020126BR.GOV.BCB.PIX-STUB-${txid}-${total}5204000053039865802BR5910MAQUINA-PIX6009SAO-PAULO62070503***6304FAKE`,
    status: 'ATIVA',
    provider: 'stub',
  };
}

// ---------- Checkout de cartão ONLINE (saque pago no cartão, sem maquininha) ----------
// Gera um link/QR do checkout hospedado do Mercado Pago: cliente abre e paga
// (débito por padrão; crédito só com CARD_ALLOW_CREDIT=1). Webhook fecha o ciclo.
async function createCardCheckout({ amountCents, totalCents, sessionId }) {
  const total = totalCents || amountCents;
  if (PSP === 'mercadopago') {
    const excludedTypes = [{ id: 'ticket' }];
    if (!CARD_ALLOW_CREDIT) excludedTypes.push({ id: 'credit_card' });
    const pref = await mpFetch('POST', '/checkout/preferences', {
      items: [{ title: 'Saque Maquina Pix', quantity: 1, currency_id: 'BRL', unit_price: total / 100 }],
      external_reference: sessionId,
      ...(MP_NOTIFICATION_URL ? { notification_url: MP_NOTIFICATION_URL } : {}),
      payment_methods: {
        excluded_payment_methods: [{ id: 'pix' }],
        excluded_payment_types: excludedTypes,
        installments: 1,
      },
      statement_descriptor: 'MAQUINAPIX',
    });
    const url =
      MP_TOKEN.startsWith('TEST') && pref.sandbox_init_point ? pref.sandbox_init_point : pref.init_point;
    return { txid: String(pref.id), checkoutUrl: url, status: 'ATIVA', provider: 'mercadopago' };
  }
  // STUB
  return {
    txid: `PREF-${sessionId}-${Date.now()}`,
    checkoutUrl: `https://checkout.exemplo/mpx/${sessionId}?t=${total}`,
    status: 'ATIVA',
    provider: 'stub',
  };
}

// ---------- Consulta de pagamento Mercado Pago (usado pelo webhook) ----------
async function getPayment(paymentId) {
  if (PSP !== 'mercadopago') {
    throw new Error('Webhook do Mercado Pago só funciona com PSP=mercadopago');
  }
  return mpFetch('GET', `/v1/payments/${paymentId}`);
}

// ---------- Pix out (cash-out — usado no DEPÓSITO: dinheiro → Pix pro cliente) ----------
// EXIGE conta BaaS com saldo (debitParty.account) — liberada no onboarding real.
const BAAS_ACCOUNT = process.env.CELCOIN_BAAS_ACCOUNT || '';

async function sendPix({ pixKey, amountCents, sessionId }) {
  if (PSP === 'celcoin') {
    if (!BAAS_ACCOUNT) {
      const e = new Error('Cash-out real exige conta BaaS (CELCOIN_BAAS_ACCOUNT) — conta sandbox sai no onboarding com o suporte Celcoin');
      e.needsOnboarding = true;
      throw e;
    }
    const j = await celcoinPOST('/baas/v2/pix/payment', {
      amount: amountCents / 100,
      clientCode: `mpx-${sessionId}-${Date.now()}`,
      initiationType: 'DICT',
      paymentType: 'IMMEDIATE',
      urgency: 'HIGH',
      transactionType: 'TRANSFER',
      debitParty: { account: BAAS_ACCOUNT },
      creditParty: { key: pixKey },
      remittanceInformation: 'Conversao Maquina Pix',
    });
    return {
      txid: j.body.id,
      endToEndId: j.body.endToEndId,
      status: j.body.status || 'PROCESSING',
      provider: 'celcoin-sandbox',
    };
  }
  if (PSP === 'mercadopago') {
    const e = new Error('Mercado Pago não tem API pública de envio de Pix — opere com ASSISTED=1 (envio manual pelo app do agente)');
    e.needsAssisted = true;
    throw e;
  }
  return { txid: `OUT-${sessionId}-${Date.now()}`, status: 'ENVIADO', pixKey, provider: 'stub' };
}

// ---------- Pagamento de boleto (dinheiro -> conta pagada) ----------
async function payBill({ line, amountCents, sessionId }) {
  if (PSP === 'celcoin') {
    const j = await celcoinPOST('/v5/transactions/billpayments', {
      barCode: { type: 3, digitable: line },
      amount: amountCents / 100,
      clientRequestId: `mpx-${sessionId}-${Date.now()}`,
    });
    const b = j.body || {};
    return { txid: String(b.transactionId || j.transactionId), status: b.status || 'PROCESSING', provider: 'celcoin-sandbox' };
  }
  if (PSP === 'mercadopago') {
    const e = new Error('Mercado Pago não tem API de pagamento de boleto — opere com ASSISTED=1 (pagamento manual pelo app)');
    e.needsAssisted = true;
    throw e;
  }
  return { txid: `BILL-${sessionId}-${Date.now()}`, status: 'PAGO', line, provider: 'stub' };
}

// ---------- Recarga de celular (dinheiro -> crédito) ----------
async function topup({ phone, amountCents, sessionId, carrier }) {
  if (PSP === 'celcoin') {
    const j = await celcoinPOST('/v5/transactions/recharges', {
      topupData: { carrierId: carrier || 1, phone },
      value: amountCents / 100,
      clientRequestId: `mpx-${sessionId}-${Date.now()}`,
    });
    const b = j.body || {};
    return { txid: String(b.transactionId || j.transactionId), status: b.status || 'PROCESSING', provider: 'celcoin-sandbox' };
  }
  if (PSP === 'mercadopago') {
    const e = new Error('Mercado Pago não tem API de recarga — opere com ASSISTED=1 (recarga manual pelo app)');
    e.needsAssisted = true;
    throw e;
  }
  return { txid: `REC-${sessionId}-${Date.now()}`, status: 'RECARGADO', phone, provider: 'stub' };
}

// ---------- Webhook Celcoin/stub: verificação de assinatura HMAC local ----------
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.PIX_WEBHOOK_SECRET || 'dev-secret-sandbox';
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!signatureHeader) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Webhook Mercado Pago: validação da assinatura x-signature ----------
// Cabeçalho: "ts=1704921469584,v1=<hmac>".
// Manifesto assinado (HMAC-SHA256 com MP_WEBHOOK_SECRET sobre o corpo BRUTO):
//   v2:    "id:{data.id};request-id:{x-request-id};ts:{ts};data:{corpo bruto}"
//   legado:"id:{data.id};request-id:{x-request-id};ts:{ts};{corpo bruto}"
// Aceitamos os dois formatos + janela anti-replay de 300s.
function verifyMPWebhookSignature(rawBody, sigHeader, requestId, dataId) {
  if (!sigHeader || !MP_WEBHOOK_SECRET || !dataId) return false;
  const parts = {};
  for (const kv of sigHeader.split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const ts = parts.ts;
  const v1 = (parts.v1 || '').toLowerCase();
  if (!ts || !v1) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;
  const manifests = [
    `id:${dataId};request-id:${requestId || ''};ts:${ts};data:${rawBody}`,
    `id:${dataId};request-id:${requestId || ''};ts:${ts};${rawBody}`,
  ];
  const a = Buffer.from(v1);
  for (const m of manifests) {
    const h = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(m).digest('hex');
    const b = Buffer.from(h);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

module.exports = {
  PSP, FEE_PIX_PCT, FEE_CARD_PCT, CARD_MAX_CENTS, CARD_ALLOW_CREDIT,
  createCharge, createCardCheckout, getPayment,
  sendPix, payBill, topup,
  verifyWebhookSignature, verifyMPWebhookSignature,
};
