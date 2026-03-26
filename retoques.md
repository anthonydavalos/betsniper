# Registro de Retoques y Correcciones

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
