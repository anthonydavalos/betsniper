# CHANGELOG - BetSniper V3

Todos los cambios notables de este proyecto están documentados aquí.

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
Versión semántica conforme a [Semantic Versioning](https://semver.org/).

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
- **`src/utils/teamMatcher.js`** — Tolerancia temporal migrada de hardcoded (20 min) a env var `MATCH_TIME_TOLERANCE_MINUTES` (default 5 min). Categoría mismatch ahora reconoce tokens `II`, `III`, `IV`, `Sub-17`, `Sub-20`.
- **`.env.example`** — Totalmente actualizado con todas las variables nuevas documentadas.
- **`server.js`** — Boot integra `startAltenarPrematchAdaptiveScheduler()` y monta router `bookyRouter` en `/api/booky`.

### 🐛 Fixed

- Normalización de mercado `1x2` en payloads de oportunidades live (nombre normalizado vs display name causaba fallos de match de mercado).
- Retry anti-lock de LowDB al escribir `pinnacle_prematch.json` en Windows (EPERM en escritura simultánea).
- Estabilidad del boot: umbrales del matcher con valor fuera de rango no generan error silencioso (ahora se loggea y hace clamp).
- Frontend `Finalizados` de Booky: ahora usa estado liquidado del proveedor (`1,2,4,8,18`) como criterio principal, evitando ocultar tickets cerrados que llegan sin `liveTime`/`score`.
- Botón de actualizar dashboard: forzado de sync remoto de Booky con `refresh=1` para reflejar liquidaciones inmediatamente en UI.

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
