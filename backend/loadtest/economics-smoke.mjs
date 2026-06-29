/**
 * TEAMCRM Этап 2 — нагрузочный smoke движка economics.
 * Генерит поток закрытий time_log (start/stop) по множеству задач; движок в очереди
 * пересчитывает себестоимость. Проверяет: cost>0, отсутствие потери/задвоения работы
 * (идемпотентность — форсированный повторный пересчёт не меняет cost).
 *
 * Один активный таймер на пользователя (инвариант БД) → продюсер серийный, нагрузка на
 * стороне очереди/воркера (+ тик расписания включён). Через edge nginx.
 */
const BASE_URL = process.env.BASE_URL || 'http://crm-edge';
const TASKS = Number(process.env.TASKS || 16);
const DURATION_MS = Number(process.env.DURATION_MS || 20000);
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 120);
const RATE = Number(process.env.RATE || 360000); // /час

const API = `${BASE_URL}/api`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const env = await res.json();
  if (!env.ok) throw new Error(`${method} ${path}: ${env.error?.code} ${env.error?.message}`);
  return env.data;
}

async function drainPnl(projectId, token, timeoutMs = 15000) {
  // ждём стабилизации costActual (две одинаковые подряд проверки)
  let prev = -1;
  const stop = Date.now() + timeoutMs;
  while (Date.now() < stop) {
    const pnl = await call('GET', `/projects/${projectId}/pnl`, null, token);
    const c = Number(pnl.costActual);
    if (c === prev && c > 0) return c;
    prev = c;
    await sleep(1000);
  }
  return prev;
}

async function main() {
  console.log(`# economics smoke -> ${BASE_URL} tasks=${TASKS} duration=${DURATION_MS}ms`);
  const reg = await call('POST', '/auth/register', {
    tenantName: 'EconLoad', email: `el_${Date.now()}@l.test`, password: 'password123', fullName: 'EL',
  });
  const token = reg.accessToken;
  const userId = reg.user.id;
  await call('POST', '/rates', { userId, hourlyRate: RATE }, token);
  const project = await call('POST', '/projects', { name: 'EconLoad', budget: 1_000_000_000 }, token);

  const tasks = [];
  for (let i = 0; i < TASKS; i++) {
    tasks.push((await call('POST', '/tasks', { projectId: project.id, title: `t${i}` }, token)).id);
  }

  // поток закрытий: серийно (1 активный таймер на юзера), быстро, по разным задачам
  let closures = 0;
  let errors = 0;
  const stopAt = Date.now() + DURATION_MS;
  let i = 0;
  const t0 = Date.now();
  while (Date.now() < stopAt) {
    const taskId = tasks[i++ % tasks.length];
    try {
      await call('POST', `/tasks/${taskId}/timer/start`, null, token);
      await sleep(INTERVAL_MS);
      await call('POST', `/tasks/${taskId}/timer/stop`, null, token);
      closures++;
    } catch {
      errors++;
    }
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`load done: ${closures} closures in ${elapsed.toFixed(1)}s (${(closures / elapsed).toFixed(1)}/s), errors=${errors}`);

  // дать очереди обработать + стабилизироваться
  const c1 = await drainPnl(project.id, token);

  // идемпотентность: форсируем повторный полный пересчёт проекта (через no-op порог) и сверяем
  await call('POST', `/projects/${project.id}/margin-threshold`, { threshold: 15 }, token);
  await sleep(4000);
  const c2 = await drainPnl(project.id, token);

  const expectedApprox = (RATE * (closures * INTERVAL_MS / 1000)) / 3600;
  const report = {
    base_url: BASE_URL,
    closures,
    errors,
    duration_s: Number(elapsed.toFixed(1)),
    closures_per_sec: Number((closures / elapsed).toFixed(1)),
    cost_actual_after_drain: c1,
    cost_actual_after_recompute: c2,
    idempotent: c1 === c2,
    expected_cost_approx: Math.round(expectedApprox),
    ratio_actual_to_expected: expectedApprox ? Number((c1 / expectedApprox).toFixed(2)) : null,
  };
  console.log('\n===== ECONOMICS LOAD SMOKE REPORT =====');
  console.log(JSON.stringify(report, null, 2));
  console.log('=======================================');
  if (!report.idempotent) {
    console.error('FAIL: cost changed on recompute → потеря/задвоение работы');
    process.exit(1);
  }
  if (!(c1 > 0)) {
    console.error('FAIL: cost_actual is not positive');
    process.exit(1);
  }
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error('ECON LOADTEST FAILED:', e);
  process.exit(1);
});
