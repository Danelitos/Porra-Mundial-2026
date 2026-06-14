/**
 * livesource.js — Resultados en tiempo real desde TheSportsDB (gratuita, sin clave, CORS abierto).
 *
 * Compartido entre el navegador (js/live.js) y Node (scripts/sync-results.js).
 * Liga: FIFA World Cup (id 4429), temporada 2026.
 *
 * IMPORTANTE: se consulta POR DÍA (eventsday.php), no por jornada. El endpoint
 * por jornada (eventsround.php) con la clave gratuita devuelve como máximo 5
 * eventos, pero cada jornada del Mundial tiene 24 partidos — por eso la mayoría
 * de partidos jugados nunca se marcaban como finalizados. Consultando por fecha
 * obtenemos todos los partidos de cada día sin ese tope.
 */

import { resolveTeam } from "./engine.js";

export const API_BASE = "https://www.thesportsdb.com/api/v1/json/3";
export const LEAGUE_ID = 4429;
export const SEASON = "2026";

/** Margen hacia el futuro: además de los días pasados, sondeamos los partidos
 *  que arrancan en las próximas ~36 h (para cogerlos en directo). */
const FUTURE_HORIZON_MS = 36 * 3600 * 1000;

/** URL de los eventos de un día concreto (YYYY-MM-DD, en UTC). */
export function dayURL(date) {
  return `${API_BASE}/eventsday.php?d=${date}&l=${LEAGUE_ID}`;
}

/**
 * Días (UTC) que conviene sondear: todos los de partidos aún no finalizados que
 * ya se jugaron o empiezan en las próximas ~36 h. Se incluye el día anterior y
 * el posterior de cada uno para absorber desfases horarios entre la API y
 * nuestro calendario. Se reduce solo a medida que los partidos se cierran.
 */
export function relevantDates(matches, now = new Date()) {
  const horizon = now.getTime() + FUTURE_HORIZON_MS;
  const dates = new Set();
  for (const m of matches) {
    if (m.status === "finished") continue;
    const t = new Date(m.date).getTime();
    if (t > horizon) continue;
    const base = new Date(m.date);
    for (const delta of [-1, 0, 1]) {
      const d = new Date(base.getTime() + delta * 86_400_000);
      dates.add(d.toISOString().slice(0, 10));
    }
  }
  return [...dates].sort();
}

/** Ventana máxima razonable de un partido desde el saque inicial: 105 min de
 *  juego + descanso + añadidos + margen ≈ 2 h 30. Pasada esta ventana dejamos
 *  de inferir "en juego" por hora. */
export const MATCH_WINDOW_MS = 150 * 60 * 1000;

/**
 * Estado "de cara a la web". Combina lo guardado / lo recibido de la API con una
 * inferencia por hora: si ya pasó el saque inicial y el partido aún no está
 * finalizado, lo mostramos "en juego" AUNQUE la API no lo confirme. Esto evita
 * depender de que TheSportsDB tenga ese partido en su calendario o de que
 * actualice su estado en directo (en la clave gratuita no siempre lo hace).
 */
export function viewStatus(m, now = Date.now()) {
  if (m.status === "finished") return "finished";
  if (m.status === "live") return "live";
  const t = new Date(m.date).getTime();
  return now >= t && now < t + MATCH_WINDOW_MS ? "live" : "pending";
}

/**
 * Minuto aproximado de un partido en directo, como texto ("23", "Descanso",
 * "67", "90+"). Si la API nos dio el minuto real, se respeta. Si no, se estima
 * por la hora de inicio asumiendo un descanso de ~15 min.
 */
export function liveMinute(m, now = Date.now()) {
  if (m.minute) return m.minute;
  const elapsed = Math.floor((now - new Date(m.date).getTime()) / 60000);
  if (elapsed < 1) return "1";
  if (elapsed <= 45) return String(elapsed);
  if (elapsed <= 60) return "Descanso";
  if (elapsed <= 105) return String(elapsed - 15); // restamos el descanso
  return "90+";
}

/** Estado de TheSportsDB → nuestro estado. */
export function mapStatus(str) {
  const s = String(str || "").toUpperCase();
  if (["FT", "AET", "PEN", "MATCH FINISHED", "FINISHED"].includes(s)) return "finished";
  if (["NS", "", "NOT STARTED", "TBD", "POSTPONED", "CANC"].includes(s)) return "pending";
  return "live"; // 1H, HT, 2H, ET, minuto en curso…
}

/**
 * Convierte los eventos de la API en actualizaciones sobre nuestros partidos.
 * events: arrays de la API (uno por jornada) · matches: data/matches.json
 * Devuelve { updates: [{id, score, status}], unmatched: [evento…] }
 */
export function mapEventsToUpdates(eventsArrays, matches, groupsData) {
  const updates = [];
  const unmatched = [];
  const byPair = {};
  for (const m of matches) {
    byPair[`${m.home}|${m.away}|${m.matchday}`] = m;
  }

  for (const events of eventsArrays) {
    for (const ev of events || []) {
      const home = resolveTeam(ev.strHomeTeam, groupsData);
      const away = resolveTeam(ev.strAwayTeam, groupsData);
      const round = parseInt(ev.intRound, 10) || null;
      if (!home || !away) { unmatched.push(ev.strEvent); continue; }

      let match = byPair[`${home}|${away}|${round}`] || byPair[`${away}|${home}|${round}`];
      let swapped = false;
      if (match && match.home === away && match.away === home) swapped = true;
      if (!match) {
        // sin jornada: busca por pareja en cualquier jornada
        match = matches.find((m) => (m.home === home && m.away === away) || (m.home === away && m.away === home));
        if (match && match.home === away) swapped = true;
      }
      if (!match) { unmatched.push(ev.strEvent); continue; }

      const status = mapStatus(ev.strStatus);
      const hs = ev.intHomeScore != null && ev.intHomeScore !== "" ? parseInt(ev.intHomeScore, 10) : null;
      const as = ev.intAwayScore != null && ev.intAwayScore !== "" ? parseInt(ev.intAwayScore, 10) : null;
      const score = hs != null && as != null
        ? (swapped ? { home: as, away: hs } : { home: hs, away: as })
        : null;

      if (status === "pending" && !score) continue; // nada nuevo
      updates.push({ id: match.id, score, status, minute: ev.strProgress || null });
    }
  }
  return { updates, unmatched };
}

/**
 * Aplica las actualizaciones sobre la lista de partidos (devuelve copia).
 * Nunca borra un resultado ya finalizado guardado a mano.
 */
export function applyUpdates(matches, updates) {
  const byId = Object.fromEntries(updates.map((u) => [u.id, u]));
  let changed = 0;
  const out = matches.map((m) => {
    const u = byId[m.id];
    if (!u) return m;
    // No degradar un partido ya marcado finalizado a "live"/"pending".
    if (m.status === "finished" && u.status !== "finished") return m;
    const same = m.status === u.status &&
      JSON.stringify(m.score) === JSON.stringify(u.score || m.score);
    if (same) return m;
    changed++;
    return { ...m, score: u.score || m.score, status: u.status, minute: u.minute || null };
  });
  return { matches: out, changed };
}
