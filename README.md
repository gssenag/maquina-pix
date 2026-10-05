# Máquina Pix

Backend de validação para um kiosk ATM de troca dinheiro ⇄ Pix.
Zero dependências (Node puro), zero custo — roda no sandbox/localhost.

## Rodar

```bash
node src/server.js                          # modo stub (tudo simulado, offline)
PSP=celcoin node src/server.js              # SANDBOX REAL da Celcoin (cash-in Pix de verdade)
```

### Sandbox real da Celcoin (validado em 01/10/2026)

O modo `PSP=celcoin` usa as credenciais públicas de teste da documentação
(developers.celcoin.com.br — "Credenciais de acesso") e as URLs de sandbox.
Sem custo, sem CNPJ, sem contrato.

- ✅ Token OAuth2 real (`/v5/token`, validade 2400s, cache no adaptador)
- ✅ Cobrança QR dinâmica REAL (`/pix/v1/brcode/dynamic`) → EMV "Pix Copia e Cola"
  no padrão BCB exibido como QR Code no simulador. É um QR de sandbox: escaneável
  apenas no ambiente de teste, mas tecnicamente idêntico ao de produção.
- ⚠️ Cash-out (`/baas/v2/pix/payment`) exige conta BaaS com saldo — sai no
  onboarding com o suporte Celcoin (CNPJ). Sem conta, o depósito falha com
  RETURN_NOTES e reversão contábil (o sistema NÃO fica com o dinheiro).
- Credenciais sobrescrevem via env: CELCOIN_CLIENT_ID, CELCOIN_CLIENT_SECRET,
  CELCOIN_PIX_KEY, CELCOIN_BASE_URL, CELCOIN_BAAS_ACCOUNT

Depois abra http://localhost:3000/ — é o **simulador do kiosk** (finge o hardware:
botões de inserir cédula, webhook do PSP assinado, comando de dispensa).

## Fluxo validado

DEPÓSITO (dinheiro → Pix)
1. Kiosk inicia sessão (`POST /api/kiosk/session/start`, type DEPOSIT, chave Pix do cliente)
2. Validador conta cédulas → `POST /api/kiosk/notes-counted` (ledger: CASH_IN)
3. Backend dispara Pix ao cliente via PSP
4. Webhook `pix LIQUIDADA` assinado (HMAC) → sessão DONE (ledger: PIX_SENT)

SAQUE (Pix → dinheiro)
1. Sessão WITHDRAW → backend gera cobrança (QR) na hora
2. Cliente paga o QR
3. Webhook `LIQUIDADA` validado (assinatura + anti-replay 300s + idempotência)
   → ledger PIX_RECEIVED → comando DISPENSE vai pra fila da máquina
4. Kiosk busca comando (`GET /api/kiosk/commands/:machineId`), dispensa,
   confirma sensor (`POST /api/kiosk/dispensed`) → ledger CASH_OUT → DONE

## Regras de segurança implementadas

1. Webhook só é aceito com HMAC-SHA256 sobre o corpo bruto (timingSafeEqual)
2. Anti-replay: timestamp com janela de 300s
3. Idempotência: eventId duplicado é ignorado
4. Máquina de estados: transição inválida → 409 (dispensa dupla, evento tardio)
5. Ledger de dupla entrada com hash encadeado (hash chain) — cada lançamento
   carrega o hash do anterior; apagar/editar quebra a cadeia
6. Cofre só dispensa com liquidação CONFIRMADA (nunca com QR lido)
7. CASH_OUT só entra no ledger depois da checagem de estado (anti-dispensa dupla)

## KYC / AML (evolução 2)

Depósito (cash-in) exige CPF na tela. Regras (src/kyc.js):
1. Limite diário por CPF (padrão R$2.000, env KYC_DAILY_LIMIT)
2. Limite enforçado NA CONTAGEM (valor só se sabe depois das cédulas):
   estourou → sessão FAILED + comando RETURN_NOTES pra devolver o dinheiro
