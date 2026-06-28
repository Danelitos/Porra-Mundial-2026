/**
 * sync-results.js — Sincroniza los resultados reales desde football-data.org
 * y los PERSISTE en data/matches.json (+ instantáneas de ranking/estadísticas).
 *
 * Uso:
 *   FOOTBALL_DATA_TOKEN=xxxx npm run sync
 *
 * Usamos football-data.org (no TheSportsDB) porque su plan gratuito devuelve
 * LOS 72 partidos en una sola llamada, con marcador y estado en directo. La
 * clave gratuita de TheSportsDB capaba la salida a 3 partidos por día, así que
 * la mayoría de resultados nunca llegaban. El navegador sigue usando TheSportsDB
 * (CORS abierto) para el directo inmediato; este script, en el servidor, deja
 * los resultados completos guardados en el repo (commit + push).
 *
 * Token gratuito: https://www.football-data.org/client/register
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContext, computeRanking, computeGlobalStats, computeActualBracketTeams } from "../js/engine.js";
import { applyUpdates } from "../js/livesource.js";
import { fetchWorldCupMatches, mapFDToUpdates, mapFDKnockout, fetchWorldCupScorers, mapFDScorers } from "./footballdata.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = (f) => path.join(ROOT, "data", f);
const readJSON = (f) => JSON.parse(fs.readFileSync(DATA(f), "utf8"));
const readJSONOr = (f, fallback) => (fs.existsSync(DATA(f)) ? readJSON(f) : fallback);
const writeJSON = (f, o) => fs.writeFileSync(DATA(f), JSON.stringify(o, null, 2) + "\n", "utf8");

const groupsData = readJSON("groups.json");
const rules = readJSON("scoring_rules.json");
const matchesFile = readJSON("matches.json");
const participantsFile = readJSON("participants.json");
const tournament = readJSON("tournament.json");
const bracket = readJSONOr("bracket.json", null);
const knockoutFile = readJSONOr("knockout.json", { lastUpdated: null, results: {} });

console.log("🔄 Consultando football-data.org (Mundial 2026, todos los partidos)…");

let fdMatches;
try {
  fdMatches = await fetchWorldCupMatches(process.env.FOOTBALL_DATA_TOKEN);
} catch (err) {
  console.error(`✖ ${err.message}`);
  console.error("  No se toca ningún dato. Comprueba el token (FOOTBALL_DATA_TOKEN).");
  process.exit(1);
}

const { updates, unmatched } = mapFDToUpdates(fdMatches, matchesFile.matches, groupsData);
const { matches, changed } = applyUpdates(matchesFile.matches, updates);
const total = fdMatches.length;

console.log(`   ${total} eventos recibidos · ${updates.length} con datos · ${changed} cambios`);
if (unmatched.length) console.log("   ⚠ Sin emparejar:", unmatched.join(" | "));

// ----- Fase eliminatoria -----
// Cada ronda del cuadro se resuelve a partir de la anterior, así que iteramos:
// con los resultados ya conocidos calculamos los equipos reales de cada cruce,
// casamos los eventos de la API y, si aparecen nuevos ganadores, repetimos para
// resolver la siguiente ronda en la misma ejecución.
let koChanged = false;
if (bracket) {
  for (let pass = 0; pass < 7; pass++) {
    const ctx = buildContext({
      rules, groupsData, matches,
      participants: participantsFile.participants,
      tournament, bracket, knockout: knockoutFile,
    });
    const actualTeams = computeActualBracketTeams(ctx);
    const { updates: koUpdates } = mapFDKnockout(fdMatches, actualTeams, groupsData);
    let passChanged = false;
    for (const u of koUpdates) {
      const prev = knockoutFile.results[u.id];
      if (prev && prev.status === "finished" && u.status !== "finished") continue; // no degradar
      const same = prev && prev.status === u.status && prev.winner === u.winner &&
        JSON.stringify(prev.score) === JSON.stringify(u.score);
      if (same) continue;
      knockoutFile.results[u.id] = u;
      passChanged = true;
      koChanged = true;
    }
    if (!passChanged) break;
  }
  const koFin = Object.values(knockoutFile.results).filter((r) => r.status === "finished").length;
  console.log(`   eliminatoria: ${Object.keys(knockoutFile.results).length} cruces con datos · ${koFin} finalizados${koChanged ? " · actualizada" : ""}`);
}

// Máximos goleadores: llamada independiente y no crítica. Si falla (p. ej. el
// plan gratuito devuelve la tabla vacía hasta que hay goles), no abortamos el
// sync de resultados; simplemente dejamos scorers.json como estaba.
let scorersChanged = false;
const scorersFile = readJSONOr("scorers.json", { lastUpdated: null, scorers: [] });
try {
  const fdScorers = await fetchWorldCupScorers(process.env.FOOTBALL_DATA_TOKEN);
  const scorers = mapFDScorers(fdScorers, groupsData);
  if (JSON.stringify(scorers) !== JSON.stringify(scorersFile.scorers)) {
    scorersFile.scorers = scorers;
    scorersChanged = true;
  }
  console.log(`   ${scorers.length} goleadores recibidos${scorersChanged ? " · actualizados" : " · sin cambios"}`);
} catch (err) {
  console.log(`   ⚠ No se pudieron leer goleadores: ${err.message}`);
}

if (!changed && !scorersChanged && !koChanged) {
  console.log("✔ Todo estaba ya al día.");
  process.exit(0);
}

const now = new Date().toISOString();

if (scorersChanged) {
  scorersFile.lastUpdated = now;
  writeJSON("scorers.json", scorersFile);
}

if (changed) {
  matchesFile.matches = matches;
  matchesFile.lastUpdated = now;
  writeJSON("matches.json", matchesFile);
}

if (koChanged) {
  knockoutFile.lastUpdated = now;
  writeJSON("knockout.json", knockoutFile);
}

// El ranking depende de los resultados de grupos Y de la eliminatoria.
if (changed || koChanged) {
  tournament.lastUpdated = now;

  const ctx = buildContext({
    rules, groupsData, matches,
    participants: participantsFile.participants,
    tournament, bracket, knockout: knockoutFile,
  });
  const ranking = computeRanking(ctx);
  const stats = computeGlobalStats(ctx);

  writeJSON("tournament.json", tournament);
  writeJSON("ranking.json", {
    lastUpdated: now,
    ranking: ranking.map((r) => ({ position: r.position, id: r.id, name: r.name, demo: r.demo, ...r.breakdown, exactHits: r.stats.exactHits, signHits: r.stats.signHits, koHits: r.stats.koHits })),
  });
  writeJSON("statistics.json", { lastUpdated: now, ...stats });

  console.log("\n🏅 Ranking actual:");
  for (const r of ranking.slice(0, 10)) {
    console.log(`  ${String(r.position).padStart(2)}. ${r.name.padEnd(20)} ${r.breakdown.total} pts${r.demo ? "  (demo)" : ""}`);
  }
}

console.log("\n✔ Datos guardados. Haz commit + push para publicar.");
