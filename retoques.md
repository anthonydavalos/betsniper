# Registro de Retoques y Correcciones

## [2026-04-08] Corrida controlada Fase 2 completada (evidencia auditable)

- **Ejecucion controlada realizada:** `npm run phase2:controlled`.
- **Resultado de validacion:** `success=true`, `runStatus=200`, `summaryStatus=200`.
- **Criterios de salida Fase 2 (cumplidos en corrida controlada):**
  - `fill total` -> `CONFIRMED`.
  - `fallo de segunda pata` -> `REJECTED`.
  - `timeout incierto` -> `UNCERTAIN`.
  - `100% outcome explicito` -> `closed=3/3`.
- **Evidencia generada en JSON:** `data/phase2-controlled-run-2026-04-08T23-49-33-637Z.json`.
- **Refuerzo tecnico aplicado para operar la corrida:**
  - Soporte de escenarios controlados en `POST /api/opportunities/arbitrage/live/simulation/run`.
  - Modo controlado con defaults (`useDefaultControlledScenarios=true`) y evidencia por pata conservando `request/response/diagnostic`.

## [2026-04-08] Fase 2 iniciada: Simulacion Operativa (Paper + Dry-Run dual)

- **Orquestador inicial implementado:** `src/services/liveArbitrageSimulationService.js`.
- **Pipeline operativo (2 patas):**
  - Selecciona candidatos `SUREBET_DC_OPPOSITE_LIVE` (solo operaciones de 2 patas).
  - Ejecuta dry-run por pata usando flujos semi-auto existentes:
    - Altenar/Booky: `prepareSemiAutoTicket` + `getRealPlacementDryRun`.
    - Pinnacle: `preparePinnacleSemiAutoTicket` + `getPinnacleRealPlacementDryRun`.
  - Limpia tickets temporales en ambos providers via cancelacion best-effort.
- **Maquina de estados (simulacion):** `OPEN -> PARTIAL -> HEDGED -> CLOSED`.
- **Outcome final obligatorio por operacion:** `CONFIRMED`, `REJECTED` o `UNCERTAIN`.
- **Evidencia por pata registrada:** request/response, endpoint, preview, payload y diagnostico (`providerStatus`, `providerBody`, `requestId`) cuando aplica.
- **API Fase 2 disponible:**
  - `POST /api/opportunities/arbitrage/live/simulation/run`
  - `GET /api/opportunities/arbitrage/live/simulation/history`
  - `GET /api/opportunities/arbitrage/live/simulation/summary`
- **Smoke API:** endpoints respondiendo `200` sobre backend reiniciado; en la muestra actual no hubo operaciones simuladas porque el preview live estaba en `count=0` en ese instante.

## [2026-04-08] Cierre operativo Fase 0 y Fase 1 (Arbitraje Live Preview)

### Fase 0 - Baseline y observabilidad minima (Estado: CERRADA)
- **Baseline ejecutado:** corrida extendida de diagnosticos/arbitrage en ventana de 120 minutos.
- **Resultado operacional:** endpoints estables sin timeouts recurrentes ni errores de runtime durante la corrida.
- **Top causas de descarte observadas:**
  - `unlinked` (dominante),
  - `staleAltenar`,
  - `noSurebetEdge`,
  - `sameProvider` (baja frecuencia).
- **Accion aplicada para cuello de botella dominante:** fallback contextual de linking (Altenar live -> upcoming) y fallback contextual para mapping a Pinnacle live cuando falla el id-match directo.

### Fase 1 - Motor de Arbitraje Live (Preview Only) (Estado: CERRADA)
- **Entregables implementados:**
  - servicio `src/services/liveArbitrageService.js`,
  - endpoint `GET /api/opportunities/arbitrage/live/preview`,
  - endpoint `GET /api/opportunities/arbitrage/live/diagnostics`,
  - endpoint operativo `POST /api/opportunities/arbitrage/live/diagnostics/inventory` para inventario de snapshots.
