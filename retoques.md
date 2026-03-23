# Registro de Retoques y Correcciones

## [2026-03-22] Finalizados REAL + Auto-Snipe + Cache History
- **Finalizados REAL sin truncamiento:** se habilitó `historyLimit=0` en `/api/booky/account`, con hidratación completa en pestaña Finalizados REAL y bypass de caché parcial cuando se pide `fetchAll`.
- **Filtro por fecha robusto en snapshot:** `getBookyAccountSnapshot()` ahora filtra por `BOOKY_CASHFLOW_FROM_DATE` / `BOOKY_FINISHED_FROM_DATE` sobre historial completo antes de aplicar recorte.
- **Fix de stale closure en polling UI:** `fetchData()` usa refs (`activeTabRef`, `tokenHealthRef`) para que el intervalo respete tab/modo actual y no pida límites antiguos.
- **Auto-snipe resiliente:** soporte explícito SIM (`confirmSemiAutoTicket`) y reintento único ante re-quote.
- **Drift configurable en Booky:** `BOOKY_LIVE_MAX_ODD_DRIFT` y `BOOKY_PREMATCH_MAX_ODD_DRIFT` leídos desde entorno.
- **Aliases operativos nuevos:** `gimpo citizen -> gimpo`, `university of macau -> universidade de macau`.

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
