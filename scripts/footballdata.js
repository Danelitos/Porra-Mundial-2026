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

/** Descarga la tabla de máximos goleadores. Lanza si el token falta o falla.
 *  limit alto (100) para cubrir también a pichichis con pocos goles que no
 *  entran en el top corto (p. ej. Oyarzabal), y poder mostrar sus goles. */
export async function fetchWorldCupScorers(token, limit = 100) {
  if (!token) throw new Error("Falta FOOTBALL_DATA_TOKEN");
  const res = await fetch(`${API}/competitions/${COMPETITION}/scorers?limit=${limit}`, {
    headers: { "X-Auth-Token": token },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`football-data scorers ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.scorers || [];
}

/**
 * Normaliza la tabla de goleadores de football-data.org a nuestro formato.
 * Resuelve el equipo a nuestro id (para pintar la bandera); si no se puede,
 * deja teamId en null y conserva el nombre que devuelve la API.
 * Devuelve [{ name, teamId, teamName, goals, assists, penalties, playedMatches }].
 */
export function mapFDScorers(fdScorers, groupsData) {
  return fdScorers
    .filter((s) => s.player?.name)
    .map((s) => {
      const teamId =
        resolveTeam(s.team?.name, groupsData) || resolveTeam(s.team?.tla, groupsData) || null;
      return {
        name: s.player.name,
        teamId,
        teamName: s.team?.name || null,
        goals: s.goals ?? 0,
        assists: s.assists ?? 0,
        penalties: s.penalties ?? 0,
        playedMatches: s.playedMatches ?? 0,
      };
    });
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

/**
 * Convierte los partidos de football-data.org en resultados de la ELIMINATORIA,
 * casándolos con nuestro cuadro por la pareja de equipos. `actualTeams` es el
 * mapa { <idPartido>: { home, away } } con los equipos reales de cada cruce ya
 * conocidos (computeActualBracketTeams). Como cada ronda se resuelve a partir de
 * la anterior, el sync llama a esto varias veces recalculando `actualTeams`.
 *
 * Devuelve { updates: [{ id, home, away, score, winner, loser, status, minute }] }
 * con la orientación home/away de NUESTRO cuadro (no la de la API).
 */
export function mapFDKnockout(fdMatches, actualTeams, groupsData) {
  const byPair = {};
  for (const [id, t] of Object.entries(actualTeams)) {
    if (t.home && t.away) byPair[[t.home, t.away].sort().join("|")] = id;
  }
  const updates = [];
  for (const ev of fdMatches) {
    if (!ev.homeTeam?.name || !ev.awayTeam?.name) continue;
    const home = resolveTeam(ev.homeTeam.name, groupsData) || resolveTeam(ev.homeTeam.tla, groupsData);
    const away = resolveTeam(ev.awayTeam.name, groupsData) || resolveTeam(ev.awayTeam.tla, groupsData);
    if (!home || !away) continue;
    const id = byPair[[home, away].sort().join("|")];
    if (!id) continue; // no es un cruce del cuadro (todavía) resoluble, o es de grupos

    const ourHome = actualTeams[id].home, ourAway = actualTeams[id].away;
    const swapped = home !== ourHome;
    const status = mapStatus(ev.status);
    const ft = ev.score?.fullTime || {};
    const hs = ft.home, as = ft.away;
    const score = hs != null && as != null
      ? (swapped ? { home: as, away: hs } : { home: hs, away: as })
      : null;

    let winner = null;
    if (status === "finished") {
      const w = ev.score?.winner; // HOME_TEAM / AWAY_TEAM (incluye prórroga y penaltis)
      if (w === "HOME_TEAM") winner = home;
      else if (w === "AWAY_TEAM") winner = away;
      else if (score) winner = score.home > score.away ? ourHome : score.away > score.home ? ourAway : null;
    }
    const loser = winner ? (winner === ourHome ? ourAway : ourHome) : null;

    if (status === "pending" && !score) continue;
    updates.push({ id, home: ourHome, away: ourAway, score, winner, loser, status, minute: ev.minute ? String(ev.minute) : null });
  }
  return { updates };
}
