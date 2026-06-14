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
