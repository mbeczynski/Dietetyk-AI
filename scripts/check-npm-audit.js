#!/usr/bin/env node

// Ocenia wynik `npm audit --json` i decyduje, czy zablokować pipeline.
//
// Dlaczego ten skrypt istnieje: `npm audit` traktuje WSZYSTKIE podatności
// "high"/"critical" jednakowo, niezależnie od tego, czy dotyczą kodu, który
// faktycznie działa w produkcji, czy tylko narzędzi używanych przez `npm ci`
// do skompilowania natywnego bindingu (np. łańcuch sqlite3 -> node-gyp ->
// tar/make-fetch-happen/cacache/http-proxy-agent/@tootallnate/once). Te
// narzędzia kompilacyjne NIE trafiają do działającej aplikacji i nie są
// nigdy wywoływane w runtime - są używane wyłącznie raz, podczas instalacji
// zależności. Jedyny realny sposób ich "naprawienia" wymagałby podbicia
// sqlite3 na wersję główną, której prebuildowany binarz wymaga nowszego
// glibc niż ma obraz produkcyjny (node:20-slim) - co faktycznie WYSADZIŁO
// produkcję (ERR_DLOPEN_FAILED / GLIBC_2.38 not found) przy próbie tego
// fixu. Dlatego pakiety z tego konkretnego, udokumentowanego łańcucha są
// jawnie odłożone na białą listę poniżej - każda INNA podatność high/
// critical (czyli realna zależność runtime) wciąż blokuje pipeline.
//
// Użycie: node check-npm-audit.js <plik-audit.json> [dozwolony-pakiet,...]

const fs = require('fs');

const auditPath = process.argv[2];
const allowList = (process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean);

if (!auditPath) {
  console.error('Użycie: node check-npm-audit.js <plik-audit.json> [dozwolony-pakiet,...]');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
} catch (err) {
  console.error(`Nie udało się odczytać/sparsować ${auditPath}: ${err.message}`);
  process.exit(1);
}

const vulns = report.vulnerabilities || {};
const blocking = [];
const accepted = [];

for (const [pkgName, info] of Object.entries(vulns)) {
  const severity = info.severity;
  if (severity !== 'high' && severity !== 'critical') continue;

  if (allowList.includes(pkgName)) {
    accepted.push(`${pkgName} (${severity})`);
  } else {
    blocking.push(`${pkgName} (${severity})`);
  }
}

if (accepted.length > 0) {
  console.log('Zaakceptowane podatności (znana, udokumentowana wyjątkowa lista - tylko build-time, nigdy w runtime):');
  accepted.forEach(p => console.log(`  - ${p}`));
}

if (blocking.length > 0) {
  console.error('\nBlokujące podatności high/critical (NIE na białej liście):');
  blocking.forEach(p => console.error(`  - ${p}`));
  console.error('\nnpm audit nie przechodzi. Jeśli to nowa, realna podatność w zależności runtime - napraw ją (podbicie wersji / usunięcie zależności). Jeśli to kolejny build-time-only pakiet analogiczny do tych na białej liście - dodaj go do listy w kroku workflow, z uzasadnieniem.');
  process.exit(1);
}

console.log('\nOK - brak blokujących podatności high/critical poza zaakceptowaną listą.');
process.exit(0);
