const http = require('http');
const fs = require('fs');
const path = require('path');
const ledger = require('./ledger');
const { Session } = require('./session');
const psp = require('./psp');
const queue = require('./queue');
const kyc = require('./kyc');

const sessions = new Map(); // sessionId -> Session
const processedEvents = new Map(); // eventId -> true (idempotência do webhook)
const machineStatus = new Map(); // machineId -> {lastSeen, cashNotes}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || '600000', 10); // 10 min

/** Sessão presa (Pix nunca confirmou, cliente sumiu) expira e vira FAILED */
function sweepSessions() {
  const now = Date.now();
  const expired = [];
  for (const s of sessions.values()) {
    if (['DONE', 'FAILED'].includes(s.state)) continue;
    const age = now - new Date(s.createdAt).getTime();
    if (age > SESSION_TIMEOUT_MS) {
      try { s.transition('FAILED'); } catch { continue; }
      expired.push(s);
    }
  }
  return expired;
}

function newSessionId() {
  return 'S-' + Math.random().toString(36).slice(2, 10).toUpperCase();
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ---------- Painel / monitor ----------
  if (req.method === 'GET' && p === '/api/panel/overview') {
    const bal = ledger.balances();
    const live = [...sessions.values()].map((s) => ({
      id: s.id, type: s.type, state: s.state, amount: s.amountCents, txid: s.txid,
    }));
    const expired = sweepSessions();
    const alerts = [];
    for (const s of expired) {
      alerts.push(`SESSÃO EXPIRADA ${s.id} (${s.type}, ${s.state}) — ${s.type === 'DEPOSIT' ? 'cédulas no cofre sem Pix confirmado: verificar!' : 'Pix recebido sem cédula entregue: reembolsar!'}`);
    }
    if (bal.cashCents < 5000) alerts.push('COFRE BAIXO: menos de R$50 em cédulas na máquina');
    for (const [mid, st] of machineStatus) {
      if (Date.now() - new Date(st.lastSeen).getTime() > 60000)
        alerts.push(`MÁQUINA OFFLINE: ${mid} sem heartbeat há mais de 60s`);
    }
    return json(res, 200, {
      balances: bal, sessions: live, alerts, events: ledger.all().slice(-20),
      kycClients: kyc.list(), kycDailyLimit: kyc.DAILY_LIMIT_CENTS,
    });
  }

  // ---------- Kiosk: heartbeat ----------
  if (req.method === 'POST' && p === '/api/kiosk/heartbeat') {
    const body = JSON.parse((await readBody(req)) || '{}');
    machineStatus.set(body.machineId, {
      lastSeen: new Date().toISOString(),
      cashNotes: body.cashNotes || {},
    });
    return json(res, 200, { ok: true, serverTime: new Date().toISOString() });
  }

  // ---------- Kiosk: iniciar sessão ----------
  if (req.method === 'POST' && p === '/api/kiosk/session/start') {
    const body = JSON.parse((await readBody(req)) || '{}');
    let s;
    try {
      s = new Session(newSessionId(), body.type, body.machineId, {
        amountCents: body.amountCents,
        pixKey: body.pixKey,
      });
      if (body.type === 'BILL') s.billLine = body.billLine || null;   // linha digitável
      if (body.type === 'TOPUP') { s.phone = body.phone || null; s.carrier = body.carrier || null; }
    } catch (e) {
      return json(res, 400, { error: e.message });
    }

    // DEPÓSITO = cash-in de terceiros: KYC obrigatório antes de aceitar cédula
    if (s.type === 'DEPOSIT') {
      const check = kyc.check(body.cpf);
      if (!check.ok) {
        return json(res, 403, { error: check.reason, usedCents: check.used, limitCents: check.limit });
      }
      s.cpf = body.cpf;
      s.clientName = body.clientName || null;
    }
    sessions.set(s.id, s);

    // SAQUE: gera cobrança na hora (Pix QR ou checkout de cartão online)
    if (s.type === 'WITHDRAW') {
      const method = body.method === 'card' ? 'card' : 'pix';
      if (method === 'card' && s.amountCents > psp.CARD_MAX_CENTS) {
        return json(res, 400, { error: `Saque no cartão limitado a R$ ${(psp.CARD_MAX_CENTS/100).toFixed(2)} por operação (CARD_MAX_CENTS)` });
      }
      s.method = method;
      s.feeCents = Math.round(s.amountCents * (method === 'card' ? psp.FEE_CARD_PCT : psp.FEE_PIX_PCT) / 100);
      s.totalCents = s.amountCents + s.feeCents; // o que o cliente paga

      const charge = method === 'card'
        ? await psp.createCardCheckout({ amountCents: s.amountCents, totalCents: s.totalCents, sessionId: s.id })
        : await psp.createCharge({ amountCents: s.amountCents, totalCents: s.totalCents, sessionId: s.id });
      s.txid = charge.txid;
      s.qrText = charge.qrText || null;
      s.checkoutUrl = charge.checkoutUrl || null;
      s.transition('CHARGE_CREATED');
      return json(res, 200, {
        sessionId: s.id, state: s.state, method, feeCents: s.feeCents, totalCents: s.totalCents,
        qrText: s.qrText, checkoutUrl: s.checkoutUrl, txid: s.txid,
      });
    }
    return json(res, 200, { sessionId: s.id, state: s.state, qrText: s.qrText, txid: s.txid });
  }

  // ---------- Kiosk: depósito — cédulas contadas ----------
  if (req.method === 'POST' && p === '/api/kiosk/notes-counted') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const s = sessions.get(body.sessionId);
    if (!s) return json(res, 404, { error: 'Sessão não encontrada' });
    if (s.type !== 'DEPOSIT' && s.type !== 'BILL' && s.type !== 'TOPUP')
      return json(res, 400, { error: 'Sessão não é depósito/boleto/recarga' });
    if (s.state !== 'CREATED') return json(res, 409, { error: `Sessão já avançou (${s.state})` });
    s.amountCents = body.amountCents;
    const isService = s.type === 'BILL' || s.type === 'TOPUP';

    // Enforça o limite diário NA CONTAGEM (valor só se sabe agora)
    const k = kyc.check(s.cpf);
    if (k.used + s.amountCents > k.limit) {
      s.transition('FAILED');
      queue.push(s.machineId, {
        action: 'RETURN_NOTES',
        sessionId: s.id,
        reason: `LIMITE DIÁRIO: usado ${(k.used/100).toFixed(2)} + depositado ${(s.amountCents/100).toFixed(2)} > limite ${(k.limit/100).toFixed(2)}`,
      });
      return json(res, 200, {
        sessionId: s.id, state: s.state, refused: true,
        message: 'LIMITE EXCEDIDO — devolva as cédulas ao cliente',
      });
    }
    s.transition('COUNTING');

    // Cédulas aceitas: registra no ledger (dinheiro físico ENTROU no cofre)
    ledger.post('CASH_IN', { cash: s.amountCents, digital: 0 }, { sessionId: s.id, note: 'Cédulas validadas' });

    // MODO ASSISTIDO (agente humano): o pagamento é feito manualmente pelo app do PSP do operador
    if (process.env.ASSISTED === '1') {
      s.transition(isService ? 'PAYMENT_PENDING' : 'PIX_SENDING');
      const acao = s.type === 'BILL' ? 'pague o boleto' : s.type === 'TOPUP' ? 'faça a recarga' : `envie o Pix de R$ ${(s.amountCents/100).toFixed(2)} para a chave "${s.pixKey}"`;
      return json(res, 200, {
        sessionId: s.id, state: s.state, assisted: true,
        message: `No app do seu PSP, ${acao} e confirme no painel do agente.`,
      });
    }

    // Mercado Pago não tem API de envio: operação é manual (ASSISTED=1)
    if (psp.PSP === 'mercadopago' && process.env.ASSISTED !== '1') {
      s.transition('FAILED');
      queue.push(s.machineId, { action: 'RETURN_NOTES', sessionId: s.id, reason: 'MODO MP: configure ASSISTED=1 (envio manual pelo app do agente)' });
      ledger.post('CASH_IN_REVERT', { cash: -s.amountCents, digital: 0 }, { sessionId: s.id, note: 'Modo Mercado Pago exige ASSISTED=1' });
      return json(res, 200, { sessionId: s.id, state: s.state, failed: true, message: 'DEVOLVA as cédulas: no modo Mercado Pago o envio é manual. Rode o servidor com ASSISTED=1.' });
    }

    // Dispara o pagamento (Pix pro cliente, boleto ou recarga)
    try {
      let result;
      if (s.type === 'BILL') {
        if (!s.billLine) throw new Error('Linha digitável do boleto não informada no início da sessão');
        result = await psp.payBill({ line: s.billLine, amountCents: s.amountCents, sessionId: s.id });
      } else if (s.type === 'TOPUP') {
        if (!s.phone) throw new Error('Telefone da recarga não informado no início da sessão');
        result = await psp.topup({ phone: s.phone, carrier: s.carrier, amountCents: s.amountCents, sessionId: s.id });
      } else {
        result = await psp.sendPix({ pixKey: s.pixKey, amountCents: s.amountCents, sessionId: s.id });
      }
      s.txid = result.txid;
      s.transition(isService ? 'PAYMENT_PENDING' : 'PIX_SENDING');
      return json(res, 200, { sessionId: s.id, state: s.state, txid: s.txid, paymentStatus: result.status });
    } catch (e) {
      // PSP recusou/indisponível: devolve as cédulas, NÃO fica com o dinheiro
      s.transition('FAILED');
      queue.push(s.machineId, { action: 'RETURN_NOTES', sessionId: s.id, reason: `PIX OUT FALHOU: ${e.message}` });
      // reverte o cash-in do ledger (cédula não aceita afinal)
      ledger.post('CASH_IN_REVERT', { cash: -s.amountCents, digital: 0 }, { sessionId: s.id, note: `Pix out falhou: ${e.message.slice(0, 80)}` });
      return json(res, 200, { sessionId: s.id, state: s.state, failed: true, message: 'Pix não enviado — DEVOLVA as cédulas: ' + e.message });
    }
  }

  // ---------- Consulta de sessão (polling do painel do agente) ----------
  if (req.method === 'GET' && p.startsWith('/api/session/')) {
    const s = sessions.get(decodeURIComponent(p.split('/')[3]));
    if (!s) return json(res, 404, { error: 'Sessão não encontrada' });
    return json(res, 200, {
      sessionId: s.id, type: s.type, state: s.state, method: s.method || null,
      amountCents: s.amountCents, totalCents: s.totalCents || s.amountCents,
      feeCents: s.feeCents || 0, qrText: s.qrText, checkoutUrl: s.checkoutUrl || null,
      txid: s.txid, endToEndId: s.endToEndId,
    });
  }

  // ---------- Kiosk: comando retirado (polling) ----------
  if (req.method === 'GET' && p.startsWith('/api/kiosk/commands/')) {
    const machineId = decodeURIComponent(p.split('/')[4]);
    return json(res, 200, { commands: queue.drain(machineId) });
  }

  // ---------- Kiosk: confirma entrega de cédula ----------
  if (req.method === 'POST' && p === '/api/kiosk/dispensed') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const s = sessions.get(body.sessionId);
    if (!s) return json(res, 404, { error: 'Sessão não encontrada' });
    if (!body.sensorOk) {
      s.transition('FAILED');
      return json(res, 200, { sessionId: s.id, state: s.state, warning: 'Sensor não confirmou entrega — acionar alerta' });
    }
    if (s.state !== 'DISPENSING') {
      return json(res, 409, { error: `Sem dispensa pendente (estado ${s.state})` });
    }
    ledger.post('CASH_OUT', { cash: -s.amountCents, digital: 0 }, { sessionId: s.id, note: 'Cédulas dispensadas' });
    s.transition('DONE');
    return json(res, 200, { sessionId: s.id, state: s.state, endToEndId: s.endToEndId });
  }

  // ---------- Agente: confirmação manual do Pix (modo assistido) ----------
  // No modo assistido o operador é a fonte da verdade: ele vê o Pix no app do PSP dele.
  if (req.method === 'POST' && p === '/api/agent/confirm-pix') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const s = sessions.get(body.sessionId);
    if (!s) return json(res, 404, { error: 'Sessão não encontrada' });
    const endToEndId = body.endToEndId || ('MANUAL-' + Date.now());
    const manual = { sessionId: s.id, endToEndId, manual: true, operator: body.operator || 'agente' };

    // Falha declarada pelo agente: estorna o que precisa e encerra
    if (body.fail) {
      const awaitingPayment = s.type === 'DEPOSIT' ? ['PIX_SENDING', 'PIX_CONFIRMED'] : ['PAYMENT_PENDING', 'CONFIRMED'];
      const hadCashIn = awaitingPayment.includes(s.state);
      s.transition('FAILED');
      if (hadCashIn) {
        ledger.post('CASH_IN_REVERT', { cash: -s.amountCents, digital: 0 }, { sessionId: s.id, note: 'Agente não conseguiu pagar — cédulas devolvidas ao cliente' });
      }
      return json(res, 200, { sessionId: s.id, state: s.state, failed: true });
    }

    if (s.type === 'DEPOSIT') {
      if (s.state !== 'PIX_SENDING') return json(res, 409, { error: `Estado ${s.state} não aguarda confirmação de Pix enviado` });
      s.endToEndId = endToEndId;
      s.transition('PIX_CONFIRMED');
      ledger.post('PIX_SENT', { cash: 0, digital: -s.amountCents }, { ...manual, note: 'Pix enviado manualmente pelo agente (app PSP)' });
      if (s.cpf) kyc.registerDeposit(s.cpf, s.clientName, s.amountCents);
      s.transition('DONE');
      return json(res, 200, { sessionId: s.id, state: s.state, ok: true });
    }

    // BOLETO / RECARGA: agente pagou o serviço (app PSP) com o dinheiro recebido
    if (s.type === 'BILL' || s.type === 'TOPUP') {
      if (s.state !== 'PAYMENT_PENDING') return json(res, 409, { error: `Estado ${s.state} não aguarda confirmação de pagamento` });
      s.endToEndId = endToEndId;
      s.transition('CONFIRMED');
      const servico = s.type === 'BILL' ? 'Boleto pago' : 'Recarga efetivada';
      ledger.post('PAYMENT_SENT', { cash: 0, digital: -s.amountCents }, { ...manual, note: `${servico} manualmente pelo agente (app PSP)` });
      s.transition('DONE');
      return json(res, 200, { sessionId: s.id, state: s.state, ok: true });
    }

    // WITHDRAW: agente viu o pagamento do cliente cair na conta (Pix ou cartão)
    if (s.state !== 'CHARGE_CREATED') return json(res, 409, { error: `Estado ${s.state} não aguarda confirmação de recebimento` });
    s.endToEndId = endToEndId;
    s.transition('PIX_CONFIRMED');
    const received = s.totalCents || s.amountCents;
    if (s.method === 'card') {
      ledger.post('CARD_RECEIVED', { cash: 0, digital: received }, { ...manual, method: 'card', feeCents: s.feeCents || 0, note: 'Cartão aprovado (checkout online) — confirmado manualmente pelo agente' });
    } else {
      ledger.post('PIX_RECEIVED', { cash: 0, digital: received }, { ...manual, method: 'pix', feeCents: s.feeCents || 0, note: 'Pix recebido confirmado manualmente pelo agente' });
    }
    s.transition('DISPENSING');
    return json(res, 200, { sessionId: s.id, state: s.state, deliverCash: true });
  }

  // ---------- Webhook do Mercado Pago (fonte da verdade no modo MP) ----------
  if (req.method === 'POST' && p === '/webhook/mercadopago') {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'JSON inválido' }); }
    const dataId = body && body.data && body.data.id ? String(body.data.id) : null;
    if (!dataId) return json(res, 400, { error: 'data.id ausente' });

    // 1. Assinatura x-signature (HMAC-SHA256, janela de 300s)
    const sig = req.headers['x-signature'] || '';
    const requestId = req.headers['x-request-id'] || '';
    if (!psp.verifyMPWebhookSignature(raw, sig, requestId, dataId)) {
      return json(res, 401, { error: 'Assinatura inválida' });
    }

    // 2. Só notificações de pagamento interessam
    if (body.type !== 'payment' && !(typeof body.action === 'string' && body.action.startsWith('payment'))) {
      return json(res, 200, { ok: true, ignored: `tipo ${body.type || '?'}` });
    }

    // 3. Idempotência: MP reenvia o mesmo evento várias vezes
    const evKey = 'mp-' + dataId;
    if (processedEvents.has(evKey)) return json(res, 200, { ok: true, deduped: true });
    processedEvents.set(evKey, true);

    // 4. Busca o pagamento na API do MP (fonte da verdade, não o payload do webhook)
    let payment;
    try {
      payment = await psp.getPayment(dataId);
    } catch (e) {
      return json(res, 200, { ok: false, error: 'Falha ao consultar pagamento: ' + e.message });
    }
    if (payment.status !== 'approved') {
      return json(res, 200, { ok: true, ignored: `status ${payment.status}` });
    }

    // 5. Liga o pagamento à sessão (external_reference = sessionId)
    const s = sessions.get(payment.external_reference);
    if (!s) return json(res, 200, { ok: true, ignored: 'sessão não encontrada (possivelmente expirada)' });
    if (s.type !== 'WITHDRAW' || s.state !== 'CHARGE_CREATED') {
      return json(res, 200, { ok: true, ignored: `estado ${s.state} não aguarda aprovação` });
    }

    // Aprovado: confirma e libera a entrega do dinheiro
    s.endToEndId = String(payment.id);
    s.transition('PIX_CONFIRMED');
    const recebidoCents = Math.round((payment.transaction_amount || s.totalCents || s.amountCents) * 100);
    const isCard = typeof payment.payment_method_id === 'string' && payment.payment_method_id.includes('card');
    if (isCard) {
      ledger.post('CARD_RECEIVED', { cash: 0, digital: recebidoCents }, { sessionId: s.id, endToEndId: s.endToEndId, method: 'card', feeCents: s.feeCents || 0, note: 'Cartão aprovado via webhook Mercado Pago' });
    } else {
      ledger.post('PIX_RECEIVED', { cash: 0, digital: recebidoCents }, { sessionId: s.id, endToEndId: s.endToEndId, method: 'pix', feeCents: s.feeCents || 0, note: 'Pix aprovado via webhook Mercado Pago' });
    }
    s.transition('DISPENSING');
    queue.push(s.machineId, { action: 'DISPENSE', sessionId: s.id, amountCents: s.amountCents, endToEndId: s.endToEndId });
    return json(res, 200, { ok: true, sessionId: s.id, state: s.state, method: isCard ? 'card' : 'pix' });
  }

  // ---------- Webhook do PSP (fonte da verdade) ----------
  if (req.method === 'POST' && p === '/webhook/psp') {
    const raw = await readBody(req);
    const sig = req.headers['x-webhook-signature'] || '';

    // 1. Assinatura HMAC sobre o corpo BRUTO
    if (!psp.verifyWebhookSignature(raw, sig)) {
      return json(res, 401, { error: 'Assinatura inválida' });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: 'JSON inválido' });
    }
    // 2. Anti-replay: timestamp dentro de janela de 300s
    const age = Math.abs(Date.now() - new Date(body.timestamp).getTime()) / 1000;
    if (age > 300) return json(res, 401, { error: 'Evento fora da janela de tempo' });

    // 3. Idempotência: evento duplicado é ignorado
    if (processedEvents.has(body.id)) {
      return json(res, 200, { ok: true, deduped: true });
    }
    processedEvents.set(body.id, true);

    const s = sessions.get(body.data.sessionId);
    if (!s) return json(res, 404, { error: 'Sessão não encontrada' });
    if (body.data.status !== 'LIQUIDADA') {
      return json(res, 200, { ok: true, ignored: `status ${body.data.status}` });
    }
    // BOLETO/RECARGA pagos pela conta BaaS (modo autônomo): confirmação do PSP fecha a sessão
    if ((s.type === 'BILL' || s.type === 'TOPUP') && s.state === 'PAYMENT_PENDING') {
      s.endToEndId = body.data.endToEndId;
      s.transition('CONFIRMED');
      const servico = s.type === 'BILL' ? 'Boleto pago' : 'Recarga efetivada';
      ledger.post('PAYMENT_SENT', { cash: 0, digital: -s.amountCents }, { sessionId: s.id, endToEndId: s.endToEndId, note: `${servico} via API PSP` });
      s.transition('DONE');
      return json(res, 200, { ok: true, sessionId: s.id, state: s.state });
    }
    if (s.state !== 'PIX_SENDING' && s.state !== 'CHARGE_CREATED') {
      return json(res, 409, { error: `Evento de liquidação inesperado (estado ${s.state})` });
    }

    s.endToEndId = body.data.endToEndId;
    s.transition('PIX_CONFIRMED');

    if (s.type === 'DEPOSIT') {
      // Dinheiro já está no cofre; Pix saiu. Lado digital sai da nossa conta PSP.
      ledger.post('PIX_SENT', { cash: 0, digital: -s.amountCents }, { sessionId: s.id, endToEndId: s.endToEndId });
      if (s.cpf) kyc.registerDeposit(s.cpf, s.clientName, s.amountCents);
      s.transition('DONE');
      return json(res, 200, { ok: true, sessionId: s.id, state: s.state });
    }

    // WITHDRAW: pagamento do cliente liquidado -> autoriza dispensa de cédulas
    const recebido = s.totalCents || s.amountCents;
    if (s.method === 'card') {
      ledger.post('CARD_RECEIVED', { cash: 0, digital: recebido }, { sessionId: s.id, endToEndId: s.endToEndId, method: 'card', feeCents: s.feeCents || 0 });
    } else {
      ledger.post('PIX_RECEIVED', { cash: 0, digital: recebido }, { sessionId: s.id, endToEndId: s.endToEndId, method: 'pix', feeCents: s.feeCents || 0 });
    }
    s.transition('DISPENSING');
    queue.push(s.machineId, { action: 'DISPENSE', sessionId: s.id, amountCents: s.amountCents, endToEndId: s.endToEndId });
    return json(res, 200, { ok: true, sessionId: s.id, state: s.state, dispense: 'queued' });
  }

  // ---------- Compliance: bloquear/desbloquear cliente ----------
  if (req.method === 'POST' && p === '/api/panel/kyc/block') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const c = kyc.setBlocked(body.cpf, body.blocked !== false);
    return json(res, 200, { ok: true, client: { blocked: !!c.blocked } });
  }

  // ---------- Painel (dashboard HTML) ----------
  if (req.method === 'GET' && p === '/panel') {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // ---------- Painel do agente (modo assistido) ----------
  if (req.method === 'GET' && p === '/agent') {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'agent.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // ---------- Simulador (página) ----------
  if (req.method === 'GET' && (p === '/' || p === '/simulator')) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'simulator.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  return json(res, 404, { error: 'Rota não encontrada' });
}

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('ERRO NÃO TRATADO:', e.message);
    if (!res.headersSent) json(res, 500, { error: 'Erro interno', detail: e.message });
  });
}).listen(PORT, () => {
  console.log(`Máquina Pix backend (PSP=${psp.PSP}) rodando em http://localhost:${PORT}`);
  console.log(`Taxas do agente: Pix ${psp.FEE_PIX_PCT}% | Cartão ${psp.FEE_CARD_PCT}% (teto cartão R$ ${(psp.CARD_MAX_CENTS/100).toFixed(2)}, crédito ${psp.CARD_ALLOW_CREDIT ? 'LIBERADO' : 'bloqueado — CARD_ALLOW_CREDIT=1 para liberar'})`);
  console.log(`Simulador do kiosk: http://localhost:${PORT}/`);
});
