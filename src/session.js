/**
 * Máquina de estados da sessão de uma transação no kiosk.
 * Transições válidas — qualquer outra é rejeitada (evita evento tardio sobrescrevendo estado terminal).
 *
 * BOLETO/RECARGA (dinheiro -> serviço pago pela conta BaaS):
 *   CREATED -> COUNTING -> PAYMENT_PENDING -> CONFIRMED -> DONE
 * DEPÓSITO (dinheiro -> Pix):
 *   CREATED -> COUNTING -> PIX_SENDING -> PIX_CONFIRMED -> DONE
 * SAQUE (Pix -> dinheiro):
 *   CREATED -> CHARGE_CREATED -> PIX_CONFIRMED -> DISPENSING -> DONE
 * Falha em qualquer estado -> FAILED
 */
// BOLETO (dinheiro -> pagamento de boleto) e RECARGA (dinheiro -> crédito no celular):
//   CREATED -> COUNTING -> PAYMENT_PENDING -> CONFIRMED -> DONE
const BILL_TOPUP = {
  CREATED: ['COUNTING', 'FAILED'],
  COUNTING: ['PAYMENT_PENDING', 'FAILED'],
  PAYMENT_PENDING: ['CONFIRMED', 'FAILED'],
  CONFIRMED: ['DONE', 'FAILED'],
  DONE: [],
  FAILED: [],
};

const VALID = {
  BILL: BILL_TOPUP,
  TOPUP: BILL_TOPUP,
  DEPOSIT: {
    CREATED: ['COUNTING', 'FAILED'],
    COUNTING: ['PIX_SENDING', 'FAILED'],
    PIX_SENDING: ['PIX_CONFIRMED', 'FAILED'],
    PIX_CONFIRMED: ['DONE', 'FAILED'],
    DONE: [],
    FAILED: [],
  },
  WITHDRAW: {
    CREATED: ['CHARGE_CREATED', 'FAILED'],
    CHARGE_CREATED: ['PIX_CONFIRMED', 'FAILED'],
    PIX_CONFIRMED: ['DISPENSING', 'FAILED'],
    DISPENSING: ['DONE', 'FAILED'],
    DONE: [],
    FAILED: [],
  },
};

class Session {
  constructor(id, type, machineId, extra = {}) {
    if (!VALID[type]) throw new Error(`Tipo inválido: ${type}`);
    this.id = id;
    this.type = type; // DEPOSIT | WITHDRAW
    this.machineId = machineId;
    this.state = 'CREATED';
    this.amountCents = extra.amountCents || null;
    this.pixKey = extra.pixKey || null;
    this.txid = null;
    this.endToEndId = null;
    this.qrText = null;
    this.createdAt = new Date().toISOString();
    this.history = [{ state: 'CREATED', ts: this.createdAt }];
  }

  transition(newState) {
    const allowed = VALID[this.type][this.state];
    if (!allowed.includes(newState)) {
      throw new Error(`Transição inválida: ${this.state} -> ${newState} (${this.type})`);
    }
    this.state = newState;
    this.history.push({ state: newState, ts: new Date().toISOString() });
    return this;
  }
}

module.exports = { Session, VALID };
