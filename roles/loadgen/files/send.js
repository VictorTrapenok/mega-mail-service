// Load generator for the Postal HTTP API.
//
// The open model (constant-arrival-rate) is a deliberate choice. A closed
// generator stops applying load exactly when the system under test
// stalls, so only the requests the system allowed make it into the statistics,
// and the latency tail is systematically understated — that is, precisely what
// distinguishes builds gets hidden.
//
// There is exactly ONE scenario here. The warm-up and the working phase are launched by
// separate invocations with a different BENCH_PHASE: only this way does the final summary
// contain the counters of a single phase. With two scenarios in one run, k6 would fold them
// into common metrics, and more would be shown as accepted for the run than falls into the
// measurement window.
//
// A non-zero dropped_iterations means the generator failed to keep the schedule,
// and such a run is unusable for conclusions about latency.

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

// Generator operating mode.
//
//   rate  — the open model at a configured rate. The only mode suitable
//           for conclusions about latency and about the ingress rate.
//   burst — queue filling: a given number of messages as fast as
//           Postal accepts them. There is no schedule, so latency in this
//           mode only measures itself and does not feed conclusions. It exists to
//           prepare a queue of a given length before measuring the drain.
const MODE = __ENV.BENCH_MODE || 'rate';
const ITERATIONS = parseInt(__ENV.BENCH_ITERATIONS || '0', 10);
const BURST_VUS = parseInt(__ENV.BENCH_BURST_VUS || '32', 10);

// The VU headroom relative to the configured rate. By Little's law, a rate R
// at latency L requires R*L concurrent virtual users,
// so the VU ceiling directly limits the achievable rate: at a factor of 10 the
// run physically could not sustain 58 messages/s once the ingress latency
// exceeded 10 s, and the generator started dropping iterations. The factor must be
// knowingly larger than the ratio of the worst expected latency to one second.
const MAX_VU_FACTOR = parseInt(__ENV.BENCH_MAX_VU_FACTOR || '30', 10);

export const accepted = new Counter('postal_accepted_recipients');
export const rejected = new Counter('postal_rejected_recipients');
export const acceptLatency = new Trend('postal_accept_latency', true);

export const options = {
  discardResponseBodies: false,
  // The default k6 summary does not contain p99, and it reports the median under the key med
  // rather than p(50). Without this, the report printed zeros where percentiles were expected.
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

// The dictionary used to assemble the body. A body made of a single repeated byte compresses
// to almost nothing, and any compression — of tables, of InnoDB pages or of the transport —
// makes writing the MIME free, and with it renders the whole write profile untrustworthy.
// Real text compresses three- to fourfold, and that is the order of magnitude Postal should
// see. The non-ASCII words here are not decoration: they force the Mail gem
// to pick quoted-printable, as in a real mailing, rather than leave 7bit.
// The dictionary is predominantly ASCII with a small share of non-ASCII. The proportion
// was not picked by eye: quoted-printable encodes every non-ASCII BYTE with three
// characters, so a body made entirely of non-ASCII text would inflate the MIME roughly
// threefold, and the profile's declared 100 KB would become 300 KB in the database.
// Some non-ASCII is still needed, otherwise the Mail gem leaves 7bit and the encoding
// path is not exercised at all.
const WORDS = [
  'offer', 'discount', 'update', 'newsletter', 'product', 'limited',
  'exclusive', 'subscribe', 'details', 'available', 'shipping', 'today',
  'catalog', 'delivery', 'bonus', 'season', 'collection', 'free', 'order',
  'customer', 'promo', 'sale', 'gift', 'preview', 'summary', 'reference',
  'rabatté', 'überblick', 'cadeaux-spécial',
];

// String length in UTF-8 bytes. The message budget is given in bytes, whereas length yields
// characters: for non-ASCII text these values diverge by a factor of two, and a "100 KB"
// profile would silently turn into 144 KB on the wire.
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

// A deterministic generator: the bodies must differ between messages
// but must not depend on the run, otherwise two runs of the same build would compare
// different data.
//
// Only a short fragment is assembled, and the required size is reached by repeating it.
// This is not cosmetics: the code in the module scope is executed anew
// for EVERY virtual user, and assembling hundreds of kilobytes character by character
// across a hundred VUs consumed both generator cores entirely — the run measured k6, not Postal.
// The fragment is small because the body size is made up of a whole number of its repeats:
// the smaller it is, the more precisely the given budget is hit. A repeat must not be cut
// in the middle — the cut would land in the middle of a multi-byte character.
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
  // The links are essential: with tracking enabled Postal rewrites
  // every one of them and writes a row into the links table, so a message without links
  // does not exercise that path at all.
  const head =
    '<html><body><h1>' +
    WORDS[seed % WORDS.length] +
    '</h1><p><a href="https://example.test/c/' +
    seed +
    '">détails</a></p><p>';
  const tail = '</p></body></html>';
  const fill = Math.max(0, bytes - byteLength(head) - byteLength(tail));
  return head + makeText(fill, seed + 7) + tail;
}

// The body is the same for all messages, and this is modelling rather than a simplification:
// a real promotional mailing sends the same layout to every addressee, and what differs is
// the recipient and the personalisation in the headers. The MIME is still unique
// per message — its own To, Subject, Message-ID and DKIM signature.
//
// Keeping a pool of different bodies here is also ruled out by how k6 works: the module scope
// is executed for EVERY virtual user, so the pool would be copied
// as many times as there are VUs, and at high ingress latency
// (and hence a large number of VUs) the generator would be OOM-killed instead of producing a result.
const PLAIN_SHARE = 0.35;
const BUDGET = Math.max(0, MIME_SIZE - 512);
const BODY = {
  plain: makeText(Math.floor(BUDGET * PLAIN_SHARE), 1),
  html: makeHtml(Math.ceil(BUDGET * (1 - PLAIN_SHARE)), 2),
};

// Skewing the destination domains brings the distribution closer to a real mailing:
// a few large recipients and a long tail of small ones. This matters fundamentally,
// because batch_key = "outgoing-<domain>" packs up to 100 messages into a batch,
// and sending to a single domain hands Postal a free ~100x win.
//
// The distribution is quadratic rather than Zipf: the share of the hottest domain
// comes out noticeably lower than with a true Zipf, and the report names it accordingly.
function skewedDomainIndex() {
  const u = Math.random();
  return Math.min(DOMAIN_COUNT - 1, Math.floor(DOMAIN_COUNT * u * u));
}

export default function () {
  const seq = exec.scenario.iterationInTest;
  const domainIdx = skewedDomainIndex();
  // The phase name is part of the address: each run has its own iteration counter,
  // and without this the warm-up and the working phase would send messages to the same
  // addressees. A repeated address is a direct route into Postal's suppression list
  // (two HardFails per address within a day), where messages silently become Held.
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
      // Mandatory. Postal does config.hosts << web_hostname, and a non-empty
      // config.hosts enables Rails host authorization: a request by IP address
      // gets a 403, and that would look like Postal refusing to accept mail.
      Host: WEB_HOST,
    },
    tags: { name: 'send' },
  });

  acceptLatency.add(res.timings.duration);

  // Postal answers with HTTP 200 on errors too, so we check the status field
  // in the body rather than the response code. Otherwise we get a benchmark of the HTTP client.
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
