// Генератор нагрузки на HTTP API Postal.
//
// Открытая модель (constant-arrival-rate) выбрана осознанно. Замкнутый
// генератор перестаёт подавать нагрузку ровно тогда, когда система под тестом
// затыкается, поэтому в статистику попадают только те запросы, которые система
// разрешила сделать, и хвост латентности систематически занижается — то есть
// скрывается ровно то, чем отличаются сборки.
//
// Сценарий здесь ОДИН. Прогрев и рабочая фаза запускаются отдельными вызовами
// с разным BENCH_PHASE: только так итоговая сводка содержит счётчики одной
// фазы. При двух сценариях в одном запуске k6 сложил бы их в общие метрики,
// и принято за прогон оказалось бы больше, чем попадает в окно измерения.
//
// Ненулевой dropped_iterations означает, что генератор не удержал расписание,
// и такой прогон непригоден для выводов о латентности.

import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const API_URL = __ENV.POSTAL_API_URL;
const API_KEY = __ENV.POSTAL_API_KEY;
const WEB_HOST = __ENV.POSTAL_WEB_HOST;
const RUN_ID = __ENV.BENCH_RUN_ID;
const PHASE = __ENV.BENCH_PHASE;
const DOMAIN = __ENV.BENCH_DOMAIN;
const DOMAIN_COUNT = parseInt(__ENV.BENCH_DOMAIN_COUNT, 10);
const MIME_SIZE = parseInt(__ENV.BENCH_MIME_SIZE, 10);
const RATE = parseInt(__ENV.BENCH_RATE, 10);
const DURATION = __ENV.BENCH_DURATION;

// Тело письма собирается один раз: цель — нагрузить Postal, а не генератор.
const BODY = 'x'.repeat(Math.max(0, MIME_SIZE - 512));

export const accepted = new Counter('postal_accepted_recipients');
export const rejected = new Counter('postal_rejected_recipients');
export const acceptLatency = new Trend('postal_accept_latency', true);

export const options = {
  discardResponseBodies: false,
  scenarios: {
    load: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(20, RATE),
      maxVUs: Math.max(100, RATE * 10),
      tags: { phase: PHASE },
    },
  },
};

// Перекос по доменам назначения приближает распределение к реальной рассылке:
// несколько крупных получателей и длинный хвост мелких. Это принципиально,
// потому что batch_key = "outgoing-<домен>" собирает до 100 писем в батч,
// и отправка в один домен дарит Postal бесплатный примерно стократный выигрыш.
//
// Распределение квадратичное, а не Zipf: доля самого горячего домена
// получается заметно ниже, чем у настоящего Zipf, и в отчёте оно так и названо.
function skewedDomainIndex() {
  const u = Math.random();
  return Math.min(DOMAIN_COUNT - 1, Math.floor(DOMAIN_COUNT * u * u));
}

export default function () {
  const seq = exec.scenario.iterationInTest;
  const domainIdx = skewedDomainIndex();
  // Имя фазы входит в адрес: счётчик итераций у каждого запуска свой,
  // и без этого прогрев и рабочая фаза слали бы письма одним и тем же
  // адресатам. Повторный адрес — это прямая дорога в список подавления
  // Postal (два HardFail на адрес за сутки), где письма молча становятся Held.
  const to = `r${RUN_ID}-${PHASE}-${seq}@d${String(domainIdx + 1).padStart(4, '0')}.${DOMAIN}`;

  const payload = JSON.stringify({
    to: [to],
    from: `bench@${DOMAIN}`,
    subject: `bench ${RUN_ID} ${PHASE} ${seq}`,
    plain_body: BODY,
    headers: { 'X-Bench-Run': RUN_ID, 'X-Bench-Phase': PHASE, 'X-Bench-Seq': String(seq) },
  });

  const res = http.post(`${API_URL}/api/v1/send/message`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-Server-API-Key': API_KEY,
      // Обязателен. Postal делает config.hosts << web_hostname, а непустой
      // config.hosts включает host authorization Rails: запрос по IP-адресу
      // получает 403, и это выглядело бы как отказ Postal принимать почту.
      Host: WEB_HOST,
    },
    tags: { name: 'send' },
  });

  acceptLatency.add(res.timings.duration);

  // Postal отвечает HTTP 200 и на ошибку тоже, поэтому проверяем поле status
  // в теле, а не код ответа. Иначе получится бенчмарк HTTP-клиента.
  let ok = false;
  try {
    ok = res.status === 200 && JSON.parse(res.body).status === 'success';
  } catch (e) {
    ok = false;
  }

  if (ok) {
    accepted.add(1);
  } else {
    rejected.add(1);
  }
}

export function handleSummary(data) {
  const c = (name) =>
    data.metrics[name] && data.metrics[name].values ? data.metrics[name].values.count : 0;
  return {
    [`/results/${RUN_ID}-${PHASE}-summary.json`]: JSON.stringify(data, null, 2),
    stdout:
      `phase=${PHASE} accepted=${c('postal_accepted_recipients')} ` +
      `rejected=${c('postal_rejected_recipients')} ` +
      `dropped=${c('dropped_iterations')}\n`,
  };
}
