# 🎯 BetSniper V3 - Quantitative Sports Arbitrage Engine

**BetSniper V3** es un sistema automatizado de trading deportivo y arbitraje (Value Betting) de alta frecuencia. Su motor cruza datos en tiempo real entre un "Sharp Bookie" (Pinnacle/Arcadia) y un "Soft Bookie" (Altenar/DoradoBet) para identificar ineficiencias de mercado y ejecutar estrategias de valor esperado positivo (EV+).

## 🚀 Características Principales

### 🧠 Motor Cuantitativo (Quant Core)
*   **Simultaneous Kelly Criterion:** Gestión de bankroll avanzada que optimiza el tamaño de la apuesta basándose en la ventaja matemática (Edge) y la volatilidad, utilizando curvas de saturación asintótica para manejar apuestas simultáneas.
*   **Risk Profiles Dinámicos:** Asigna fracciones de Kelly específicas según la confianza de la estrategia:
    *   `PREMATCH`: 0.25 (Alta confianza, baja varianza).
    *   `LIVE_VALUE`: 0.125 (Varianza media, ruido de mercado).
    *   `LIVE_SNIPE`: 0.10 (Alta volatilidad, eventos de "cisne negro").
*   **NAV-Based Staking:** Calcula el tamaño de la posición basándose en el Valor Liquidativo Neto (Balance + Exposición Activa) para evitar la sub-inversión.

### 🕵️ Scanners & Estrategias
*   **Arcadia Gateway:** Ingesta de cuotas reales (Fair Odds) desde Pinnacle mediante WebSockets y Puppeteer, eliminando el margen de la casa (Vig) al vuelo.
*   **Live Snipe ("La Volteada"):** Detecta en tiempo real cuando un favorito pre-match va perdiendo por 1 gol entre el minuto 15-70, con métricas de dominancia (Posesión, Tiros) intactas.
*   **Zombie Protocol:** Sistema de auto-recuperación para liquidar apuestas de eventos que desaparecen de los feeds en vivo (partidos suspendidos o finalizados prematuramente).

## 🛠️ Stack Tecnológico

*   **Runtime:** Node.js (ES Modules)
*   **Frontend:** React + Vite + TailwindCSS
*   **Data Broker:** Puppeteer (Chrome Headless) + WebSockets
*   **Persistencia:** LowDB (JSON local de alto rendimiento)
*   **Cliente HTTP:** Axios (con configuración de evasión de huella digital y rotación de headers).

## 📂 Estructura del Proyecto

```
/
├── server.js                 # Entry point del Backend
├── altenarWSDK.js            # Referencia de la API de Altenar
├── PROJECT_BLUEPRINT.md      # Arquitectura y Reglas de Negocio
├── .github/copilot-instructions.md # Guía de estilo para IA
├── client/                   # Frontend (React)
├── db.json                   # Base de datos local
├── src/
│   ├── services/
│   │   ├── pinnacleGateway.js    # Gestor de concurrencia (Lockfiles)
│   │   ├── pinnacleLight.js      # Scraper ligero de Pinnacle
│   │   ├── liveScannerService.js # Lógica de "Live Snipes"
│   │   ├── paperTradingService.js# Motor de ejecución y Bankroll
│   │   └── ...
│   ├── utils/
│   │   ├── mathUtils.js          # Fórmulas financieras (Kelly, EV, Dampener)
│   │   ├── teamMatcher.js        # Lógica Fuzzy + Levenshtein
│   │   └── ...
│   └── routes/                   # API Endpoints
└── scripts/                  # Herramientas de mantenimiento y debugging
```

## 🔧 Instalación y Despliegue

### Requisitos Previos
*   Node.js v18+
*   Navegador Chromium (instalado automáticamente por Puppeteer)

### 1. Backend (Scanner & API)
```bash
# Instalar dependencias
npm install

# Iniciar el servidor (desarrollo)
npm run dev

# Ejecutar Scanners Específicos (Manual)
node scripts/scan_live.js      # Escaneo en vivo
node scripts/ingest-pinnacle.js # Actualizar cuotas base
```

### 2. Frontend (Dashboard)
```bash
cd client
npm install
npm run dev
```
Accede al dashboard en `http://localhost:5173`.

## 📈 Matemáticas del Sistema

El sistema no utiliza un corte arbitrario ("Hard Cap") para el riesgo. En su lugar, aplica una función de utilidad marginal decreciente:

$$ Stake_{Real} = Cap \cdot (1 - e^{-Stake_{Kelly} / Cap}) $$

Esto permite:
1.  **Escalabilidad:** Las apuestas con ventaja masiva (High Edge) reciben más capital.
2.  **Seguridad:** El crecimiento se satura suavemente al acercarse al límite de seguridad (aprox 3.5% del NAV), protegiendo contra la ruina (Risk of Ruin ~ 0%).

---
**Disclaimer:** Este software es una herramienta de investigación cuantitativa. El trading deportivo conlleva riesgo de pérdida de capital.
