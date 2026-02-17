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
1.  **Nombres de Equipos (Fuzzy):** Usa Levenshtein distance y limpieza de strings. Altenar usa sufijos como `(F)` o `(Res.)`.
2.  **Contexto de Liga (CRÍTICO):** Verifica siempre si la Liga o el País coinciden para evitar falsos positivos (Ej. "Liverpool" ENG vs "Liverpool" URU). Si la liga contiene "Women", "U21", "Reserve", el match debe ser estricto.
3.  **Sincronización Temporal (Timezone):**
    *   Pinnacle = Verificar Timezone.
    *   Altenar = UTC (Zulu).
    *   Regla: Si la hora coincide (+/- 20 min) tras ajustar timezone, asume match aunque los nombres no sean idénticos al 100%.

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