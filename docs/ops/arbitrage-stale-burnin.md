# Burn-in de Stale (Arbitraje Prematch)

Esta guía documenta el procedimiento de validación anti-stale para Altenar en el flujo de arbitraje prematch.

## Objetivo

- Mantener `skippedStaleAltenar` con comportamiento estable en ventana extendida.
- Criterio de aceptación: `p95 < 10`.

## Perfil estable recomendado

Variables relevantes:

```env
ALTENAR_PREMATCH_SCHEDULER_LINKED_MAX_INTERVAL_MS=90000
ALTENAR_PREMATCH_SCHEDULER_STALE_SWEEP_ENABLED=true
ALTENAR_PREMATCH_SCHEDULER_STALE_SWEEP_THRESHOLD_MS=120000
ALTENAR_PREMATCH_SCHEDULER_STALE_SWEEP_MAX_EVENTS_PER_TICK=16
```

## Ejecución de burn-in (60m)

Script:

```bash
node scripts/tmp-burnin-60m-final-check.mjs
```

Salida esperada:

- Muestras periódicas `t0..t60` con campos `stale`, `older3m`, `p50`.
- Resumen final en consola (`BURNIN_60M_FINAL_SUMMARY=...`).
- Artefacto en `data/burnin-60m-final-check.json`.

## Interpretación de p95

- `p95` es el percentil 95: el valor que deja por debajo al 95% de las observaciones.
- En términos operativos, ayuda a medir cola alta de degradación sin dejar que un outlier aislado domine la lectura.
- Si `p95=1`, significa que el 95% de los puntos observados tuvo `stale <= 1`.

## Lectura recomendada del reporte

- `fromSamples.stale.p95`: salud de la corrida puntual.
- `fromHistory.stale.p95`: salud consolidada en snapshots persistidos.
- `passCriteria.bySamples` y `passCriteria.byHistory`: validación final del objetivo.

## Indicador de cierre reciente de DC

El preview de arbitraje expone diagnóstico para detectar cierre de mercado `Double Chance` entre snapshots:

- `dcClosedRecentlyCount`
- `dcClosedRecentWindowMinutes`
- `dcClosedRecentlySample`

Uso operativo:

- Si `dcClosedRecentlyCount > 0`, tratar señales DC con cautela y priorizar refresh de confirmación.
- El badge en UI ayuda a distinguir no-match de pricing vs cierre real de mercado.
