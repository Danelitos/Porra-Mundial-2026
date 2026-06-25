/**
 * engine.js — Motor de puntuación y estadísticas de la Porra Mundial 2026.
 *
 * Módulo ES compartido entre el navegador (app.js) y Node (scripts/import-excel.js).
 * Todas las funciones son puras: reciben datos y devuelven resultados,
 * nunca mutan las predicciones originales.
 */

/* ============================== Utilidades ============================== */

/** Normaliza un texto: minúsculas, sin tildes, solo alfanumérico. */
export function normName(s) {
  if (s == null) return "";
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Distancia de Levenshtein acotada (para tolerar erratas en los Excel). */
export function levenshtein(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** Signo 1·X·2 de un marcador. */
export function signOf(home, away) {
  if (home > away) return "1";
  if (home < away) return "2";
  return "X";
}

/* =========================== Contexto de datos =========================== */

/**
 * Construye el contexto a partir de los JSON crudos.
 * data = { rules, groupsData, matches, participants, tournament }
 */
export function buildContext(data) {
  const teamsById = {};
  const groupByTeam = {};
  for (const g of data.groupsData.groups) {
    for (const t of g.teams) {
      teamsById[t.id] = { ...t, group: g.id };
      groupByTeam[t.id] = g.id;
    }
  }
  return {
    rules: data.rules,
    groupsData: data.groupsData,
    matches: data.matches,
    participants: data.participants,
    tournament: data.tournament,
    teamsById,
    groupByTeam,
  };
}

/** Resuelve un nombre de equipo escrito a mano a su id canónico. */
export function resolveTeam(raw, groupsData) {
  const norm = normName(raw);
  if (!norm) return null;
  if (groupsData.aliases && groupsData.aliases[norm]) return groupsData.aliases[norm];
  const all = groupsData.groups.flatMap((g) => g.teams);
  // 1) coincidencia exacta normalizada
  for (const t of all) if (normName(t.name) === norm || normName(t.id) === norm) return t.id;
  // 2) contención (mín. 4 caracteres)
  if (norm.length >= 4) {
    for (const t of all) {
      const tn = normName(t.name);
      if (tn.includes(norm) || norm.includes(tn)) return t.id;
    }
  }
  // 3) distancia de edición ≤ 2 (erratas tipo "Re. Checa")
  let best = null, bestD = 3;
  for (const t of all) {
    const d = levenshtein(norm, normName(t.name), 2);
    if (d < bestD) { bestD = d; best = t.id; }
  }
  return best;
}

/* ====================== Puntuación de un partido ====================== */

/**
 * Puntos de un pronóstico sobre un partido finalizado.
 * pred = {home, away, sign} · score = {home, away}
 */
export function matchPoints(pred, score, rules) {
  const out = { sign: 0, exact: 0, total: 0, hitSign: false, hitExact: false };
  if (!pred || !score || score.home == null || score.away == null) return out;
  const g = rules.groupStage;
  const real = signOf(score.home, score.away);

  if (pred.home === score.home && pred.away === score.away) {
    out.exact = g.exact;
    out.hitExact = true;
    // El exacto implica el signo: si además su signo elegido coincide, suma el punto.
    if (g.exactAddsSign && pred.sign === real) {
      out.sign = g.sign;
      out.hitSign = true;
    }
  } else if (pred.sign != null && pred.sign === real) {
    out.sign = g.sign;
    out.hitSign = true;
  }
  out.total = out.sign + out.exact;
  return out;
}

/* ================= Clasificación oficial de cada grupo ================= */

/**
 * Tabla de un grupo calculada con los resultados reales (solo finalizados).
 * Devuelve filas {teamId, pj, pg, pe, pp, gf, gc, dg, pts} ordenadas.
 */
export function computeGroupTable(group, matches) {
  const rows = {};
  for (const t of group.teams) {
    rows[t.id] = { teamId: t.id, pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0, dg: 0, pts: 0 };
  }
  for (const m of matches) {
    if (m.group !== group.id || m.status !== "finished" || !m.score) continue;
    const h = rows[m.home], a = rows[m.away];
    if (!h || !a) continue;
    h.pj++; a.pj++;
    h.gf += m.score.home; h.gc += m.score.away;
    a.gf += m.score.away; a.gc += m.score.home;
    const s = signOf(m.score.home, m.score.away);
    if (s === "1") { h.pg++; a.pp++; h.pts += 3; }
    else if (s === "2") { a.pg++; h.pp++; a.pts += 3; }
    else { h.pe++; a.pe++; h.pts++; a.pts++; }
  }
  const list = Object.values(rows);
  for (const r of list) r.dg = r.gf - r.gc;
  // Criterios FIFA simplificados: puntos, diferencia de goles, goles a favor, nombre.
  list.sort((x, y) => y.pts - x.pts || y.dg - x.dg || y.gf - x.gf || x.teamId.localeCompare(y.teamId));
  return list;
}

/** ¿Han terminado los 6 partidos del grupo? */
export function isGroupComplete(groupId, matches) {
  const ms = matches.filter((m) => m.group === groupId);
  return ms.length > 0 && ms.every((m) => m.status === "finished");
}

/** ¿Ha terminado toda la fase de grupos? (matches.json solo tiene partidos de
 *  grupos, así que basta con que estén todos finalizados). Desbloquea la
 *  sección "Mi Quiniela" del cuadro eliminatorio. */
export function isGroupStageComplete(matches) {
  return matches.length > 0 && matches.every((m) => m.status === "finished");
}

/* ================= Puntuación completa de un participante ================= */

/**
 * Calcula el desglose completo de puntos y estadísticas de un participante.
 * options.upTo: ISO date — solo cuenta partidos finalizados hasta esa fecha
 * (se usa para la evolución histórica). options.skipBonuses omite pichichi/terceros.
 */
export function computeParticipant(p, ctx, options = {}) {
  const { rules, groupsData, tournament } = ctx;
  const upTo = options.upTo || null;
  const matches = ctx.matches.map((m) => {
    if (m.status === "finished" && upTo && m.date > upTo) {
      return { ...m, status: "pending", score: null };
    }
    return m;
  });

  const perMatch = [];
  let signPts = 0, exactPts = 0, signHits = 0, exactHits = 0;
  let winsHit = 0, drawsHit = 0, lossesHit = 0, playedWithPred = 0;

  for (const m of matches) {
    const pred = p.predictions.matches[m.id] || null;
    const finished = m.status === "finished" && m.score;
    const pts = finished ? matchPoints(pred, m.score, rules) : { sign: 0, exact: 0, total: 0, hitSign: false, hitExact: false };
    if (finished && pred) {
      playedWithPred++;
      signPts += pts.sign;
      exactPts += pts.exact;
      if (pts.hitExact) exactHits++;
      if (pts.hitSign || (pts.hitExact && pred.sign === signOf(m.score.home, m.score.away))) signHits++;
      const real = signOf(m.score.home, m.score.away);
      const hitDir = pts.hitExact || pts.hitSign;
      if (hitDir) {
        if (real === "X") drawsHit++;
        else if (real === "1") winsHit++;
        else lossesHit++;
      }
    }
    perMatch.push({ matchId: m.id, pred, score: finished ? m.score : null, status: m.status, pts });
  }

  // Clasificación de grupos: 1º y 2º se puntúan cuando el grupo está completo.
  let groupPickPts = 0, groupPickHits = 0;
  const groupResults = {};
  for (const g of groupsData.groups) {
    const complete = isGroupComplete(g.id, matches);
    const table = computeGroupTable(g, matches);
    const pick = p.predictions.groups[g.id] || {};
    const res = { complete, first: null, second: null, third: null, pts: 0 };
    if (complete) {
      if (pick.first && pick.first === table[0].teamId) { res.first = true; res.pts += rules.groupStage.groupWinner; groupPickHits++; }
      else if (pick.first) res.first = false;
      if (pick.second && pick.second === table[1].teamId) { res.second = true; res.pts += rules.groupStage.groupSecond; groupPickHits++; }
      else if (pick.second) res.second = false;
    }
    groupPickPts += res.pts;
    groupResults[g.id] = res;
  }

  // Terceros: 1 punto por acertar el 3º de cualquier grupo (cuando el grupo está completo).
  let thirdsPts = 0, thirdsHits = 0;
  if (!options.skipBonuses) {
    for (const g of groupsData.groups) {
      if (!isGroupComplete(g.id, matches)) continue;
      const pick = p.predictions.groups[g.id] || {};
      if (!pick.third) continue;
      const table = computeGroupTable(g, matches);
      if (table[2] && pick.third === table[2].teamId) {
        thirdsPts += rules.groupStage.thirdQualifies;
        thirdsHits++;
        if (groupResults[g.id]) {
          groupResults[g.id].third = true;
          groupResults[g.id].pts += rules.groupStage.thirdQualifies;
        }
      } else if (groupResults[g.id] && groupResults[g.id].third == null) {
        groupResults[g.id].third = false;
      }
    }
  }

  // Pichichi (bonus, se concede al final del torneo).
  let pichichiPts = 0, pichichiHit = false;
  if (!options.skipBonuses && tournament.pichichi && tournament.pichichi.real && p.pichichi) {
    const real = normName(tournament.pichichi.real);
    const aliases = (tournament.pichichi.aliases || []).map(normName);
    const mine = normName(p.pichichi);
    if (mine === real || aliases.includes(mine) || levenshtein(mine, real, 2) <= 2) {
      pichichiPts = rules.bonus.pichichi;
      pichichiHit = true;
    }
  }

  const total = signPts + exactPts + groupPickPts + thirdsPts + pichichiPts;
  return {
    id: p.id,
    name: p.name,
    demo: !!p.demo,
    breakdown: { signPts, exactPts, groupPickPts, thirdsPts, pichichiPts, total },
    stats: {
      playedWithPred, signHits, exactHits, winsHit, drawsHit, lossesHit,
      groupPickHits, thirdsHits, pichichiHit,
      accuracy: playedWithPred ? Math.round((signHits / playedWithPred) * 100) : 0,
      exactRate: playedWithPred ? Math.round((exactHits / playedWithPred) * 100) : 0,
    },
    groupResults,
    perMatch,
  };
}

/* ============================ Ranking general ============================ */

/** Comparador de desempate configurable desde scoring_rules.json. */
function tieCompare(a, b, tiebreakers) {
  for (const tb of tiebreakers) {
    let d = 0;
    if (tb === "points") d = b.breakdown.total - a.breakdown.total;
    else if (tb === "exactCount") d = b.stats.exactHits - a.stats.exactHits;
    else if (tb === "signCount") d = b.stats.signHits - a.stats.signHits;
    else if (tb === "groupPicks") d = b.stats.groupPickHits - a.stats.groupPickHits;
    else if (tb === "name") d = a.name.localeCompare(b.name, "es");
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Ranking ordenado con posiciones (empates comparten posición).
 * Devuelve array de resultados de computeParticipant + .position
 */
export function computeRanking(ctx, options = {}) {
  const results = ctx.participants.map((p) => computeParticipant(p, ctx, options));
  const tbs = ctx.rules.tiebreakers || ["points", "name"];
  results.sort((a, b) => tieCompare(a, b, tbs));
  let pos = 0, prevKey = null;
  results.forEach((r, i) => {
    const key = [r.breakdown.total, r.stats.exactHits, r.stats.signHits, r.stats.groupPickHits].join("|");
    if (key !== prevKey) { pos = i + 1; prevKey = key; }
    r.position = pos;
  });
  return results;
}

/* ======================= Evolución del ranking ======================= */

/**
 * Historial: un punto de control por cada día con partidos finalizados.
 * Devuelve [{date, label, standings: [{id, name, total, position}]}]
 */
export function computeEvolution(ctx) {
  const finished = ctx.matches
    .filter((m) => m.status === "finished")
    .map((m) => m.date)
    .sort();
  const days = [...new Set(finished.map((d) => d.slice(0, 10)))];
  const checkpoints = [];
  for (let i = 0; i < days.length; i++) {
    const upTo = days[i] + "T23:59:59+02:00";
    const last = i === days.length - 1;
    const ranking = computeRanking(ctx, { upTo, skipBonuses: !last });
    checkpoints.push({
      date: days[i],
      label: days[i].slice(8, 10) + "/" + days[i].slice(5, 7),
      standings: ranking.map((r) => ({ id: r.id, name: r.name, total: r.breakdown.total, position: r.position })),
    });
  }
  return checkpoints;
}

/* ==================== ¿Qué necesita cada participante? ==================== */

/**
 * Escenarios por participante: distancia al líder, partidos pendientes
 * con sus pronósticos y máximo de puntos aún alcanzable en fase de grupos.
 */
export function computeScenarios(ctx) {
  const ranking = computeRanking(ctx);
  const leader = ranking[0];
  const g = ctx.rules.groupStage;

  return ranking.map((r) => {
    const p = ctx.participants.find((x) => x.id === r.id);
    const pendingMatches = ctx.matches
      .filter((m) => m.status !== "finished")
      .map((m) => ({ match: m, pred: p.predictions.matches[m.id] || null }))
      .filter((x) => x.pred);

    // Máximo por partidos: exacto + signo en cada pendiente con pronóstico.
    let maxFromMatches = pendingMatches.length * (g.exact + g.sign);

    // Máximo por clasificación de grupos aún no cerrados.
    let maxFromGroups = 0;
    for (const grp of ctx.groupsData.groups) {
      if (!isGroupComplete(grp.id, ctx.matches)) {
        const pick = p.predictions.groups[grp.id] || {};
        if (pick.first) maxFromGroups += g.groupWinner;
        if (pick.second) maxFromGroups += g.groupSecond;
        if (pick.third) maxFromGroups += g.thirdQualifies;
      } else if (ctx.tournament.bestThirds && !ctx.tournament.bestThirds.length) {
        const pick = p.predictions.groups[grp.id] || {};
        const table = computeGroupTable(grp, ctx.matches);
        if (pick.third && table[2] && table[2].teamId === pick.third) maxFromGroups += g.thirdQualifies;
      }
    }

    const maxFromPichichi =
      p.pichichi && !(ctx.tournament.pichichi && ctx.tournament.pichichi.real) ? ctx.rules.bonus.pichichi : 0;

    const maxRemaining = maxFromMatches + maxFromGroups + maxFromPichichi;
    return {
      id: r.id,
      name: r.name,
      demo: r.demo,
      position: r.position,
      total: r.breakdown.total,
      gapToLeader: leader.breakdown.total - r.breakdown.total,
      pendingWithPred: pendingMatches.length,
      maxRemaining,
      maxReachable: r.breakdown.total + maxRemaining,
      canCatchLeader: r.breakdown.total + maxRemaining >= leader.breakdown.total,
      pendingMatches: pendingMatches.slice(0, 12),
    };
  });
}

/* ============================ Estadísticas globales ============================ */

export function computeGlobalStats(ctx) {
  const ranking = computeRanking(ctx);
  const finished = ctx.matches.filter((m) => m.status === "finished");
  const totalGoals = finished.reduce((s, m) => s + (m.score ? m.score.home + m.score.away : 0), 0);
  return {
    participants: ranking.length,
    matchesPlayed: finished.length,
    matchesTotal: ctx.matches.length,
    totalGoals,
    avgGoals: finished.length ? +(totalGoals / finished.length).toFixed(2) : 0,
    totalExactHits: ranking.reduce((s, r) => s + r.stats.exactHits, 0),
    totalSignHits: ranking.reduce((s, r) => s + r.stats.signHits, 0),
    leader: ranking[0] ? { id: ranking[0].id, name: ranking[0].name, total: ranking[0].breakdown.total } : null,
  };
}