- **Cobertura MVP validada:**
  - mercados `1x2` y `double_chance + opposite_1x2`,
  - filtros de estado incierto/stale,
  - filtro de categorias sensibles,
  - normalizacion de orientacion,
  - stake split con redondeo y chequeo de profit neto positivo.
- **Contrato de salida validado:** `edgePercent`, `roiPercent`, `stakePlan` y `diagnostics` por descarte presentes en preview.
- **Hardening aplicado post-baseline:**
  - lectura resiliente del feed local de Pinnacle (retry corto + fallback a ultimo snapshot valido),
  - retry defensivo en lectura de DB para mitigar parseos parciales transitorios.
- **Validacion de estabilidad sostenida post-hardening:**
  - soak de 30 minutos: `29/29` ciclos OK, `0` failed cycles, `0` exceptions, `200/200` en preview/diagnostics.

### Decision de gate para siguiente fase
- **Decision:** habilitado el paso a **Fase 2 (Simulacion Operativa)** en modo paper/dry-run dual, manteniendo `preview-first` y `requireCrossProvider=true`.

## [2026-04-06] Plan Camino 2: Implementacion de Arbitraje Live Real (por fases y seguro)

### Objetivo
- Implementar un motor de arbitraje **live** separado del prematch, con rollout gradual, trazabilidad total y proteccion contra ejecucion parcial riesgosa.
- Mantener el enfoque de seguridad operacional: primero preview, luego simulacion, luego real en canary.

### Principios de seguridad (obligatorios)
1. **Separacion de motores:** no mezclar logica prematch con live; crear pipeline live dedicado.
2. **Preview-first:** no ejecutar placement real hasta tener estabilidad estadistica de preview.
3. **Outcome obligatorio por intento:** cada intento debe cerrar en `CONFIRMED`, `REJECTED` o `UNCERTAIN`.
4. **Sin reintento ciego:** ante estado incierto, reconciliar por cuenta/historial antes de cualquier reintento.
5. **Cross-provider real:** mantener `requireCrossProvider=true` para evitar pseudo-arbitraje del mismo proveedor.

### Fase 0 - Baseline y observabilidad minima
**Objetivo:** asegurar que el sistema actual puede medir correctamente por que no aparecen oportunidades live.

**Tareas:**
1. Crear baseline de 60-120 minutos con diagnosticos live y arbitrage (sin tocar ejecucion real).
2. Registrar top motivos de descarte: `sameProvider`, `unlinked`, `staleAltenar`, `missingOdds`, `noSurebetEdge`.
3. Definir umbrales operativos minimos para avanzar de fase.

**Criterio de salida:**
1. Reporte con frecuencias de descarte y acciones propuestas por causa.
2. Latencia de endpoints de diagnostico estable (sin timeouts recurrentes).

---

### Fase 1 - Motor de Arbitraje Live (Preview Only)
**Objetivo:** detectar oportunidades live sin ejecutar apuestas.

**Alcance tecnico:**
1. Nuevo servicio (sugerido): `src/services/liveArbitrageService.js`.
2. Nuevo endpoint (sugerido): `GET /api/opportunities/arbitrage/live/preview`.
3. Endpoint de diagnostico live arbitrage (sugerido): `GET /api/opportunities/arbitrage/live/diagnostics`.

**Reglas de deteccion inicial (MVP):**
1. Mercados iniciales: `1x2` y `double_chance + opposite_1x2` (siempre que ambos lados esten disponibles en vivo).
2. Filtro temporal: excluir eventos con estado incierto y odds stale.
3. Filtro de calidad: bloquear categorias sensibles sin contexto estricto (Women/U21/Reserve/II/III).
4. Normalizacion estricta de orientacion (`normal/swapped`) antes de calcular edge.
5. Calculo financiero: stake split con redondeo y validacion de profit neto > 0 tras redondeo.

**Criterio de salida:**
1. Preview devuelve oportunidades live con `edgePercent`, `roiPercent`, `stakePlan` y `diagnostics` por descarte.
2. 0 errores de runtime en scanner durante corrida de prueba >= 2 horas.

