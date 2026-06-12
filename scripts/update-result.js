/**
 * update-result.js — Herramienta del árbitro para introducir resultados reales.
 *
 * Uso:
 *   npm run result A1 2 1          → México 2-1 Sudáfrica (finalizado)
 *   npm run result A1 1 1 live     → marcar como "en juego" con marcador parcial
 *   npm run result A1 --clear      → borrar el resultado (vuelve a pendiente)
 *   npm run result -- --list A     → listar los partidos del grupo A con su id
 *   npm run result -- --thirds RSA CZE ...   → fijar los 8 mejores terceros
 *   npm run result -- --pichichi "Kylian Mbappé"
 *
 * Después de actualizar, recalcula y guarda las instantáneas
 * (ranking.json y statistics.json). La web recalcula sola al recargar.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContext, computeRanking, computeGlobalStats, resolveTeam } from "../js/engine.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = (f) => path.join(ROOT, "data", f);
const readJSON = (f) => JSON.parse(fs.readFileSync(DATA(f), "utf8"));
const writeJSON = (f, o) => fs.writeFileSync(DATA(f), JSON.stringify(o, null, 2) + "\n", "utf8");

const groupsData = readJSON("groups.json");
const rules = readJSON("scoring_rules.json");
const matchesFile = readJSON("matches.json");
const participantsFile = readJSON("participants.json");
const tournament = readJSON("tournament.json");

const teamName = (id) => {
  for (const g of groupsData.groups) for (const t of g.teams) if (t.id === id) return `${t.flag} ${t.name}`;
  return id;
};

const args = process.argv.slice(2);

if (!args.length || args.includes("--help")) {
  console.log("Uso: npm run result <idPartido> <golesLocal> <golesVisitante> [live]");
  console.log("     npm run result -- --list [grupo]");
  console.log("     npm run result -- --thirds RSA CZE ... (8 equipos)");
  console.log('     npm run result -- --pichichi "Nombre Jugador"');
  process.exit(0);
}

if (args[0] === "--list") {
  const filter = (args[1] || "").toUpperCase();
  for (const m of matchesFile.matches) {
    if (filter && m.group !== filter) continue;
    const score = m.score ? `${m.score.home}-${m.score.away}` : "—";
    console.log(`${m.id.padEnd(4)} [${m.status.padEnd(8)}] ${teamName(m.home)} vs ${teamName(m.away)}  ${score}  (${(m.date || "").slice(0, 16)})`);
  }
  process.exit(0);
}

if (args[0] === "--thirds") {
  const ids = args.slice(1).map((t) => resolveTeam(t, groupsData) || t.toUpperCase());
  tournament.bestThirds = ids;
  console.log("Mejores terceros fijados:", ids.map(teamName).join(", "));
} else if (args[0] === "--pichichi") {
  tournament.pichichi = tournament.pichichi || { real: null, aliases: [] };
  tournament.pichichi.real = args[1];
  console.log("Pichichi real fijado:", args[1]);
} else {
  const [id, h, a, flag] = args;
  const match = matchesFile.matches.find((m) => m.id.toUpperCase() === id.toUpperCase());
  if (!match) {
    console.error(`No existe el partido "${id}". Usa --list para ver los ids.`);
    process.exit(1);
  }
  if (args.includes("--clear")) {
    match.score = null;
    match.status = "pending";
    console.log(`${match.id}: resultado borrado, vuelve a PENDIENTE.`);
  } else {
    const home = parseInt(h, 10), away = parseInt(a, 10);
    if (Number.isNaN(home) || Number.isNaN(away)) {
      console.error("Goles no válidos. Ejemplo: npm run result A1 2 1");
      process.exit(1);
    }
    match.score = { home, away };
    match.status = flag === "live" ? "live" : "finished";
    console.log(`${match.id}: ${teamName(match.home)} ${home}-${away} ${teamName(match.away)}  [${match.status}]`);
  }
}

/* Recalcular instantáneas */
const now = new Date().toISOString();
tournament.lastUpdated = now;
matchesFile.lastUpdated = now;

const ctx = buildContext({
  rules, groupsData,
  matches: matchesFile.matches,
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
console.log("\n✔ Datos recalculados. Haz commit + push para publicar en GitHub Pages.");
