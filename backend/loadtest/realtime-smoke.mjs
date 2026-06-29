/**
 * TEAMCRM Этап 1 — нагрузочный smoke realtime-слоя (Шаг 1.4 / DoD).
 *
 * Проверяет WebSocket-слой под нагрузкой: множество одновременных сокетов,
 * подписанных на одну комнату проекта, и поток перемещений карточек.
 * Метрики: число установленных сокетов, число перемещений, fan-out событий,
 * end-to-end задержка доставки task.moved (REST move -> приход события).
 *
 * Гоняется через edge nginx (реальный путь, ws-upgrade).
 * Параметры через env: BASE_URL, CLIENTS, MOVERS, DURATION_MS, SEED_TASKS.
 */
import { io } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL || 'http://crm-edge';
const CLIENTS = Number(process.env.CLIENTS || 75);
const MOVERS = Number(process.env.MOVERS || 4);
const DURATION_MS = Number(process.env.DURATION_MS || 20000);
const SEED_TASKS = Number(process.env.SEED_TASKS || 24);

const API = `${BASE_URL}/api`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms

async function apiPost(path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const env = await res.json();
  if (!env.ok) throw new Error(`${path}: ${env.error?.code} ${env.error?.message}`);
  return env.data;
}
async function apiGet(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const env = await res.json();
  if (!env.ok) throw new Error(`${path}: ${env.error?.code}`);
  return env.data;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function main() {
  console.log(`# realtime smoke -> ${BASE_URL}  clients=${CLIENTS} movers=${MOVERS} duration=${DURATION_MS}ms`);

  // 1. setup: tenant + project + tasks
  const email = `load_${Date.now()}@load.test`;
  const reg = await apiPost('/auth/register', { tenantName: 'LoadTest', email, password: 'password123', fullName: 'Load' }, null);
  const token = reg.accessToken;
  const project = await apiPost('/projects', { name: 'Load Project' }, token);
  const projectId = project.id;

  for (let i = 0; i < SEED_TASKS; i++) {
    await apiPost('/tasks', { projectId, title: `task-${i}` }, token);
  }
  const board = await apiGet(`/projects/${projectId}/board`, token);
  const columns = board.columns.map((c) => c.id);
  const allTasks = board.columns.flatMap((c) => c.tasks).map((t) => t.id);
  const proberTask = allTasks[0];
  const moverTasks = allTasks.slice(1);
  console.log(`setup ok: project=${projectId} columns=${columns.length} tasks=${allTasks.length}`);

  // 2. connect N sockets, subscribe to project room
  let received = 0;
  const proberArrivals = new Map(); // taskId+col -> resolve
  let connectedCount = 0;
  const sockets = [];

  const connectAll = Array.from({ length: CLIENTS }, (_, idx) => {
    return new Promise((resolve) => {
      const s = io(BASE_URL, { transports: ['websocket'], auth: { token }, reconnection: false });
      s.on('connect', async () => {
        await s.emitWithAck('project.subscribe', { projectId });
        connectedCount++;
        resolve();
      });
      s.on('connect_error', () => resolve());
      s.on('task.moved', (t) => {
        received++;
        if (idx === 0) {
          const key = `${t.id}:${t.column_id}`;
          const cb = proberArrivals.get(key);
          if (cb) cb();
        }
      });
      sockets.push(s);
    });
  });
  await Promise.race([Promise.all(connectAll), sleep(15000)]);
  console.log(`connected sockets: ${connectedCount}/${CLIENTS}`);

  // 3. load: movers hammer moves; prober measures latency
  const latencies = [];
  let movesIssued = 0;
  let moveErrors = 0;
  // возрастающая позиция: target всегда > всех существующих -> перенос не сдвигает
  // соседние строки (минимальный lock footprint, меряем realtime, а не write-contention)
  let posCounter = 1000;
  const stopAt = Date.now() + DURATION_MS;

  const mover = async (mi) => {
    let col = mi % columns.length;
    while (Date.now() < stopAt) {
      const taskId = moverTasks[Math.floor(Math.random() * moverTasks.length)];
      col = (col + 1) % columns.length;
      try {
        await apiPost(`/tasks/${taskId}/move`, { columnId: columns[col], position: posCounter++ }, token);
        movesIssued++;
      } catch {
        moveErrors++;
      }
    }
  };

  const prober = async () => {
    let col = 0;
    while (Date.now() < stopAt) {
      col = (col + 1) % columns.length;
      const targetCol = columns[col];
      const key = `${proberTask}:${targetCol}`;
      const t0 = now();
      const arrived = new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        proberArrivals.set(key, () => {
          clearTimeout(timer);
          resolve();
        });
      });
      try {
        await apiPost(`/tasks/${proberTask}/move`, { columnId: targetCol, position: posCounter++ }, token);
        movesIssued++;
      } catch {
        moveErrors++;
      }
      await arrived;
      latencies.push(now() - t0);
      proberArrivals.delete(key);
      await sleep(150);
    }
  };

  const t0 = now();
  await Promise.all([...Array.from({ length: MOVERS }, (_, i) => mover(i)), prober()]);
  const elapsed = (now() - t0) / 1000;

  // дать долетающим событиям осесть
  await sleep(1500);

  const sorted = latencies.slice().sort((a, b) => a - b);
  const report = {
    base_url: BASE_URL,
    clients_requested: CLIENTS,
    clients_connected: connectedCount,
    movers: MOVERS,
    duration_s: Number(elapsed.toFixed(1)),
    moves_issued: movesIssued,
    move_errors: moveErrors,
    moves_per_sec: Number((movesIssued / elapsed).toFixed(1)),
    events_received_total: received,
    events_per_sec: Number((received / elapsed).toFixed(0)),
    fanout_ratio: movesIssued ? Number((received / movesIssued).toFixed(1)) : 0,
    latency_ms: {
      samples: sorted.length,
      p50: Number(pct(sorted, 50).toFixed(1)),
      p90: Number(pct(sorted, 90).toFixed(1)),
      p99: Number(pct(sorted, 99).toFixed(1)),
      max: Number((sorted[sorted.length - 1] || 0).toFixed(1)),
    },
  };

  console.log('\n===== REALTIME LOAD SMOKE REPORT =====');
  console.log(JSON.stringify(report, null, 2));
  console.log('======================================');

  for (const s of sockets) s.close();
  // forceExit
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => {
  console.error('LOADTEST FAILED:', e);
  process.exit(1);
});