---

### Fase 2 - Simulacion Operativa (Paper + Dry-Run dual)
**Objetivo:** ensayar ejecucion dual sin riesgo de capital real.

**Tareas:**
1. Implementar orquestador de 2 patas en modo simulacion con estados de operacion:
  - `OPEN` -> `PARTIAL` -> `HEDGED` -> `CLOSED`.
2. Integrar dry-run de placement para pata Booky antes de cualquier confirmacion.
3. Registrar evidencia por pata: request/response/status/requestId/providerBody.
4. Implementar politica de hedge cuando la segunda pata falla o cambia cuota fuera de tolerancia.

**Guardas obligatorias:**
1. Min EV y min stake por operacion.
2. Cooldown por `eventId+pick` y limite por hora.
3. Reentry solo si mejora minima de cuota (% o puntos).

**Criterio de salida:**
1. Simulacion de extremo a extremo con cierre correcto en escenarios:
  - fill total,
  - fallo de segunda pata,
  - timeout incierto.
2. 100% de operaciones con outcome final explicito.

---

### Fase 3 - Canary Real Controlado (baja exposicion)
**Objetivo:** habilitar ejecucion real en ventana corta y bajo limites conservadores.

**Configuracion recomendada inicial:**
1. Ventana: 30-60 minutos por sesion.
2. Kelly fraccion reducida (perfil LIVE_SNIPE, conservador).
3. Limite de operaciones/hora bajo.
4. Solo ligas de alta liquidez y bajo ruido.

**Operacion segura:**
1. `BOOKY_REAL_PLACEMENT_ENABLED=true` solo en ventana canary.
2. Mantener `AUTO_SNIPE_DRY_RUN=false` solo si Fase 2 ya aprobo.
3. Ante `UNCERTAIN`, reconciliar por `GET /api/booky/account?refresh=1` antes de reintentar.

**Criterio de salida:**
1. Tasa de `UNCERTAIN` bajo umbral definido.
2. Sin incidentes de duplicado ni reintento ciego.
3. PnL/ROI dentro de banda esperada sin desviaciones anormales de slippage.

---

### Fase 4 - Escalado gradual + hardening
**Objetivo:** ampliar cobertura sin perder control de riesgo.

**Tareas:**
1. Expandir mercados live (totales/BTTS) por etapas.
2. Mejorar matcher contextual en no-match dominantes (sin bajar umbrales globales a ciegas).
3. Dashboard operativo de arbitraje live:
  - abiertas/parciales/cerradas,
  - slippage,
  - latencia por proveedor,
  - razones de rechazo.
4. Alertas de degradacion y rollback automatico por thresholds.

**Criterio de salida:**
1. Estabilidad sostenida multi-sesion.
2. Trazabilidad completa de operaciones y auditoria reproducible.

---

### Checklist de validacion por fase (paso a paso)
1. Verificar diagnosticos live/arbitrage antes de cada fase.
2. Ejecutar smoke tests de endpoints nuevos y validar JSON de salida.
3. Ejecutar corrida controlada y guardar muestra de operaciones.
4. Revisar metricas de rechazo/incertidumbre/slippage.
5. Aprobar o rollback segun criterios de salida.

### Reglas de rollback (siempre activas)
1. Si sube `UNCERTAIN` sobre el umbral: volver a dry-run.
2. Si hay duplicados por latencia: activar lock/cooldown estricto y cortar canary.
3. Si cae calidad de matching (no-match alto): pausar escalado y corregir aliases/contexto.
4. Si hay timeouts persistentes provider: desactivar real placement y mantener solo preview.

### Entregable inmediato recomendado (Semana 1)
1. Fase 0 completa (baseline + reporte de causas).
2. Fase 1 MVP (preview live + diagnostics live).
3. Sin ejecucion real todavia.

