# INSTRUCCIONES PARA GITHUB COPILOT - BETSNIPER V3

Actúa como un Desarrollador Senior Full Stack y Experto en Trading Deportivo (Matemáticas Financieras).

## 1. CONTEXTO Y FUENTE DE LA VERDAD
- **Plan Maestro:** Tu guía absoluta es el archivo `PROJECT_BLUEPRINT.md` ubicado en la raíz. **Léelo antes de escribir cualquier código.**
- **Diccionario Técnico (SDK):** Usa el archivo `altenarWSDK.js` ubicado en la raíz como referencia para validar endpoints, nombres de parámetros y estructura de microservicios.
- **Objetivo:** Construir un sistema de arbitraje y apuestas de valor en vivo cruzando datos de Pinnacle y Altenar (DoradoBet).
- **Arcadia (Truth Source):** El módulo de Pinnacle ("Arcadia") utiliza WebSockets (`ws`) y Puppeteer para obtener cuotas en tiempo real ("Live Truth").

## 2. ESTÁNDARES TECNOLÓGICOS
- **Backend:** Node.js (ES Modules `import`/`export`), Express.
- **Base de Datos:** `lowdb` (JSON local). Prioriza el caché agresivo.
- **HTTP Client:** `axios` (Con configuración estricta anti-bot).
- **Scraping Avanzado:** Puppeteer & WebSockets para feeds de alta frecuencia (Arcadia).
- **Frontend:** React + Vite + TailwindCSS (Separado en carpeta `/client`).
- **Matemáticas:** Usa librerías como `decimal.js` si es necesario para precisión financiera (Cálculo de EV y Kelly).

## 3. REGLAS CRÍTICAS (PROTOCOLO "INMORTAL")
Al conectar con Altenar (DoradoBet), DEBES seguir estas restricciones para evitar bloqueos y errores de datos:

1.  **PROHIBIDO HEADER AUTHORIZATION:** NUNCA envíes un token de autorización. Caduca y rompe el bot. Usa el acceso público.
2.  **CONFIGURACIÓN AXIOS OBLIGATORIA:**
    - `User-Agent`: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
    - `Referer`: 'https://doradobet.com/'
    - `Origin`: 'https://doradobet.com'
    - `integration`: 'doradobet'
    - `numFormat`: 'en-GB' (**Vital:** Para recibir decimales con punto `1.50` y no con coma).
    - `countryCode`: 'PE'
3.  **MANEJO DE ERRORES:**
    - Verifica siempre si los arrays (`events`, `markets`) están vacíos antes de iterar.
    - Usa `try/catch` en todas las peticiones asíncronas.

## 4. MANEJO DE DATOS (MODELO RELACIONAL)
La API de Altenar devuelve datos normalizados (separados).
- **NO** asumas que la estructura es anidada simple.
- **SIEMPRE** mapea las relaciones globales (`data.champs` y `data.categories`):
  - Inyecta `league: champsMap.get(event.champId)` y `country: catsMap.get(event.catId)` en cada evento.
  - Cruza `event.marketIds` con el array `markets`.
  - Cruza `market.oddIds` con el array `odds`.
  - Cruza `event.competitorIds` con el array `competitors`.
- Consulta los ejemplos JSON en `PROJECT_BLUEPRINT.md` para ver la estructura exacta de cada endpoint.

## 4.1 NORMALIZACIÓN (DESAFÍO PRINCIPAL)
Al cruzar datos entre dos fuentes (Pinnacle vs Altenar), aplica siempre esta lógica de Matcher:
1.  **Nombres de Equipos (Fuzzy):** Usa Levenshtein distance y limpieza de strings. Altenar usa sufijos como `(F)` o `(Res.)`. Los aliases dinámicos se leen de `src/utils/dynamicAliases.json` y se recargan **sin reiniciar** (hot-reload cada 30s sobre mtime). Añade aliases ahí para correcciones rápidas de nombre.
2.  **Diagnóstico de no-match:** Usa `diagnoseNoMatch(teamName, startDate, candidates, league)` de `teamMatcher.js` para obtener `probableReason` (p.ej. `time_window_5m`, `category_mismatch`, `similarity_below_threshold`) y `bestScore`.
3.  **Contexto de Liga (CRÍTICO):** Verifica siempre si la Liga o el País coinciden para evitar falsos positivos (Ej. "Liverpool" ENG vs "Liverpool" URU). Si la liga contiene "Women", "U21", "Reserve", "(F)", "II", "III", el match debe ser estricto.
4.  **Sincronización Temporal (Timezone):**
    *   Pinnacle = Verificar Timezone.
    *   Altenar = UTC (Zulu).
    *   **Tolerancia configurable vía `.env`:**
        - `MATCH_TIME_TOLERANCE_MINUTES` (default 5 min) — ventana primaria.
        - `MATCH_TIME_EXTENDED_TOLERANCE_MINUTES` (default 30 min) — ventana extendida para candidatos secundarios.
    *   Ajusta `MATCH_TIME_TOLERANCE_MINUTES=10` si el diagnóstico muestra `time_window_5m` como razón dominante.

## 5. LÓGICA DE NEGOCIO Y MATEMÁTICAS (QUANT TRADING)
- **Value Bets:** Compara siempre Probabilidad Implícita (Pinnacle Fair) vs Probabilidad Real (Altenar Implied) en mercados 1x2, Over/Under y BTTS.
- **Estrategia "La Volteada":** 
  - **Umbral de Favorito:** Probabilidad > 55% (antes 60%). Ajustado para capturar más valor (Ej. Caso Tigres/Pumas).
  - Prioriza la eficiencia. Usa `GetLiveOverview` para el escaneo rápido y `GetEventDetails` solo para la confirmación profunda.
