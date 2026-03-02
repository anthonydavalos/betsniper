# Plantilla de Evaluación de Matcher (Live)

Usa esta plantilla para comparar corridas con distintos valores en `.env`.

## 1) Configuración de la corrida

- Fecha/Hora:
- Branch:
- Commit (opcional):
- Perfil Booky (`BOOK_PROFILE`):
- `MATCH_DIAGNOSTIC_LOG`:
- `MATCH_TIME_TOLERANCE_MINUTES`:
- `MATCH_TIME_EXTENDED_TOLERANCE_MINUTES`:
- `MATCH_FUZZY_THRESHOLD`:
- `MATCH_MIN_ACCEPT_SCORE`:

Comando ejecutado:

```bash
npm run dev
```

---

## 2) Resumen por ciclo (copiar 3 ciclos)

> Copia solo las líneas `MATCH_DIAG_SUMMARY` y `MATCH_DIAG_RECOMMENDATION`.

### Ciclo 1
- `unmatched`:
- `awayFallbackMatches`:
- `topReasons`:
- `scoreStats` (`p50/p75/p90/nearThresholdRate`):
- `fuzzyCurrent`:
- `fuzzySuggested`:
- `reason`:

### Ciclo 2
- `unmatched`:
- `awayFallbackMatches`:
- `topReasons`:
- `scoreStats` (`p50/p75/p90/nearThresholdRate`):
- `fuzzyCurrent`:
- `fuzzySuggested`:
- `reason`:

### Ciclo 3
- `unmatched`:
- `awayFallbackMatches`:
- `topReasons`:
- `scoreStats` (`p50/p75/p90/nearThresholdRate`):
- `fuzzyCurrent`:
- `fuzzySuggested`:
- `reason`:

---

## 3) Comparativa A/B (antes vs después)

| Métrica | Baseline (ej: 5 min) | Prueba (ej: 10 min) | Delta | Resultado |
|---|---:|---:|---:|---|
| Promedio `unmatched` (3 ciclos) |  |  |  |  |
| Promedio `awayFallbackMatches` |  |  |  |  |
| `% time_window_*` |  |  |  |  |
| `% category_mismatch` |  |  |  |  |
| `nearThresholdRate` promedio |  |  |  |  |

---

## 4) Regla de decisión rápida

Marca una opción:

- [ ] **Mantener configuración actual**
- [ ] **Subir ventana temporal** (`MATCH_TIME_TOLERANCE_MINUTES`)
- [ ] **Bajar ventana temporal**
- [ ] **Bajar fuzzy** (`MATCH_FUZZY_THRESHOLD`)
- [ ] **Subir fuzzy**

### Criterio recomendado

- Si domina `time_window_*` en 2/3 ciclos → subir ventana temporal (5 → 10 → 12).
- Si al subir ventana aumenta mucho `category_mismatch` → volver al valor anterior.
- Si `nearThresholdRate` alto y baja fricción por categoría → considerar bajar fuzzy (0.77 → 0.75).
- No mover fuzzy si el problema dominante sigue siendo tiempo.

---

## 5) Decisión final de esta prueba

- Cambio aplicado en `.env`:
- Motivo:
- Riesgo observado:
- Próxima prueba sugerida:

---

## 6) Snippets útiles de terminal

Filtrar diagnóstico en vivo:

```bash
npm run dev | grep "MATCH_DIAG"
```

Ver solo recomendaciones:

```bash
npm run dev | grep "MATCH_DIAG_RECOMMENDATION"
```

Ver solo resumen agregado:

```bash
npm run dev | grep "MATCH_DIAG_SUMMARY"
```

---

## 7) Ejemplo prellenado (tu baseline actual)

### Configuración observada

- Fecha/Hora: 2026-03-02 (corrida compartida en chat)
- Perfil Booky (`BOOK_PROFILE`): `acity`
- `MATCH_DIAGNOSTIC_LOG`: `1`
- `MATCH_TIME_TOLERANCE_MINUTES`: `5`
- `MATCH_TIME_EXTENDED_TOLERANCE_MINUTES`: `30`
- `MATCH_FUZZY_THRESHOLD`: `0.77`
- `MATCH_MIN_ACCEPT_SCORE`: `0.60`

### Resultado (patrón repetido)

- `unmatched=1`
- `awayFallbackMatches=0`
- `topReasons=[{"reason":"time_window_5m","count":1}]`
- `scoreStats={"count":0,"p50":null,"p75":null,"p90":null,"nearThresholdRate":0}`
- `fuzzySuggested=0.77` con `reason=keep_current`

### Interpretación

- El cuello de botella es **temporal** (no entra ningún candidato en ventana primaria), no de similitud/fuzzy.
- Por eso no hay `bestScore` (sale `n/a`) y no corresponde mover `MATCH_FUZZY_THRESHOLD` todavía.

### Siguiente prueba recomendada (A/B)

1) Edita `.env`:
- `MATCH_TIME_TOLERANCE_MINUTES=10`
- Mantén: `MATCH_TIME_EXTENDED_TOLERANCE_MINUTES=30`, `MATCH_FUZZY_THRESHOLD=0.77`, `MATCH_MIN_ACCEPT_SCORE=0.60`

2) Reinicia backend:

```bash
npm run dev
```

3) Toma 3 ciclos y completa secciones 2 y 3.

4) Regla rápida para decidir:
- Si baja `% time_window_*` y no sube mucho `% category_mismatch`, deja `10`.
- Si sigue alto `% time_window_*`, prueba `12`.
- Si sube fuerte `category_mismatch`, vuelve a `5` o `8`.
