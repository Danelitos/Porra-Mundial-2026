/**
 * footballdata.js — Fuente de resultados desde football-data.org (plan gratuito).
 *
 * A diferencia de TheSportsDB con clave gratuita (que capa la salida a 3-5
 * eventos por consulta), football-data.org devuelve LOS 72 partidos del Mundial
 * en una sola llamada, con marcador y estado (incluido IN_PLAY). Solo se usa
 * desde el GitHub Action (lado servidor): requiere token y no permite CORS, así
 * que el navegador no puede llamarla directamente.
 *
 * Token gratuito: https://www.football-data.org/client/register
 * Se pasa por la variable de entorno FOOTBALL_DATA_TOKEN.
 */

import { resolveTeam } from "../js/engine.js";

const API = "https://api.football-data.org/v4";
export const COMPETITION = "WC"; // FIFA World Cup

/** Descarga todos los partidos del Mundial. Lanza si el token falta o falla. */
export async function fetchWorldCupMatches(token) {
  if (!token) throw new Error("Falta FOOTBALL_DATA_TOKEN");
  const res = await fetch(`${API}/competitions/${COMPETITION}/matches`, {
    headers: { "X-Auth-Token": token },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`football-data ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.matches || [];
}

/** Estado de football-data.org → nuestro estado. */
export function mapStatus(s) {
  const v = String(s || "").toUpperCase();
  if (["FINISHED", "AWARDED"].includes(v)) return "finished";
  if (["IN_PLAY", "PAUSED", "SUSPENDED"].includes(v)) return "live";
  return "pending"; // SCHEDULED, TIMED, POSTPONED, CANCELLED
}

/**
 * Convierte los partidos de football-data.org en actualizaciones sobre nuestros
 * partidos (mismo formato que js/livesource.js para reutilizar applyUpdates).
 * Devuelve { updates: [{id, score, status, minute}], unmatched: [texto…] }.
 */
export function mapFDToUpdates(fdMatches, matches, groupsData) {
  const updates = [];
  const unmatched = [];
  const byPair = {};
  for (const m of matches) byPair[`${m.home}|${m.away}`] = m;

  for (const ev of fdMatches) {
    // Eliminatorias aún sin equipos definidos: la API las trae como huecos
    // (homeTeam/awayTeam sin nombre). No son parte de nuestra fase de grupos.
    if (!ev.homeTeam?.name || !ev.awayTeam?.name) continue;

    // Resolvemos por nombre y, si falla, por código de equipo (tla): football-data
    // usa nombres en inglés ("United States", "Cape Verde Islands") que no siempre
    // tenemos como alias, pero su tla coincide casi siempre con nuestro id.
    const home = resolveTeam(ev.homeTeam.name, groupsData) || resolveTeam(ev.homeTeam.tla, groupsData);
    const away = resolveTeam(ev.awayTeam.name, groupsData) || resolveTeam(ev.awayTeam.tla, groupsData);
    if (!home || !away) {
      unmatched.push(`${ev.homeTeam.name} vs ${ev.awayTeam.name}`);
      continue;
    }

    let match = byPair[`${home}|${away}`];
    let swapped = false;
    if (!match) {
      match = matches.find(
        (m) => (m.home === home && m.away === away) || (m.home === away && m.away === home)
      );
      if (match && match.home === away) swapped = true;
    }
    if (!match) { unmatched.push(`${home} vs ${away}`); continue; }

    const status = mapStatus(ev.status);
    const ft = ev.score?.fullTime || {};
    const hs = ft.home, as = ft.away;
    const score = hs != null && as != null
      ? (swapped ? { home: as, away: hs } : { home: hs, away: as })
      : null;

    if (status === "pending" && !score) continue; // nada nuevo
    updates.push({ id: match.id, score, status, minute: ev.minute ? String(ev.minute) : null });
  }
  return { updates, unmatched };
}