- **Gestión de Bankroll (Portfolio Theory):**
  - **Base:** NAV (Net Asset Value = Balance + Active Exposure).
  - **Risk Profiles:** Aplica fracciones dinámicas según la volatilidad (Prematch: 0.25, Live: 0.125, Snipe: 0.10).
  - **Simultaneous Kelly:** Usa una curva de saturación logarítmica para gestionar apuestas múltiples, en lugar de un "Hard Cap" arbitrario.
- **Protocolo de Liquidación (Settlement Logic):**
  - **Live Snipes:** Liquidación **INMEDIATA** si el evento desaparece del feed y `(Minuto >= 90 OR Tiempo Estimado > 100')`.
  - **Zombie Bets:** Si `GetEventDetails` falla (evento borrado), CONSULTAR SIEMPRE `GetEventResults` (API de Resultados) antes de aplicar reglas de tiempo. Si la API confirma fin, liquidar.

## 6. ESTILO DE CÓDIGO
- Usa Español para comentarios explicativos, especialmente en la lógica financiera.
- Mantén el código modular: separa la lógica de la API (`services/`), la lógica matemática (`utils/`) y las rutas (`routes/`).

## 7. PROTOCOLO DE COLOCACIÓN REAL (Booky)
Cuando se trabaja en el flujo de apuesta real (`src/services/bookySemiAutoService.js`), respetar estas reglas adicionales:

1.  **SIEMPRE DRY-RUN PRIMERO:** Antes de implementar `confirmRealPlacement`, verifica vía `POST /api/booky/real/dryrun/:id` que el payload `placeWidget` esté bien construido.
2.  **FLAG DE HABILITACIÓN:** `BOOKY_REAL_PLACEMENT_ENABLED=true` debe estar explícito en `.env` para que cualquier función de placement real ejecute. Por defecto es `false`.
3.  **GUARDAS OBLIGATORIAS (`enforceValueGuardsOrThrow`):**
    - Token JWT válido con al menos `BOOKY_TOKEN_MIN_REMAINING_MINUTES` de vida.
    - EV del ticket ≥ `BOOKY_MIN_EV_PERCENT`.
    - Drop máximo de cuota desde el snapshot ≤ `BOOKY_MAX_ODD_DROP` (protege ante cuota antigua).
4.  **ESTADO INCIERTO:** Si el request a `placeWidget` devuelve timeout/error de red SIN confirmación, llamar a `archiveUncertainRealPlacement()`. **NUNCA reintentar ciegamente.** Primero verificar via `GET /api/booky/account?refresh=1` si la apuesta ya existe.
5.  **RECHAZO AUDITABLE:** Si `placeWidget` responde rechazo definitivo (`BOOKY_PLACEWIDGET_REJECTED`), archivar siempre en historial con `archiveRejectedRealPlacement()` y estado `REAL_REJECTED`/`REAL_REJECTED_FAST`, incluyendo `realPlacement.diagnostic` (status/code/body/requestId).
6.  **PERFIL ANTES DE TOKEN:** El perfil (`BOOK_PROFILE`, `ALTENAR_INTEGRATION`, `ALTENAR_ORIGIN`) debe estar correcto ANTES de extraer el JWT. Usa `npm run book:dorado` o `npm run book:acity` primero, luego `npm run token:booky:wait-close`.
7.  **BASE KELLEY:** El stake real se calcula sobre `getKellyBankrollBase()` que tiene 3 niveles de fallback: balance real `booky-real` → `portfolio` → `config.bankroll`. Nunca hardcodear el NAV.

## 8. OPERACIÓN EN ALTA CARGA (SÁBADOS)

Cuando haya freeze intermitente o timeouts en `portfolio/live/prematch`:

1.  **NO** desactivar todo por defecto. Prioriza flags granulares en `.env`:
  - `DISABLE_LIVE_SCANNER=false`
  - `DISABLE_PREMATCH_SCHEDULER=true`
  - `DISABLE_PINNACLE_INGEST_CRON=true`
2.  Mantén `DISABLE_BACKGROUND_WORKERS=false` salvo emergencia total.
3.  Valida impacto con `npm run health:latency` antes/después del cambio.
4.  Si se toca polling del frontend, separar ciclos core y prematch, y permitir degradación parcial sin bloquear el dashboard completo.

## 9. RESILIENCIA ARCADIA (AUTO-REFRESH SIN BUCLES)

Cuando haya desync de reloj o socket stale en Pinnacle:

1.  **Mantener modo automático por defecto** (no manual), usando `PINNACLE_GATEWAY_AUTOSTART=true`.
2.  **Evitar relanzamientos en bucle:** respetar siempre `PINNACLE_GATEWAY_AUTOSTART_MIN_INTERVAL_MS` (recomendado 1h-2h).
3.  **Trigger stale con persistencia:** no disparar por un unico pico; exigir al menos 2 hits de lag persistente en `liveValueScanner`.
4.  **Umbral de lag configurable:** usar `PINNACLE_STALE_TIME_DIFF_MINUTES` (default endurecido: 6m).
5.  **Sockets Arcadia:** permitir `PINNACLE_ARCADIA_MIN_SOCKETS=1` como minimo operativo.
6.  **Auto-login opcional y seguro:**
  - habilitar solo con `PINNACLE_AUTO_LOGIN_ENABLED=true`
  - credenciales via `PINNACLE_LOGIN_USERNAME` y `PINNACLE_LOGIN_PASSWORD`
  - si faltan credenciales, loggear warning y continuar sin bloquear gateway.
7.  **No reiniciar ciegamente durante grace de login** salvo que `PINNACLE_STALE_RELOAD_ALLOW_DURING_GRACE=true`.