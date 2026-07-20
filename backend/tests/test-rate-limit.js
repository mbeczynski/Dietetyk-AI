// Test dedykowanego limitera AI (middleware/rateLimit.js -> aiRateLimiter, Runda 18 -
// naprawa z audytu: routes/chat.js i routes/meals.js POST /api/meals miały jako jedyną
// ochronę globalny apiRateLimiter 120 req/min/IP, który realnie nie chronił przed
// nadużyciem kosztu wywołań Gemini przez pojedynczego użytkownika).
// Czysto jednostkowy test middleware (fałszywe req/res) - bez bazy danych/sieci.
// UWAGA: limiter sam wyłącza się pod NODE_ENV=test/CI=true (patrz middleware/rateLimit.js),
// więc ten test musi jawnie ustawić inny NODE_ENV, żeby faktycznie przetestować limit.
process.env.NODE_ENV = 'rate-limit-test';
delete process.env.CI;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function makeRes(capture) {
  return {
    set: (k, v) => { capture.headers[k] = v; },
    status: (code) => {
      capture.status = code;
      return { json: (body) => { capture.body = body; } };
    }
  };
}

function run() {
  console.log('\n--- TEST: aiRateLimiter ---');
  const { aiRateLimiter } = require('../middleware/rateLimit');

  const req = { user: { id: 424242 }, ip: '127.0.0.1', originalUrl: '/api/chat', method: 'POST' };
  let nextCalls = 0;
  const next = () => { nextCalls++; };

  const AI_MAX_REQUESTS = 30; // musi być zgodne ze stałą w middleware/rateLimit.js
  let lastCapture = null;
  for (let i = 0; i < AI_MAX_REQUESTS + 1; i++) {
    lastCapture = { headers: {}, status: null, body: null };
    aiRateLimiter(req, makeRes(lastCapture), next);
  }

  assert(nextCalls === AI_MAX_REQUESTS, `next() wywołane dokładnie ${AI_MAX_REQUESTS} razy - żądanie ponad limit jest zablokowane, nie przepuszczone dalej`);
  assert(lastCapture.status === 429, 'żądanie ponad limit dostaje status 429');
  assert(lastCapture.body && typeof lastCapture.body.error === 'string', 'odpowiedź 429 zawiera komunikat błędu');
  assert(!!lastCapture.headers['Retry-After'], 'odpowiedź 429 zawiera nagłówek Retry-After');

  // Inny użytkownik ma WŁASNY licznik - limit jest per-user, nie globalny.
  const otherUserReq = { user: { id: 999999 }, ip: '127.0.0.1', originalUrl: '/api/chat', method: 'POST' };
  let otherUserNextCalls = 0;
  const otherCapture = { headers: {}, status: null, body: null };
  aiRateLimiter(otherUserReq, makeRes(otherCapture), () => { otherUserNextCalls++; });
  assert(otherUserNextCalls === 1, 'inny użytkownik (inny user_id) NIE jest zablokowany limitem pierwszego użytkownika (limit per-user)');
}

try {
  run();
  console.log('\n🎉 TESTY LIMITERA AI ZAKOŃCZONE SUKCESEM!\n');
  process.exit(0);
} catch (err) {
  console.error('\n' + err.message);
  console.error('❌ TESTY LIMITERA AI NIEUDANE');
  process.exit(1);
}
