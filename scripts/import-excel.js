/**
 * import-excel.js — Importador de porras en Excel.
 *
 * Uso:
 *   npm run import                  → procesa todos los .xlsx de /excels
 *   node scripts/import-excel.js --demo=5    → añade 5 participantes demo
 *   node scripts/import-excel.js --no-demo   → elimina los participantes demo
 *
 * Qué hace:
 *   1. Lee todos los .xlsx de la carpeta /excels. Admite dos formatos:
 *      - Libro individual (la plantilla común): un participante por archivo.
 *      - Libro multi-participante: todas las porras en columnas (Aaron, Aitor…)
 *        dentro de cada hoja "Grupo X". Se detecta automáticamente.
 *   2. Extrae pronósticos de los 72 partidos, clasificación prevista de cada
 *      grupo, eliminatorias (fase futura) y pichichi de cada participante.
 *   3. Genera data/participants.json y data/matches.json (calendario oficial).
 *      Los resultados reales ya guardados en matches.json se CONSERVAN.
 *   4. Recalcula data/ranking.json y data/statistics.json como instantáneas.
 *
 * Para añadir un participante nuevo: copia su .xlsx en /excels y vuelve a
 * ejecutar `npm run import`. No hay que tocar código.
 *
 * El nombre se deduce del nombre del archivo. Para personalizarlo, crea
 * excels/participants-config.json:  { "archivo.xlsx": { "name": "Nombre Bonito" } }
 * Otras opciones por archivo: "id" y "excludeMatches" (ids de partidos que no
 * puntúan a ese participante, p. ej. por entrar tarde a la porra: ["A1","A2"]).
 */

import XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveTeam, normName, signOf, buildContext,
  computeRanking, computeGlobalStats, computeGroupTable,
} from "../js/engine.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXCELS_DIR = path.join(ROOT, "excels");
const DATA_DIR = path.join(ROOT, "data");

const args = process.argv.slice(2);
const demoArg = args.find((a) => a.startsWith("--demo"));
const noDemo = args.includes("--no-demo");
const demoCount = demoArg && demoArg.includes("=") ? parseInt(demoArg.split("=")[1], 10) : null;

const groupsData = readJSON(path.join(DATA_DIR, "groups.json"));
const rules = readJSON(path.join(DATA_DIR, "scoring_rules.json"));

/* ------------------------------ utilidades ------------------------------ */

function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
  console.log("  ✔ escrito", path.relative(ROOT, file));
}
function sheetRows(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
}
function slugify(name) {
  return normName(name).slice(0, 30) || "participante";
}