## [2026-04-01] Activación operativa DC para arbitraje (Pinnacle + Altenar)
- **Pinnacle prematch:** `scripts/ingest-pinnacle.js` ahora deriva y persiste `odds.doubleChance` desde 1x2 para no depender del estado de un feed parcial.
- **Cache-first prematch:** `src/services/prematchScannerService.js` conserva `doubleChance` al hidratar `upcomingMatches` desde `getAllPinnaclePrematchOdds`.
- **Altenar GetUpcoming/GetEventDetails:** extractor reforzado para mercados typeId=10 usando `desktopOddIds/mobileOddIds` y mapeo por `odd.typeId` (`9=1X`, `10=12`, `11=X2`), con fallback por nombre.
- **Scheduler adaptativo Altenar:** `src/services/altenarPrematchScheduler.js` mapea DC por `typeId` antes de heurística textual para robustez en perfiles multilenguaje.
- **Verificación de cobertura post-fix:**
  - `upcoming=63`, `pinnacleWithDC=59`
  - `altenar=81`, `altenarWithDC=79`
  - `linked=30`, `linkedAltWithDc=30`

## [2026-03-30] Sprint A.1: Preview 2 patas (Double Chance + opuesto 1x2)
- **Extensión de motor:** `src/services/arbitrageService.js` ahora combina, además del 1x2 de 3 patas, estas rutas de arbitraje de 2 patas:
  - `1X + Away`
  - `X2 + Home`
  - `12 + Draw`
- **Mapper contextual por orientación:** si el evento queda en `swapped`, se invierten correctamente `1X <-> X2` en Altenar para no romper la cobertura.
- **Stake Splitter 2 patas:** se agrega cálculo específico con redondeo por centavos, ajuste de residuo y métricas (`edgePercent`, `guaranteedPayout`, `expectedProfit`, `roiPercent`).
- **Respuesta API enriquecida:** `GET /api/opportunities/arbitrage/preview` ahora devuelve mercado mixto (`1x2` + `double_chance+opposite_1x2`) y diagnóstico por tipo generado/descartado.

## [2026-03-30] Sprint A MVP: Surebet 1x2 + Stake Splitter + API Preview
- **Servicio nuevo:** `src/services/arbitrageService.js`.
  - Detector de surebet **1x2 prematch** usando `upcomingMatches` (Pinnacle) + `altenarUpcoming` (Altenar).
  - Resolución de orientación de equipos (`normal`/`swapped`) para mapear correctamente home/away.
  - Cálculo de arbitraje matemático con criterio `sum(1/odds) < 1`.
  - **Stake Splitter** por bankroll con payout garantizado, profit esperado y ROI.
- **Endpoint nuevo:** `GET /api/opportunities/arbitrage/preview` en `src/routes/opportunities.js`.
  - Parámetros soportados:
    - `bankroll` (opcional)
    - `limit` (opcional)
  - Modo explícito: `preview-only` (sin ejecución real).
- **Diagnóstico incluido en respuesta:** filas escaneadas y descartes (`unlinked`, `orientation`, `missingOdds`).
- **Smoke de servicio:** validado con muestra real devolviendo edge positivo y stakes por pata.

## Guía de Ruta - Objetivo Arbitraje

### Estado actual (2026-03-30)
- **Fase actual:** Pre-arbitraje operable.
- **Ya resuelto:**
  - ingestión Pinnacle/Altenar estable,
  - matching y normalización operativa,
  - ejecución semi/real por proveedor,
  - reconciliación de historial Pinnacle,
  - PnL de Pinnacle anclado a cashflow externo,
  - observabilidad mínima de decisiones y sync.
- **Conclusión:** el sistema ya opera con valor esperado, pero aún no cierra arbitraje matemático completo de 2 patas con cobertura automática de fallo parcial.

