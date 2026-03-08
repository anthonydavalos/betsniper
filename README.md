# 🎯 BetSniper V3 - Quantitative Sports Arbitrage Engine

<div align="center">

**Sistema de Trading Deportivo Automatizado con Gestión de Riesgo Cuantitativo**

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-18+-blue.svg)](https://reactjs.org/)
[![License](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)

</div>

---

## 📖 Tabla de Contenidos

- [Descripción General](#-descripción-general)
- [Cambios Recientes (Último Commit)](#-cambios-recientes-último-commit)
- [Características Principales](#-características-principales)
- [Arquitectura del Sistema](#-arquitectura-del-sistema)
- [Estrategias de Trading](#-estrategias-de-trading)
- [Gestión Financiera](#-gestión-financiera-portfolio-theory)
- [Guía de Configuración Pre-Operativa](#-guía-de-configuración-pre-operativa)
- [Instalación y Despliegue](#-instalación-y-despliegue)
- [Interfaz de Usuario](#-interfaz-de-usuario-dashboard)
- [API Endpoints](#-api-endpoints)
- [Configuración Avanzada](#-configuración-avanzada)
- [Guía de Scripts y Comandos](#-guía-de-scripts-y-comandos)
- [Troubleshooting](#-troubleshooting)
- [Roadmap](#-roadmap)

---

## 🌟 Descripción General

**BetSniper V3** es un sistema de trading deportivo de alta frecuencia diseñado bajo principios de finanzas cuantitativas. El sistema opera como un **arbitrajista algorítmico**, cruzando datos en tiempo real entre un "Sharp Bookie" (Pinnacle/Arcadia - fuente de probabilidades reales) y un "Soft Bookie" (Altenar/DoradoBet - mercado objetivo) para identificar ineficiencias y ejecutar estrategias de valor esperado positivo (EV+).

### ¿Cómo Funciona?

1.  **Ingesta de Datos:** Conexión WebSocket con Pinnacle para obtener cuotas "sin margen" (Fair Odds) que representan la probabilidad real de los eventos.
2.  **Escaneo de Mercado:** Análisis continuo de cuotas de Altenar (DoradoBet) para detectar discrepancias con las probabilidades reales.
3.  **Cálculo Matemático:** Aplicación de Kelly Criterion con perfiles de riesgo dinámicos para determinar el tamaño óptimo de cada apuesta.
4.  **Ejecución Simulada:** Sistema de Paper Trading que simula la ejecución de apuestas y trackea P&L en tiempo real.
5.  **Monitoreo Continuo:** Seguimiento del estado de apuestas activas y liquidación automática basada en resultados reales.

---

## 🆕 Cambios Recientes (Último Commit)

Esta sección resume lo implementado desde el último commit para dejar trazabilidad técnica y operativa.

### 1) Matcher Pinnacle ↔ Altenar reforzado

- **Hot-reload de aliases dinámicos** en `src/utils/teamMatcher.js` leyendo `src/utils/dynamicAliases.json` sin reiniciar proceso.
- **Diagnóstico de no-match** con `diagnoseNoMatch(...)` y razones probables (`time_window_*`, `category_mismatch`, `similarity_below_threshold`, etc.).
- **Umbrales por entorno**:
  - `MATCH_DIAGNOSTIC_LOG`
  - `MATCH_FUZZY_THRESHOLD`
  - `MATCH_MIN_ACCEPT_SCORE`
  - `MATCH_TIME_TOLERANCE_MINUTES`
  - `MATCH_TIME_EXTENDED_TOLERANCE_MINUTES`
- **Validación al boot** (clamp/rango) para umbrales y flags inválidos.
- **Fallback inverso (away-team)** en `src/services/liveScannerService.js` cuando el match por home no alcanza score mínimo.
- **Resumen agregado por ciclo** en logs: `MATCH_DIAG_SUMMARY` y `MATCH_DIAG_RECOMMENDATION`.

### 2) Cobertura PREMATCH más robusta (Pinnacle + Altenar)

- `services/pinnacleLight.js` ahora mantiene **canal prematch separado** y guarda en `data/pinnacle_prematch.json`.
- `src/services/pinnacleService.js` agrega `getAllPinnaclePrematchOdds()` (cache-first con fallback API).
- `src/services/prematchScannerService.js` usa cache prematch, hace **upsert** a DB y persiste con retry anti-lock (`EPERM/EBUSY`).
- Se añade filtro consistente para excluir variantes no deseadas (corners/cards/bookings/8 games).
- Ventana temporal prematch en horario PE (noche extendida hasta 06:00 del día siguiente).

### 3) Scheduler adaptativo Altenar Prematch

- Nuevo servicio: `src/services/altenarPrematchScheduler.js`.
- Discovery + refresh por prioridad temporal/evento enlazado, con concurrencia controlada y backoff por fallos.
- Integrado en `server.js` con `startAltenarPrematchAdaptiveScheduler()`.

### 4) Flujo Booky semi-auto + placement real controlado

- Nuevas rutas en `src/routes/booky.js` bajo `/api/booky/*`.
- Nuevo servicio `src/services/bookySemiAutoService.js`:
  - Tickets draft/confirm/cancel.
  - `dryrun` de payload real (`placeWidget`).
  - `confirm` y `confirm-fast` con guardas de valor y manejo de estado incierto.
  - Control de token JWT (`ALTENAR_BOOKY_AUTH_TOKEN`) y renovación asistida.
- Nuevo servicio `src/services/bookyAccountService.js`:
  - Balance real por perfil (`BOOK_PROFILE`).
  - Historial remoto reconciliado con historial local.
  - Base de bankroll Kelly con fallback (`booky-real` → `portfolio` → `config`).
- `src/db/database.js` agrega estructura persistente `booky`.

### 5) Hardening Live (calidad de señal)

- Estabilidad por ticks en `src/services/liveValueScanner.js` y `src/services/scannerService.js` para filtrar falsos spikes.
- Guardia de sincronización de marcador Alt vs Pin antes de publicar oportunidades live.
- Normalización de mercado `1x2` en payloads y refresh.
- Cálculo de stake usando bankroll base centralizado (`getKellyBankrollBase()`).

### 6) Scripts nuevos de operación y diagnóstico

- Perfil rápido de booky: `npm run book:dorado`, `npm run book:acity`.
- Extracción token: `npm run token:booky:*`.
- Captura payload placeWidget: `npm run capture:booky:*`.
- Spy de historial/endpoints: `npm run spy:booky:history`.
- Smoke test API booky: `npm run smoke:booky` y `npm run smoke:booky:live`.
- Saneo manual de huérfanas en `portfolio.activeBets`: `npm run cleanup:booky:orphans`.
- Ingesta Pinnacle manual: `npm run ingest:pinnacle:force` (normal) y `npm run ingest:pinnacle:safe` (sin flush incremental, recomendado en OneDrive).
- Plantilla de experimento matcher: `MATCH_DIAG_TEMPLATE.md` (guía A/B para ajustar `MATCH_TIME_TOLERANCE_MINUTES` con baseline prefilled).

## 🚀 Características Principales

### 🧠 Motor Cuantitativo (Quant Core)

**Simultaneous Kelly Criterion con Amortiguación Logarítmica**
- Implementación avanzada del criterio de Kelly que evita los "cortes arbitrarios" (Hard Caps).
- Usa una función de saturación exponencial: `Stake = Cap × (1 - e^(-Kelly/Cap))`.
- Permite que apuestas con ventaja masiva reciban más capital sin comprometer la seguridad del bankroll.
- **Risk of Ruin (ROR):** < 0.5% mediante control asintótico.

**Risk Profiles Dinámicos**
El sistema ajusta automáticamente la agresividad de las apuestas según la volatilidad inherente de cada estrategia:

| Estrategia | Fracción Kelly | Volatilidad | Caso de Uso |
|------------|----------------|-------------|-------------|
| `PREMATCH_VALUE` | 0.25 (1/4) | Baja | Cuotas pre-partido con datos históricos sólidos |
| `LIVE_VALUE` | 0.125 (1/8) | Media | Arbitraje en vivo con ruido de mercado |
| `LIVE_SNIPE` | 0.10 (1/10) | Alta | "La Volteada" - Eventos de alta incertidumbre |

**NAV-Based Staking (Net Asset Value)**
- Calcula el tamaño de posición sobre `Balance Líquido + Exposición Activa`.
- Evita la "sub-inversión" sistemática que ocurre al tener múltiples apuestas simultáneas.
- Ejemplo: Con $1000 en balance y $200 en apuestas activas, el sistema calcula sobre NAV = $1200.

### 🕵️ Scanners Especializados

**1. Arcadia Gateway (Truth Source)**
- Conexión WebSocket de baja latencia con Pinnacle API.
- Extracción de cuotas "Fair" (sin margen de casa) mediante eliminación de Vig.
- Auto-renovación de sesión mediante Puppeteer cuando el token caduca.
- Detección de datos congelados (Stale Data) y reinicio automático.

**2. Pre-Match Scanner**
- Escaneo diario de eventos próximos (ventana de 48h).
- Cruza cuotas de Pinnacle vs Altenar identificando oportunidades pre-partido.
- Matcher inteligente con Fuzzy Logic + Levenshtein Distance para normalización de nombres.

**3. Live Scanner ("The Sniper")**
- Escaneo de alta frecuencia con **polling adaptativo** (~2s a ~7s según actividad/errores).
- Detección de dos tipos de oportunidades en tiempo real:
  - **Value Bets Live:** Discrepancias de cuotas en eventos en juego.
  - **"La Volteada":** Estrategia especializada (ver sección Estrategias).

**4. Monitor Dashboard**
- Vista comparativa en tiempo real de cuotas Pinnacle vs Altenar.
- Indicadores visuales de tendencia (flechas arriba/abajo) y pulsos de actualización.
- Detección de eventos "desvinculados" (sin match Pinnacle).

### 🛡️ Sistemas de Seguridad

**Zombie Protocol (Auto-Recovery)**
- Detecta eventos que desaparecen de los feeds en vivo (suspensiones, finalizaciones prematuras).
- Consulta automática a la API de Resultados (`GetEventResults`) para liquidación precisa.
- Previene apuestas "colgadas" en estado PENDING indefinidamente.

**Duplicate Bet Prevention**
- Sistema de locks en memoria (`processingBets Set`) para evitar apuestas duplicadas.
- Filtro de Blacklist persistente para eventos descartados manualmente.
- Validación de stake mínimo (S/1.00) antes de registrar oportunidades.

**Stale Data Detection**
- Compara tiempos de partido entre Pinnacle y Altenar.
- Si la diferencia supera 3 minutos, gatilla reinicio automático del WebSocket.
- Archivo trigger (`pinnacle_stale.trigger`) para comunicación inter-proceso.

### 🎨 Interfaz de Usuario (React + TailwindCSS)

**Dashboard Multi-Pestaña**
1.  **Pre-Match:** Lista de oportunidades futuras con cálculo de EV y Kelly.
2.  **En Vivo:** Oportunidades detectadas en tiempo real ("La Volteada" + Value Bets).
3.  **Activas:** Apuestas en curso con tracking de marcador y tiempo en vivo.
4.  **Historial:** Registro completo de apuestas liquidadas con P&L y estadísticas.
5.  **Monitor:** Comparador visual de cuotas Pinnacle vs Altenar (modo profesional).
6.  **Matcher:** Herramienta manual para vincular eventos no detectados automáticamente.

---

## 📊 Estrategias de Trading

### 1. Pre-Match Value Betting

**Descripción:** Detección de discrepancias entre cuotas pre-partido.

**Flujo:**
1.  Ingesta diaria de eventos próximos desde Pinnacle (cuotas "Fair").
2.  Normalización de nombres de equipos y ligas (Fuzzy Matching).
3.  Comparación con cuotas de Altenar en el mismo evento.
4.  Identificación de valor cuando: `Prob_Real × Cuota_Altenar > 1`.

**Ventajas:**
- Datos estables (no volátiles).
- Mayor tiempo para análisis manual.
- Menor riesgo de cambios bruscos.

**Riesgo:** Bajo (0.25 Kelly).

---

### 2. Live Value Betting

**Descripción:** Arbitraje algorítmico en eventos en curso.

**Flujo:**
1.  Escaneo continuo de partidos en vivo con **polling adaptativo** (~2s a ~7s según actividad y errores).
2.  Comparación de cuotas actualizadas en tiempo real.
3.  Detección de valor positivo mediante Fair Odds de Pinnacle Live.
4.  Ejecución si Kelly sugiere stake ≥ S/1.00.

**Ventajas:**
- Oportunidades frecuentes.
- Cuotas más volátiles = mayor margen.

**Riesgo:** Medio (0.125 Kelly).

---

### 3. "La Volteada" (Live Snipe Strategy)

**Descripción:** Estrategia propietaria que detecta remontadas potenciales.

**Condiciones de Entrada:**
1.  **Perfil del Evento:** Favorito Pre-Match (Probabilidad Real > 55%).
2.  **Estado del Partido:** Favorito va perdiendo por **exactamente 1 gol**.
3.  **Ventana Temporal:** Minuto 15 - 80 del partido.
4.  **Validación de Dominancia:**
    - Sin expulsiones (Red Cards = 0).
    - Estadísticas de dominio (Posesión, Tiros) favorables al favorito (opcional).

**Lógica Matemática:**
- Recalcula probabilidad de remontada usando cuotas Pinnacle Live.
- Aplica Kelly ultra-conservador (0.10) por alta volatilidad.
- Busca cuota de Altenar inflada (típicamente > 2.5x para el favorito).

**Ejemplo Real:**
```
Tigres UANL (Favorito Pre-Match: ~70%) vs Pumas
Score Actual: 0-1 (Tigres perdiendo) - Minuto 35'
Cuota Pinnacle Live (Tigres): 1.50 → Prob Real: ~60%
Cuota Altenar (Tigres): 2.20 → EV = 32%
Kelly (0.10): Stake sugerido = $8 (NAV = $1200)
```

**Ventajas:**
- Aprovecha pánico de mercado (Altenar sobrevalora al underdog).
- Alta frecuencia en ligas volátiles.

**Riesgo:** Alto (0.10 Kelly). Requiere liquidación rápida.

---

### 4. Next Goal Value (Totales)

**Descripción:** Detección de presión ofensiva para mercados Over/Under.

**Condiciones:**
1.  Equipo dominante con > 60% posesión.
2.  Diferencia de tiros a puerta > 3.
3.  Minuto > 60'.

**Objetivo:** Apostar a "Over 2.5" o "Over 3.5" cuando el partido está "caliente".

**Estado:** Experimental (requiere calibración).

---

## � Gestión Financiera (Portfolio Theory)

### Kelly Criterion: La Matemática Detrás

El **criterio de Kelly** determina la fracción óptima del bankroll a arriesgar en función de la ventaja estadística:

$$f^* = \frac{bp - q}{b}$$

Donde:
- `p` = Probabilidad Real de ganar (Pinnacle Fair Odds)
- `q` = Probabilidad de perder (1 - p)
- `b` = Ganancia neta por unidad apostada (Cuota - 1)

**Problema del Kelly Puro:** En su forma original, Kelly puede sugerir apuestas muy grandes (10-20% del bankroll) en situaciones de alta ventaja, exponiendo al trader a alta volatilidad.

### Mejoras Implementadas

**1. Fractional Kelly**
- Multiplicador conservador sobre el Kelly puro.
- Reduce volatilidad a cambio de menor tasa de crecimiento.
- BetSniper usa fracciones adaptativas según volatilidad del mercado.

**2. Logarithmic Dampening (Amortiguación)**
En lugar de cortar arbitrariamente las apuestas grandes, aplicamos:

$$Stake_{Real} = Cap \times (1 - e^{-\frac{Stake_{Kelly}}{Cap}})$$

**Efecto:**
- Apuestas pequeñas (< 2%): Crecimiento casi lineal (no penalizadas).
- Apuestas grandes (> 5%): Crecimiento asintótico hacia el Cap (3.5%).
- **Resultado:** Aprovechas ventajas masivas sin arriesgar la ruina.

**Gráfica Conceptual:**
```
Stake Real (%)
    │
3.5%├─────────────────────── (Asíntota)
    │                  ╱─
    │               ╱─
2.0%│           ╱─
    │       ╱─
1.0%│   ╱─
    │╱──────────────────────→ Kelly Crudo (%)
    0   2   4   6   8  10
```

### NAV (Net Asset Value)

**Definición:** Patrimonio Total = Balance Disponible + Stakes en Apuestas Activas.

**¿Por qué usarlo?**
- Escenario: Tienes $1000 de balance y 5 apuestas activas de $50 cada una ($250 en juego).
- **Error Común:** Calcular Kelly sobre $1000 → Sub-inversión en nuevas oportunidades.
- **Solución NAV:** Calcular Kelly sobre $1250 (NAV) → Apuestas proporcionales al patrimonio real.

**Implementación:**
```javascript
const currentNAV = portfolio.balance + 
                   portfolio.activeBets.reduce((sum, b) => sum + b.stake, 0);
const kellyStake = calculateKellyStake(realProb, odd, currentNAV, strategy);
```

### Control de Riesgo

**Validaciones Pre-Ejecución:**
1.  **Stake Mínimo:** S/1.00 (Evita micro-apuestas poco prácticas).
2.  **Liquidez:** No apostar más del balance disponible (incluso si NAV lo sugiere).
3.  **Duplicate Check:** Verificar que no existe apuesta activa en el mismo evento.
4.  **Blacklist:** Filtrar eventos descartados manualmente.

**Liquidación Automática:**
- **Pre-Match:** Buffer de 2.2 horas post-inicio antes de verificar resultados.
- **Live:** Liquidación inmediata si `Tiempo >= 90'` o evento desaparece del feed.
- **Zombie Bets:** Consulta a API de Resultados si `GetEventDetails` falla.

---

## 🛠️ Arquitectura del Sistema

### Diagrama de Componentes

```
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND (React)                         │
│  ┌──────────┬───────────┬──────────┬──────────┬──────────┐ │
│  │ Pre-Match│ En Vivo   │ Activas  │Historial │ Monitor  │ │
│  └────┬─────┴─────┬─────┴─────┬────┴────┬─────┴────┬─────┘ │
│       │           │           │         │          │        │
└───────┼───────────┼───────────┼─────────┼──────────┼───────┘
        │           │           │         │          │
        └───────────┴───────────┴─────────┴──────────┘
                           ▼
        ┌───────────────────────────────────────────────────┐
        │         EXPRESS API (server.js)                   │
        │  ┌─────────────────────────────────────────────┐  │
        │  │   Background Scanner (Bucle Infinito)       │  │
        │  │   - Pre-Match Scan (cada 2 min)             │  │
        │  │   - Live Scan (polling adaptativo)          │  │
        │  │   - Active Bets Monitoring                  │  │
        │  └─────────────────────────────────────────────┘  │
        │                                                    │
        │  ┌─────────────────────────────────────────────┐  │
        │  │   API Routes                                 │  │
        │  │   /api/opportunities                         │  │
        │  │   /api/portfolio                             │  │
        │  │   /api/monitor                               │  │
        │  │   /api/matcher                               │  │
        │  │   /api/booky                                 │  │
        │  └─────────────────────────────────────────────┘  │
        └──────────────┬──────────────────┬────────────────┘
                       │                  │
        ┌──────────────▼─────┐   ┌────────▼──────────────┐
        │  LowDB (db.json)   │   │  Axios Clients        │
        │  - Matches         │   │  - Altenar API        │
        │  - Portfolio       │   │  - Pinnacle (REST)    │
        │  - Blacklist       │   └───────────────────────┘
        └────────────────────┘
                                    ┌───────────────────────┐
                                    │ services/             │
                                    │ pinnacleLight.js      │
                                    │ (Proceso Separado)    │
                                    │                       │
                                    │ ┌──────────────────┐  │
                                    │ │ Puppeteer        │  │
                                    │ │ (Chrome Headless)│  │
                                    │ └────────┬─────────┘  │
                                    │          │            │
                                    │          ▼            │
                                    │   WebSocket Client   │
                                    │   (wss://arcadia)    │
                                    │          │            │
                                    │          ▼            │
                                    │ pinnacle_live.json   │
                                    └──────────────────────┘
```

### Flujo de Datos (Live Trading)

1.  **Ingesta (Terminal 2 - `pinnacleLight.js`):**
    - Puppeteer navega a Pinnacle y extrae headers de autenticación.
    - WebSocket abierto en `wss://api.arcadia.pinnacle.com/ws`.
    - Frames recibidos cada ~500ms, parseados y escritos en `data/pinnacle_live.json`.

2.  **Procesamiento (Terminal 1 - `server.js`):**
    - Background Scanner lee `pinnacle_live.json` con polling adaptativo (~2s a ~7s).
    - Consulta eventos en vivo desde Altenar (`GetLivenow`).
    - Matcher fuzzy para vincular eventos Pinnacle ↔ Altenar.
    - Evalúa condiciones de estrategias (Value, Volteada, Next Goal).
    - Calcula Kelly y registra oportunidades en caché.

3.  **Presentación (Terminal 3 - `client/`):**
    - Frontend consulta `/api/opportunities` cada 5s.
    - Renderiza oportunidades en pestaña "En Vivo".
    - Usuario puede ejecutar apuesta manual (botón "APOSTAR").

4.  **Ejecución (Paper Trading):**
    - `placeAutoBet()` registra apuesta en `db.json`.
    - Descuenta stake del balance.
    - Añade a lista `activeBets`.

5.  **Monitoreo:**
    - En cada ciclo del scanner, `updateActiveBetsWithLiveData()` verifica:
      - Si el evento sigue en vivo (actualiza score/tiempo).
      - Si finalizó (consulta `GetEventDetails` o `GetEventResults`).
    - Liquida apuesta si hay resultado oficial.

---

## 🔧 Guía de Configuración Pre-Operativa

Antes de instalar el sistema necesitas tener cuentas activas en los servicios externos que BetSniper consume. Esta sección detalla **qué cuentas abrir**, **qué datos extraer de cada una** y **cómo volcarlas al `.env`**.

---

### Paso 1: Servicios a los que debes suscribirte

#### 1A. Pinnacle (obligatorio — fuente de probabilidades reales)

| Campo | Detalle |
|---|---|
| **Web** | [pinnacle.com](https://www.pinnacle.com) |
| **Tipo** | Sharp Bookie — márgenes muy bajos, acepta ganadores |
| **Qué necesitas** | Cuenta activa con acceso a la sección "Sports" (Live Soccer visible) |
| **Restricciones** | No disponible en todos los países. Usar VPN si es necesario (recomendado: servidor NL o MT). |
| **Uso en BetSniper** | Solo como fuente de cuotas. **No se colocan apuestas en Pinnacle.** |
| **Coste** | Gratuito (solo necesitas la cuenta para acceder a la API de cuotas en tiempo real) |

> **Por qué Pinnacle:** Su API pública (`api.arcadia.pinnacle.com`) expone cuotas con márgenes de 2-3%, lo que las convierte en el mejor proxy de probabilidad real del mercado.

#### 1B. DoradoBet (obligatorio para modo live — bookie objetivo principal)

| Campo | Detalle |
|---|---|
| **Web** | [doradobet.com](https://doradobet.com) |
| **Plataforma** | Altenar (mismo backend que ACity) |
| **Qué necesitas** | Cuenta registrada con saldo real |
| **Perfil en `.env`** | `BOOK_PROFILE=doradobet` |
| **Uso en BetSniper** | Detección de value bets + colocación real (si habilitas `BOOKY_REAL_PLACEMENT_ENABLED`) |
| **Restricciones** | Disponible principalmente en Perú. Si operas desde otro país, verificar disponibilidad. |

#### 1C. Casino Atlantic City — ACity (alternativo — mismo motor Altenar)

| Campo | Detalle |
|---|---|
| **Web** | [casinoatlanticcity.com/apuestas-deportivas](https://www.casinoatlanticcity.com/apuestas-deportivas) |
| **Plataforma** | Altenar (misma API, distinto `integration` y `origin`) |
| **Qué necesitas** | Cuenta registrada con saldo real |
| **Perfil en `.env`** | `BOOK_PROFILE=acity` |
| **Uso en BetSniper** | Alternativa a DoradoBet. Puedes operar en ambas en sesiones separadas. |

> **Nota:** DoradoBet y ACity usan el mismo motor Altenar pero con integraciones distintas. BetSniper soporta cambiar entre ellas con un solo comando (`npm run book:dorado` / `npm run book:acity`) sin reiniciar el servidor.

---

### Paso 2: Configuración detallada del `.env`

Copia el archivo de plantilla:

```bash
cp .env.example .env
```

Luego edita `.env` siguiendo esta guía variable por variable:

---

#### 🔧 Variables de Sistema

```env
NODE_ENV=development
```
> Usa `development` siempre. Solo cambiar a `production` si despliegas en servidor remoto.

```env
PORT=3000
```
> Puerto del backend. Si tienes conflicto con otro proceso, cámbialo (ej. `3001`).

```env
TZ=America/Lima
```
> Timezone del proceso. **Importante:** afecta el horario mostrado en el dashboard y los filtros de ventana prematch nocturna. Ajústar según tu país si no estás en Perú.

```env
DISABLE_BACKGROUND_WORKERS=false
DISABLE_LIVE_SCANNER=false
DISABLE_PREMATCH_SCHEDULER=false
DISABLE_PINNACLE_INGEST_CRON=false
DISABLE_MONITOR_DASHBOARD=false

# Live tuning
LIVE_VALUE_MIN_EV=0.02
LIVE_VALUE_MIN_DISPLAY_STAKE=0.10
LIVE_VALUE_NON_1X2_STAKE_FACTOR=1
LIVE_SNIPE_REQUIRE_PINNACLE_LIVE=true
LIVE_VALUE_REQUIRE_SCORE_SYNC=true
LIVE_VALUE_SCORE_SYNC_MAX_GOAL_DIFF=0
LIVE_VALUE_ENABLE_STABILITY_FILTER=true
LIVE_VALUE_STABILITY_MIN_HITS=2
LIVE_VALUE_STABILITY_MIN_AGE_MS=4000
LIVE_GLOBAL_STABILITY_ENABLED=true
LIVE_GLOBAL_STABILITY_MIN_HITS=2

# Recalculo prematch en caliente al apostar
PREMATCH_REFRESH_RECALCULATE_PINNACLE=true
PREMATCH_PINNACLE_CACHE_TTL_MS=15000

# Ventana híbrida de descarga prematch (deslizante + precarga)
PREMATCH_WINDOW_PRIMARY_HOURS=6
PREMATCH_WINDOW_PREFETCH_HOURS=6
PREMATCH_WINDOW_OVERLAP_MINUTES=30
```
> Pon `true` solo para depurar el servidor Express sin que los scanners consuman CPU.

> `LIVE_SNIPE_REQUIRE_PINNACLE_LIVE=true` mantiene modo estricto (solo entra si hay cuota live PIN). Si estás en día de feed incompleto, puedes bajarlo temporalmente a `false`.

> `LIVE_VALUE_REQUIRE_SCORE_SYNC=true` + `LIVE_VALUE_SCORE_SYNC_MAX_GOAL_DIFF=0` exige marcador idéntico Altenar/Pinnacle. Para no quedarte sin señales, usa `LIVE_VALUE_SCORE_SYNC_MAX_GOAL_DIFF=1` o desactiva la guard con `LIVE_VALUE_REQUIRE_SCORE_SYNC=false`.

> `PREMATCH_REFRESH_RECALCULATE_PINNACLE=true` fuerza recálculo de `realProb` prematch justo antes de confirmar/apostar, consultando el feed de Pinnacle. El frontend mostrará el delta instantáneo de cuota/EV/stake/probabilidad en el modal de confirmación.

> Ventana híbrida recomendada para ingestas prematch: `PREMATCH_WINDOW_PRIMARY_HOURS=6` + `PREMATCH_WINDOW_PREFETCH_HOURS=6` con `PREMATCH_WINDOW_OVERLAP_MINUTES=30`. En la práctica descarga una ventana deslizante `now-30m -> now+12h`, priorizando el próximo bloque sin quedarte ciego en cambios de hora/latencia.

---

#### 🎯 Variables de Perfil Altenar (Bookie objetivo)

Estas variables se auto-escriben con `npm run book:dorado` o `npm run book:acity`. Pero si prefieres editarlas manualmente:

**Para DoradoBet:**
```env
BOOK_PROFILE=doradobet
ALTENAR_INTEGRATION=doradobet
ALTENAR_ORIGIN=https://doradobet.com
ALTENAR_REFERER=https://doradobet.com/deportes-en-vivo
```

**Para ACity:**
```env
BOOK_PROFILE=acity
ALTENAR_INTEGRATION=casinoatlanticcity
ALTENAR_ORIGIN=https://www.casinoatlanticcity.com
ALTENAR_REFERER=https://www.casinoatlanticcity.com/apuestas-deportivas
```

**Comunes a ambos (no cambiar salvo que el bookie cambie de país):**
```env
ALTENAR_COUNTRY_CODE=PE        # Código ISO del país de la cuenta
ALTENAR_CULTURE=es-ES           # Idioma de la API (no cambiar)
ALTENAR_TIMEZONE_OFFSET=300     # UTC-5 (Perú). GMT-4=240, GMT-6=360
ALTENAR_NUM_FORMAT=en-GB        # VITAL: garantiza decimales con punto (1.50 no 1,50)
ALTENAR_DEVICE_TYPE=1           # 1=Desktop. No cambiar.
ALTENAR_SPORT_ID=0              # 0=todos los deportes. 66=solo fútbol.
```

> **`ALTENAR_NUM_FORMAT=en-GB` es crítico.** Si usas `es-ES`, las cuotas llegan como `1,50` y el parser falla silenciosamente.

---

#### 🔐 Variables de Autenticación Booky (Para apuestas reales)

Esto es necesario **solo si quieres ejecutar apuestas reales**. En modo Paper Trading puedes omitir esta sección.

**Paso 1 — URL de acceso al bookie:**
```env
# DoradoBet:
ALTENAR_BOOKY_URL=https://doradobet.com/deportes-en-vivo

# ACity:
ALTENAR_BOOKY_URL=https://www.casinoatlanticcity.com/apuestas-deportivas#/overview
```
> Esta es la URL a la que Puppeteer navega para iniciar sesión y capturar el JWT.

**Paso 2 — Credenciales de tu cuenta:**
```env
ALTENAR_LOGIN_USERNAME=tu_email_o_usuario
ALTENAR_LOGIN_PASSWORD=tu_contraseña
```
> Se usan para el login automático con Puppeteer. Se leen en tiempo de ejecución del script, nunca se loggean.

**Paso 3 — Capturar el JWT real:**

Con las credenciales en `.env`, ejecuta:

```bash
# Abre Chrome, inicia sesión automáticamente y espera a que cierres la ventana
npm run token:booky:wait-close

# Alternativa: headless con timeout de 90 segundos
npm run token:booky:timeout
```

El script escribe automáticamente en tu `.env`:
```env
ALTENAR_BOOKY_AUTH_TOKEN=Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXV...
```

> **El JWT caduca en ~24-72h** dependiendo del bookie. Necesitarás renovarlo periódicamente con el mismo comando. Si `BOOKY_AUTO_TOKEN_REFRESH_ENABLED=true`, el sistema lo notifica automáticamente cuando queden menos de `BOOKY_TOKEN_MIN_REMAINING_MINUTES` minutos.

---

#### 🛡️ Variables de Seguridad — Guardas de Placement Real

```env
BOOKY_REAL_PLACEMENT_ENABLED=false
```
> **Esta variable es el interruptor principal.** Mientras sea `false`, el sistema NUNCA envía apuestas reales aunque el resto esté configurado. Cámbiala a `true` solo cuando hayas validado todo el flujo con dry-run.

```env
BOOKY_TOKEN_MIN_REMAINING_MINUTES=2
```
> Si el JWT tiene menos de X minutos de vida, el sistema rechaza el placement y notifica para renovar. Recomendado: `5` para mayor margen.

```env
BOOKY_MIN_EV_PERCENT=2
```
> EV mínimo para permitir placement real. Con `2`, solo apuesta si la ventaja esperada es ≥ 2%. Sube a `5` si quieres filtrar solo oportunidades de alta calidad.

```env
BOOKY_MAX_ODD_DROP=0.20
```
> Drop máximo de cuota desde el snapshot del ticket. Si la cuota bajó más de 20% entre cuando detectaste la oportunidad y cuando intentas apostar, el placement se rechaza. Recomendado: `0.15` para mercados volátiles.

```env
BOOKY_AUTO_TOKEN_REFRESH_ENABLED=true
```
> Activa el sistema de alertas automáticas cuando el token está por vencer.

```env
BOOKY_KEEP_REAL_PLACEMENT_ON_TOKEN_REFRESH=false
```
> Si `false` (recomendado): el sistema desactiva placements reales al detectar token vencido hasta renovación manual. Si `true`: intenta renovar y retomar solo (solo si `BOOKY_AUTO_TOKEN_REFRESH_ENABLED=true`).

---

#### 🧮 Variables del Matcher Pinnacle ↔ Altenar

```env
MATCH_DIAGNOSTIC_LOG=1
```
> Activa logs de diagnóstico del matcher. `0`=off (producción silenciosa), `1`=resumen por ciclo (recomendado para puesta en marcha), `2`=verbose por cada evento.

```env
MATCH_FUZZY_THRESHOLD=0.77
```
> Similitud mínima de Levenshtein entre nombres de equipo para considerar que son el mismo. Rango: `0.0–1.0`.
> - `0.90+` → muy estricto, pocos matches, casi sin falsos positivos.
> - `0.70–0.80` → equilibrado (recomendado).
> - `<0.65` → permisivo, más matches pero riesgo de falsos positivos.

```env
MATCH_MIN_ACCEPT_SCORE=0.60
```
> Score compuesto mínimo para dar por válido un match (combina similitud de nombre + ventana temporal + contexto de liga). Bajar a `0.50` si hay muchos eventos sin match en ligas menores.

```env
MATCH_TIME_TOLERANCE_MINUTES=5
```
> Ventana temporal primaria (en minutos) para buscar candidatos. Si Pinnacle dice que el partido empieza a las 15:00 y Altenar dice 15:04, con tolerancia de 5 se linked correctamente.
> - Subir a `10` si el diagnóstico muestra `time_window_5m` como razón dominante de no-match.
> - Bajar a `3` solo si tienes muchos falsos positivos por partidos cercanos en horario.

```env
MATCH_TIME_EXTENDED_TOLERANCE_MINUTES=30
```
> Ventana secundaria para candidatos con alta similitud de nombre. Permite matchear eventos con diferencia de horario maior (ajustes de timezone inesperados). No bajar de `20`.

---

#### 🧹 Variables de Housekeeping (Opcionales)

```env
BOOKY_BALANCE_REFRESH_MS=45000
```
> Cada cuántos milisegundos se refresca el balance real del bookie. `45000` = 45 segundos.

```env
BOOKY_HISTORY_REFRESH_MS=60000
```
> Frecuencia de sincronización del historial remoto de apuestas.

```env
BOOKY_HISTORY_RETENTION_DAYS=30
```
> Cuántos días de historial conservar en `db.json`. Apuestas más antiguas se purgan automáticamente.

```env
BOOKY_PROFILE_HISTORY_MAX_ITEMS=500
```
> Límite de entradas de historial por perfil en DB. Evita que `db.json` crezca indefinidamente.

```env
BOOKY_ORPHAN_ACTIVE_GRACE_MS=120000
```
> Ventana de gracia (ms) antes de considerar huérfana una apuesta activa sin `providerBetId`. Evita falsos positivos por latencia de sincronización.

```env
BOOKY_ORPHAN_ACTIVE_HARD_MAX_MS=1200000
```
> Límite duro (ms) para forzar saneo de activas huérfanas aunque no haya señal fuerte de error en el ticket.

---

### Paso 3: Resumen — ¿qué es obligatorio vs opcional?

| Variable / Paso | Paper Trading | Live Apuestas Reales |
|---|:---:|:---:|
| Cuenta Pinnacle activa | ✅ | ✅ |
| Cuenta DoradoBet o ACity con saldo | ❌ | ✅ |
| `BOOK_PROFILE` + `ALTENAR_*` | ✅ | ✅ |
| `ALTENAR_LOGIN_USERNAME` + `PASSWORD` | ❌ | ✅ |
| `ALTENAR_BOOKY_AUTH_TOKEN` | ❌ | ✅ |
| `BOOKY_REAL_PLACEMENT_ENABLED=true` | ❌ | ✅ |
| Guards (`BOOKY_MIN_EV_PERCENT`, etc.) | ❌ | ✅ Recomendado |
| `MATCH_*` (matcher tuning) | Opcional | Opcional |

> **Recomendación para nuevos usuarios:** arranca con Paper Trading (sin credenciales de bookie) durante al menos 3-5 días para validar que el matcher detecta correctamente los eventos en tu región antes de habilitar apuestas reales.

---

## 📦 Instalación y Despliegue

### Requisitos Previos

- **Node.js:** v18.0.0 o superior
- **npm:** v8.0.0 o superior
- **Sistema Operativo:** Windows, macOS o Linux
- **Chromium:** Instalado automáticamente por Puppeteer (primer arranque)
- **Memoria RAM:** Mínimo 4GB recomendado (2GB para Node.js + 2GB para Chromium)

### Instalación Rápida

```bash
# 1. Clonar repositorio
git clone https://github.com/tu-usuario/betsniper-v3.git
cd betsniper-v3

# 2. Instalar dependencias del Backend
npm install

# 3. Instalar dependencias del Frontend
cd client
npm install
cd ..

# 4. Configurar variables de entorno (opcional)
cp .env.example .env
# Editar .env si necesitas customizar puertos o configuraciones
```

### Estructura de Archivos Generados

El sistema creará automáticamente estos directorios y archivos en el primer arranque:

```
data/
├── pinnacle_live.json      # Feed en tiempo real de Pinnacle
├── pinnacle_token.json    # Headers de autenticación (auto-renovado)
└── pinnacle_stale.trigger # Flag para reinicio de socket (auto-generado)

db.json                     # Base de datos local (creada por LowDB)
```

### Modo de Ejecución: Arquitectura de 3 Terminales

Para operación completa, ejecuta estos comandos **en paralelo** (3 terminales diferentes):

#### **Terminal 1: Servidor Backend (Obligatorio)**

Levanta la API REST, la base de datos y el scanner de fondo.

```bash
npm run dev
```

**¿Qué hace?**
- Expone API en `http://localhost:3000`
- Ejecuta ingesta automática de Pinnacle/Altenar cada 2 horas
- Scanner de oportunidades Live en bucle (polling adaptativo según actividad)
- Monitoreo de apuestas activas y liquidación automática

**Logs Esperados:**
```
🚀 Servidor BetSniper V3 corriendo en http://localhost:3000
📝 Modo: development
🔄 Background Scanner Iniciado (Modo Seguro Anti-Ban) + AUTO-TRADING ACTIVO
⏰ [CRON] Ejecutando Ingesta Automática de Pinnacle...
```

---

#### **Terminal 2: Ingesta Pinnacle (Obligatorio para Live)**

Mantiene la conexión WebSocket con Pinnacle y guarda cuotas en tiempo real.

```bash
node services/pinnacleLight.js
```

**Primer Arranque (Autenticación):**
- Si no existe `data/pinnacle_token.json`, el script abrirá una ventana de **Chrome automáticamente**.
- **Acción Requerida:** Inicia sesión manualmente en Pinnacle en esa ventana.
- Una vez que navegues a la sección "Live Soccer", el script capturará los headers automáticamente.
- **Cierra la ventana de Chrome** cuando veas el mensaje `💾 Token actualizado en disco`.
- El script continuará solo con el WebSocket.

**Renovación Automática:**
- Si el token expira (cada ~1 hora), el script detecta y abre Chrome nuevamente.
- Repite el proceso de login manual.

**Logs Esperados:**
```
🚀 Starting Pinnacle Auth Scraper (Direct WS)...
✅ Headers cargados y válidos (Generados: 14:32:15).
🔌 Conectando al WebSocket...
✅ WebSocket Conectado! (Esperando frames...)
📡 FRAME: Straight - Updates: 12
💾 Datos guardados en disco (6 eventos).
```

---

#### **Terminal 3: Frontend (Obligatorio para UI)**

Levanta la interfaz React en modo desarrollo.

```bash
cd client
npm run dev
```

**URL:** `http://localhost:5173`

**Logs Esperados:**
```
VITE v5.0.0  ready in 324 ms

➜  Local:   http://localhost:5173/
➜  Network: use --host to expose
➜  press h + enter to show help
```

---

### Herramientas Opcionales (Debugging)

#### Flujo Booky (perfil, token, captura, smoke)

```bash
# 1) Seleccionar perfil operativo
npm run book:acity
# o
npm run book:dorado

# 2) Capturar token auth real (abre Chrome)
npm run token:booky:wait-close

# 3) Capturar payloads placeWidget/betslip
npm run capture:booky

# 4) Ver salud de token y flujo seguro (sin apostar real)
npm run smoke:booky

# 5) Saneo manual de activas huérfanas (si UI muestra EN JUEGO fantasma)
npm run cleanup:booky:orphans
```

Para pruebas con envío real controlado (solo si habilitas `BOOKY_REAL_PLACEMENT_ENABLED=true`):

```bash
npm run smoke:booky:live
```

> Recomendación: mantener `BOOKY_REAL_PLACEMENT_ENABLED=false` en desarrollo normal.

Opciones útiles del script de saneo:

```bash
# Solo salida JSON
npm run cleanup:booky:orphans -- --json

# Limpiar para un perfil concreto
npm run cleanup:booky:orphans -- --profile=acity

# Usar cache remoto (sin refresh forzado)
npm run cleanup:booky:orphans -- --refresh=false
```

#### Scanner Manual (Modo Observador)

Si quieres ver logs detallados de cada oportunidad detectada en tiempo real **sin interferir con el servidor**:

```bash
node scripts/scan_live.js --dry-run
```

**Nota Importante:** El flag `--dry-run` es **obligatorio** si el servidor ya está corriendo. De lo contrario, ambos procesos intentarían registrar apuestas simultáneamente (riesgo de duplicados).

**Salida:**
```
🟢 INICIANDO LIVE SNIPER (Intervalo: 60s) [MODO: OBSERVADOR (Dry Run)]...
   🛡️  Dry Run: No se ejecutarán apuestas, solo detección.
   🎯 Pinnacle Live Found: Home=1.155, Away=11.83 -> RealProb(away)=7.7%

🔥 OPORTUNIDADES EN VIVO DETECTADAS 🔥
┌─────┬──────────────────────┬───────┬──────┬──────────┬─────────┬─────┬──────────┬───────┐
│Match│ CS Constantine (F)   │ Score │ Time │ Strategy │ Real %  │ Odd │ Kelly $  │  EV   │
├─────┼──────────────────────┼───────┼──────┼──────────┼─────────┼─────┼──────────┼───────┤
│ ... │ Afak Relizane (F)    │ 1-0   │ 62'  │ LIVE_VAL │ 7.7%    │37.0 │ $12.30   │185.9% │
└─────┴──────────────────────┴───────┴──────┴──────────┴─────────┴─────┴──────────┴───────┘
```

#### Ingesta Manual de Datos

Si quieres forzar una actualización de la base de datos pre-match sin esperar al cron automático:

```bash
# Actualizar eventos de Altenar (DoradoBet)
node scripts/ingest-altenar.js

# Actualizar eventos de Pinnacle
node scripts/ingest-pinnacle.js
```

**Uso:** Ejecutar una vez al día o antes de sesiones de trading pre-match.

---

## 🖥️ Interfaz de Usuario (Dashboard)

### Vista General

El dashboard está diseñado para traders profesionales, con 6 pestañas especializadas:

```
┌─────────────────────────────────────────────────────────────────┐
│ 🎯 BetSniper V3         |Balance: S/1,234.56| ROI: +12.3%|      │
├─────────────────────────────────────────────────────────────────┤
│ [Pre-Match] [En Vivo] [Activas] [Historial] [Monitor] [Matcher]│
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [Contenido dinámico según pestaña seleccionada]               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

### 1. Pre-Match (Oportunidades Futuras)

**Propósito:** Detectar value bets en eventos que aún no han comenzado.

**Columnas:**
- **Partido:** Nombre del evento (Home vs Away).
- **Liga:** Competición y país.
- **Hora:** Fecha y hora de inicio (ajustada a timezone local).
- **PIN (Pinnacle):** Cuota "Fair" calculada sin margen.
- **ALT (Altenar):** Cuota ofrecida por DoradoBet.
- **EV%:** Valor Esperado (Expected Value). Ej: `15.2%` = Ganancia esperada por cada S/1 apostado.
- **Kelly:** Stake sugerido en soles (S/).
- **Acciones:** Botón `APOSTAR` (registra en Paper Trading).

**Filtros:**
- Mínimo EV: Solo mostrar ops con EV > 5%.
- Máximo Tiempo: Eventos en las próximas X horas.

---

### 2. EN VIVO (Live Opportunities)

**Propósito:** Oportunidades detectadas en partidos en curso.

**Indicadores Especiales:**
- **🔥 Badge Rojo:** "La Volteada" (favorito perdiendo).
- **⚡ Badge Verde:** Value Bet Live (discrepancia de cuota).
- **⚽ Badge Azul:** Next Goal (presión ofensiva).

**Información Adicional:**
- **Score Actual:** `1-0` (actualizado en tiempo real).
- **Minuto:** `67'` (sincronizado con Pinnacle).
- **Tarjetas Rojas:** 🟥 (si hay expulsiones, se desactiva "La Volteada").

**Ejemplo:**
```
┌───────────────────────────────────────────────────────────────────────┐
│ 🔥 LIVE SNIPE │ Tigres UANL vs Pumas     │ 0-1 │ 42' │ EV: 28% │ S/8 │
│ Favorito perdiendo. Prob Real: 62% | Cuota ALT: 2.20                  │
│ [📊 VER STATS]  [💰 APOSTAR]                                          │
└───────────────────────────────────────────────────────────────────────┘
```

---

### 3. ACTIVAS (Apuestas en Curso)

**Propósito:** Monitoreo en tiempo real de apuestas pendientes.

**Columnas:**
- **Partido:** Evento apostado.
- **Selección:** `Home` / `Draw` / `Away` (o línea específica si es Total).
- **Stake:** Monto apostado (S/).
- **Cuota:** Odd en el momento de la apuesta.
- **Score Actual:** Marcador en vivo (actualizado cada 5s).
- **Tiempo:** Minuto del partido.
- **Estado:** 
  - 🟢 `WINNING` (va ganando)
  - 🟡 `PENDING` (resultado incierto)
  - 🔴 `LOSING` (va perdiendo)
- **Potencial:** Ganancia si gana / Pérdida si pierde.

**Acciones:**
- Ver detalles (`🔍` Estadísticas completas del partido).
- Cash Out manual (deshabilitado en Paper Trading).

---

### 4. HISTORIAL (Bets Liquidadas)

**Propósito:** Análisis de rendimiento histórico.

**Métricas Agregadas (Header):**
```
Total Apostado: S/1,234.00 | Ganado: S/1,421.30 | ROI: +15.2% | Win Rate: 58.3%
```

**Tabla de Apuestas:**
- **Fecha:** Timestamp de ejecución.
- **Partido:** Evento.
- **Estrategia:** `PREMATCH` / `LIVE_SNIPE` / `LIVE_VALUE`.
- **Resultado:** ✅ `WON` / ❌ `LOST`.
- **P&L:** Profit/Loss en soles.

**Filtros:**
- Por fecha (últimos 7 días, 30 días, todo).
- Por estrategia.
- Por resultado (Solo ganadas / Solo perdidas).

**Exportación:** Botón `📥 Exportar CSV` para análisis externo.

---

### 5. MONITOR (Comparador de Cuotas)

**Propósito:** Vista profesional en tiempo real de todos los partidos en vivo.

**Layout:**
```
┌──────────────────────┬───────────────────────┬───────────────────────┐
│ PARTIDO / TIEMPO     │ PINNACLE (Live & Pre) │ ALTENAR (Bookie)      │
├──────────────────────┼───────────────────────┼───────────────────────┤
│ Liverpool vs Man Utd │  1   │  X  │  2       │  1   │  X  │  2       │
│ PIN: 72' │ 2-1       │ 1.45 │ 4.5 │ 7.2      │ 1.38 │ 4.8 │ 8.5      │
│ ALT: 72' │ 2-1       │ ▲    │ ●   │ ▼        │ ●    │ ●   │ ●        │
└──────────────────────┴───────────────────────┴───────────────────────┘
```

**Indicadores:**
- **▲ Verde:** Cuota subiendo (oportunidad potencial).
- **▼ Rojo:** Cuota bajando.
- **● Azul:** Cuota estable (pulsando = dato fresco).
- **Badges Morados:** Cuotas pre-match para referencia.

**Columnas Extra:**
- **PIN Goals / ALT Goals:** Mercados de Totales (Over/Under 2.5, 1.5, 3.5).

**Uso:** Detectar manualmente oportunidades que el scanner automático podría haber filtrado.

---

### 6. MATCHER (Vinculación Manual)

**Propósito:** Herramienta para que el usuario fuerce matches entre eventos de Pinnacle y Altenar que el sistema no pudo vincular automáticamente.

**Casos de Uso:**
- Nombres muy diferentes (ej: "Man City" vs "Manchester City FC").
- Ligas con nombres ambiguos.
- Eventos de ligas menores sin cobertura completa.

**Flujo:**
1.  Lista de eventos Altenar sin match.
2.  Buscar manualmente en lista de Pinnacle.
3.  Click en "VINCULAR".
4.  El sistema guarda el mapping en `db.json`.
5.  Futuras detecciones usarán este match guardado.

---

## 🔌 API Endpoints

El servidor expone los siguientes endpoints REST:

### **Oportunidades**

**`GET /api/opportunities/prematch`**
- **Descripción:** Retorna value bets pre-partido.
- **Respuesta:**
```json
{
  "success": true,
  "data": [
    {
      "eventId": 15234567,
      "match": "Real Madrid vs Barcelona",
      "league": "La Liga",
      "date": "2026-02-20T20:00:00.000Z",
      "pinnaclePrice": 2.15,
      "altenarPrice": 2.35,
      "realProb": 46.5,
      "ev": 9.3,
      "kellyStake": 12.50,
      "selection": "Home"
    }
  ]
}
```

**`GET /api/opportunities/live`**
- **Descripción:** Retorna oportunidades en tiempo real.
- **Cache:** 5 segundos.

**`POST /api/opportunities/discard`**
- **Body:** `{ "eventId": 123456 }`
- **Descripción:** Añade evento a blacklist (no volverá a mostrarse).

---

### **Portfolio (Paper Trading)**

**`GET /api/portfolio`**
- **Descripción:** Estado actual del bankroll.
- **Respuesta:**
```json
{
  "balance": 1234.56,
  "initialCapital": 1000.00,
  "activeBets": [
    {
      "id": "1708176543210",
      "match": "Tigres vs Pumas",
      "selection": "Home",
      "stake": 8.00,
      "odd": 2.20,
      "status": "PENDING",
      "score": "0-1",
      "liveTime": "42'"
    }
  ],
  "history": [...]
}
```

**`POST /api/portfolio/bet`**
- **Body:** Objeto de oportunidad completo.
- **Descripción:** Ejecuta apuesta manual (Paper Trading).

**`POST /api/portfolio/reset`**
- **Descripción:** Resetea portfolio a capital inicial.
- **⚠️ Peligro:** Borra todo el historial.

---

### **Monitor**

**`GET /api/monitor/live-odds`**
- **Descripción:** Feed comparativo Pinnacle vs Altenar.
- **Formato:** Array de eventos con odds anidadas.
- **Actualización:** Tiempo real (lee `pinnacle_live.json` + consulta Altenar).

---

### **Matcher**

**`GET /api/matcher/unlinked`**
- **Descripción:** Eventos de Altenar sin match Pinnacle.

**`POST /api/matcher/link`**
- **Body:** `{ "altenarId": 123, "pinnacleId": 456 }`
- **Descripción:** Fuerza vinculación manual.

---

### **Booky (Semi-Auto + Real Controlado)**

**`GET /api/booky/tickets`**
- Retorna tickets pendientes + histórico booky.

**`POST /api/booky/prepare`**
- Prepara ticket draft desde una oportunidad.

**`POST /api/booky/confirm/:id`**
- Confirma ticket en modo semi-auto (espejo en portfolio).

**`POST /api/booky/cancel/:id`**
- Cancela ticket draft.

**`GET /api/booky/token-health`**
- Estado del JWT real (`exp`, minutos restantes, autenticación).

**`POST /api/booky/token/renew`**
- Dispara renovación asistida de token.

**`GET /api/booky/account?refresh=1&historyLimit=60`**
- Snapshot de cuenta real por perfil (balance + historial remoto reconciliado).

**`GET /api/booky/capture/latest`**
- Última captura de payloads en `data/booky`.

**`POST /api/booky/real/dryrun/:id`**
- Construye payload final `placeWidget` sin enviar apuesta real.

**`POST /api/booky/real/confirm/:id`**
- Confirmación real estándar (con guardas).

**`POST /api/booky/real/confirm-fast/:id`**
- Confirmación real rápida con manejo de estado incierto y reintento controlado.

---

## ⚙️ Configuración Avanzada

### Variables de Entorno (`.env`)

```env
# Core
NODE_ENV=development
PORT=3000
TZ=America/Lima
DISABLE_BACKGROUND_WORKERS=false

# Altenar Profile (set-book-profile.js)
BOOK_PROFILE=doradobet
ALTENAR_INTEGRATION=doradobet
ALTENAR_ORIGIN=https://doradobet.com
ALTENAR_REFERER=https://doradobet.com/deportes-en-vivo
ALTENAR_COUNTRY_CODE=PE
ALTENAR_CULTURE=es-ES
ALTENAR_TIMEZONE_OFFSET=300
ALTENAR_NUM_FORMAT=en-GB
ALTENAR_DEVICE_TYPE=1
ALTENAR_SPORT_ID=0

# Overrides opcionales
# ALTENAR_WIDGET_BASE_URL=https://sb2frontend-altenar2.biahosted.com/api/widget
# ALTENAR_USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36
# ALTENAR_ACCEPT_LANGUAGE=es-ES,es;q=0.9,en;q=0.8

# Booky / Real Placement
# ALTENAR_BOOKY_URL=https://www.casinoatlanticcity.com/apuestas-deportivas#/overview
# ALTENAR_LOGIN_USERNAME=tu_usuario
# ALTENAR_LOGIN_PASSWORD=tu_password
# ALTENAR_BOOKY_AUTH_TOKEN=Bearer <jwt>
# BOOKY_REAL_PLACEMENT_ENABLED=false
# BOOKY_KEEP_REAL_PLACEMENT_ON_TOKEN_REFRESH=false
# BOOKY_AUTO_TOKEN_REFRESH_ENABLED=true
# BOOKY_TOKEN_MIN_REMAINING_MINUTES=2
# BOOKY_MIN_EV_PERCENT=2
# BOOKY_MAX_ODD_DROP=0.20

# Matcher diagnostics/tuning
# MATCH_DIAGNOSTIC_LOG=1
# MATCH_FUZZY_THRESHOLD=0.77
# MATCH_MIN_ACCEPT_SCORE=0.60
# MATCH_TIME_TOLERANCE_MINUTES=5
# MATCH_TIME_EXTENDED_TOLERANCE_MINUTES=30

# Housekeeping historial/cuenta booky (opcionales)
# BOOKY_BALANCE_REFRESH_MS=45000
# BOOKY_HISTORY_REFRESH_MS=60000
# BOOKY_HISTORY_RETENTION_DAYS=30
# BOOKY_PROFILE_HISTORY_MAX_ITEMS=500

# Rendimiento de endpoint prematch (opcional)
# PREMATCH_CACHE_TTL_MS=20000
```

#### Modo de Alta Carga (Sabadazo)

Para mantener el dashboard responsivo cuando sube mucho el volumen de partidos:

```env
DISABLE_BACKGROUND_WORKERS=false
DISABLE_LIVE_SCANNER=false
DISABLE_PREMATCH_SCHEDULER=true
DISABLE_PINNACLE_INGEST_CRON=true
DISABLE_MONITOR_DASHBOARD=true

# Perfil desbloqueo LIVE (temporal)
LIVE_SNIPE_REQUIRE_PINNACLE_LIVE=false
LIVE_VALUE_MIN_EV=0.01
LIVE_VALUE_REQUIRE_SCORE_SYNC=false
LIVE_VALUE_SCORE_SYNC_MAX_GOAL_DIFF=1
LIVE_VALUE_STABILITY_MIN_HITS=1
LIVE_VALUE_STABILITY_MIN_AGE_MS=1500
LIVE_GLOBAL_STABILITY_MIN_HITS=1
```

Luego, reinicia backend. En días normales vuelve ambos flags a `false`.

### Personalización de Risk Profiles

Editar `src/utils/mathUtils.js`:

```javascript
const RISK_PROFILES = {
  'PREMATCH_VALUE': 0.25,   // Cambiar a 0.30 para ser más agresivo
  'LIVE_VALUE': 0.125,      
  'LIVE_SNIPE': 0.10,       // Cambiar a 0.05 para ser ultra-conservador
};
```

### Ajuste de Filtros (Scanner)

Editar `src/services/scannerService.js`:

```javascript
// Línea ~135: Filtro de Stake Mínimo
ops = ops.filter(op => op.kellyStake >= 1.00); // Cambiar a 0.50 para capturar más ops
```

---

## � Guía de Scripts y Comandos

BetSniper incluye dos tipos de scripts: **comandos npm** (definidos en `package.json`, llamados con `npm run <nombre>`) y **scripts directos** (en `scripts/`, ejecutados con `node scripts/<archivo>.js`). Esta guía los organiza por función.

---

### 🧩 Comandos npm (package.json)

#### Servidor Principal

| Comando | Descripción |
|---|---|
| `npm start` | Arranca el servidor en modo producción (`node server.js`). Sin hot-reload. |
| `npm run dev` | Arranca el servidor en modo desarrollo con **nodemon** (reinicia al guardar archivos). Recomendado para desarrollo. |

---

#### Gestión de Perfil Booky

| Comando | Descripción |
|---|---|
| `npm run book:dorado` | Cambia el perfil activo a **DoradoBet** en `.env` (`BOOK_PROFILE`, `ALTENAR_INTEGRATION`, `ALTENAR_ORIGIN`, `ALTENAR_REFERER`). Sin reinicio de servidor. |
| `npm run book:acity` | Cambia el perfil activo a **ACity** (Casino Atlantic City) en `.env`. Sin reinicio de servidor. |

> Ejecutar siempre **antes** de capturar un token o hacer capture/spy, para que Puppeteer use el perfil correcto.

---

#### Extracción de Token JWT (Autenticación Booky)

| Comando | Modo | Descripción |
|---|---|---|
| `npm run token:booky` | Headed + timeout auto | Abre Chrome con sesión visual. Captura JWT automáticamente tras detectar login. Cierra sol en timeout. |
| `npm run token:booky:wait-close` | Headed + espera manual | Abre Chrome, captura JWT y **espera a que el usuario cierre la ventana** manualmente. Útil si el login requiere 2FA o captcha. |
| `npm run token:booky:dorado` | DoradoBet + headed | Igual que `token:booky` pero fuerza perfil DoradoBet aunque `.env` diga otra cosa. |
| `npm run token:booky:dorado:wait-close` | DoradoBet + manual | Combinación: perfil DoradoBet + espera manual de cierre. |
| `npm run token:booky:acity` | ACity + headed | Fuerza perfil ACity. |
| `npm run token:booky:acity:wait-close` | ACity + manual | ACity + espera manual. |

**¿Qué hace internamente?**
1. Lee `ALTENAR_BOOKY_URL`, `ALTENAR_LOGIN_USERNAME`, `ALTENAR_LOGIN_PASSWORD` del `.env`.
2. Abre Puppeteer, navega al bookie, inicia sesión automáticamente.
3. Intercepta la respuesta del servidor que contiene el JWT.
4. Valida que sea un token de usuario autenticado (no guest).
5. Escribe `ALTENAR_BOOKY_AUTH_TOKEN=Bearer eyJ...` en tu `.env`.

**Output esperado:**
```
✅ Login detectado. Capturando JWT...
🔑 JWT válido: usuario antho@ejemplo.com | Expira: 2026-03-03T14:22:00Z
💾 Token escrito en .env
```

---

#### Captura de Payload placeWidget

Necesario para entender qué envía el bookie cuando colocas una apuesta real (para construir el payload del `confirmRealPlacement`).

| Comando | Modo | Descripción |
|---|---|---|
| `npm run capture:booky` | Headed + perfil actual | Abre Chrome, navega al bookie, captura el payload `placeWidget`/betslip al hacer click en una apuesta. |
| `npm run capture:booky:headless` | Headless | Igual pero sin ventana visible. |
| `npm run capture:booky:dorado` | DoradoBet headed | ForZa perfil DoradoBet. |
| `npm run capture:booky:dorado:headless` | DoradoBet headless | Fuerza DoradoBet sin ventana. |
| `npm run capture:booky:acity` | ACity headed | Fuerza perfil ACity. |
| `npm run capture:booky:acity:headless` | ACity headless | ACity sin ventana. |

El payload capturado se guarda en `data/booky/capture-*.json` y queda disponible en `GET /api/booky/capture/latest`.

---

#### Spy de Historial y Perfil

| Comando | Descripción |
|---|---|
| `npm run spy:altenar` | Auto-detecta parámetros de integración del bookie (integration, countryCode, baseUrl) interceptando tráfico real. Útil si el bookie cambia su configuración. Guarda en `data/altenar-profile-*.json`. |
| `npm run spy:booky:history` | Abre Chrome (headed), navega al historial del bookie y captura las respuestas completas de los endpoints de balance e historial. Guarda en `data/booky/spy-history-*.json`. |
| `npm run spy:booky:history:headless` | Igual que el anterior pero headless con timeout de 120 segundos. |

---

#### Smoke Test del Flujo Booky

| Comando | Descripción |
|---|---|
| `npm run smoke:booky` | Ejecuta el flujo E2E completo en modo **seguro**: `token-health` → `account snapshot` → `prepare ticket` → `confirm-fast`. **No envía ninguna apuesta real** aunque `BOOKY_REAL_PLACEMENT_ENABLED=true`. |
| `npm run smoke:booky:live` | Igual pero pasa por el path de placement real (requiere `BOOKY_REAL_PLACEMENT_ENABLED=true` y EV ≥ 0%). Usar solo para validar el flujo completo en ambiente controlado. |
| `npm run health:latency` | Ejecuta un chequeo de latencia por muestras sobre endpoints críticos (`portfolio`, `live`, `prematch`, `booky/account`, `kelly-diagnostics`) para detectar freezes/event-loop blocking. |

> **Recomendación:** ejecutar `npm run smoke:booky` después de cada renovación de token para confirmar que el sistema está operativo.

---

### 📥 Scripts de Ingesta Manual (`scripts/`)

El servidor ejecuta estas ingestas automáticamente, pero puedes forzarlas manualmente:

#### `node scripts/ingest-altenar.js`
Actualiza el caché de eventos prematch de Altenar (DoradoBet) en `db.json`.
- **Smart skip:** si los datos tienen menos de 100 minutos, omite la ingesta automáticamente.
- **Forzar:** modifica la llamada internámente cambiando `force=true` o elimina `altenarLastUpdate` de `db.json`.
- **Cuándo usarlo:** antes de una sesión de trading prematch para asegurar datos frescos.

#### `node scripts/ingest-pinnacle.js`
Descarga y normaliza eventos prematch de Pinnacle Arcadia (REST) en `db.json`.
- Convierte cuotas americanas a decimales.
- Calcula probabilidades Fair (sin vig).
- **Cuándo usarlo:** una vez al día, o cada vez que quieras refrescar el caché prematch de Pinnacle.

Comandos recomendados:

```bash
# Modo normal (con flush incremental)
npm run ingest:pinnacle:force

# Modo seguro para OneDrive (sin flush incremental)
npm run ingest:pinnacle:safe
```

> Si operas sobre carpetas sincronizadas (OneDrive), usa `ingest:pinnacle:safe` para reducir colisiones de escritura (`EPERM/EBUSY`).

---

### 🔍 Scripts de Scanner Manual

#### `node scripts/scan_live.js [--dry-run]`
Ejecuta el scanner live en modo standalone (fuera del servidor) con bucle de 60 segundos.
- **`--dry-run` / `-d`:** modo observador — detecta oportunidades pero **no registra apuestas**. Usar siempre si el servidor ya está corriendo.
- Sin `--dry-run`: registra apuestas en `db.json` (usar solo si el servidor está detenido).

```bash
# Modo observador (recomendado con servidor activo)
node scripts/scan_live.js --dry-run

# Modo activo (solo si el servidor está detenido)
node scripts/scan_live.js
```

#### `node scripts/run_linker.js`
Ejecuta el scanner prematch en modo standalone.
- Lee `db.json` (cache de Pinnacle y Altenar).
- Cruza eventos y muestra oportunidades prematch detectadas.
- No registra apuestas. Solo diagnóstico.

```bash
node scripts/run_linker.js
```

---

### 🦵 Scripts de Diagnóstico de Base de Datos

#### `node scripts/check_db.js`
Muestra un resumen rápido del estado de `db.json`: cantidad de registros en cada colección (pinnacle, matches, scanned_prematch, etc.).

```bash
node scripts/check_db.js
# Output: Keys: ['config','upcomingMatches','portfolio',...]
# Pinnacle Count: 142
```

#### `node scripts/find_match_in_db.js <termino>`
Busca un equipo o partido en `db.json` y en `data/pinnacle_live.json` de forma recursiva.

```bash
node scripts/find_match_in_db.js "Liverpool"
node scripts/find_match_in_db.js "Tigres"
```

#### `node scripts/find_live_match.js`
Busca un partido específico en el feed live actual de Pinnacle (`data/pinnacle_live.json`).

#### `node scripts/check_linked_status.js`
Verifica el estado de linking de registros específicos en `db.json` (orientado a depurar por qué un partido concreto no se enlazó).

#### `node scripts/check_odds.js`
Muestra las cuotas almacenadas para un partido concreto, cruzando datos de Pinnacle y Altenar.

#### `node scripts/check_mapping.js`
Muestra entradas del diccionario `mappedTeams` en `db.json` para verificar alias guardados.

#### `node scripts/generate_full_report.cjs`
Genera un CSV completo (`reporte_completo_partidos.csv`) con todos los partidos de Pinnacle y Altenar, mostrando si están enlazados o no. Útil para auditar la calidad del matcher.

```bash
node scripts/generate_full_report.cjs
# Crea: reporte_completo_partidos.csv
```

---

### 🧹 Scripts de Mantenimiento de Portfolio

#### `node scripts/reset_database.js`
Restablece `db.json` a los valores por defecto (bankroll 100, historial vacío).
> ⚠️ **Destructivo:** borra todo el historial y apuestas activas. Úsa solo en desarrollo o para empezar desde cero.

```bash
node scripts/reset_database.js
```

#### `node scripts/force_settle_bets.js`
Liquida forzadamente apuestas activas que están atascadas en estado `PENDING`.
- Consulta la API de resultados de Altenar (`GetEventResults`) para obtener el score final.
- Aplica la lógica de ganancia/pérdida para cada tipo de pick (home, away, draw, over, under).
- Útil cuando el Zombie Protocol no pudo liquidar automáticamente.

```bash
node scripts/force_settle_bets.js
```

#### `node scripts/purge_invalid_bets.cjs`
Elimina manualmente apuestas con IDs de evento inválidos o corruptos de `db.json`.
- Los IDs a purgar están listados en el propio script (`TARGET_IDS`).
- Editar el array para añadir IDs si encuentras nuevas apuestas corruptas.

```bash
node scripts/purge_invalid_bets.cjs
```

#### `node scripts/fix_under_2_bets.cjs`
Repara apuestas Under con línea `under_0` (línea mal parseada). Extrae la línea real del campo `market` y corrige el `pick`.

```bash
node scripts/fix_under_2_bets.cjs
```

#### `node scripts/migrate_bankroll.js`
Escala el bankroll de `db.json` a un nuevo valor (por ejemplo de 1,000 a 10,000), aplicando el mismo factor a balance e historial proporcional.
- Editar el valor `newCapital` dentro del script antes de ejecutar.

```bash
node scripts/migrate_bankroll.js
```

---

### 🧪 Scripts de Testing y Mock

#### `node scripts/mock_pinnacle.js`
Genera un archivo `data/pinnacle_live.json` con datos ficticios (partidos de prueba como Man City vs Liverpool). Permite desarrollar y probar el scanner sin conexión real a Pinnacle.

```bash
node scripts/mock_pinnacle.js
# Crea datos de prueba en data/pinnacle_live.json
```

#### `node scripts/tmp-run-booky-confirm.mjs`
Ejecución directa de una confirmación de ticket booky para testing en caliente. Requiere editar el `ticketId` dentro del archivo antes de ejecutar.

```bash
node scripts/tmp-run-booky-confirm.mjs
```

---

### 🐞 Scripts de Debug (Herramientas de Desarrollo)

Scripts de diagnóstico genéricos. No forman parte del flujo normal de operación pero son útiles para investigar problemas en vivo:

| Script | ¿Cuándo usarlo? |
|---|---|
| `debug_live.js` | Ver estructura cruda del feed Altenar live (`GetLivenow`) |
| `debug_live_event.js` | Inspeccionar un evento live concreto con todos sus detalles |
| `debug_live_markets.js` | Ver mercados disponibles (abiertos/cerrados) en un evento live |
| `debug_live_names.js` | Ver nombres de equipos crudos tal como los devuelve Altenar |
| `debug_live_odds.js` | Comparar cuotas Altenar vs Pinnacle en un evento live |
| `debug_live_structure_v3.js` | Explorar la estructura JSON completa del endpoint live (versión actual) |
| `debug_matching.js` | Depurar por qué un par de equipos concretos no se está vinculando |
| `debug_matcher_specific.js` | Probar `findMatch()` con el cache de Pinnacle actual (`data/pinnacle_live.json`) |
| `debug_full_scan.js` | Ejecutar un scan completo de oportunidades con logging máximo |
| `debug_monitor_link.js` | Diagnosticar por qué el monitor no muestra cuotas de Arcadia (cuenta `linked` y `pinnacleFound`) |
| `debug_pinnacle_structure.js` | Ver estructura cruda de la respuesta de Pinnacle Arcadia |
| `debug_pinnacle_raw.js` | Ver respuesta HTTP raw de Pinnacle sin transformar |
| `debug_pinnacle_endpoints.js` | Probar diferentes endpoints de Pinnacle (matchups, odds, etc.) |
| `debug_pinnacle_markets.cjs` | Inspeccionar mercados disponibles en un evento de Pinnacle |
| `debug_pinnacle_match_info.cjs` | Ver información completa (teams, odds, status) de un partido Pinnacle |
| `debug_altenar_markets.js` | Inspeccionar los mercados (1X2, Totales, BTTS) de un evento Altenar |
| `debug_totals_structure.js` | Ver estructura de mercados Over/Under para verificar la normalización |
| `debug_scanner_v2.js` | Analizar el output del scanner paso a paso (versión actual) |
| `audit_date.js` | **Auditoría histórica del portfolio:** consulta `GetEventResults`, compara el score final real con el registrado en `db.json`, corrige estados WON/LOST erróneos y ajusta el balance. Acepta fecha como argumento. |

```bash
# Diagnóstico de matching:
node scripts/debug_matching.js
node scripts/debug_matcher_specific.js

# Diagnóstico de monitor/linking:
node scripts/debug_monitor_link.js
node scripts/debug_full_scan.js

# Auditoría histórica del portfolio (corrige scores/estados):
node scripts/audit_date.js 2026-03-01
```

---

### 📊 Resumen rápido: ¿qué ejecutar en cada situación?

| Situación | Comandos |
|---|---|
| **Arranque diario normal** | Terminal 1: `npm run dev` \| Terminal 2: `node services/pinnacleLight.js` \| Terminal 3: `cd client && npm run dev` |
| **Cambiar de bookie** | `npm run book:acity` o `npm run book:dorado` |
| **Renovar token JWT** | `npm run book:dorado` → `npm run token:booky:wait-close` |
| **Verificar que todo funciona** | `npm run smoke:booky` |
| **Ver oportunidades sin servidor activo** | `node scripts/scan_live.js --dry-run` |
| **Forzar actualización datos prematch** | `node scripts/ingest-altenar.js` + `node scripts/ingest-pinnacle.js` |
| **Apuesta atascada en PENDING** | `node scripts/force_settle_bets.js` |
| **Matcher no vincula un equipo** | `node scripts/debug_matching.js` o `node scripts/debug_matcher_specific.js` → añadir alias en `dynamicAliases.json` |
| **Score/resultado de apuesta incorrecto** | `node scripts/audit_date.js YYYY-MM-DD` (corrige estados en `db.json`) |
| **Auditar calidad del matcher** | `node scripts/generate_full_report.cjs` |
| **Reiniciar base de datos** | `node scripts/reset_database.js` |
| **Testear sin Pinnacle real** | `node scripts/mock_pinnacle.js` → `npm run dev` |

---

## �🚨 Troubleshooting

### Problema: "Chromium no se cierra"

**Síntoma:** Ventana de Chrome queda abierta indefinidamente.

**Causa:** El token de Pinnacle no se capturó correctamente.

**Solución:**
1.  Cierra manualmente la ventana de Chrome.
2.  Elimina el archivo: `rm data/pinnacle_token.json`
3.  Reinicia: `node services/pinnacleLight.js`
4.  Vuelve a iniciar sesión en Pinnacle cuando se abra Chrome.

---

### Problema: "No aparecen oportunidades en Frontend"

**Síntoma:** Pestañas "Pre-Match" y "En Vivo" vacías.

**Diagnóstico:**
1.  Verifica que los 3 procesos estén corriendo (Terminal 1, 2, 3).
2.  Revisa logs de Terminal 1 (servidor) buscando errores.
3.  Abre `http://localhost:3000/api/opportunities/live` directamente en navegador.

**Soluciones:**
- **Si la API devuelve `[]`:** El matcher no está vinculando eventos. Usa la pestaña "Matcher" para forzar links.
- **Si hay error 500:** Revisa que exist `data/pinnacle_live.json` y contenga datos.
- **Si `pinnacle_live.json` está vacío:** El proceso de Terminal 2 falló. Reinicia.

---

### Problema: "Latencia intermitente / pantallazos en carga"

**Síntoma:** a veces carga rápido y a veces todo timeout (capital, oportunidades, kelly card).

**Diagnóstico rápido:**

```bash
npm run health:latency
```

**Si aparecen timeouts intermitentes:**
1. Activa modo de alta carga (`DISABLE_PREMATCH_SCHEDULER=true`, `DISABLE_PINNACLE_INGEST_CRON=true`; opcional `DISABLE_MONITOR_DASHBOARD=true` si el monitor está abierto).
2. Reinicia backend.
3. Repite `npm run health:latency` y confirma que `portfolio/live` quedan estables.

---

### Problema: "Datos congelados (Stale Data)"

**Síntoma:** Monitor muestra tiempos desactualizados (ej: Altenar en minuto 75', Pinnacle en 70').

**Causa:** El WebSocket de Pinnacle dejó de recibir frames.

**Solución Automática:** El sistema detecta esto y crea `data/pinnacle_stale.trigger`, gatillando reinicio automático del socket.

**Solución Manual:**
1.  Detén Terminal 2: `Ctrl+C`
2.  Reinicia: `node services/pinnacleLight.js`

---

### Problema: "Apuestas Duplicadas"

**Síntoma:** Mismo evento aparece dos veces en "Activas".

**Causa:** Ejecutaste `scan_live.js` SIN el flag `--dry-run` mientras el servidor estaba corriendo.

**Prevención:** Usa **SIEMPRE** `--dry-run` si el servidor está activo.

**Limpieza:**
```javascript
// Abrir db.json y eliminar manualmente la entrada duplicada en activeBets[]
```

---

### Problema: "Token Booky inválido o vencido"

**Síntoma:** endpoints `/api/booky/real/*` responden `BOOKY_TOKEN_RENEWAL_REQUIRED`.

**Solución:**
1. Cambia al perfil correcto: `npm run book:acity` o `npm run book:dorado`.
2. Renueva token: `npm run token:booky:wait-close`.
3. Verifica estado: `GET /api/booky/token-health`.

---

### Problema: "No se confirmó placeWidget (estado incierto)"

**Síntoma:** respuesta `BOOKY_REAL_CONFIRMATION_UNCERTAIN`.

**Interpretación:** la casa pudo aceptar la apuesta, pero no devolvió confirmación definitiva (timeout/red).

**Acción recomendada:**
1. Revisar Open Bets/History en Booky.
2. Revisar `GET /api/booky/account?refresh=1`.
3. No reintentar ciegamente hasta validar si la apuesta ya existe.

---

## 🗺️ Roadmap

### V3.1 (Q1 2026)
- [ ] Integración con Telegram Bot para notificaciones en tiempo real.
- [ ] Exportación de historial a Excel/CSV.
- [ ] Gráficos de rendimiento (Chart.js).

### V3.2 (Q2 2026)
- [ ] Soporte para múltiples bookies (Betano, Inkabet).
- [ ] Machine Learning para predicción de líneas de cierre.
- [ ] Backtesting engine con datos históricos.

### V4.0 (Q3 2026)
- [ ] Modo Real Trading (conexión directa con APIs de bookies).
- [ ] Hedging automático (cobertura de riesgo).
- [ ] Multi-deporte (NBA, NFL, Tennis).

---

## 📄 Licencia

ISC License - Ver archivo `LICENSE` para detalles.

---

## ⚠️ Disclaimer

Este software está orientado a investigación cuantitativa, simulación y operación asistida. El módulo de ejecución real existe pero está **protegido por flags y validaciones** (`BOOKY_REAL_PLACEMENT_ENABLED`, guardas de token/valor). El trading deportivo involucra riesgo de pérdida de capital. Usa bajo tu propia responsabilidad.

---

## 🤝 Contribuciones

Pull requests son bienvenidos. Para cambios mayores, abre un issue primero para discutir qué te gustaría cambiar.

---

## 📧 Contacto

- **Autor:** BetSniper Architect
- **Repositorio:** [GitHub](https://github.com/tu-usuario/betsniper-v3)
- **Issues:** [Reportar Bug](https://github.com/tu-usuario/betsniper-v3/issues)

---

<div align="center">

**Construido con ❤️ para traders algorítmicos**

⭐ Si este proyecto te fue útil, considera darle una estrella en GitHub

</div>
