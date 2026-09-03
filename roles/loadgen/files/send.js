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

// Режим работы генератора.
//
//   rate  — открытая модель с заданной скоростью. Единственный режим, годный
//           для выводов о латентности и о скорости приёма.
//   burst — набивка очереди: заданное число писем настолько быстро, насколько
//           их принимает Postal. Расписания нет, поэтому латентность в этом
//           режиме измеряет только сам себя и в выводы не идёт. Нужен, чтобы
//           подготовить очередь заданной длины перед измерением дренажа.
const MODE = __ENV.BENCH_MODE || 'rate';
const ITERATIONS = parseInt(__ENV.BENCH_ITERATIONS || '0', 10);
const BURST_VUS = parseInt(__ENV.BENCH_BURST_VUS || '32', 10);

// Запас VU относительно заданной скорости. По закону Литтла для скорости R
// при латентности L одновременно требуется R*L виртуальных пользователей,
// поэтому потолок VU напрямую ограничивает достижимую скорость: при факторе 10
// прогон физически не мог подавать 58 писем/с, как только латентность приёма
// превысила 10 с, и генератор начинал ронять итерации. Фактор должен быть
// заведомо больше отношения худшей ожидаемой латентности к секунде.
const MAX_VU_FACTOR = parseInt(__ENV.BENCH_MAX_VU_FACTOR || '30', 10);

export const accepted = new Counter('postal_accepted_recipients');
export const rejected = new Counter('postal_rejected_recipients');
export const acceptLatency = new Trend('postal_accept_latency', true);

export const options = {
  discardResponseBodies: false,
  // Дефолтная сводка k6 не содержит p99, а медиану отдаёт под ключом med,
  // а не p(50). Отчёт без этого печатал нули там, где ожидались перцентили.
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    load:
      MODE === 'burst'
        ? {
            executor: 'shared-iterations',
            vus: BURST_VUS,
            iterations: ITERATIONS,
            maxDuration: DURATION,
            tags: { phase: PHASE },
          }
        : {
            executor: 'constant-arrival-rate',
            rate: RATE,
            timeUnit: '1s',
            duration: DURATION,
            preAllocatedVUs: Math.max(20, RATE),
            maxVUs: Math.max(100, RATE * MAX_VU_FACTOR),
            tags: { phase: PHASE },
          },
  },
};

// Словарь для сборки тела. Тело из одного повторяющегося байта сжимается почти
// в ничто, и любая компрессия — таблиц, страниц InnoDB или транспорта — делает
// запись MIME бесплатной, а вместе с ней недостоверным весь профиль записи.
// Реальный текст сжимается втрое-вчетверо, и это тот порядок, который должен
// видеть Postal. Неascii-слова здесь не для красоты: они заставляют Mail gem
// выбрать quoted-printable, как в настоящей рассылке, а не оставить 7bit.
// Словарь преимущественно из ASCII, с небольшой долей неascii. Пропорция
// подобрана не на глаз: quoted-printable кодирует каждый неascii БАЙТ тремя
// символами, поэтому тело целиком из кириллицы раздулось бы в MIME примерно
// втрое, и заявленные 100 КБ профиля превратились бы в 300 КБ в базе.
// Немного неascii при этом нужно, иначе Mail gem оставит 7bit и путь
// кодирования не нагрузится вовсе.
const WORDS = [
  'offer', 'discount', 'update', 'newsletter', 'product', 'limited',
  'exclusive', 'subscribe', 'details', 'available', 'shipping', 'today',
  'catalog', 'delivery', 'bonus', 'season', 'collection', 'free', 'order',
  'customer', 'promo', 'sale', 'gift', 'preview', 'summary', 'reference',
  'скидка', 'новинка', 'подарок',
];

// Длина строки в байтах UTF-8. Бюджет письма задан в байтах, а length даёт
// символы: на кириллице эти величины расходятся вдвое, и профиль «100 КБ»
// молча превращался бы в 144 КБ по проводу.
function byteLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c > 0x7ff) n += 3;
    else if (c > 0x7f) n += 2;
    else n += 1;
  }
  return n;
}

// Детерминированный генератор: тела должны различаться между письмами,
// но не зависеть от запуска, иначе два прогона одной сборки сравнивали бы
// разные данные.
//
// Собирается только короткий фрагмент, а нужный размер набирается его
// повторением. Это не косметика: код в области модуля выполняется заново
// для КАЖДОГО виртуального пользователя, и посимвольная сборка сотен килобайт
// на сотню VU съедала оба ядра генератора целиком — прогон мерил k6, а не Postal.
// Фрагмент мелкий, потому что размер тела набирается целым числом его повторов:
// чем он меньше, тем точнее попадание в заданный бюджет. Обрезать повтор
// на середине нельзя — разрез пришёлся бы на середину многобайтового символа.
const FRAGMENT_CHARS = 512;

function makeFragment(seed) {
  let out = '';
  let s = seed || 1;
  while (out.length < FRAGMENT_CHARS) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out += WORDS[s % WORDS.length];
    out += s % 11 === 0 ? '.\n' : ' ';
  }
  return out;
}

function makeText(bytes, seed) {
  if (bytes <= 0) return '';
  const frag = makeFragment(seed);
  const repeats = Math.max(1, Math.floor(bytes / byteLength(frag)));
  return frag.repeat(repeats);
}

function makeHtml(bytes, seed) {
  // Ссылки обязательны по существу: при включённом tracking Postal переписывает
  // каждую из них и пишет строку в таблицу links, поэтому письмо без ссылок
  // не нагружает этот путь вообще.
  const head =
    '<html><body><h1>' +
    WORDS[seed % WORDS.length] +
    '</h1><p><a href="https://example.test/c/' +
    seed +
    '">подробнее</a></p><p>';
  const tail = '</p></body></html>';
  const fill = Math.max(0, bytes - byteLength(head) - byteLength(tail));
  return head + makeText(fill, seed + 7) + tail;
}

// Тело одно на все письма, и это не упрощение, а моделирование: настоящая
// промо-рассылка отправляет один и тот же макет всем адресатам, а различаются
// получатель и персонализация в заголовках. MIME при этом всё равно уникален
// у каждого письма — свои To, Subject, Message-ID и подпись DKIM.
//
// Держать пул разных тел здесь нельзя ещё и по устройству k6: область модуля
// исполняется для КАЖДОГО виртуального пользователя, поэтому пул копировался
// бы столько раз, сколько VU создано, и при высокой латентности приёма
// (а значит и большом числе VU) генератор получал бы OOM вместо результата.
const PLAIN_SHARE = 0.35;
const BUDGET = Math.max(0, MIME_SIZE - 512);
const BODY = {
  plain: makeText(Math.floor(BUDGET * PLAIN_SHARE), 1),
  html: makeHtml(Math.ceil(BUDGET * (1 - PLAIN_SHARE)), 2),
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
    plain_body: BODY.plain,
    html_body: BODY.html,
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
      `phase=${PHASE} mode=${MODE} accepted=${c('postal_accepted_recipients')} ` +
      `rejected=${c('postal_rejected_recipients')} ` +
      `dropped=${c('dropped_iterations')}\n`,
  };
}