### Lo que falta para arbitraje real completo
1. **Motor Surebet Multi-mercado:** detectar arbitrajes 2-way/3-way en tiempo real y calcular stakes por pata con beneficio neto garantizado.
2. **Orquestador de Ejecución Dual:** ejecutar ambas patas con control de latencia y política de hedge si una pata falla.
3. **Modelo de Operación de Arbitraje:** entidad única por operación (OPEN, PARTIAL, HEDGED, CLOSED) y PnL por operación, no solo por ticket.
4. **Guardas de Ejecutabilidad:** límites por mercado/casa, stake mínimo/máximo, lock por evento y protección anti-duplicado.
5. **Observabilidad de Producción:** métricas de slippage, partial fills, tiempo de ejecución y alertas de degradación.

### Plan de ejecución propuesto

#### Sprint A - Core matemático de arbitraje
- Implementar detector de surebet para 1x2, Totales y líneas compatibles.
- Implementar calculadora de stake por pata con redondeo y verificación de rentabilidad neta.
- Exponer endpoint de oportunidades de arbitraje con score de ejecutabilidad.

**Criterio de salida Sprint A:** oportunidades de arbitraje detectadas con stake plan válido y margen neto positivo validado por tests.

#### Sprint B - Ejecución dual segura
- Implementar orquestador de 2 patas con timeout y orden de prioridad configurable.
- Manejar fallo parcial con cobertura automática (hedge) y estado PARTIAL/HEDGED.
- Persistir evidencia completa de provider por cada pata (request/response/status).

**Criterio de salida Sprint B:** flujo E2E de operación dual con cierre controlado en escenarios de éxito total y fallo parcial.

#### Sprint C - Libro de arbitraje y operación diaria
- Crear libro de operaciones de arbitraje con estados y PnL consolidado.
- Agregar dashboard de arbitraje (abiertas, parciales, cerradas, ROI neto).
- Agregar health operativo específico de arbitraje (latencia, ratio de partial, fallos por provider).

**Criterio de salida Sprint C:** tablero operativo listo para uso diario y auditoría completa por operación.

### Próximo paso inmediato recomendado
- Iniciar Sprint A con un primer entregable mínimo:
  - detector surebet 1x2,
  - stake splitter,
  - endpoint de preview de operación (sin ejecución real).

## [2026-03-29] Auto-ejecución LIVE_VALUE + diagnóstico por tipos + alias wave
- **Auto-placement multi-strategy:** `scannerService` ahora permite auto-ejecución por lista de tipos (`AUTO_SNIPE_ALLOWED_TYPES`) y deja habilitado por defecto `LIVE_SNIPE, LA_VOLTEADA, LIVE_VALUE`.
- **Descartes más claros:** cuando una oportunidad no está habilitada por tipo, el motivo pasa a `type-not-enabled` (reemplaza `not-snipe` en ese caso).
- **Visibilidad operativa:** `GET /api/opportunities/live/diagnostics` incorpora `scanner.autoPlacementAllowedTypes` para validar en runtime qué tipos están activos.
- **Alias matcher:** expansión adicional en `dynamicAliases.json` para reducir no-match internacional y ajustar casos ambiguos (`gimnasia`, `nacional`, etc.).

## [2026-03-26] Finalizados REAL: fuente/ticket/score + aliases matcher
- **Etiqueta correcta de ejecución:** en Finalizados, las filas reales locales ya no aparecen como `SIM`; ahora se distinguen `BOOKY`, `REAL` y `SIM`.
- **Ticket visible en real local:** se corrige condición de UI para mostrar `Ticket <providerBetId>` también en filas `isRealHistory`.
- **Score consistente entre entradas del mismo evento:** se añade fallback por `eventId`/`match` para evitar casos `1-1` vs `?-?` en el mismo partido.
- **Aliases dinámicos ampliados:** `src/utils/dynamicAliases.json` incorpora nuevas equivalencias (incluye variantes internacionales y U21) para reducir no-match por nombre.

