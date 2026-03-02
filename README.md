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
- [Instalación y Despliegue](#-instalación-y-despliegue)
- [Interfaz de Usuario](#-interfaz-de-usuario-dashboard)
- [API Endpoints](#-api-endpoints)
- [Configuración Avanzada](#-configuración-avanzada)
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
```

Para pruebas con envío real controlado (solo si habilitas `BOOKY_REAL_PLACEMENT_ENABLED=true`):

```bash
npm run smoke:booky:live
```

> Recomendación: mantener `BOOKY_REAL_PLACEMENT_ENABLED=false` en desarrollo normal.

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
```

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

## 🚨 Troubleshooting

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
