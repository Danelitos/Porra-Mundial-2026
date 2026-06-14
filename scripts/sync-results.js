/**
 * sync-results.js — Sincroniza los resultados reales desde TheSportsDB
 * y los PERSISTE en data/matches.json (+ instantáneas de ranking/estadísticas).
 *
 * Uso:
 *   npm run sync
 *
 * La web ya se sincroniza sola en el navegador; este script sirve para dejar
 * los resultados guardados en el repositorio (commit + push), de modo que la
 * web funcione aunque la API caiga y el historial quede versionado.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContext, computeRanking, computeGlobalStats } from "../js/engine.js";
import { dayURL, relevantDates, mapEventsToUpdates, applyUpdates } from "../js/livesource.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = (f) => path.join(ROOT, "data", f);
const readJSON = (f) => JSON.parse(fs.readFileSync(DATA(f), "utf8"));
const writeJSON = (f, o) => fs.writeFileSync(DATA(f), JSON.stringify(o, null, 2) + "\n", "utf8");

const groupsData = readJSON("groups.json");
const rules = readJSON("scoring_rules.json");
const matchesFile = readJSON("matches.json");
const participantsFile = readJSON("participants.json");
const tournament = readJSON("tournament.json");

// Por defecto solo consultamos los días "relevantes" (partidos no finalizados
// que ya se jugaron o empiezan en las próximas ~36 h): así el job automático no
// machaca la API con los 39 días del calendario en cada pasada. Con `--all` se
// fuerza un resincronizado completo (útil para backfill manual).
//
// Consultamos día a día (eventsday.php), no por jornada, porque el endpoint por
// jornada devuelve como máximo 5 eventos con la clave gratuita (y cada jornada
// del Mundial tiene 24 partidos).
const FULL = process.argv.includes("--all");
const allDates = FULL
  ? [...new Set(matchesFile.matches.map((m) => new Date(m.date).toISOString().slice(0, 10)))].sort()
  : relevantDates(matchesFile.matches);

if (!allDates.length) {
  console.log("✔ No hay partidos pendientes que sondear ahora mismo.");
  process.exit(0);
}

console.log(`🔄 Consultando TheSportsDB (Mundial 2026, ${allDates.length} día(s)${FULL ? ", modo completo" : ""})…`);

// Resiliente: si un día concreto falla (timeout, throttle, HTTP != 200) lo
// saltamos y seguimos con el resto, en vez de tumbar toda la sincronización.
let failures = 0;
const eventsArrays = await Promise.all(
  allDates.map(async (d) => {
    try {
      const res = await fetch(dayURL(d), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).events || [];
    } catch (err) {
      failures++;
      console.log(`   ⚠ Día ${d}: ${err.message} (saltado)`);
      return [];
    }
  })
);

if (failures === allDates.length) {
  console.error("✖ La API no respondió en ningún día. Se aborta sin tocar los datos.");
  process.exit(1);
}

const total = eventsArrays.reduce((s, e) => s + e.length, 0);
const { updates, unmatched } = mapEventsToUpdates(eventsArrays, matchesFile.matches, groupsData);
const { matches, changed } = applyUpdates(matchesFile.matches, updates);

console.log(`   ${total} eventos recibidos · ${updates.length} con datos · ${changed} cambios`);
if (unmatched.length) console.log("   ⚠ Sin emparejar:", unmatched.join(" | "));

if (!changed) {
  console.log("✔ Todo estaba ya al día.");
  process.exit(0);
}

const now = new Date().toISOString();
matchesFile.matches = matches;
matchesFile.lastUpdated = now;
tournament.lastUpdated = now;

const ctx = buildContext({
  rules, groupsData, matches,
  participants: participantsFile.participants,
  tournament,
});
const ranking = computeRanking(ctx);
const stats = computeGlobalStats(ctx);

writeJSON("matches.json", matchesFile);
writeJSON("tournament.json", tournament);
writeJSON("ranking.json", {
  lastUpdated: now,
  ranking: ranking.map((r) => ({ position: r.position, id: r.id, name: r.name, demo: r.demo, ...r.breakdown, exactHits: r.stats.exactHits, signHits: r.stats.signHits })),
});
writeJSON("statistics.json", { lastUpdated: now, ...stats });

console.log("\n🏅 Ranking actual:");
for (const r of ranking.slice(0, 10)) {
  console.log(`  ${String(r.position).padStart(2)}. ${r.name.padEnd(20)} ${r.breakdown.total} pts${r.demo ? "  (demo)" : ""}`);
}
console.log("\n✔ Resultados guardados. Haz commit + push para publicar.");
