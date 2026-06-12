/**
 * livesource.js — Resultados en tiempo real desde TheSportsDB (gratuita, sin clave, CORS abierto).
 *
 * Compartido entre el navegador (js/live.js) y Node (scripts/sync-results.js).
 * Liga: FIFA World Cup (id 4429), temporada 2026. Las jornadas 1-3 cubren
 * los 72 partidos de la fase de grupos.
 */

import { resolveTeam } from "./engine.js";

export const API_BASE = "https://www.thesportsdb.com/api/v1/json/3";
export const LEAGUE_ID = 4429;
export const SEASON = "2026";
export const GROUP_ROUNDS = [1, 2, 3];

export function roundURL(round) {
  return `${API_BASE}/eventsround.php?id=${LEAGUE_ID}&r=${round}&s=${SEASON}`;
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
