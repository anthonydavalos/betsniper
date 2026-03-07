# CHANGELOG - BetSniper V3

Todos los cambios notables de este proyecto están documentados aquí.

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
Versión semántica conforme a [Semantic Versioning](https://semver.org/).

---

## [v3.4.1] — 2026-03-06 — Sprint: Live PIN Integrity + Re-Entry Fidelity + UI Consistency

> Rama: `master`

### ✅ Added

#### Frontend — Persistencia y Fallback de referencia Pinnacle
- **`client/src/App.jsx`**:
  - Caché sticky en memoria para referencias Pinnacle por claves robustas (`ticket`, `opp`, `pin`) para evitar pérdida de contexto en ciclos de refresh.
  - Enriquecimiento de apuestas abiertas remotas (`getOpenBookyRemoteBets`) con fallback por `providerBetId` hacia `portfolio.activeBets/history`.
  - Soporte de `pinnacleInfo`, `pinnaclePrice`, `ev`, `realProb`, `pick` y `kellyStake` en filas remotas abiertas.

#### Frontend — UX de Re-Entry y trazabilidad visual
- **`client/src/App.jsx`**:
  - Re-Snipe en la misma fila activa con validaciones: mejora mínima de cuota, EV mínimo y stake mínimo.
  - Badge visual `RE-ENTRY CANDIDATE` para candidatas de reapuesta.
  - Nueva etiqueta contextual `ENTRY #x/y` para distinguir entradas múltiples del mismo `match+pick` (re-entries), ordenadas por hora de ticket.

### 🔄 Changed

#### Frontend — Confirmación optimista más robusta
- **`client/src/App.jsx`**:
  - TTL optimista extendido: base (`45s`) y modo snipe (`60s`).
  - Estado de flujo optimista (`optimisticInFlight`, `optimisticFlow`) para evitar falsos negativos durante confirmación real.
  - Expiración de optimistic rows condicionada a chequeo remoto fresco y misses consecutivos controlados.

#### Frontend — Alertas y rendering en LIVE más estables
- **`client/src/App.jsx`**:
  - Cooldown de alertas por oportunidad (`LIVE_ALERT_COOLDOWN_MS`) para reducir ruido por flapping.
  - Supresión de tendencias/flechas en filas activas ejecutadas; se conservan en `PENDING`.
  - Reconciliación de `effectivePinnacleInfo/effectivePinnaclePrice` con fallback multifuente (`betData`, snapshot pendiente, candidato live, sticky cache).

#### Frontend — Política de stake mínimo visual
- **`client/src/App.jsx`**:
  - Filtro duro de oportunidades con stake sugerido `< S/. 1` en ingestión de `liveOps/prematchOps` y defensa adicional en `getFilteredData`.

#### Booky History — Hidratación persistente de metadata
- **`src/services/bookyAccountService.js`**:
  - Enriquecimiento de historial remoto con metadata local de portfolio y profile history (`type`, `strategy`, `ev`, `realProb`, `kellyStake`, `pick`, `pinnacleInfo`, `pinnaclePrice`).
  - Fusión de metadatos por `providerBetId` y fallback por `eventId+pick` para conservar contexto cuando el remoto viene sparse.
  - `mapBookyHistoryItem` ahora preserva explícitamente `pinnacleInfo` y `pinnaclePrice`.

### 🐛 Fixed

#### LIVE PIN OFF — integridad de fuente
- **`client/src/App.jsx`** y **`src/services/bookyAccountService.js`**:
  - Separación estricta de uso de cuota PIN por origen:
    - `PREMATCH`: permitido fallback de referencia desde `prematchContext`.
    - `LIVE`: bloqueado fallback prematch para evitar mostrar cuota pre-match como si fuera live.
  - Sanitización para invalidar `pinnaclePrice` live cuando coincide 1:1 con `prematchPrice` en filas ejecutadas/históricas.
  - Excepción para oportunidades `PENDING`: se conserva la cuota scanner para no ocultar PIN válido durante detección en vivo.

#### Re-Entry colapsado en UI
- **`client/src/App.jsx`**:
  - Resolución de filas prioriza `providerBetId` (ticket) antes de `eventId+selection`.
  - Corrige el colapso de múltiples entradas en una sola hidratación visual (ticket/odd/stake/EV/hora incorrectos).

#### LIVE_SNIPE sin cuota PIN live real
- **`src/services/liveScannerService.js`**:
  - Endurecida regla de publicación: `LIVE_SNIPE` requiere cuota live real de Pinnacle (`isLivePinnacle`), evitando tickets nuevos con `pinnaclePrice=null`.
  - Corrección de alcance de `pinLiveOdds` para evitar inconsistencias al construir payload de oportunidad.

#### Matcher aliases operativos
- **`src/utils/dynamicAliases.json`**:
  - Ajustes y altas de aliases para mejorar matching en nombres divergentes de equipos/ligas.

---

## [v3.4.0] — 2026-03-05 — Sprint: Booky Robustness + EV Enrichment + Arcadia Hardening

> Rama: `master` | Base commit: `756476c`

### ✅ Added

#### Booky — PnL Base + Diagnósticos Kelly
- **`src/routes/booky.js`**:
  - Nuevos endpoints: `GET /api/booky/pnl-base`, `GET /api/booky/kelly-diagnostics`, `POST /api/booky/pnl-base/import-spy`, `POST /api/booky/pnl-base/sync`.
  - `GET /api/booky/account` amplía `historyLimit` (default 300, máximo 500).
- **`src/services/bookyAccountService.js`**:
  - Importación de base de PnL desde spy-cashflow (`importBookyPnlBaseFromSpy`).
  - Snapshot de base PnL (`getBookyPnlBaseSnapshot`).
  - Diagnóstico Kelly con riesgo de ruina bootstrap (`getBookyKellyDiagnostics`) y recomendación de fracciones por presión de simultaneidad.
  - Soporte de `BOOKY_FINISHED_FROM_DATE` (fallback a `BOOKY_CASHFLOW_FROM_DATE`) para filtrar historial finalizado y métricas de PnL.
- **Scripts nuevos**:
  - **`scripts/spy-booky-cashflow.js`** — captura endpoints de caja/transacciones y estima base de capital sugerida.
  - **`scripts/sync-booky-pnl-base-from-spy.js`** — sincroniza base PnL desde el último spy.
- **`package.json`**:
  - Scripts agregados: `spy:booky:cashflow`, `spy:booky:cashflow:headless`, `sync:booky:pnl-base`, `sync:booky:pnl-base:acity`.

#### Frontend — Telemetría de Riesgo en Header
- **`client/src/App.jsx`**:
  - Panel Kelly en header con base, presión de exposición, riesgo de ruina por estrategia y timestamp de diagnóstico.
  - Fetch throttled de `kelly-diagnostics` (cada 60s) y de cuenta Booky con mayor profundidad de historial.

### 🔄 Changed

#### Booky — Enriquecimiento histórico y cálculo de base Kelly
- **`src/services/bookyAccountService.js`**:
  - Enriquecimiento de historial remoto por `providerBetId` y fallback `eventId+pick` para rescatar `type/strategy/ev/realProb/kellyStake`.
  - Mejor mapeo de picks para Totals/BTTS (`selectionTypeIdToPick` + parse de línea).
  - PnL neto ahora soporta enfoque anclado a balance real (`byBalance`) y conserva breakdown de exposición abierta.
  - `getKellyBankrollBase` soporta modo `NAV` con exposición abierta (además de fallback `booky-real → portfolio → config`).

#### Oportunidades y Scanners
- **`src/services/liveValueScanner.js`**:
  - Umbrales configurables para EV y stake (`LIVE_VALUE_MIN_EV`, `LIVE_VALUE_NON_1X2_STAKE_FACTOR`, `LIVE_VALUE_MIN_DISPLAY_STAKE`).
  - Parsing de Double Chance más robusto, incluyendo selección `12`.
- **`src/services/prematchScannerService.js`** y **`src/services/altenarPrematchScheduler.js`**:
  - Activación/evaluación de Double Chance en prematch (`1X`, `12`, `X2`) con extracción desde detalles Altenar.
- **`src/services/liveScannerService.js`**:
  - Cooldown anti-spam para trigger de stale/restart del gateway (`PINNACLE_STALE_TRIGGER_MIN_INTERVAL_MS`).

#### Arcadia / Pinnacle — Estabilidad operativa
- **`services/pinnacleGateway.js`**:
  - Auto-close endurecido: mínimo de sockets Arcadia, ventana mínima de readiness, checklist de validación y filtrado estricto de tráfico Arcadia (evita falsos positivos de sockets no relevantes).
  - Grace period para ignorar trigger stale durante fase de login manual.
- **`services/pinnacleLight.js`**:
  - Lock de proceso con archivo (`pinnacle_light.lock`) para evitar instancias duplicadas.
  - Liberación de lock en `SIGINT/SIGTERM/exit`.

#### Matcher y aliases
- **`src/routes/matcher.js`**:
  - Reintentos internos de persistencia en `POST /link` para mitigar carrera con scanner/ingestor.
  - Verificación explícita de persistencia y respuesta `409` si no queda grabado tras reintentos.
- **`client/src/components/ManualMatcher.jsx`**:
  - Manejo de `409` como carrera transitoria (retry/control de mensaje al usuario).
- **`src/utils/dynamicAliases.json`**:
  - Nuevos aliases operativos para mejorar matching en ligas con naming heterogéneo.

### 🐛 Fixed

#### UI / Estado de apuestas
- **`client/src/App.jsx`**:
  - Corrección de clasificación LIVE vs PREMATCH usando señales confiables de reloj + inferencia temporal (`placedAt` vs `eventStart`).
  - Deduplicación por selección (`eventId + pick`) para evitar ocultar picks distintos del mismo partido.
  - Evita “stake fantasma”: expiración/limpieza de apuestas optimistas no confirmadas con TTL y chequeos remotos consecutivos.
  - Evita marcar apuesta como confirmada sin `providerBetId` o sin evidencia mínima de aceptación.
  - En FINISHED, EV se reconcilia con snapshots locales/históricos cuando el row remoto viene incompleto.

#### Persistencia de EV
- **`src/services/paperTradingService.js`**:
  - Persistencia de `ev` al crear nuevas apuestas en portfolio, habilitando trazabilidad histórica posterior.

#### Riesgo configurable
- **`src/utils/mathUtils.js`**:
  - Fracciones Kelly migradas a configuración por entorno (`KELLY_FRACTION_*`) con clamp seguro.

---

## [v3.3.0] — 2026-03-04 — Sprint: PnL Integrity + Live Render Fix + Pinnacle Auto-Close

> Rama: `master` | Base commit: `1f36a63`

### ✅ Fixed

#### Booky — Historial Completo y Precisión PnL
- **`src/services/bookyAccountService.js`**:
  - `buildHistoryPayload` — ventana de lookback ahora configurable via `BOOKY_HISTORY_LOOKBACK_DAYS` (default 3650 días, antes hardcodeado a 45). Permite recuperar el historial completo desde el inicio.
  - `requestRemoteBetHistory` — límite de páginas ahora configurable via `BOOKY_HISTORY_MAX_PAGES` (default 120, antes hardcodeado a 6); tamaño de página subido a 100; parámetro `fetchAll` para recuperación sin cap.
  - `getCachedRemoteHistory` — `limit=0` retorna todos los ítems sin slice (antes siempre limitaba).
  - `syncRemoteBookyHistory` — acepta flag `fetchAll`; caché en memoria y valor de retorno respetan `limit=0`.
  - `mapBookyHistoryItem` — usa `entry.realPlacement.providerStatus` (numérico) como `status` en lugar de `entry.status` (era textual del flujo local, e.g. `REAL_CONFIRMED_FAST`). Elimina contaminación de estado.
  - `computePnlBreakdown` — rows con `status` no-numérico se omiten con contador `rowsIgnored` en lugar de tratarse como apuestas abiertas (antes inflaban el open stake).
  - `replaceProfileHistory()` — nueva función que **reemplaza** (no acumula) el historial de perfil con array limpio y deduplicado. Previene acumulación de rows locales obsoletos.
  - `getBookyHistory` — llama `syncRemoteBookyHistory` con `fetchAll:true, limit:0`; usa `replaceProfileHistory` en lugar de `upsertProfileHistory`; filtra rows locales sin `providerBetId`.
  - Resultado: DB acity pasó de 188 rows (PnL inflado +201.85) a 113 rows alineados con Booky remoto (PnL real: ~48.34).

#### Frontend — PnL correcto y Oportunidades LIVE no bloqueadas
- **`client/src/App.jsx`**:
  - `pnlFromSnapshot` ahora lee `bookyAccount?.pnl?.netAfterOpenStake` (antes `pnl?.realized`). Cadena de fallback: `netAfterOpenStake` → `total` → `realized` → `0`.
  - Eliminado el recálculo de PnL a partir del historial visible (60 rows) que devolvía un valor incorrecto (-40.23 vs real ~48).
  - `isBookyOpenStatus = (value) => Number(value) === 0` — único criterio correcto para "apuesta abierta". Reemplaza `!BOOKY_SETTLED_STATUSES.has(Number(row?.status))` en los 4 puntos donde se filtraban rows abiertos. Corrige bug donde rows con `status=null/NaN` bloqueaban la renderización de oportunidades LIVE.
  - Añadidos helpers de tipado seguro: `resolveBookySelectionTypePick`, `getBookyOpenBetKey`, `getBookyOpenEventId`.
  - Añadido `hasLiveClockSignal` e `isLiveOriginOpportunity` para distinción precisa de oportunidades LIVE vs PREMATCH.
  - `fetchInFlightRef` — guard de in-flight para evitar peticiones concurrentes de `fetchData`.
  - `lastBookyAccountFetchAtRef` — throttle de fetch de cuenta Booky: máximo 1 petición cada 15s en ciclos normales (salvo `forceBookyRefresh`).
  - Historial visible capped a 60 rows en la URL (`historyLimit=60`).

#### Matcher — Link Manual Pegajoso (anti-race condition, anti-pruning)
- **`src/services/prematchScannerService.js`**:
  - `manualSticky` flag — si un match tiene `linkSource: 'manual'`, se preserva el link contra pruning temporal y contra fallo de verificación de par. Resuelve race condition al reiniciar scanner con link manual reciente.
  - Merge de `dbPinnacleMatches` + `pinnacleMatches` deduplicado por `id` antes del loop de enlace. Garantiza que matches con link manual en DB no se pierdan si no vienen en la respuesta actual del feed.
  - `findDirectPairFallback` — nueva función de fallback que busca par directo en ventana extendida (`MATCH_TIME_EXTENDED_TOLERANCE_MINUTES`) cuando el matcher principal falla.
  - Al limpiar link (pruning), se resetea también `linkSource = null` y `linkUpdatedAt`.
- **`scripts/ingest-pinnacle.js`**:
  - `db.read()` al inicio para leer estado fresco antes de escribir (`existingById` map).
  - Al reconstruir cada match se preservan `altenarId`, `altenarName`, `linkSource`, `linkUpdatedAt` del match existente en DB, para no perder enlaces al reiniciar el ingestor.
- **`src/routes/matcher.js`**:
  - `buildTupleKey(row)` — clave compuesta `(home, away, timestamp)` para aplicar link a **todos** los matches con el mismo par de equipos y fecha, no solo al que tiene ese `id`.
  - `POST /link` — aplica link a N matches (por id O tuple) e incluye verificación post-write con `db.read()`. Devuelve HTTP 409 si el dato no persistió (race condition visible al cliente).
  - `DELETE /link` — añade `linkSource: null` y `linkUpdatedAt` al desvincular.
  - Coerción flexible `m.id == pinnacleId` (loose equality) en unlink para evitar mismatch numérico vs string.

#### Odds Service — Parsing Robusto de Totales
- **`src/services/oddsService.js`**:
  - `extractFirstNumber` — extrae primer número válido de strings normalizados (reemplaza regex inline frágiles).
  - `parseTotalsHint(marketName, selectionName)` — detecta `side` (over/under) y `line` desde nombre de mercado o selección. Maneja casos ambiguos (línea como sufijo numérico de selección vs mercado). `lineFrom` para trazabilidad.
  - Detección de mercados Totales ampliada: acepta `typeId=18` **O** nombre contiene "total", sin necesidad de ambas condiciones.
  - Fallback en lectura de oddIds: `desktopOddIds.flat()` con fallback a `oddIds` cuando la propiedad es un array simple (variación de estructura de API).

### ✅ Added

#### Pinnacle — Auto-close Chrome al detectar socket válido
- **`services/pinnacleGateway.js`**:
  - Constante `IS_STANDALONE` para detectar si el script corre como proceso hijo o standalone.
  - Propiedades: `autoCloseEnabled` (env `PINNACLE_AUTO_CLOSE_ON_VALID_SOCKET`, default `true`), `autoCloseDelayMs` (env `PINNACLE_AUTO_CLOSE_DELAY_MS`, default 1800ms), más flags `autoCloseTriggered`, `socketDetected`, `sessionDetected`, `firstFrameReceived`.
  - Método `maybeAutoClose(reason)` — se activa cuando **socket Arcadia** (`api.arcadia.pinnacle.com/ws`) **Y** cabecera `X-Session` han sido detectados. Llama `shutdown()` y `process.exit(0)` tras el delay configurable.
  - Tres puntos de disparo: `webSocketCreated`, `x-session-captured` (captura de `X-Session`) y `first-websocket-frame`.
  - Log informativo: `"🤖 Auto-close activo: la ventana se cerrará al detectar sesión+socket válido."`.
- **`services/pinnacleLight.js`**:
  - Mensaje de instrucción actualizado: "al detectar socket válido se cerrará automáticamente" (ya no indica cerrar manualmente).

#### Scripts y Utilidades
- **`scripts/migrate-booky-legacy-integration.mjs`** — Migración de historial Booky legado: normaliza `integration` e `origin` para perfiles que usaban valores incorrectos. Modos `--apply` y `--aggressive --apply`.
- **`scripts/pnl_assign_audit.mjs`** — Auditoría de asignación PnL entre las 4 fuentes: Booky extended, Booky limited, DB acity y DB doradobet. Útil para validación de integridad post-sync.

#### npm Scripts Nuevos
```bash
migrate:booky:legacy-integration              → migrate-booky-legacy-integration.mjs --apply
migrate:booky:legacy-integration:aggressive   → migrate-booky-legacy-integration.mjs --aggressive --apply
```

#### Variables de Entorno Nuevas
```env
# Historial Booky
BOOKY_HISTORY_LOOKBACK_DAYS=3650
BOOKY_HISTORY_MAX_PAGES=120
BOOKY_HISTORY_PAGE_SIZE=100
BOOKY_HISTORY_MAX_REMOTE_ROWS=20000

# Pinnacle Auto-Close
PINNACLE_AUTO_CLOSE_ON_VALID_SOCKET=true
PINNACLE_AUTO_CLOSE_DELAY_MS=1800

# Matcher ventana extendida (ya existía, ahora también en prematchScanner)
MATCH_TIME_EXTENDED_TOLERANCE_MINUTES=30
```

---

## [Unreleased] — Sprint: Booky Real Placement + Matcher Diagnostics

> Rama: `feature/socket-spy` | Base commit: `a895644`

### ✅ Added

#### Módulo: Booky Semi-Auto + Real Placement
- **`src/routes/booky.js`** — Router Express dedicado bajo `/api/booky/*` con 11 endpoints cubriendo el ciclo completo: prepare, confirm, cancel, dryrun, real/confirm, real/confirm-fast, account, capture, token-health y token/renew.
- **`src/services/bookySemiAutoService.js`** — Servicio completo de ciclo de vida de tickets:
  - `prepareSemiAutoTicket` — Genera ticket draft desde una oportunidad.
  - `confirmSemiAutoTicket` / `cancelSemiAutoTicket` — Gestión de estado semi-auto.
  - `getRealPlacementDryRun` — Construye payload `placeWidget` sin enviar apuesta.
  - `confirmRealPlacement` / `confirmRealPlacementFast` — Colocación real con reintento controlado.
  - `enforceValueGuardsOrThrow` — Guardas de EV mínimo, drop de cuota y token válido.
  - `archiveUncertainRealPlacement` — Manejo de estado incierto (timeout/red).
  - `getBookyTokenHealth` / `ensureTokenFreshOrThrow` — Validación JWT con minutos restantes.
- **`src/services/bookyAccountService.js`** — Gestión de cuenta real por perfil:
  - `fetchBookyBalance` — Balance real vía API con cache configurable.
  - `syncRemoteBookyHistory` — Historial remoto reconciliado con historial local.
  - `getBookyAccountSnapshot` — Snapshot completo de cuenta (balance + historial + NAV).
  - `getKellyBankrollBase` — Base de bankroll Kelly con tres niveles de fallback: `booky-real` → `portfolio` → `config`.
  - `reconcileLocalTicketHistoryFromRemote` — Mapea resultado de ticket contra historial remoto.
  - `cleanupBookyHistoricalData` — Purga de historial según `BOOKY_HISTORY_RETENTION_DAYS`.
- **`src/db/database.js`** — Añadida estructura persistente `booky` con sub-keys `byProfile`, `tickets`, `captures`.

#### Módulo: Altenar Prematch Scheduler Adaptativo
- **`src/services/altenarPrematchScheduler.js`** — Scheduler de descubrimiento y refresco adaptativo:
  - Discovery configurable (intervalo base ajustable).
  - Refresco de detalle por prioridad temporal: eventos próximos en < 6h tienen mayor frecuencia.
  - Cola de prioridad con score compuesto basado en tiempo al inicio, EV conocido y enlace activo.
  - Concurrencia limitada (`p-limit`) con backoff exponencial por fallos de red.
  - Extracción completa de cuotas 1x2, Totales y BTTS desde `GetEventDetails`.
- Integración en `server.js` — `startAltenarPrematchAdaptiveScheduler()` iniciando al boot.

#### Módulo: Matcher Pinnacle ↔ Altenar — Diagnósticos y Hardening
- **`src/utils/teamMatcher.js`**:
  - Hot-reload de `src/utils/dynamicAliases.json` sin reiniciar el proceso (polling de mtime cada 30s).
  - `diagnoseNoMatch(teamName, startDate, candidates, league)` — Devuelve `probableReason`, `bestScore`, `inWindow5`, `inWindow20`, `aliasApplied`.
  - Razones de no-match codificadas: `time_window_5m`, `time_window_20m`, `time_window_exceeded`, `category_mismatch`, `similarity_below_threshold`, `no_candidates`.
  - Umbrales configurables vía `.env`: `MATCH_FUZZY_THRESHOLD`, `MATCH_MIN_ACCEPT_SCORE`, `MATCH_TIME_TOLERANCE_MINUTES`, `MATCH_TIME_EXTENDED_TOLERANCE_MINUTES`.
  - Validación al boot con clamp de rangos seguros (previene valores fuera de rango silenciosos).
- **`src/services/liveScannerService.js`**:
  - Fallback inverso (away-team first) cuando el match por equipo local no alcanza score mínimo.
  - Log por ciclo `MATCH_DIAG_SUMMARY` (distribución de razones de no-match) y `MATCH_DIAG_RECOMMENDATION` (recomendación automática de threshold a ajustar).
  - Umbral de aceptación por entorno: `MATCH_MIN_ACCEPT_SCORE`.

#### Scripts de Operación y Diagnóstico
- **`scripts/extract-booky-auth-token.js`** — Captura JWT real desde sesión Altenar autenticada via Puppeteer. Modos: `--wait-close` (requiere cerrar Chrome manualmente) y `--timeout` (headless). Escribe token a `.env` y valida payload JWT (usuario autenticado, no guest).
- **`scripts/set-book-profile.js`** — Cambia perfil operativo (`doradobet`/`acity`) actualizando vars en `.env` sin reinicio. Usado via `npm run book:dorado` / `npm run book:acity`.
- **`scripts/smoke-booky.js`** — Smoke test E2E del flujo booky: token-health → account → prepare → confirm-fast. Modo safe (default) y `--live` (ticket real con EV mínimo 0%).
- **`scripts/spy-altenar-profile.js`** — Auto-detección headless de parámetros de integración Altenar (integration, countryCode, baseUrl) capturando tráfico de red.
- **`scripts/spy-booky-history.js`** — Captura y dump de historial de apuestas + balance desde endpoints reales. Escribe a `data/booky/spy-history-*.json` con request/response completo.
- **`scripts/tmp-run-booky-confirm.mjs`** — Script temporal de confirmación directa para testing en caliente.
- **`MATCH_DIAG_TEMPLATE.md`** — Plantilla de experimento A/B para ajuste sistemático de thresholds del matcher. Incluye baseline prefilled (`MATCH_TIME_TOLERANCE_MINUTES=5`, razón dominante: `time_window_5m`).

#### npm Scripts Nuevos
```
book:dorado       → set-book-profile.js doradobet
book:acity        → set-book-profile.js acity
token:booky:wait-close → extract-booky-auth-token.js --wait-close
token:booky:timeout    → extract-booky-auth-token.js --timeout 90000
capture:booky          → spy-altenar-profile.js (capture payloads)
spy:booky:history      → spy-booky-history.js
smoke:booky            → smoke-booky.js
smoke:booky:live       → smoke-booky.js --live
```

#### Variables de Entorno Nuevas
```env
# Perfil Booky
BOOK_PROFILE=doradobet
ALTENAR_INTEGRATION=doradobet
ALTENAR_ORIGIN=https://doradobet.com
ALTENAR_REFERER=https://doradobet.com/deportes-en-vivo

# Real Placement
ALTENAR_BOOKY_AUTH_TOKEN=Bearer <jwt>
BOOKY_REAL_PLACEMENT_ENABLED=false
BOOKY_KEEP_REAL_PLACEMENT_ON_TOKEN_REFRESH=false
BOOKY_AUTO_TOKEN_REFRESH_ENABLED=true
BOOKY_TOKEN_MIN_REMAINING_MINUTES=2
BOOKY_MIN_EV_PERCENT=2
BOOKY_MAX_ODD_DROP=0.20

# Matcher diagnostics
MATCH_DIAGNOSTIC_LOG=1
MATCH_FUZZY_THRESHOLD=0.77
MATCH_MIN_ACCEPT_SCORE=0.60
MATCH_TIME_TOLERANCE_MINUTES=5
MATCH_TIME_EXTENDED_TOLERANCE_MINUTES=30

# Housekeeping Booky
BOOKY_BALANCE_REFRESH_MS=45000
BOOKY_HISTORY_REFRESH_MS=60000
BOOKY_HISTORY_RETENTION_DAYS=30
BOOKY_PROFILE_HISTORY_MAX_ITEMS=500
```

### 🔄 Changed

- **`src/services/liveValueScanner.js`** — Estabilidad por ticks: oportunidades live requieren confirmación en N ciclos consecutivos antes de publicarse (filtro anti-spike).
- **`src/services/scannerService.js`** — Guardia de sincronización: cruza score Alt vs Pin antes de publicar oportunidad. Stake calculado desde base centralizada `getKellyBankrollBase()`.
- **`src/services/pinnacleService.js`** — Agrega `getAllPinnaclePrematchOdds()` con cache-first y fallback a API.
- **`services/pinnacleLight.js`** — Canal prematch separado guarda en `data/pinnacle_prematch.json`.
- **`src/services/prematchScannerService.js`** — Upsert a DB con retry anti-lock (`EPERM/EBUSY`). Filtro consistente para excluir mercados de corners/cards/bookings/8-games. Ventana temporal PE (noche extendida hasta 06:00 del día siguiente).
- **`src/services/prematchScannerService.js`** — Hardening de enlace prematch: ruptura de enlaces huérfanos, validación estricta de par home/away y persistencia robusta del `altenarId` sobre el registro canónico en `upcomingMatches`.
- **`src/utils/teamMatcher.js`** — Tolerancia temporal migrada de hardcoded (20 min) a env var `MATCH_TIME_TOLERANCE_MINUTES` (default 5 min). Categoría mismatch ahora reconoce tokens `II`, `III`, `IV`, `Sub-17`, `Sub-20`.
- **`src/utils/teamMatcher.js`** — Matching contextual reforzado por liga/país y normalización de categorías Women con variantes `fem.`, `femenino`, `femenina` para reducir `category_mismatch` falsos.
- **`.env.example`** — Totalmente actualizado con todas las variables nuevas documentadas.
- **`server.js`** — Boot integra `startAltenarPrematchAdaptiveScheduler()` y monta router `bookyRouter` en `/api/booky`.
- **`client/src/components/ManualMatcher.jsx`** — Señal visual `SWAPPED RISK` para candidatos con local/visita invertidos.

### 🐛 Fixed

- Normalización de mercado `1x2` en payloads de oportunidades live (nombre normalizado vs display name causaba fallos de match de mercado).
- Retry anti-lock de LowDB al escribir `pinnacle_prematch.json` en Windows (EPERM en escritura simultánea).
- Estabilidad del boot: umbrales del matcher con valor fuera de rango no generan error silencioso (ahora se loggea y hace clamp).
- Frontend `Finalizados` de Booky: ahora usa estado liquidado del proveedor (`1,2,4,8,18`) como criterio principal, evitando ocultar tickets cerrados que llegan sin `liveTime`/`score`.
- Botón de actualizar dashboard: forzado de sync remoto de Booky con `refresh=1` para reflejar liquidaciones inmediatamente en UI.
- Auto-link prematch: bloqueado en escenarios `swapped` (home/away invertidos) para evitar enlaces peligrosos en mercados 1x2.

---

## [3.2.1] — UX Hardening: Latencia, Locks y Aliases

> Commit: `23d7495` | Fecha: 2026-03-04

### 🐛 Fixed

#### `client/src/App.jsx` — Botón "Renovar Token"
- **Bug crítico:** El botón quedaba bloqueado permanentemente en estado `"Abriendo..."` tras lanzar Chrome. Causa: dos `return` dentro del bloque `try` de `handleTokenRenewGuide` hacían que el `finally` (que libera `setTokenRenewing(false)`) nunca se ejecutara.
- **Fix:** Eliminados los `return` prematuros; reemplazados por flags booleanos `launched` / `handledBusy`. El bloque `finally` ahora siempre corre, garantizando que `tokenRenewingRef.current = false` y `setTokenRenewing(false)` se ejecuten en cualquier escenario (éxito, busy, error, fallback de clipboard).
- **Polling post-renovación:** Tras lanzar Chrome exitosamente, arranca un loop asíncrono independiente (12 iteraciones × 1 500 ms = máx. 18 s) que consulta `/api/booky/token-health` cada 1,5 s. En cuanto el token queda sano, actualiza la UI y fuerza `fetchData({ forceBookyRefresh: true })` → el indicador verde aparece segundos después de cerrar Chrome, sin esperar el ciclo de polling normal.

#### `client/src/App.jsx` — Botón "Apostar" (`handlePlaceBet`)
- Timeout de `prepare` aumentado de 12 000 ms a **25 000 ms** para cubrir escenarios donde Altenar tarda en responder (eventos internacionales como Liga Croacia/Dinamo Zagreb).
- **Retry automático en timeout:** Si `prepare` falla por `ECONNABORTED` o mensaje `timeout`, espera 700 ms y reintenta una vez automáticamente, sin intervención del usuario.
- **Mensaje específico de timeout:** En el catch del endpoint `confirm`, si el error contiene `"timeout"`, muestra aviso claro: *"La preparación del ticket tardó más de lo esperado. La cuota puede seguir vigente: intenta nuevamente en 2-3 segundos."*

#### `client/src/components/ManualMatcher.jsx` — Locks de acción
- **Anti-doble-click en linkeado:** Estado `linking` (boolean) bloquea el botón `CONFIRM LINK` durante toda la operación. Botón deshabilitado + spinner `<RefreshCw animate-spin>` + texto `"LINKEANDO..."` como feedback visual.
- **Anti-doble-click en desvinculación:** Set `unlinkingIds` rastrea qué filas Pinnacle están procesando unlink. El ícono `<Unlink>` muestra `animate-pulse` y se deshabilita individualmente por fila mientras procesa.
- **Timeout explícito:** 15 000 ms en `handleLink`, 10 000 ms en `handleUnlink`.
- **Retry en timeout para link:** En `handleLink`, si el error es timeout (`ECONNABORTED`), espera 700 ms y reintenta una vez antes de lanzar error.
- **`finally` garantizado:** Ambos handlers limpian su estado de lock en el bloque `finally`, evitando locks permanentes ante errores inesperados.

### 📝 Updated

#### `src/utils/dynamicAliases.json` — +55 aliases nuevos
Añadidos aliases para equipos frecuentes en ligas de Europa, América Latina y Asia que generaban `similarity_below_threshold`:
- Clubes alemanes (Dynamo Makhachkala, Wehen Wiesbaden, Rot Weiss Erfurt, Hertha Zehlendorf, Meuselwitz, Erzgebirge Aue, SCR Altach, Köln, SSV Ulm, etc.)
- Clubes albaneses/balcánicos (Bylis Ballsh, Teuta Durrës, Dinamo Tirana, Macva Šabac, Dinamo Zagreb)
- Clubes portugueses sub-23 (Sporting CP, Benfica, Braga)
- Clubes italianos (US Livorno, Saronno, Baranzatese, Legnano, Cazzago Bornato, Castellana)
- Clubes centroamericanos/latinoamericanos (Municipal Pérez Zeledón, Sport Sebacó, Real Oruro, Deportes Recoleta, Operario Ferroviario, DAC 1904 Dunajská Streda, Universitatea Craiova, Fortaleza Ceif, América Mineiro)
- Países en español (Filipinas → Philippines, Republic of Korea → South Korea)
- Otros (OFI Crete, Fundació Esportiva Grama, Tirol, Universidad de Chile)

---

## [3.1.0] — Live-Trading V2 + Matcher Mejorado

> Commit base: `a895644`

### Added
- WebSocket Pinnacle (Arcadia) via Puppeteer — cuotas en tiempo real ("Live Truth").
- Matcher con Levenshtein + filtro de categoría (Women/U21/Res.) estricto.
- Protocolo Zombie + `GetEventResults` para liquidación de apuestas colgadas.
- Settlement Engine con buffer 2.2h para prematch y liquidación inmediata live ≥90'.
- Scanner Live ("La Volteada") con threshold favorito ajustado a 55%.
- Paper Trading completo con NAV-based staking y Kelly simultáneo amortiguado.
- Frontend React + Vite + TailwindCSS con 6 pestañas especializadas.
- Monitor comparador de cuotas Pinnacle vs Altenar en tiempo real.
- Pestaña Matcher para vinculación manual de eventos.
- Scanner adaptativo: polling ~2s a ~7s según actividad y errores.
- `GetLiveOverview` (migrado a `GetLivenow`) con soporte de mercados Totales/BTTS.

### Changed
- Umbral de favorito: 60% → 55% (captura más valor, e.g. caso Tigres/Pumas).
- Ventana temporal matcher: 180 min → ajustable en `.env`.

---

## [3.0.0] — Primera Versión Funcional

### Added
- Arquitectura monorepo: Backend Node.js ESM + Frontend React/Vite en `/client`.
- Ingesta Altenar (DoradoBet) con headers anti-bot y parser relacional normalizado.
- Ingesta Pinnacle REST (`/sports/29/leagues`, `/matchups/{id}/markets/related/straight`).
- Cálculo de EV y Kelly en `src/utils/mathUtils.js`.
- LowDB (`db.json`) como base de datos JSON local.
- Módulos base: `GetUpcoming`, `GetLivenow`, `GetEventDetails`, `GetEventResults`, `GetTopEvents`, `GetStreamingEvents`, `GetPopularBets`, `GetFavouritesChamps`.
- Dashboard React con pestañas Pre-Match, En Vivo, Activas, Historial.

---

> Mantenido por: BetSniper Architect
> Para reportar bugs: abrir issue en el repositorio.
