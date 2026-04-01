# CHANGELOG - BetSniper V3

Todos los cambios notables de este proyecto están documentados aquí.

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
Versión semántica conforme a [Semantic Versioning](https://semver.org/).

---

## [v3.4.24] -- 2026-04-01 -- Sprint: ARBITRAGE Semi-Auto (Fase 1) + Dual Sequential (Fase 2)

> Rama: `master`

### ✅ Added

#### Fase 1: ejecución semi-automática por pata en ARBITRAGE
- **`client/src/App.jsx`**:
  - Nuevo botón `Semi-auto` por leg cuando el provider de la pata es Altenar.
  - Conversión de legs de arbitraje (`1x2` y `Double Chance + opuesto`) a payload compatible con flujo Booky (`prepare`/`confirm`).
  - Las patas Arcadia/Pinnacle se mantienen como referencia en Fase 1 (sin envío automático individual).

#### Dry-run obligatorio antes de confirmación real en Booky
- **`client/src/App.jsx`**:
  - Antes de cualquier `confirm` real en Booky se ejecuta `POST /api/booky/real/dryrun/:id`.
  - Si el dry-run falla, se cancela ticket draft y se aborta la ejecución real.
  - Se muestra resumen operativo de dry-run (stake/odd/requestId) en el bloque de confirmación.

#### Fase 2: ejecución dual secuencial Arcadia -> Altenar
- **`client/src/App.jsx`**:
  - Nuevo botón `Ejecutar Dual` en tarjeta de arbitraje.
  - Plan dual automático con selección de pata Arcadia y pata Altenar por mayor stake por lado.
  - Secuencia transaccional UI:
    - Arcadia: `prepare -> dryrun -> real/confirm-fast`
    - Altenar: `prepare -> dryrun -> real/confirm-fast`
  - Lock por tarjeta para evitar doble disparo simultáneo.

### 🔄 Changed

#### Outcome final explícito en ejecución dual
- **`client/src/App.jsx`**:
  - `CONFIRMED`: ambas patas confirmadas.
  - `REJECTED`: falla Arcadia y no se ejecuta Altenar.
  - `HEDGE_REQUIRED`: Arcadia confirmada y Altenar `REJECTED` o `UNCERTAIN`.
  - Mensajería final con ticket ids y acción operativa sugerida cuando queda exposición.

### 🧪 Validated

- Build frontend exitoso (`vite build`) tras integración de Fase 1 + Fase 2.
- Sin errores estáticos reportados en `client/src/App.jsx` tras los cambios.

## [v3.4.23] -- 2026-04-01 -- Sprint A.1: DC+Opuesto Operativo + Hardening de Ingesta/Cache

> Rama: `master`

### ✅ Added

#### Preview de arbitraje expandido a combinaciones de 2 patas
- **`src/services/arbitrageService.js`**:
  - Nuevo bloque de combinaciones `Double Chance + opuesto 1x2`:
    - `1X + Away`
    - `X2 + Home`
    - `12 + Draw`
  - Nuevo stake splitter de 2 patas con ajuste de residuos en centavos.
  - Respuesta enriquecida con `markets` mixto y `generatedByType` en diagnósticos.

#### Diagnóstico de cobertura por tipo de oportunidad
- **`src/services/arbitrageService.js`**:
  - Nuevos contadores de descarte para DC (`skippedMissingOddsDcOpposite`).
  - Métricas separadas de generación para `surebet1x2` y `surebetDcOpposite`.

### 🔄 Changed

#### Persistencia robusta de Double Chance en Pinnacle prematch
- **`scripts/ingest-pinnacle.js`**:
  - Se deriva y persiste `odds.doubleChance` desde 1x2 (`home/draw/away`) durante la ingesta.
  - Fallback de preservación al snapshot previo para evitar pérdida de DC ante fuentes parciales.

#### Extracción Altenar compatible con shape real de mercados typeId=10
- **`scripts/ingest-altenar.js`**:
  - Se agrega soporte de flatten para `desktopOddIds`/`mobileOddIds` además de `oddIds`.
  - Se mapea DC por `typeId` de odd (`9=1X`, `10=12`, `11=X2`) y fallback por nombre.
  - Se persiste `odds.doubleChance` en `altenarUpcoming` y se conserva valor previo cuando un barrido no trae DC.

- **`src/services/altenarPrematchScheduler.js`**:
  - Mapeo DC reforzado con `typeId` (`9/10/11`) antes de la heurística por texto.

#### Cache-first prematch sin pérdida de DC
- **`src/services/prematchScannerService.js`**:
  - Al hidratar `upcomingMatches` desde `getAllPinnaclePrematchOdds`, ahora persiste explícitamente `doubleChance`.

#### Claridad documental del endpoint de arbitraje
- **`src/routes/opportunities.js`**:
  - Comentario de endpoint actualizado para reflejar mercado mixto `1x2 + DC/opuesto`.

### 🧪 Validated

- Verificación de fuente prematch Pinnacle:
  - `getAllPinnaclePrematchOdds()` devolvió eventos con `doubleChance` activo.
- Verificación post-fix en DB local:
  - `upcomingMatches`: 63
  - `pinnacleWithDC`: 59
  - `altenarUpcoming`: 81
  - `altenarWithDC`: 79
  - `linked`: 30
  - `linkedAltWithDc`: 30
- Smoke preview arbitrage:
  - Mercado mixto expuesto (`1x2`, `double_chance+opposite_1x2`).
  - `skippedMissingOddsDcOpposite=0` en snapshot validado.

## [v3.4.22] -- 2026-03-29 -- Sprint: Pinnacle History Recovery + PnL Real + Sync UX

> Rama: `master`

### ✅ Added

#### API Pinnacle para cuenta e historial remoto
- **`src/routes/pinnacle.js`**:
  - Nuevo endpoint `GET /api/pinnacle/account` con soporte de refresh e hidratacion opcional de historial.
  - Nuevo endpoint `GET /api/pinnacle/history` para sincronizacion manual/auditable de apuestas remotas.

#### Sincronizacion de historial Arcadia y reconciliacion local
- **`src/services/pinnacleSemiAutoService.js`**:
  - Nuevo flujo `syncRemotePinnacleHistory(...)` consumiendo `GET /0.1/bets` con contrato confirmado (`startDate`, `endDate`, `status`).
  - Reconciliacion por `providerBetId` hacia `portfolio.history/activeBets` con upsert/move consistente.
  - Soporte de cache TTL para historial remoto y respuesta con `reconcileStats`.

#### Captura y diagnostico operativo de endpoints Pinnacle
- **`scripts/capture-pinnacle-account.js`** (nuevo):
  - Captura XHR/fetch de Arcadia y account flows via Puppeteer para discovery/forensics.
- **`scripts/debug-pinnacle-history-endpoints.js`** (nuevo):
  - Probe automatizado de endpoints de historial/transacciones y shape de payload.
- **`package.json`**:
  - Nuevos comandos `capture:pinnacle:account` y `capture:pinnacle:account:headless`.

### 🔄 Changed

#### Provider metadata explicita en mirrors locales
- **`src/services/paperTradingService.js`**:
  - `placeAutoBet(...)` persiste `provider`, `placementProvider`, `integration`.
- **`src/services/bookySemiAutoService.js`**:
  - Se aplica metadata Booky en confirmaciones semi/real y parches post-aceptacion.
- **`src/services/pinnacleSemiAutoService.js`**:
  - Se aplica metadata Pinnacle en confirmaciones semi/real, mirror manual y reconciliacion remota.

#### UI: provider manual, sync explicito y Finalizados por origen
- **`client/src/App.jsx`**:
  - Selector runtime de proveedor manual (`BOOKY`/`PINNACLE`) en Auto Placement.
  - Boton/badge de provider para sync manual de historial Pinnacle (estado `SYNC...`, hover `SYNC PINNACLE`).
  - Filtro de Finalizados por proveedor (`ALL/BOOKY/PINNACLE/SIM`) y badge de origen por fila.

#### Cuenta Pinnacle con PnL real anclado a cashflow externo
- **`src/services/pinnacleSemiAutoService.js`**:
  - `getPinnacleAccountBalance(...)` ahora incluye `pnl` + `transactions`.
  - Base de capital inferida desde `GET /0.1/transactions` (depositos/retiros externos) con fallback por entorno.
  - Nuevos knobs:
    - `PINNACLE_PNL_WINDOW_DAYS`
    - `PINNACLE_PNL_BASE_CAPITAL`

### 🐛 Fixed

#### PnL incorrecto en header al usar proveedor manual Pinnacle
- **`client/src/App.jsx`**:
  - Se corrige mezcla de saldo Pinnacle con PnL de Booky.
  - El header ahora muestra PnL de Pinnacle cuando el provider activo es Pinnacle.

#### Desborde de control sync en tarjeta Auto Placement
- **`client/src/App.jsx`**:
  - Layout responsive (`flex-wrap` + stack en ancho estrecho) para evitar overflow del control de sync.

### 🧪 Validated

- Build frontend exitoso:
  - `npm --prefix client run build`.
- Smoke test servicio Pinnacle:
  - balance `0.82`, base capital `25`, PnL `-24.18` (caso real validado).
- Sin errores estaticos en archivos tocados (`App.jsx`, `pinnacleSemiAutoService.js`, `pinnacle.js`, `bookySemiAutoService.js`, `paperTradingService.js`).

## [v3.4.21] -- 2026-03-29 -- Sprint: Auto-Placement Provider Selector (Booky/Pinnacle)

> Rama: `master`

### ✅ Added

#### Selector de proveedor de auto-placement en runtime
- **`src/services/scannerService.js`**:
  - Nuevo provider activo para auto-placement (`booky` o `pinnacle`) con parser seguro y fallback.
  - Nuevos helpers exportados:
    - `getAutoPlacementProvider()`
    - `setAutoPlacementProvider(provider)`

#### API para consulta/cambio en caliente
- **`src/routes/opportunities.js`**:
  - `GET /api/opportunities/live/placement-provider`
  - `POST /api/opportunities/live/placement-provider`
  - Validación estricta de proveedor permitido y respuesta con `allowed`.

### 🔄 Changed

#### Ejecución auto-snipe provider-aware
- **`src/services/scannerService.js`**:
  - `maybeRunAutoSnipe` ahora enruta confirmación por proveedor activo.
  - Guardas de habilitación real se evalúan por proveedor (`BOOKY_REAL_PLACEMENT_ENABLED` vs `PINNACLE_REAL_PLACEMENT_ENABLED`).
  - Diagnóstico live incluye proveedor activo y lista de proveedores soportados.

### 🧪 Validated

- Sin errores estáticos en archivos modificados:
  - `src/services/scannerService.js`
  - `src/routes/opportunities.js`
- Smoke test en localhost:
  - GET provider devuelve `booky`/`pinnacle`.
  - POST provider permite switch en caliente.
  - POST inválido retorna `400`.

## [v3.4.20] -- 2026-03-29 -- Sprint: Auto-Placement Multi-Strategy (LIVE_VALUE habilitado) + Alias Wave

> Rama: `master`

### ✅ Added

#### Auto-placement configurable por tipos de oportunidad
- **`src/services/scannerService.js`**:
  - Se agrega parser de entorno para tipos permitidos (`AUTO_SNIPE_ALLOWED_TYPES`) con fallback seguro.
  - Default operativo ampliado para permitir auto-ejecución de:
    - `LIVE_SNIPE`
    - `LA_VOLTEADA`
    - `LIVE_VALUE`

#### Diagnóstico de tipos permitidos en runtime
- **`src/services/scannerService.js`**:
  - `getLiveDecisionDiagnostics()` ahora expone `scanner.autoPlacementAllowedTypes`.
  - Log de arranque del scanner incluye el set activo de tipos (`types=...`) para auditoría rápida.

### 🔄 Changed

#### Regla de elegibilidad del motor auto
- **`src/services/scannerService.js`**:
  - La validación ya no está hardcodeada solo a SNIPE/Volteada.
  - Ahora evalúa contra la lista configurable de tipos habilitados.

#### Razón de descarte más precisa
- **`src/services/scannerService.js`**:
  - `reason=not-snipe` se reemplaza por `reason=type-not-enabled` cuando el tipo de oportunidad no está en la lista permitida.

#### Catálogo de aliases dinámicos expandido
- **`src/utils/dynamicAliases.json`**:
  - Nueva ola de aliases para ligas/selecciones internacionales (incluyendo variantes idiomáticas y U21) para mejorar linking PIN vs ALT.
  - Ajustes de precedencia en aliases ambiguos (`gimnasia`, `nacional`) para reducir cruces erróneos.

### 🐛 Fixed

#### LIVE_VALUE detectadas pero no elegibles por restricción de tipo
- Se elimina bloqueo estructural del motor auto que impedía ejecutar `LIVE_VALUE` aun con EV/guardas válidas.

### 🧪 Validated

- Import y sintaxis del servicio actualizados correctamente:
  - `scannerService import ok`.
- Seguimiento en `data/live_opportunity_decisions.jsonl` confirmando registro multi-tipo (`LIVE_SNIPE` y `LIVE_VALUE`).
- Auditoría operativa reciente:
  - `LIVE_VALUE` deja de depender de exclusión por tipo; los bloqueos predominantes observados pasan a ser de guardas (`stake-guard`, `cooldown`, etc.).

## [v3.4.19] -- 2026-03-26 -- Sprint: Finalizados REAL Clarity + Score Consistency + Alias Expansion

> Rama: `master`

### ✅ Added

#### Hidratación de score en Finalizados REAL
- **`client/src/App.jsx`**:
  - Se agrega resolución robusta de marcador final con fallback por `eventId` y por `match` para filas hermanas del mismo partido.
  - Cuando una fila no trae score propio (`?-?`), reutiliza un score válido del mismo evento para evitar inconsistencias visuales.

#### Expansión de aliases dinámicos para matcher
- **`src/utils/dynamicAliases.json`**:
  - Se amplía significativamente el catálogo de aliases para mejorar matching internacional (ligas menores, variantes ortográficas y selecciones U21).
  - Se incluyen equivalencias nuevas para equipos/ligas con variantes frecuentes en feed ALT/PIN.

### 🔄 Changed

#### Etiqueta de fuente en Finalizados
- **`client/src/App.jsx`**:
  - La pastilla de fuente deja de marcar como `SIM` a filas reales locales.
  - Nuevo criterio visual:
    - `BOOKY` para historial remoto,
    - `REAL` para historial real local,
    - `SIM` solo para simulado real.

#### Ticket ID visible en historial real local
- **`client/src/App.jsx`**:
  - En pestaña Finalizados, el `Ticket <providerBetId>` ahora también se muestra para filas `isRealHistory` (no solo `isBookyHistory`).

### 🐛 Fixed

#### Falso `SIM` en apuestas reales finalizadas
- Se corrige confusión de estado donde apuestas reales locales aparecían como simuladas.

#### Inconsistencia de marcador en el mismo partido (`1-1` vs `?-?`)
- Se elimina discrepancia visual causada por fuentes heterogéneas entre historial local y remoto.

#### Ticket oculto en segunda entrada real
- Se corrige condición de render que ocultaba `providerBetId` en entradas reales locales dentro de Finalizados.

### 🧪 Validated

- Build de frontend exitoso tras cambios de UI:
  - `npm --prefix client run build`.
- Verificación manual sobre casos reportados:
  - Etiqueta `REAL` en filas reales locales,
  - score consistente en entradas del mismo evento,
  - ticket visible en ambas entradas reales cuando existe `providerBetId`.

## [v3.4.18] -- 2026-03-24 -- Sprint: Live Diagnostics Deep Dive + Requote UX + Monitor Score Integrity

> Rama: `master`

### ✅ Added

#### Diagnostico LIVE consultable por API
- **`src/services/scannerService.js`**:
  - Se agrega bitacora estructurada de decisiones live (`triggered`, `not-triggered`, `no-opportunities`) con motivos y metadatos (`ev`, `kellyStake`, `placementMode`, `ticketId`).
  - Se incluye persistencia opcional en `data/live_opportunity_decisions.jsonl`.
  - Nuevos knobs de entorno:
    - `LIVE_DIAG_MAX_ENTRIES`
    - `LIVE_DIAG_PERSIST_FILE`

- **`src/routes/opportunities.js`**:
  - Nuevo endpoint `GET /api/opportunities/live/diagnostics` para consultar:
    - estado del pipeline (`raw/dedup/stable/final`),
    - breakdown de razones,
    - eventos recientes.

#### Diagnostico pre-oportunidad en LIVE_SNIPE
- **`src/services/liveScannerService.js`**:
  - Se incorpora contador por ciclo para candidatos LIVE_SNIPE y motivos de descarte antes de `opportunities.push()`.
  - Nuevo getter `getLiveSnipeScanDiagnostics()` expuesto en el endpoint de diagnostics.
  - Razones auditables añadidas: `real_prob_invalid`, `require_pinnacle_live_failed`, `altenar_odd_invalid`, `ev_invalid`, `ev_non_positive`, `stake_below_1`, `details_missing`, `details_error`, `pushed`.

### 🔄 Changed

#### Requote provider code=4: clasificación y UX correctas
- **`src/services/bookySemiAutoService.js`**:
  - Se preserva `BOOKY_PLACEWIDGET_REQUOTE_REQUIRED` en capa de retry (no se degrada a rechazo genérico).
  - `providerCode=4` mantiene semántica de re-quote/selección cambiante.

- **`client/src/App.jsx`**:
  - Manejo explícito de `BOOKY_REAL_REQUOTE_REQUIRED` con mensaje accionable en UI.
  - Se agrega flujo de reintento inmediato guiado (confirmación del usuario) con límite de 1 intento para evitar bucles.
  - El reintento respeta modo de confirmación por estrategia:
    - `confirm-fast` para `LIVE_SNIPE`
    - `confirm` para el resto.

#### Integridad de marcador PIN vs ALT en monitor
- **`src/services/pinnacleService.js`** y **`src/services/liveValueScanner.js`**:
  - Parseo de score estricto para evitar coerción `null -> 0` y prevenir `0-0` falsos.
  - Normalización de score en payload de monitor para no serializar marcadores vacíos/ambiguos.

- **`client/src/components/MonitorDashboard.jsx`**:
  - Se elimina fallback visual engañoso a `0-0` cuando PIN no trae score real.
  - Se agrega etiqueta `DESYNC` cuando ambos marcadores existen y difieren.
  - Se agrega `sticky` temporal frontend y badge `STALE` para micro-cortes de feed.

### 🐛 Fixed

#### Caso de apuestas reales con HTTP 200 pero error funcional provider
- `providerStatus=200 + providerCode=4` ahora se informa como re-quote (no rechazo definitivo), con trazabilidad de `requestId` y sugerencia de repreparar.

#### Diagnostico ambiguo de "no oportunidades"
- Se corrige ceguera operacional donde solo se veía `finalCount=0` sin razones; ahora el endpoint expone causas pre-filtro de LIVE_SNIPE y razones de no-trigger.

#### Marcadores PIN en `?`/`0-0` espurios
- Se evita mostrar score inválido cuando falta tick puntual de Pinnacle, manteniendo último dato útil por ventana corta y señalizando `STALE`.

### 🧪 Validated

- Verificación en runtime de endpoint:
  - `GET /api/opportunities/live/diagnostics?limit=60` devolviendo `pipeline.at` activo + `liveSnipeDiagnostics.reasonCounts`.
- Confirmación de causas reales observadas en sesión:
  - `ev_non_positive` dominante,
  - `stake_below_1` secundario,
  - `pushed=0` en ciclos auditados.
- Sin errores estáticos en archivos modificados (`App.jsx`, `bookySemiAutoService.js`, `liveScannerService.js`, `scannerService.js`).

## [v3.4.17] -- 2026-03-22 -- Sprint: Finalizados REAL Full-History + Auto-Snipe Requote + SIM/REAL Reconciliation Hardening

> Rama: `master`

### ✅ Added

#### Finalizados REAL: hidratacion completa bajo demanda
- **`client/src/App.jsx`**:
  - Se agrega `BOOKY_HISTORY_LIMIT_FINISHED_REAL=0` para solicitar historial completo en pestaña Finalizados (modo REAL).
  - Primera carga de Finalizados REAL fuerza refresh remoto (`refresh=1`) una vez por sesion de UI para evitar quedarse con snapshot recortado.

#### Auto-snipe: confirmacion simulada y reintento por re-quote
- **`src/services/scannerService.js`**:
  - Se habilita ruta de confirmacion SIM (`confirmSemiAutoTicket`) cuando `BOOKY_REAL_PLACEMENT_ENABLED=false`.
  - Ante error de re-quote, se agrega un reintento automatico con nuevo ticket para reducir caidas a manual por volatilidad transitoria.
  - Logs finales incluyen `mode=REAL|SIM`, `status`, `portfolioBetId` y bandera de `retry` cuando aplica.

### 🔄 Changed

#### Frontend Finalizados: separacion estricta SIM vs REAL
- **`client/src/App.jsx`**:
  - `getFinishedDataForSelectedDate()` ahora bifurca por modo:
    - **SIM:** solo historial paper/local + heuristica `WAIT_RES` local.
    - **REAL:** portfolio real liquidado + remoto Booky liquidado, excluyendo abiertas y evitando duplicados por `providerBetId`.
  - En modo REAL se oculta control de vista de seleccion cuando el modo es simulado para evitar confusion de fuentes.
  - Se muestra hora de apuesta (`AP`) y hora de inicio (`INI`) en filas finalizadas para trazabilidad temporal.

#### Polling UI: correccion de cierre stale en intervalos
- **`client/src/App.jsx`**:
  - `fetchData()` ahora usa refs vivas (`activeTabRef`, `tokenHealthRef`) para evaluar tab/modo actual dentro de `setInterval`.
  - Se corrige escenario donde el polling seguia pidiendo `historyLimit` de tab antigua (ej. `ALL`) tras cambiar a `FINISHED`.

#### Snapshot account: filtro por fecha antes del recorte
- **`src/services/bookyAccountService.js`**:
  - `getBookyAccountSnapshot()` construye `history` desde historial completo del perfil filtrado por `BOOKY_FINISHED_FROM_DATE`/`BOOKY_CASHFLOW_FROM_DATE` y recorta despues.
  - Con `historyLimit<=0`, retorna historial completo filtrado por fecha sin truncamiento.

#### Historial remoto: deteccion de cache parcial y bypass en fetchAll
- **`src/services/bookyAccountService.js`**:
  - Se introduce metadato `limitBound` para distinguir snapshots potencialmente parciales.
  - Si una solicitud requiere `fetchAll`, se evita reutilizar cache parcial (memoria/DB) y se fuerza sincronizacion completa.

#### Endpoint account: soporte ampliado de historyLimit
- **`src/routes/booky.js`**:
  - `historyLimit=0` ahora significa "sin limite".
  - Se amplía tope superior de limite positivo hasta `5000` para diagnosticos/operacion.

#### Drift configurable por entorno para confirmacion Booky
- **`src/services/bookySemiAutoService.js`**:
  - `LIVE_MAX_ODD_DRIFT` y `PREMATCH_MAX_ODD_DRIFT` pasan a leerse desde `.env` (`BOOKY_LIVE_MAX_ODD_DRIFT`, `BOOKY_PREMATCH_MAX_ODD_DRIFT`) con fallback seguro.

#### .env example alineado a operación real/sim
- **`.env.example`**:
  - Se documentan variables de drift (`BOOKY_LIVE_MAX_ODD_DRIFT`, `BOOKY_PREMATCH_MAX_ODD_DRIFT`).
  - Se corrige receta SIM auto para placement simulado realista (`AUTO_SNIPE_DRY_RUN=false`).

#### Matching operativo
- **`src/utils/dynamicAliases.json`**:
  - Nuevos aliases:
    - `gimpo citizen -> gimpo`
    - `university of macau -> universidade de macau`

### 🐛 Fixed

#### Finalizados REAL recortaba histórico y ocultaba días 23-Feb a 08-Mar
- Se corrige truncamiento por ventana corta (`historyLimit=120`) en flujo de polling y cache parcial heredada.

#### Al cambiar de pestaña, polling continuaba con lógica de tab antigua
- Se corrige cierre stale de estado en `fetchData`, evitando decisiones de modo/tab desactualizadas.

#### Auto-snipe caía a manual por re-quote transitorio
- Se agrega reintento único y outcome final explicito para disminuir rechazos operativos por ruido de mercado.

### 🧪 Validated

- Verificacion local de API:
  - `GET /api/booky/account?historyLimit=0` devolviendo historial completo desde `BOOKY_CASHFLOW_FROM_DATE=2026-02-23`.
- Verificacion de rango en datos:
  - Presencia confirmada de filas entre `2026-02-23` y `2026-03-08` en historial de perfil `acity`.
- Diagnostico estatico:
  - Sin errores en archivos modificados (`App.jsx`, `booky.js`, `bookyAccountService.js`).

## [v3.4.16] -- 2026-03-21 -- Sprint: Pinnacle Intermittent Modal Login Recovery

> Rama: `master`

### 🔄 Changed

#### Gateway Pinnacle: auto-login robusto para flujo header + modal
- **`services/pinnacleGateway.js`**:
  - El autologin ahora prioriza campos visibles y selectores del modal (`#modal`) cuando aparece el formulario emergente.
  - Se incorpora llenado robusto de inputs (typed + fallback setter) para evitar concatenacion de credenciales en reintentos.
  - Se centraliza el submit del formulario con fallback por boton, `requestSubmit` y `Enter`.

### 🐛 Fixed

#### Login intermitente en Pinnacle que exigia Enter doble por modal tardio
- Se corrige escenario donde el primer submit abre modal y dejaba sesion sin completar.
- Se agrega segundo submit automatico de respaldo cuando se detecta modal post-submit.

## [v3.4.15] -- 2026-03-21 -- Sprint: Sim/Real Flow Separation + Remote Settlement Reconciliation + Pinnacle Auto-Login Hardening

> Rama: `master`

### ✅ Added

#### Reconciliacion remota de settlements hacia portfolio local
- **`src/services/bookyAccountService.js`**:
  - Se agrega reconciliacion por `providerBetId` para trasladar resultados confirmados por provider al portfolio local.
  - Nuevo parche de cierre remoto sobre historial local (`status`, `profit`, `return`, `closedAt`, `providerStatus`) para evitar tickets colgados como activos cuando ya figuran liquidados en Booky/ACity.
  - La reconciliacion se integra en el flujo de `getBookyHistory()` para ejecutarse junto al sync de cuenta/historial.

#### Señal explicita de modo real en token health
- **`src/services/bookySemiAutoService.js`**:
  - `getBookyTokenHealth()` ahora expone `realPlacementEnabled` para que frontend distinga, sin ambiguedad, entre confirmacion real y simulada.

### 🔄 Changed

#### Frontend: confirmacion manual separa flujo REAL vs SIMULADO
- **`client/src/App.jsx`**:
  - La confirmacion manual ya no fuerza endpoint real cuando `BOOKY_REAL_PLACEMENT_ENABLED=false`.
  - Se introduce routing condicional de confirmacion:
    - Real: `/api/booky/real/confirm` o `/api/booky/real/confirm-fast`.
    - Simulado: `/api/booky/confirm/:id`.
  - Mensajes de modal/alertas se ajustan al modo activo (REAL/SIM) para evitar confusion operativa.
  - Se mejora recuperacion/reintento de ticket preparado para respetar tambien el endpoint segun modo activo.

#### Frontend: cabecera de capital/PnL coherente con modo Kelly manual
- **`client/src/App.jsx`**:
  - Cuando `KELLY_BASE_MODE` esta en `PORTFOLIO` o `CONFIG`, el header usa base manual para `Capital` y `PnL (SIM NAV)`.
  - Se evita mezclar visualmente PnL real remoto con capital manual de simulacion.

#### Frontend: Finalizados prioriza historial simulado limpio
- **`client/src/App.jsx`**:
  - El armado de finalizados excluye filas remotas (`source=remote`, `isBookyHistory`, tickets con `selections[]`) para no contaminar la vista de simulado.
  - Se endurece el filtro en activos/finalizados para evitar doble conteo entre snapshots remotos y portfolio local.

#### Gateway Pinnacle: watchdog de sesion + anti-loop de autologin
- **`services/pinnacleGateway.js`**:
  - Se agrega deteccion de transicion tardia a estado logged-out via header y trigger controlado de relogin automatico.
  - Se refuerza anti-loop con lock `autoLoginInFlight` y seteo atomico de credenciales para evitar concatenacion repetida en inputs.
  - Se respeta cooldown configurable de submit para estabilizar retries (`PINNACLE_AUTO_LOGIN_SUBMIT_COOLDOWN_MS`).

#### Paper trading Totals: resolucion de linea mas robusta
- **`src/services/paperTradingService.js`**:
  - Se fortalece parseo de linea para Over/Under desde `pick`, `market` y `selection`.
  - Liquidaciones tempranas/finales usan resolucion de linea consistente para reducir falsos `PUSH/LOSS` por mismatch de linea.
  - Se evita degradar picks sin numero a claves artificiales (`over_0`/`under_0`).

#### Cobertura de aliases dinamicos ampliada
- **`src/utils/dynamicAliases.json`**:
  - Se incorporan aliases adicionales para corregir no-matchs reportados en operacion y mejorar vinculo Pinnacle vs Altenar en ligas/equipos con nomenclatura divergente.

### 🐛 Fixed

#### Confirmacion manual en modo simulado intentaba placement real
- Se corrige bug donde la UI seguia llamando `/api/booky/real/*` aun con real placement deshabilitado.

#### Historial local desalineado con settlement remoto
- Se corrigen casos donde Booky/ACity mostraba ticket liquidado pero `portfolio.history` permanecia abierto o con PnL desactualizado.

#### Auto-login Pinnacle inestable tras logout tardio
- Se corrige escenario de perdida de sesion detectada tarde que dejaba gateway sin relogin efectivo.

#### Auto-login con escritura repetida de usuario
- Se corrige comportamiento de concatenacion de username durante reintentos rapidos de login.

---

## [v3.4.14] -- 2026-03-18 -- Sprint: Booky UI Fallbacks (Start Time + League) for Active/Finished Bets

> Rama: `master`

### 🔄 Changed

#### Frontend: fallback robusto de hora de inicio por ticket
- **`client/src/App.jsx`**:
  - Para filas `EN JUEGO` y finalizadas, la hora de inicio ahora usa fallback por `providerBetId` (ticket) contra `bookyAccount.history`.
  - Si `op`/`activeBet` no trae `matchDate/eventDate`, la UI recupera `selections[0].eventDate` del historial remoto y evita `--:--`.

#### Frontend: fallback de liga en filas vivas/abiertas
- **`client/src/App.jsx`**:
  - La visualización de liga ahora prioriza `op.league` y cae a `betData.league` cuando el registro principal viene incompleto.
  - Se reduce aparición de `-` en tickets activos con metadatos parciales.

#### Backend: enriquecimiento remoto/local más completo
- **`src/services/bookyAccountService.js`**:
  - En merge de historial remoto + local se conservan y rellenan campos descriptivos faltantes (`match`, `league`, `eventId`, `market`, `selection`, `placedAt`) desde fuente local.
  - También se preserva `pinnacleInfo/pinnaclePrice` cuando el remoto viene sparse.
  - Corrección de derivación de `pick` en filas remotas usando `selectionTypeIdToPick(selectionTypeId, firstSelection)` para respetar línea en `Totals` y mejorar match por `eventId+pick`.

### ✅ Added

#### Ajustes de aliases dinámicos operativos
- **`src/utils/dynamicAliases.json`**:
  - Se incluyen aliases adicionales para mejorar cobertura de matching en eventos/ligas con naming divergente reportado en operación.

### 🐛 Fixed

#### Tickets activos con hora de inicio vacía pese a tener `eventDate` remoto
- Se corrige escenario donde la tarjeta mostraba `--:--` aunque el dato existía en `bookyAccount.history`.

#### Ligas vacías en tarjetas activas por payload remoto incompleto
- Se corrige la visualización `-` cuando la liga estaba disponible en snapshot local/histórico del mismo ticket.

---

## [v3.4.13] -- 2026-03-17 -- Sprint: ACity Feed Token Reliability + Monitor Polling Optimization

> Rama: `master`

### ✅ Added

#### Renovación automática de token feed en modo widget-only
- **`src/config/altenarPublicConfig.js`**:
  - La auto-renovación reactiva del token widget (ante `401/403`) ahora invoca el extractor con `--widget-only`.
  - Se mantiene ejecución desacoplada (`--no-wait-close`) con timeout configurable para evitar bloqueo del backend.

- **`scripts/extract-booky-auth-token.js`**:
  - Nuevo flag `--widget-only` para capturar y persistir **solo** `ALTENAR_WIDGET_AUTH_TOKEN`.
  - Nuevo log de modo de captura (`CaptureMode=widget-only|booky+jwt`) para diagnóstico operativo.

#### Selector de frecuencia de polling en Monitor (frontend)
- **`client/src/components/MonitorDashboard.jsx`**:
  - Nuevo control de intervalo en UI con presets `5s`, `10s`, `15s`.
  - Persistencia de preferencia de usuario vía `localStorage` (`monitorPollMs`).

### 🔄 Changed

#### Cierre temprano del navegador en renovación de feed
- **`scripts/extract-booky-auth-token.js`**:
  - Cuando está activo `--widget-only`, al capturar `ALTENAR_WIDGET_AUTH_TOKEN` se persiste inmediatamente y se cierra el navegador sin esperar JWT de Booky.
  - Resultado: menor permanencia de ventanas Puppeteer en ACity y menor ventana de exposición a `403` durante renovación.

#### Polling Monitor más eficiente y robusto
- **`client/src/components/MonitorDashboard.jsx`**:
  - Polling base ajustado a `10s` por defecto.
  - Se pausa polling cuando la pestaña no está visible (`document.visibilityState`) y se reanuda al volver al foco.
  - Se evita solapamiento de requests con lock `fetchInFlightRef`.

#### Cache corta para detalle de eventos en Monitor
- **`src/services/liveValueScanner.js`**:
  - Se incorpora cache en memoria para `GetEventDetails` del flujo Monitor (`MONITOR_EVENT_DETAILS_TTL_MS=5000`).
  - Se reutiliza respuesta reciente por `eventId` para reducir llamadas repetidas a Altenar entre ciclos consecutivos.

### 🐛 Fixed

#### Renovación de token feed que dejaba ventana Puppeteer abierta más tiempo del necesario
- Se corrige el flujo de renovación automática para que no dependa de capturar JWT de Booky cuando el objetivo es recuperar feed scanner.

#### Sobrecarga evitable en Monitor por polling en background y llamadas repetidas
- Se corrige consumo innecesario de red/backend al desactivar polling en background y reutilizar detalles recientes por evento.

---

## [v3.4.12] -- 2026-03-17 -- Sprint: Real Placement Resilience + Arcadia Live Poll Throttling

> Rama: `master`

### ✅ Added

#### Recuperación automática de ticket DRAFT en UI
- **`client/src/App.jsx`**:
  - Ante error `ticket no encontrado` durante confirmación real, el frontend intenta recuperar un ticket `DRAFT` vigente de la misma oportunidad (`eventId + market + selection`) y re-confirmarlo una sola vez.
  - Si la recuperación confirma correctamente, se evita falso negativo de UX y se refresca estado en caliente.

#### Diagnóstico extendido de token real Booky
- **`src/services/bookySemiAutoService.js`**:
  - `getBookyTokenHealth()` ahora expone `tokenIntegration`, `tokenUserName` e `integrationMismatch`.
  - Validación temprana de mismatch entre integración del JWT y `ALTENAR_INTEGRATION` activo.

#### Knobs de throttling live HTTP cuando WS está sano
- **`services/pinnacleLight.js`**:
  - Se introducen parámetros opcionales:
    - `PINNACLE_LIVE_HTTP_MAX_STALE_MS` (default interno `20000`)
    - `PINNACLE_LIVE_WS_FRESH_WINDOW_MS` (default interno `8000`)
  - Permiten reducir snapshots HTTP redundantes manteniendo refresh periódico de seguridad.

### 🔄 Changed

#### Real placement: manejo explícito de 401/403 provider
- **`src/services/bookySemiAutoService.js`**:
  - Si `placeWidget` retorna `401/403`, la respuesta pasa a `BOOKY_TOKEN_RENEWAL_REQUIRED` (428) con intento de renovación asistida y diagnóstico.
  - Se evita clasificar auth-fail como rechazo definitivo de mercado.

#### Preparación de apuesta real usa config pública Altenar
- **`src/services/bookySemiAutoService.js`**:
  - `GetEventDetails` migra a `getAltenarPublicRequestConfig(...)` para consistencia de auth widget.
  - Si `GetEventDetails` falla con `401/403`, retorna `BOOKY_WIDGET_TOKEN_RENEWAL_REQUIRED` con `eventId` y estado de auto-renew.

#### Arcadia Live: menor carga HTTP con WS estable
- **`services/pinnacleLight.js`**:
  - `fetchOdds()` salta polling cuando el websocket está abierto, con frames recientes, y snapshot HTTP aún fresco.
  - Se preserva snapshot HTTP periódico para garbage-collection y anti-zombies.

### 🐛 Fixed

#### Falsos errores de "ticket no encontrado" en confirmación real
- Se reduce el escenario de desincronización temporal entre `prepare` y `confirm` con reintento de recuperación controlado en frontend.

#### Falsos rechazos definitivos por auth en placement
- Auth failures (`401/403`) dejan de archivarse inmediatamente como `REAL_REJECTED` cuando la causa es renovación de token.

#### Cobertura de alias dinámicos
- **`src/utils/dynamicAliases.json`**:
  - Se amplía catálogo con aliases operativos adicionales para mejorar matching en ligas/juveniles y variantes reportadas.

---

## [v3.4.11] -- 2026-03-16 -- Sprint: Widget Token Auto-Renew Policy Documentation

> Rama: `master`

### ✅ Added

#### Documentación operativa de renovación automática del token widget
- **`README.md`**:
  - Se documenta la política exacta de auto-renovación del token widget Altenar:
    - trigger reactivo solo ante `401/403` (no por intervalo fijo),
    - cooldown anti-bucle por proceso (`ALTENAR_WIDGET_TOKEN_RENEW_COOLDOWN_MS`),
    - timeout de captura (`ALTENAR_WIDGET_TOKEN_RENEW_TIMEOUT_MS`),
    - secuencia operativa completa y recomendaciones de tuning por contexto (normal/alta carga/debug).

#### Fuente de verdad de arquitectura actualizada
- **`PROJECT_BLUEPRINT.md`**:
  - Se agrega sección explícita para política de resiliencia del scanner Altenar en autenticación widget:
    - renovación inmediata ante `401/403`,
    - supresión por cooldown para evitar tormenta de Puppeteer,
    - lineamientos de operación segura sin relanzamientos agresivos.

### 🔄 Changed

#### Trazabilidad de operación más clara
- Se alinea la documentación entre blueprint + readme para que la estrategia de renovación de token no se interprete como polling periódico, sino como recuperación por evento de error auth.

---

## [v3.4.10] -- 2026-03-15 -- Sprint: Token Sync to Google Sheets

> Rama: `master`

### ✅ Added

#### Sincronizacion automatica de token Altenar a Google Sheets
- **`scripts/extract-booky-auth-token.js`**:
  - Nuevo paso de sincronizacion opcional via webhook luego de persistir `ALTENAR_BOOKY_AUTH_TOKEN` en `.env`.
  - Payload enviado: `{ "token": "Bearer <jwt>" }`.
  - El flujo no se bloquea si el webhook falla; se deja diagnostico en logs.

#### Configuracion por entorno para webhook
- **`.env.example`**:
  - Se documenta `GSHEETS_TOKEN_WEBHOOK_URL` solo como ejemplo (placeholder).
- **`.env` (local)**:
  - Debe contener la URL real del Apps Script para actualizar hoja `TOKEN!A1`.

### 🔄 Changed

#### Politica de seguridad de credenciales y webhooks
- **`PROJECT_BLUEPRINT.md`**:
  - Se formaliza que la URL real del webhook no debe hardcodearse ni versionarse.

---

## [v3.4.9] -- 2026-03-15 -- Sprint: Arcadia/ACity Login Separation + Reliability Hardening

> Rama: `master`

### ✅ Added

#### Flujo de autologin ACity dedicado en scripts Booky
- **`scripts/extract-booky-auth-token.js`** y **`scripts/capture-altenar-betslip.js`**:
  - Soporte explicito para header ACity con trigger `button#login` / `#login`.
  - Soporte para campo usuario `input[name="user"]` en modal de login.
  - Submit robusto del formulario buscando boton `INICIAR SESION` / `INGRESAR`, con fallback a `requestSubmit()` y `Enter`.
  - Filtro para evitar click accidental en botones auxiliares como `MOSTRAR`.

#### Deteccion de sesion ya autenticada en ACity
- **`scripts/extract-booky-auth-token.js`** y **`scripts/capture-altenar-betslip.js`**:
  - Si el header ya muestra `MIS APUESTAS` + `DEPOSITAR`, el script omite login y continua flujo normal.

### 🔄 Changed

#### Arcadia/Pinnacle desacoplado de perfiles Booky
- **`services/pinnacleGateway.js`**:
  - Perfil Chrome por defecto ahora dedicado a Pinnacle: `data/pinnacle/chrome-profile`.
  - Se elimina dependencia por defecto de `BOOK_PROFILE` para `userDataDir` del gateway Arcadia.
  - Se mantiene override por entorno con `PINNACLE_CHROME_PROFILE_DIR`.

#### Autologin de Pinnacle endurecido con selectores reales de header
- **`services/pinnacleGateway.js`**:
  - Deteccion explicita de estado autenticado (`Account-Menu`, bankroll/deposito) para no forzar login innecesario.
  - Deteccion explicita de formulario no autenticado (`Forms-Element-username/password`, `header-login-loginButton`).
  - Soporte de selectores `input#username`, `input#password` y submit de header de Pinnacle.
  - Se conserva estrategia de no cortar intentos de login solo por `socketDetected`.

#### Configuracion operativa de perfiles
- **`.env.example`**:
  - Documentada variable `PINNACLE_CHROME_PROFILE_DIR` para separar persistencia Arcadia de Booky/Altenar.

#### Normalizacion de aliases
- **`src/utils/dynamicAliases.json`**:
  - Actualizacion de aliases dinamicos para reforzar matching en casos reales reportados durante operacion.

### 🐛 Fixed

#### Mezcla de contexto de sesion entre Arcadia y Booky
- Se corrige el escenario donde el gateway de Pinnacle podia heredar estado de login de ACity por compartir perfil de Chrome.

#### Flujos de relogin ACity incompletos
- Se corrige el caso donde ACity quedaba en modal con credenciales cargadas pero sin click final de `INICIAR SESION`.

---

## [v3.4.8] -- 2026-03-14 -- Sprint: Auto SNIPE Outcomes + Reentry Guards + Matcher High Confidence

> Rama: `master`

### ✅ Added

#### Trazabilidad completa del resultado de AUTO_SNIPE
- **`src/services/scannerService.js`**:
  - Nuevos logs de outcome final por intento: `CONFIRMED`, `REJECTED`, `UNCERTAIN`.
  - Registro explicito de motivo cuando una oportunidad `LIVE_SNIPE` queda en manual (`reason=...`).
  - Log de arranque del motor AUTO_SNIPE con parametros efectivos (`enabled`, `dryRun`, `bookyReal`, `minEV`, `minStake`, `hourlyCap`).

#### Politica de reentrada con guardas de mejora real de cuota
- **`src/services/scannerService.js`**:
  - Nueva guarda de mejora minima para segunda entrada por pick:
    - `AUTO_SNIPE_REENTRY_MIN_ODD_IMPROVEMENT_PCT`
    - `AUTO_SNIPE_REENTRY_MIN_ODD_POINTS`
  - Limite configurable de entradas por pick:
    - `AUTO_SNIPE_MAX_ENTRIES_PER_PICK`
  - Nuevos motivos operativos de rechazo en guardas: `reentry-cap`, `reentry-no-improvement(...)`.
- **`.env.example`**:
  - Se documentan las tres variables nuevas de reentrada para rollout seguro.

#### Matcher manual con motor High Confidence (frontend)
- **`client/src/components/ManualMatcher.jsx`**:
  - Nuevo scoring compuesto para sugerencias de enlace masivo:
    - similitud home/away,
    - riesgo de equipos cruzados,
    - proximidad horaria,
    - contexto de liga/pais,
    - margen frente al segundo candidato.
  - Nuevas acciones operativas: `SUGERIR`, `APLICAR`, `APLICAR TOP 20`.

### 🔄 Changed

#### Aliases dinamicos consumidos por el matcher de frontend
- **`src/routes/matcher.js`**:
  - `GET /api/matcher/data` ahora incluye `aliases` para alinear la normalizacion con backend.
- **`src/utils/dynamicAliases.json`**:
  - Expansion de aliases para casos reales de no-match en ligas y equipos con variantes (`II/B`, abreviaturas, transliteraciones y sufijos).

#### Diagnostico de rechazo provider preservado en real placement
- **`src/services/bookySemiAutoService.js`**:
  - Se conserva el detalle original de `providerBody/providerStatus` cuando `placeWidget` rechaza o falla, evitando perder evidencia en auditoria.

### 🐛 Fixed

#### Rechazos ambiguos de AUTO_SNIPE y reentradas sin mejora de precio
- Se corrige el escenario donde el sistema podia reintentar entradas sobre el mismo pick sin exigir mejora material de cuota.
- Se corrige la perdida de diagnostico provider en rechazos reales, mejorando el analisis post-mortem (`BOOKY_PLACEWIDGET_REJECTED`).

---

## [v3.4.7] — 2026-03-14 — Sprint: Auto SNIPE Controlled Rollout

> Rama: `master`

### ✅ Added

#### Motor de auto-colocación exclusivo para LIVE_SNIPE
- **`src/services/scannerService.js`**:
  - Nuevo flujo opcional de ejecución automática para oportunidades `LIVE_SNIPE` / `LA_VOLTEADA`.
  - Integración directa con Booky real placement usando `prepareSemiAutoTicket()` + `confirmRealPlacementFast()`.
  - Estado interno anti-duplicado con lock in-flight por `eventId+pick`.

#### Flags operativas para rollout gradual
- **`.env.example`**:
  - `AUTO_SNIPE_ENABLED`
  - `AUTO_SNIPE_DRY_RUN`
  - `AUTO_SNIPE_MIN_EV_PERCENT`
  - `AUTO_SNIPE_MIN_STAKE_SOL`
  - `AUTO_SNIPE_MAX_BETS_PER_HOUR`
  - `AUTO_SNIPE_COOLDOWN_PER_PICK_MS`
  - `AUTO_SNIPE_REQUIRE_REAL_PLACEMENT_ENABLED`

### 🔄 Changed

#### Guardas de riesgo para auto SNIPE
- **`src/services/scannerService.js`**:
  - Cooldown por selección para evitar re-disparo en ventanas cortas.
  - Cap horario de ejecuciones para limitar exposición en sesiones volátiles.
  - Filtros previos de EV mínimo y stake mínimo antes de cualquier intento real.
  - Compatibilidad de operación `dry-run` para validar decisiones sin enviar apuestas reales.

---

## [v3.4.6] — 2026-03-13 — Sprint: Live UX Origin Labels + Snipe Data Guards

> Rama: `master`

### 🔄 Changed

#### UX de apuestas PREMATCH cuando el partido ya está en juego
- **`client/src/App.jsx`**:
  - Las apuestas de origen PREMATCH que pasan a pestaña LIVE conservan badge `PRE-MATCH` como metadata de origen.
  - Se habilita render de badges también para filas `ACTIVE` (no solo cuando hay reloj live numérico).
  - Si el feed trae `liveTime="Live"` sin minuto, la UI muestra contador estimado por tiempo transcurrido desde `matchDate`.

### 🐛 Fixed

#### Oportunidades LIVE_SNIPE inválidas por cuotas Pinnacle en cero
- **`src/services/liveScannerService.js`**:
  - Endurecida validación de moneyline live (`home/away > 1`) antes de calcular probabilidad real.
  - Se descartan snipes con `realProb` o `ev` no finitos (casos `Infinity`/`null`).
  - Sanitización de `pinnaclePrice` y `prematchContext` para no propagar cuotas `0` a UI.

---

## [v3.4.5] — 2026-03-13 — Sprint: Live Totals Refresh Integrity

> Rama: `master`

### 🔄 Changed

#### Consistencia de pick en Totals (sin fallback a linea 0)
- **`src/services/bookySemiAutoService.js`**, **`src/services/scannerService.js`**, **`src/routes/opportunities.js`** y **`client/src/App.jsx`**:
  - `normalizePick()` deja de generar `over_0` / `under_0` cuando no puede parsear línea.
  - Nuevo comportamiento: usa `over` / `under` como fallback semántico para evitar contaminación de IDs/keys/UI con `Total 0`.

### 🐛 Fixed

#### Falso negativo de EV al confirmar apuesta real en Totals
- **`src/services/oddsService.js`**:
  - En `refreshOpportunity()`, el matching de cuotas de Totals ahora exige coincidencia de línea siempre que exista una línea válida (venga del market o de la selección).
  - Se evita capturar por error otra línea del mismo evento (ej. tomar 5.5 cuando la oportunidad era 6.5), que podía degradar EV positivo a negativo y abortar confirmaciones reales con `El valor desapareció tras refresh`.

---

## [v3.4.4] — 2026-03-13 — Sprint: Arcadia Auto-Recovery + Live Pipeline Visibility

> Rama: `master`

### ✅ Added

#### Control de arranque automatico del Gateway Pinnacle
- **`server.js`**:
  - Nuevo autostart opcional del proceso `services/pinnacleGateway.js` cuando `PINNACLE_GATEWAY_AUTOSTART=true`.
  - Nuevo watchdog de trigger stale (`data/pinnacle_stale.trigger`) con chequeo configurable.
  - Cooldown anti-bucle de relanzamiento via `PINNACLE_GATEWAY_AUTOSTART_MIN_INTERVAL_MS`.

#### Auto-login opcional en Puppeteer
- **`services/pinnacleGateway.js`**:
  - Auto-login best-effort con `PINNACLE_AUTO_LOGIN_ENABLED`, `PINNACLE_LOGIN_USERNAME`, `PINNACLE_LOGIN_PASSWORD`.
  - Reintentos de login sobre frames/selectores comunes y limpieza de timer en shutdown.

### 🔄 Changed

#### Arcadia stale handling mas fino y menos agresivo
- **`services/pinnacleGateway.js`**:
  - `PINNACLE_ARCADIA_MIN_SOCKETS` ahora permite operar con minimo 1 socket.
  - Nuevo control de gracia con `PINNACLE_STALE_RELOAD_ALLOW_DURING_GRACE`.
  - Intervalo de chequeo de trigger stale configurable (`PINNACLE_STALE_CHECK_INTERVAL_MS`).
- **`src/services/liveValueScanner.js`**:
  - Endurecimiento de guard de desync de reloj Pinnacle vs Altenar con umbral configurable (`PINNACLE_STALE_TIME_DIFF_MINUTES`).
  - Trigger stale hacia gateway con cooldown (`PINNACLE_STALE_TRIGGER_MIN_INTERVAL_MS`) y requisito de persistencia (>=2 hits).
  - Alineacion de reloj solo para drift pequeno (<=1 minuto) para evitar enmascarar congelamientos.

#### Observabilidad de pipeline LIVE
- **`src/services/scannerService.js`**:
  - Log de pipeline `raw/dedup/stable/final` para diagnosticar diferencias entre deteccion interna y payload final de API.
  - Fix de estabilidad cuando `QUOTE_STABILITY_MIN_HITS <= 1` para no exigir confirmacion extra.

#### UX de renovacion de token Booky mas resiliente
- **`client/src/App.jsx`**:
  - Retry corto de auto-renovacion cuando la llamada `/api/booky/token/renew` falla o no inicia proceso remoto.
  - El cooldown de intento silencioso ya no castiga con 45s completos en errores transitorios.

#### Configuracion operativa y utilidades
- **`package.json`**:
  - Nuevo script `npm run pinnacle:gateway`.
- **`.env.example`**:
  - Actualizacion de defaults Arcadia/Gateway (autostart, cooldowns, stale thresholds, auto-login opcional, sockets minimos).
- **`src/utils/dynamicAliases.json`**:
  - Nuevos aliases para mejorar matching en ligas con naming heterogeneo.

### 🐛 Fixed

#### Relanzamientos repetidos de Puppeteer/Pinnacle
- Se corrige el bucle de apertura frecuente del gateway ante triggers stale consecutivos, manteniendo refresco automatico pero rate-limited por cooldown.

---

## [v3.4.3] — 2026-03-07 — Sprint: Prematch Refresh + Booky Orphan Cleanup

> Rama: `master`

### ✅ Added

#### Saneo manual de apuestas activas huérfanas
- **`scripts/cleanup-booky-orphans.js`**:
  - Nuevo script CLI para reconciliar y limpiar `portfolio.activeBets` huérfanas bajo demanda.
  - Soporta flags `--profile`, `--refresh`, `--history-limit`, `--fetch-all`, `--json` y `--help`.
  - Reporta métricas operativas (`activeBefore/After`, `removedCount`, `patchedCount`, `removedIds`).
- **`package.json`**:
  - Nuevo comando `npm run cleanup:booky:orphans`.

#### Booky account reconciliation (hardening)
- **`src/services/bookyAccountService.js`**:
  - Nuevo export `cleanupBookyOrphanActiveBets()` para ejecutar saneo on-demand desde backend.
  - Reconciliación de `activeBets` ampliada con:
    - detección de apuestas sin `providerBetId` no presentes en Open Bets remotas,
    - archivado automático a `portfolio.history` como `CANCELLED_UNCONFIRMED`,
    - razón de liquidación (`orphan_active_*`) y timestamp de limpieza.
  - Nuevos knobs por entorno:
    - `BOOKY_ORPHAN_ACTIVE_GRACE_MS`
    - `BOOKY_ORPHAN_ACTIVE_HARD_MAX_MS`

### 🔄 Changed

#### Confirmación real Booky más estricta
- **`src/services/bookySemiAutoService.js`**:
  - `placeWidget` ahora exige `response.bets[]` para considerar aceptación real.
  - Si la respuesta viene con `error` o sin `bets`, se clasifica como `BOOKY_PLACEWIDGET_REJECTED` y no confirma espejo local.

#### Re-cálculo prematch en caliente antes de apostar
- **`src/services/oddsService.js`**:
  - `refreshOpportunity()` recalcula `realProb` para prematch consultando feed Pinnacle en caliente (con caché TTL).
  - Enriquecimiento del snapshot con `fairProbSource`, `pinnacleRefreshedAt`, `realPrice` y ajuste de EV/Kelly en tiempo real.

#### UX de confirmación y desbloqueo por estado incierto
- **`client/src/App.jsx`**:
  - Modal de confirmación muestra deltas instantáneos de cuota, EV, stake y probabilidad real.
  - En `BOOKY_REAL_CONFIRMATION_UNCERTAIN`, se fuerza refresh de Booky y se libera lock optimista local si no hay apuesta abierta real.

#### Configuración, aliases y documentación
- **`src/utils/dynamicAliases.json`**:
  - Nuevos aliases dinámicos para mejorar matching de nombres en ligas con naming heterogéneo.
- **`README.md`** y **`.env.example`**:
  - Documentación del script de saneo de huérfanas y de variables `BOOKY_ORPHAN_ACTIVE_*`.
  - Documentación de recálculo prematch en caliente (`PREMATCH_REFRESH_RECALCULATE_PINNACLE`, `PREMATCH_PINNACLE_CACHE_TTL_MS`).

### 🐛 Fixed

#### Apuestas fantasma bloqueando oportunidades LIVE
- Se corrige el escenario donde una confirmación incompleta (sin `providerBetId`) dejaba una apuesta en `portfolio.activeBets` sin existir en Open Bets remotas, bloqueando re-apuesta en frontend.

---

## [v3.4.2] — 2026-03-07 — Sprint: Throughput Hardening + Worker Isolation

> Rama: `master`

### ✅ Added

#### Observabilidad operativa
- **`scripts/health-latency.js`**:
  - Nuevo script para medir latencia por muestras sobre endpoints críticos (`/api/portfolio`, `/api/opportunities/live`, `/api/opportunities/prematch`, `/api/booky/account`, `/api/booky/kelly-diagnostics`).
  - Reporte por endpoint con `ok/total`, `timeouts`, promedio y `p95`.
  - Configurable por argumentos (`--base`, `--samples`, `--timeout`, `--interval`) y env vars (`HEALTH_*`).
- **`package.json`**:
  - Nuevo comando `npm run health:latency`.

#### Control granular de workers
- **`server.js`**:
  - Nuevas flags por worker:
    - `DISABLE_LIVE_SCANNER`
    - `DISABLE_PREMATCH_SCHEDULER`
    - `DISABLE_PINNACLE_INGEST_CRON`
  - Mantiene compatibilidad con `DISABLE_BACKGROUND_WORKERS` como master switch.

### 🔄 Changed

#### Frontend polling desacoplado y tolerante a fallos
- **`client/src/App.jsx`**:
  - Polling separado: ciclo core (`live + portfolio`) y ciclo prematch independiente.
  - `booky/account`, `token-health` y `kelly-diagnostics` desacoplados del fetch core para evitar bloquear la UI.
  - Reducción de payload remoto de Booky en polling (`historyLimit`) para acelerar balance/capital.
  - Mantenimiento de snapshots previos ante fallos parciales (sin tumbar el dashboard).

#### Prematch endpoint no bloqueante
- **`src/routes/opportunities.js`**:
  - Cache TTL configurable (`PREMATCH_CACHE_TTL_MS`) y deduplicación de requests concurrentes.
  - Estrategia `stale-while-revalidate`: devuelve snapshot rápido y refresca en background.
  - Fallback a cache stale cuando falla el refresh.

### 🐛 Fixed

#### Freeze intermitente de API en horas pico
- **`src/services/scannerService.js`**:
  - Se removió el escaneo prematch pesado del loop live para evitar bloquear el event loop.
  - Reemplazo por refresco liviano de IDs prematch desde DB (mantiene filtrado sin penalizar throughput).

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