/** Nombre del participante a partir del nombre del archivo. */
function nameFromFilename(file) {
  let base = path.basename(file, path.extname(file));
  base = base
    .replace(/copia de/gi, "")
    .replace(/porra[_\s]*mundial[_\s]*2026/gi, "")
    .replace(/\bporra\b/gi, "")
    .replace(/v\d+/gi, "")
    .replace(/[_\-.]+/g, " ")
    .trim();
  if (!base) base = path.basename(file, path.extname(file));
  return base
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Convierte "11 jun" + "21:00" en ISO con zona peninsular. */
function toISO(fecha, hora) {
  const months = { ene: "01", feb: "02", mar: "03", abr: "04", may: "05", jun: "06", jul: "07", ago: "08", sep: "09", oct: "10", nov: "11", dic: "12" };
  let day = null, month = null;
  if (typeof fecha === "string") {
    let m = fecha.trim().match(/^(\d{1,2})[\s/-]+([a-z]{3}|\d{1,2})/i);
    if (m) {
      day = m[1].padStart(2, "0");
      month = /\d/.test(m[2]) ? m[2].padStart(2, "0") : months[m[2].toLowerCase()] || "06";
    }
  }
  let time = "00:00";
  if (typeof hora === "string" && /\d{1,2}:\d{2}/.test(hora)) {
    time = hora.match(/(\d{1,2}:\d{2})/)[1].padStart(5, "0");
  } else if (typeof hora === "number") {
    const mins = Math.round(hora * 24 * 60);
    time = String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
  }
  if (!day || !month) return null;
  return `2026-${month}-${day}T${time}:00+02:00`;
}

function normSign(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  if (s === "1" || s === "2" || s === "X") return s;
  return null;
}

/* --------------------- parseo de un libro de porra --------------------- */

const GROUP_SHEET = /^Grupo\s+([A-L])/i;

/** Extrae las predicciones de partidos y clasificación de las 12 hojas de grupo. */
function parseGroupSheets(wb) {
  const matches = [];   // definición de partidos (solo plantilla)
  const preds = {};     // matchId → {home, away, sign}
  const groupPicks = {}; // groupId → {first, second, third}

  for (const sheetName of wb.SheetNames) {
    const m = sheetName.match(GROUP_SHEET);
    if (!m) continue;
    const groupId = m[1].toUpperCase();
    const rows = sheetRows(wb, sheetName);
    let idx = 0;

    for (const r of rows) {
      // Fila de partido: [jornada, local, predL, predV, signo, "VS", visitante, realL, realV, ...]
      if (typeof r[0] === "number" && typeof r[1] === "string" && r[6]) {
        idx++;
        const matchId = `${groupId}${idx}`;
        const home = resolveTeam(r[1], groupsData);
        const away = resolveTeam(r[6], groupsData);
        matches.push({
          id: matchId, group: groupId, matchday: r[0],
          home, away,
          date: toISO(r[11], r[12]),
        });
        const predHome = typeof r[2] === "number" ? r[2] : null;
        const predAway = typeof r[3] === "number" ? r[3] : null;
        const sign = normSign(r[4]);
        if (predHome != null && predAway != null) {
          preds[matchId] = { home: predHome, away: predAway, sign: sign || signOf(predHome, predAway) };
        } else if (sign) {
          preds[matchId] = { home: null, away: null, sign };
        }
      }
      // Filas de clasificación prevista del grupo.
      const label = typeof r[0] === "string" ? r[0] : "";
      if (label.includes("1º del grupo")) (groupPicks[groupId] ||= {}).first = resolveTeam(r[1], groupsData);
      else if (label.includes("2º del grupo")) (groupPicks[groupId] ||= {}).second = resolveTeam(r[1], groupsData);
      else if (label.includes("3º del grupo")) (groupPicks[groupId] ||= {}).third = resolveTeam(r[1], groupsData);
    }
  }
  return { matches, preds, groupPicks };
}

/** Sedes desde la hoja de calendario (clave: "HOME|AWAY"). */
function parseVenues(wb) {
  const venues = {};
  for (const name of wb.SheetNames) {
    if (!name.includes("CALENDARIO")) continue;
    for (const r of sheetRows(wb, name)) {
      if (typeof r[2] === "string" && typeof r[4] === "string" && r[5] && String(r[3]).toLowerCase() === "vs") {
        const h = resolveTeam(r[2], groupsData);
        const a = resolveTeam(r[4], groupsData);
        if (h && a) venues[`${h}|${a}`] = String(r[5]);
      }
    }
  }
  return venues;
}

/** Eliminatorias y pichichi (fase futura: se guardan, aún no puntúan). */
function parseKnockout(wb) {
  const sheetName = wb.SheetNames.find((n) => n.includes("ELIMINATORIAS"));
  if (!sheetName) return { knockout: {}, pichichi: null };
  const rows = sheetRows(wb, sheetName);
  const sections = [
    { key: "r32", marker: "1/16 DE FINAL" },
    { key: "r16", marker: "OCTAVOS DE FINAL" },
    { key: "qf", marker: "CUARTOS DE FINAL" },
    { key: "sf", marker: "SEMIFINALES" },
    { key: "thirdPlace", marker: "3º Y 4º PUESTO" },
    { key: "final", marker: "FINAL  —" },
  ];
  const knockout = {};
  let current = null;
  let pichichi = null;
  for (const r of rows) {
    const head = typeof r[0] === "string" ? r[0] : "";
    const found = sections.find((s) => head.toUpperCase().includes(s.marker));
    if (found) { current = found.key; knockout[current] = []; continue; }
    if (head.includes("PICHICHI")) { current = "pichichi"; continue; }
    if (current === "pichichi") {
      if (r[0] === "⚽" && typeof r[1] === "string" && r[1].trim()) pichichi = r[1].trim();
      continue;
    }
    if (current && typeof r[0] === "number" && (r[1] || r[5])) {
      knockout[current].push({
        home: r[1] ? resolveTeam(r[1], groupsData) || String(r[1]) : null,
        away: r[5] ? resolveTeam(r[5], groupsData) || String(r[5]) : null,
      });
    }
  }
  return { knockout, pichichi };
}

/* --------------- libro multi-participante (porras en columnas) --------------- */

/** Fila de partido en formato multi: [jor, local, "vs", visitante, fecha, …triples L/V/± por persona]. */
function isMultiMatchRow(r) {
  return typeof r[0] === "number" && typeof r[1] === "string" && String(r[2]).trim().toLowerCase() === "vs";
}

function isMultiWorkbook(wb) {
  for (const sheetName of wb.SheetNames) {
    if (!GROUP_SHEET.test(sheetName)) continue;
    if (sheetRows(wb, sheetName).some(isMultiMatchRow)) return true;
  }
  return false;
}

/** Extrae todos los participantes de un libro con las porras en columnas. */
function parseMultiWorkbook(wb) {
  const byName = {}; // nombre → { preds, groupPicks }
  const matches = [];

  for (const sheetName of wb.SheetNames) {
    const m = sheetName.match(GROUP_SHEET);
    if (!m) continue;
    const groupId = m[1].toUpperCase();
    const rows = sheetRows(wb, sheetName);

    // Cabecera "JOR. | LOCAL | VS | VISITANTE | FECHA | <persona> …": cada
    // persona ocupa 3 columnas (L, V, ±) a partir de la columna 5.
    const header = rows.find((r) => typeof r[0] === "string" && r[0].trim().toUpperCase().startsWith("JOR"));
    if (!header) continue;
    const cols = {};
    header.forEach((v, i) => {
      if (i >= 5 && typeof v === "string" && v.trim() && !v.toUpperCase().includes("RESULTADO")) cols[v.trim()] = i;
    });

    let idx = 0;
    for (const r of rows) {
      if (isMultiMatchRow(r)) {
        idx++;
        const matchId = `${groupId}${idx}`;
        matches.push({
          id: matchId, group: groupId, matchday: r[0],
          home: resolveTeam(r[1], groupsData),
          away: resolveTeam(r[3], groupsData),
          date: toISO(r[4], null),
        });
        for (const [name, c] of Object.entries(cols)) {
          const p = (byName[name] ||= { preds: {}, groupPicks: {} });
          const h = typeof r[c] === "number" ? r[c] : null;
          const a = typeof r[c + 1] === "number" ? r[c + 1] : null;
          const sign = normSign(r[c + 2]);
          if (h != null && a != null) p.preds[matchId] = { home: h, away: a, sign: sign || signOf(h, a) };
          else if (sign) p.preds[matchId] = { home: null, away: null, sign };
        }
      }
      // Clasificación prevista: filas "🥇 1º" / "🥈 2º" / "🥉 3º".
      const label = typeof r[0] === "string" ? r[0].trim() : "";
      const pos = label.endsWith("1º") ? "first" : label.endsWith("2º") ? "second" : label.endsWith("3º") ? "third" : null;
      if (pos) {
        for (const [name, c] of Object.entries(cols)) {
          const team = resolveTeam(r[c], groupsData);
          if (team) (((byName[name] ||= { preds: {}, groupPicks: {} }).groupPicks)[groupId] ||= {})[pos] = team;
        }
      }
    }
  }
  return { byName, matches };
}

/** Mismo participante con nombre corto/largo ("Roberto" ≈ "Roberto Alonso"). */
function isSamePerson(a, b) {
  const x = normName(a), y = normName(b);
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/* -------------------------- participantes demo -------------------------- */

const DEMO_NAMES = ["Lucía", "Marcos", "Aitor", "Nerea", "Iker", "Paula", "Unai", "Carmen", "Hugo", "Sara"];
const DEMO_PICHICHIS = ["Kylian Mbappé", "Erling Haaland", "Harry Kane", "Lamine Yamal", "Lionel Messi", "Vinícius Jr."];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeDemoParticipant(name, i, matches) {
  const rnd = mulberry32(1000 + i * 77);
  const goal = () => { const r = rnd(); return r < 0.32 ? 0 : r < 0.65 ? 1 : r < 0.88 ? 2 : 3; };
  const preds = {};
  for (const m of matches) {
    const h = goal(), a = goal();
    preds[m.id] = { home: h, away: a, sign: signOf(h, a) };
  }
  // Su clasificación prevista del grupo se deriva de sus propios marcadores.
  const groupPicks = {};
  for (const g of groupsData.groups) {
    const fake = matches
      .filter((m) => m.group === g.id)
      .map((m) => ({ ...m, status: "finished", score: { home: preds[m.id].home, away: preds[m.id].away } }));
    const table = computeGroupTable(g, fake);
    groupPicks[g.id] = { first: table[0].teamId, second: table[1].teamId, third: table[2].teamId };
  }
  return {
    id: "demo-" + slugify(name),
    name,
    demo: true,
    source: null,
    pichichi: DEMO_PICHICHIS[Math.floor(rnd() * DEMO_PICHICHIS.length)],
    predictions: { matches: preds, groups: groupPicks, knockout: {} },
  };
}

/* -------------------------------- proceso -------------------------------- */

console.log("📥 Importando porras desde /excels …\n");

if (!fs.existsSync(EXCELS_DIR)) {
  console.error("No existe la carpeta /excels. Crea la carpeta y copia ahí los .xlsx.");
  process.exit(1);
}

const files = fs.readdirSync(EXCELS_DIR).filter((f) => /\.xlsx?$/i.test(f) && !f.startsWith("~$"));
if (!files.length) {
  console.error("No hay archivos .xlsx en /excels.");
  process.exit(1);
}
const overrides = readJSON(path.join(EXCELS_DIR, "participants-config.json"), {});

let matchTemplate = null; // del primer libro: define los 72 partidos
let multiTemplate = null; // plantilla de un libro multi (sin fechas): solo de respaldo
let venues = {};
const realParticipants = [];
const multiParticipants = [];

for (const file of files) {
  const full = path.join(EXCELS_DIR, file);
  const wb = XLSX.readFile(full);

  if (isMultiWorkbook(wb)) {
    const { byName, matches } = parseMultiWorkbook(wb);
    if (!multiTemplate && matches.length) multiTemplate = matches;
    for (const [name, data] of Object.entries(byName)) {
      const conf = overrides[`${file}::${name}`] || {};
      for (const mid of conf.excludeMatches || []) delete data.preds[mid];
      multiParticipants.push({
        id: conf.id || slugify(conf.name || name),
        name: conf.name || name,
        demo: false,
        source: `${file} → columna ${name}`,
        pichichi: conf.pichichi || null,
        predictions: { matches: data.preds, groups: data.groupPicks, knockout: {} },
      });
    }
    console.log(`  📚 ${file}  →  libro multi-participante con ${Object.keys(byName).length} personas`);
    continue;
  }

  const { matches, preds, groupPicks } = parseGroupSheets(wb);
  const { knockout, pichichi } = parseKnockout(wb);

  if (!matchTemplate && matches.length) {
    matchTemplate = matches;
    venues = parseVenues(wb);
  }

  const conf = overrides[file] || {};
  // Partidos que no puntúan a este participante (p. ej. entró tarde a la porra).
  for (const mid of conf.excludeMatches || []) delete preds[mid];
  const name = conf.name || nameFromFilename(file);
  const id = conf.id || slugify(name);
  realParticipants.push({
    id, name, demo: false, source: file,
    pichichi: pichichi || conf.pichichi || null,
    predictions: { matches: preds, groups: groupPicks, knockout },
  });
  const nPreds = Object.keys(preds).length;
  console.log(`  👤 ${name}  (${file})  →  ${nPreds}/72 pronósticos, pichichi: ${pichichi || "—"}`);
}

// Personas del libro multi que no llegaron también como Excel individual
// (el individual gana: trae además pichichi y eliminatorias).
for (const mp of multiParticipants) {
  const dup = realParticipants.find((p) => isSamePerson(p.name, mp.name));
  if (dup) {
    console.log(`  ↩ ${mp.name}: ya importado como "${dup.name}" desde su Excel individual, se omite la columna.`);
    continue;
  }
  realParticipants.push(mp);
}

if (!matchTemplate) matchTemplate = multiTemplate;
if (!matchTemplate) {
  console.error("Ningún Excel contiene hojas de grupo válidas.");
  process.exit(1);
}

/* --- matches.json: calendario + sedes, conservando resultados reales --- */

const prevMatches = readJSON(path.join(DATA_DIR, "matches.json"), { matches: [] });
const prevById = Object.fromEntries(prevMatches.matches.map((m) => [m.id, m]));

const matches = matchTemplate
  .map((m) => {
    const prev = prevById[m.id] || {};
    return {
      ...m,
      venue: venues[`${m.home}|${m.away}`] || prev.venue || null,
      score: prev.score || null,
      status: prev.status || "pending",
    };
  })
  .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

/* --- participants.json: reales + demo (marcados y reemplazables) --- */

const prevParticipants = readJSON(path.join(DATA_DIR, "participants.json"), { participants: [] });
let demos = prevParticipants.participants.filter((p) => p.demo);
if (noDemo) demos = [];
if (demoCount != null) {
  demos = DEMO_NAMES.slice(0, demoCount).map((n, i) => makeDemoParticipant(n, i, matchTemplate));
}
// Evita duplicar nombre demo si ya entró el participante real equivalente.
const realNames = new Set(realParticipants.map((p) => normName(p.name)));
demos = demos.filter((d) => !realNames.has(normName(d.name.replace(/\s*\(demo\)/i, ""))));

const participants = [...realParticipants, ...demos];

/* --- correcciones de local/visitante (data/matches-corrections.json) ---- */
// Algunos partidos del Excel tienen el equipo local y visitante invertidos.
// Esta corrección se aplica tanto a los partidos como a las predicciones,
// de modo que el motor puntúe con el orden real de local/visitante.
const corrections = readJSON(path.join(DATA_DIR, "matches-corrections.json"), {});
const swapIds = new Set(corrections.swapHomeAway || []);
if (swapIds.size > 0) {
  for (const m of matches) {
    if (!swapIds.has(m.id)) continue;
    [m.home, m.away] = [m.away, m.home];
    if (m.score) [m.score.home, m.score.away] = [m.score.away, m.score.home];
  }
  for (const p of participants) {
    for (const id of swapIds) {
      const pred = p.predictions.matches[id];
      if (!pred) continue;
      p.predictions.matches[id] = {
        home: pred.away,
        away: pred.home,
        sign: pred.sign === "1" ? "2" : pred.sign === "2" ? "1" : pred.sign,
      };
    }
  }
  console.log(`  🔄 Local/visitante corregidos en: ${[...swapIds].sort().join(", ")}`);
}

/* --- tournament.json: estado real del torneo (se conserva si existe) --- */

const tournament = readJSON(path.join(DATA_DIR, "tournament.json"), null) || {
  name: rules.porraName,
  phase: "groups",
  bestThirds: [],
  pichichi: { real: null, aliases: [] },
};
tournament.lastUpdated = new Date().toISOString();

/* --- instantáneas: ranking.json y statistics.json --- */

const ctx = buildContext({
  rules, groupsData,
  matches, participants, tournament,
});
const ranking = computeRanking(ctx);
const stats = computeGlobalStats(ctx);

console.log("");
writeJSON(path.join(DATA_DIR, "matches.json"), { lastUpdated: tournament.lastUpdated, matches });
writeJSON(path.join(DATA_DIR, "participants.json"), { lastUpdated: tournament.lastUpdated, participants });
writeJSON(path.join(DATA_DIR, "tournament.json"), tournament);
writeJSON(path.join(DATA_DIR, "ranking.json"), {
  lastUpdated: tournament.lastUpdated,
  ranking: ranking.map((r) => ({ position: r.position, id: r.id, name: r.name, demo: r.demo, ...r.breakdown, exactHits: r.stats.exactHits, signHits: r.stats.signHits })),
});
writeJSON(path.join(DATA_DIR, "statistics.json"), { lastUpdated: tournament.lastUpdated, ...stats });

console.log(`\n✅ Importación completa: ${realParticipants.length} participantes reales + ${demos.length} demo, ${matches.length} partidos.`);

// Aviso de pronósticos incompletos para revisar los Excel originales.
for (const p of realParticipants) {
  const n = Object.keys(p.predictions.matches).length;
  if (n < matches.length) console.log(`   ⚠ ${p.name}: solo ${n}/${matches.length} pronósticos de partido.`);
  if (!p.pichichi) console.log(`   ⚠ ${p.name}: sin pichichi.`);
}
