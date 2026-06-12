# ⚽ Porra Mundial 2026

Web privada para seguir nuestra porra del Mundial FIFA 2026 (USA · México · Canadá).
100 % estática: HTML + CSS + JavaScript ES6, sin backend, lista para **GitHub Pages**.

> 🏅 Ranking en vivo · 🔮 Pronósticos de cada participante · ⚽ Clasificación automática de grupos · 📈 Estadísticas y evolución · 📱 PWA instalable

---

## 🚀 Puesta en marcha

```bash
npm install          # solo la primera vez (dependencia: xlsx para los scripts)
npm run import       # procesa los Excel de /excels y genera los JSON de /data
npm run serve        # abre http://localhost:8080 (fetch no funciona con file://)
```

### Publicar en GitHub Pages

1. Sube el repositorio a GitHub.
2. **Settings → Pages → Source: Deploy from a branch → `main` / root**.
3. Listo: `https://<usuario>.github.io/Porra-Mundial-2026/`.

Cada vez que cambies datos (resultados, nuevos participantes), haz commit + push y la web se actualiza sola.

---

## 👤 Añadir participantes (sin tocar código)

1. Copia el Excel del participante (la plantilla común de la porra) en la carpeta **`/excels`**.
2. Ejecuta `npm run import`.
3. Commit + push.

El nombre se deduce del nombre del archivo. Para personalizarlo crea `excels/participants-config.json`:

```json
{
  "porra pablo moreno.xlsx": { "name": "Pablo Moreno", "id": "pablo" }
}
```

El importador tolera erratas en los nombres de equipos ("Re. Checa", "Sudafrica"…),
signos en mayúscula/minúscula y celdas vacías, y avisa si faltan pronósticos o pichichi.

**Participantes demo:** mientras no estén todos los Excel, puedes rellenar la porra con
datos de prueba claramente marcados con la etiqueta `DEMO`:

```bash
node scripts/import-excel.js --demo=5    # genera 5 participantes demo
node scripts/import-excel.js --no-demo   # los elimina
```

---

## 📡 Resultados en tiempo real

La web se sincroniza sola con **TheSportsDB** (API gratuita, sin clave): al abrirla
descarga los marcadores reales del Mundial y los fusiona en memoria, repitiendo cada
60 s si hay partidos en juego (5 min si no). El punto verde junto al logo indica que
la sincronización está activa.

Para **persistir** los resultados en el repositorio (recomendado, así la web funciona
aunque la API caiga y el historial queda versionado):

```bash
npm run sync     # escribe los resultados reales en data/matches.json
git add data && git commit -m "Resultados" && git push
```

Si la API fallara o diera un dato erróneo, el árbitro siempre puede corregirlo a mano
(ver siguiente sección); un resultado marcado como finalizado en `matches.json` nunca
es degradado por la API.

## 🧑‍⚖️ Introducir resultados a mano (el árbitro)

```bash
npm run result -- --list A              # ver ids de los partidos del grupo A
npm run result A1 2 1                   # México 2-1 Sudáfrica (finalizado)
npm run result A1 1 1 live              # marcador parcial, partido en juego
npm run result A1 -- --clear            # borrar un resultado
npm run result -- --thirds RSA CZE ...  # fijar los 8 mejores terceros (al cerrar grupos)
npm run result -- --pichichi "Kylian Mbappé"   # fijar el pichichi real (al acabar)
```

Al introducir un resultado se recalculan **automáticamente** ranking, puntos,
estadísticas, clasificación de grupos e historial — las predicciones originales nunca se tocan.
También puedes editar `data/matches.json` a mano: la web recalcula todo en el navegador al recargar.

---

## 🏆 Sistema de puntuación

Definido en `data/scoring_rules.json` (la página *Reglas* lo lee de ahí — nada está cableado en el código):

| Acierto | Puntos |
|---|---|
| Signo correcto (1·X·2) | 1 pt |
| Marcador exacto | 3 pts (+1 del signo si coincide) |
| 1º del grupo | 4 pts |
| 2º del grupo | 2 pts |
| 3º que entra entre los 8 mejores terceros | 1 pt |
| Pichichi | 5 pts |
| Fase eliminatoria (1/16 → campeón) | 2 · 3 · 4 · 5 · 6 · 8 · 15 pts |

Desempates (configurables): más exactos → más signos → más aciertos de grupos.

---

## 📁 Estructura

```
index.html            Shell de la aplicación (SPA con rutas #/)
styles.css            Diseño: modo oscuro, iconos Lucide, responsive
app.js                Vistas y router
js/engine.js          Motor de puntuación (compartido web + Node)
data/
  participants.json   Pronósticos de todos los participantes
  matches.json        Calendario oficial + resultados reales (lo edita el árbitro)
  groups.json         12 grupos, 48 selecciones, alias de nombres
  scoring_rules.json  Reglas de puntuación y desempates
  tournament.json     Estado del torneo: mejores terceros, pichichi real
  ranking.json        Instantánea generada (la web recalcula en vivo)
  statistics.json     Instantánea generada
js/live.js            Sincronización en vivo en el navegador
js/livesource.js      Mapeo API TheSportsDB → partidos (compartido)
scripts/
  import-excel.js     Importador de porras Excel  (npm run import)
  update-result.js    Resultados del árbitro      (npm run result)
  sync-results.js     Persistir resultados de la API (npm run sync)
excels/               Los .xlsx de los participantes
manifest.json         PWA instalable
service-worker.js     Offline: shell en caché, datos network-first
```

## 🔮 Fases futuras (octavos, final, MVP…)

La arquitectura ya lo soporta sin rehacer nada:

- Las **eliminatorias y el pichichi de cada Excel ya se importan** a `predictions.knockout`.
- Los puntos de eliminatorias están definidos en `scoring_rules.json → knockout`.
- `tournament.json` guarda el estado real (fase, mejores terceros, pichichi).
- Cuando llegue la fase, solo hay que añadir el cálculo de `knockout` en `js/engine.js`
  (función `computeParticipant`) y una vista más en `app.js`.

## 🎨 Identidad visual

`assets/logo.svg` es el **emblema oficial del Mundial 2026** (trofeo sobre el "26",
obtenido de Wikipedia). Es una marca de FIFA usada aquí solo con fines personales en
una porra privada. `assets/logo-alt.svg` conserva el logo alternativo propio.
