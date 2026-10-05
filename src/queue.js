/**
 * Fila de comandos por máquina (substituto do MQTT em modo single-node).
 * O kiosk faz polling: GET /api/kiosk/commands/:machineId
 * Cada comando tem id único e timestamp — a dispensa é UM comando por sessão.
 */
const queues = new Map(); // machineId -> [command]

function push(machineId, command) {
  if (!queues.has(machineId)) queues.set(machineId, []);
  queues.get(machineId).push({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    ts: new Date().toISOString(),
    ...command,
  });
}

function drain(machineId) {
  const q = queues.get(machineId) || [];
  const cmds = [...q];
  queues.set(machineId, []);
  return cmds;
}

module.exports = { push, drain };