## [2026-03-22] Finalizados REAL + Auto-Snipe + Cache History
- **Finalizados REAL sin truncamiento:** se habilitó `historyLimit=0` en `/api/booky/account`, con hidratación completa en pestaña Finalizados REAL y bypass de caché parcial cuando se pide `fetchAll`.
- **Filtro por fecha robusto en snapshot:** `getBookyAccountSnapshot()` ahora filtra por `BOOKY_CASHFLOW_FROM_DATE` / `BOOKY_FINISHED_FROM_DATE` sobre historial completo antes de aplicar recorte.
- **Fix de stale closure en polling UI:** `fetchData()` usa refs (`activeTabRef`, `tokenHealthRef`) para que el intervalo respete tab/modo actual y no pida límites antiguos.
- **Auto-snipe resiliente:** soporte explícito SIM (`confirmSemiAutoTicket`) y reintento único ante re-quote.
- **Drift configurable en Booky:** `BOOKY_LIVE_MAX_ODD_DRIFT` y `BOOKY_PREMATCH_MAX_ODD_DRIFT` leídos desde entorno.
- **Aliases operativos nuevos:** `gimpo citizen -> gimpo`, `university of macau -> universidade de macau`.

## [2026-03-24] Diagnóstico LIVE + Requote UX + Monitor PIN/ALT
- **Diagnóstico LIVE estructurado:** se agregó bitácora de decisiones y endpoint `GET /api/opportunities/live/diagnostics` con pipeline y motivos.
- **Diagnóstico pre-oportunidad LIVE_SNIPE:** ahora se cuentan descartes por causa (`ev_non_positive`, `stake_below_1`, `real_prob_invalid`, etc.) para no depender solo de logs sueltos.
- **Requote provider code=4:** backend preserva `BOOKY_PLACEWIDGET_REQUOTE_REQUIRED` y frontend deja de mostrar rechazo genérico.
- **Reintento inmediato por re-quote:** UI ofrece reintentar al instante (máximo 1 auto-retry), respetando `confirm-fast` en `LIVE_SNIPE` y `confirm` en el resto.
- **Monitor de marcador:** se eliminan `0-0`/`?-?` espurios por coerción nula, se agrega badge `DESYNC` y modo `STALE` para micro-cortes de Pinnacle.

## [Frontend] App.jsx
- **Fix Visual (Odds):** Se modificó la tarjeta de oportunidad para priorizar `op.price` (la cuota de Altenar/DoradoBet) en lugar de `op.odd`. Esto corrige el bug donde salía `0.00`.
- **Fix Tabs:** Se separó la lógica de filtrado. "Live" muestra solo `LIVE_VALUE` y `Pre-match` muestra solo `PREMATCH_VALUE`. "Todos" muestra ambos.

## [Backend] Pinnacle API & Scanner
- **Protocolo Nuevo (The Firehose):** Se reemplazó la estrategia de "1 llamada por partido" (que era lenta y daba 404 en endpoints `related`) por una llamada global masiva a:
  - `markets/live/straight` (Cuotas)
  - `matchups/live` (Metadata/Scores)
- **Smart Parsing (Fix ASO Chlef):** Se implementó un filtro estricto `units !== 'Regular'` en `pinnacleService.js`.
  - Problema: La API devuelve múltiples objetos para el mismo partido (Regular, Córners, Tarjetas). Los de Córners a veces tenían el score desincronizado o structure distinta.
  - Solución: Solo procesamos IDs que corresponden a unidades "Regular".
- **Fix Auto-Bet (Zombie Bot):** Se corrigió `liveValueScanner.js` para incluir la propiedad `realProb` en el objeto de oportunidad.
  - Causa: `calculateKellyStake` en `paperTradingService` recibía `undefined` en probabilidad real, devolviendo stake 0.
- **Fix PaperTrading (Odd vs Price):** Se actualizó `placeAutoBet` para aceptar `opportunity.price` además de `opportunity.odd`. El scanner en vivo usa `price`, y esto provocaba que el cálculo de Kelly en el momento de la apuesta usara el default `2.0` en lugar de la cuota real.

## [Diagnóstico] Scripts
- Se creó `scripts/find_live_match.js` para inspeccionar el JSON crudo de Pinnacle y validar qué ID contenía el score correcto (2-0 vs 0-0).