3. Blocklist: POST /api/panel/kyc/block {cpf, blocked} derruba o cliente na hora
4. CPF mascarado no painel; uso diário zera à meia-noite

## Resiliência (evolução 2)

1. Sessão presa (Pix nunca confirmou) expira e vira FAILED com alerta específico
   (env SESSAO_TIMEOUT_MS, padrão 10 min) — depósito expirado = "cédulas no cofre
   sem Pix confirmado"; saque expirado = "Pix recebido sem cédula entregue"
2. Máquina offline: heartbeat a cada 20s, painel alerta após 60s sem sinal
3. Botão de caos no simulador simula a máquina caindo

## Painel

`GET /api/panel/overview` — balanços (cofre x digital), sessões ativas,
alertas (cofre baixo, máquina offline por heartbeat).

## Estrutura

- src/server.js — API HTTP (rotas kiosk, webhook, painel)
- src/ledger.js — contabilidade dupla entrada + hash chain
- src/session.js — máquina de estados da transação
- src/psp.js — adaptador PSP (stub de sandbox). Trocar Celcoin↔Mercado Pago
  não muda nada fora deste arquivo
- src/queue.js — fila de comandos por máquina (futuro: trocar por MQTT)
- src/kyc.js — KYC/AML: limite diário por CPF + blocklist
- public/simulator.html — simulador visual do kiosk (com modo offline)
- public/panel.html — dashboard de operação (abrir /panel)

## Próximos passos

1. MEI → credenciais reais de sandbox na Celcoin (developers.celcoin.com.br)
2. Trocar o stub em src/psp.js pelas chamadas reais
3. Painel com UI de verdade (dashboard)
4. Cotação do hardware (kiosk reciclador)

## Modo Mercado Pago (PSP=mercadopago) — novo em 05/10/2026

O modelo mais rápido pro balcão: cada ponto opera com a própria conta Mercado Pago
e sua plataforma coordena. Sem contrato, sem piso de volume, abre MEI/PJ na hora.

```bash
PSP=mercadopago ASSISTED=1 \
MP_ACCESS_TOKEN=TEST-xxxx \
MP_WEBHOOK_SECRET=xxxx \
node src/server.js
```

O que é automático x manual no modo MP:

- SAQUE via Pix → automático: QR dinâmico gerado pela API (`POST /v1/payments`,
  payment_method_id=pix) e o webhook `/webhook/mercadopago` confirma sozinho
- SAQUE via CARTÃO (online) → automático: link/QR do checkout hospedado do MP
  (`POST /checkout/preferences`, débito por padrão), webhook confirma
- DEPÓSITO / BOLETO / RECARGA → manuais (ASSISTED=1): o MP não tem API de envio;
  o operador faz no app e confirma no painel do agente

Taxas de serviço (a RECEITA do agente, cobrada do cliente em cima do valor):

- `FEE_PIX_PCT` (default 1%) — ex: saque de R$50 → cliente paga R$50,50
- `FEE_CARD_PCT` (default 3%) — ex: saque de R$50 → cliente paga R$51,50
- `CARD_MAX_CENTS` (default 50000 = R$500) — teto por operação de cartão
- `CARD_ALLOW_CREDIT=1` libera crédito no checkout (default: SÓ DÉBITO, por
  causa de chargeback)

Webhook: configure em developers.mercadopago.com.br → Webhooks, URL
`https://SEU-DOMINIO/webhook/mercadopago`, evento `Pagamentos`. A assinatura
`x-signature` é validada (HMAC-SHA256, janela anti-replay de 300s), o pagamento
é reconsultado na API (fonte da verdade) e `external_reference` liga à sessão.

Configuração do ponto (para outros agentes): criar conta MP PJ, criar aplicativo
no painel de developers, gerar token, cadastrar webhook e informar
MP_ACCESS_TOKEN + MP_WEBHOOK_SECRET à plataforma.

Testes: `bash ../tmp/test_mercadopago.sh` (24 verificações, usa mock do MP)
