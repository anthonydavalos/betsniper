import Decimal from 'decimal.js';

// =====================================================================
// UTILIDADES MATEMÁTICAS FINANCIERAS (TRADING DEPORTIVO)
// =====================================================================

/**
 * Calcula la Probabilidad Implícita de una cuota (con Vig).
 * P = 1 / Cuota
 * @param {number} odd - La cuota decimal (ej: 1.90)
 * @returns {Decimal} - Probabilidad en formato decimal (0.0 - 1.0)
 */
export const getImpliedProbability = (odd) => {
  if (!odd || odd <= 0) return new Decimal(0);
  return new Decimal(1).div(odd);
};

/**
 * Elimina el Margen (Vig) de las cuotas para obtener las "Fair Odds" (Probabilidades Reales).
 * Normaliza las probabilidades para que sumen exactamente 100%.
 * @param {Object} odds - Objeto con cuotas { home: 2.0, draw: 3.5, away: 4.0 }
 * @returns {Object} - Objeto con probabilidades reales (%) { home: 48.5, draw: 27.2, away: 24.3 }
 */
export const calculateFairProbabilities = (odds) => {
  const { home, draw, away } = odds;
  
  // 1. Calcular probabilidades implícitas brutas
  const pHome = getImpliedProbability(home);
  const pDraw = getImpliedProbability(draw);
  const pAway = getImpliedProbability(away);

  // 2. Suma total (será > 1 debido al Vig de la casa)
  const totalImplied = pHome.plus(pDraw).plus(pAway);

  // 3. Normalizar (Regla de tres simple para eliminar el exceso)
  return {
    home: pHome.div(totalImplied).mul(100).toNumber(),
    draw: pDraw.div(totalImplied).mul(100).toNumber(),
    away: pAway.div(totalImplied).mul(100).toNumber()
  };
};

/**
 * Calcula el Valor Esperado (EV+)
 * EV = (ProbabilidadReal% * CuotaDorado) - 1
 * @param {number} realProbPercent - Probabilidad Real (ej: 55 para 55%)
 * @param {number} offeredOdd - Cuota ofrecida por la casa (ej: 2.10)
 * @returns {number} - EV % (ej: 15.5 para 15.5%)
 */
export const calculateEV = (realProbPercent, offeredOdd) => {
  const probability = new Decimal(realProbPercent).div(100);
  const ev = probability.mul(offeredOdd).minus(1);
  return ev.mul(100).toNumber();
};

// --- 3. GESTIÓN DE RIESGO AVANZADA (RISK PROFILES & RUIN CONTROL) ---
// Define la fracción de Kelly base para cada estrategia según su volatilidad
const RISK_PROFILES = {
  'PREMATCH_VALUE': 0.25,   // 1/4 Kelly (Baja Volatilidad, Alta Confianza)
  'LIVE_VALUE': 0.125,      // 1/8 Kelly (Media Volatilidad, Ruido de Mercado)
  'LIVE_SNIPE': 0.10,       // 1/10 Kelly (Alta Volatilidad, "Cisne Negro") - Equivale a ROR ~0%
  'MANUAL': 0.125,          // Default seguro
  'DEFAULT': 0.125
};

/**
 * Criterio de Kelly Ajustado por Sharpe Ratio y Volatilidad (Portfolio Theory)
 * En lugar de cortar arbitrariamente, aplica una función de utilidad logarítmica suavizada.
 * 
 * @param {number} realProbPercent - Probabilidad Real %
 * @param {number} odd - Cuota ofrecida
 * @param {number} bankroll - Bankroll TOTAL (NAV)
 * @param {string|number} strategyOrFraction - Estrategia o fracción manual
 * @param {number} correlationFactor - (0-1) Factor de correlación con apuestas existentes (Default 0.2)
 * @returns {Object} - { percentage: %, amount: $, fractionUsed: 0.125 }
 */
export const calculateKellyStake = (realProbPercent, odd, bankroll, strategyOrFraction = 'DEFAULT', correlationFactor = 0.2) => {
  // 1. Determinar fracción base (Risk Profile)
  let fraction = RISK_PROFILES['DEFAULT'];
  if (typeof strategyOrFraction === 'number') fraction = strategyOrFraction;
  else if (typeof strategyOrFraction === 'string') fraction = RISK_PROFILES[strategyOrFraction] || RISK_PROFILES['DEFAULT'];

  const p = new Decimal(realProbPercent).div(100);
  const b = new Decimal(odd).minus(1);
  const q = new Decimal(1).minus(p);

  // 2. Full Kelly: (bp - q) / b
  const fullKelly = b.mul(p).minus(q).div(b);
  
  // 3. Ajuste de Volatilidad (Simulación de Derivada Parcial)
  // En portafolios, el Kelly óptimo se reduce si hay correlación entre activos.
  // Formula aprox: f* = FullKelly / (1 + Correlation)
  // Si asumimos baja correlación (eventos independientes), el impacto es menor.
  // Pero en Live Betting, el 'market noise' correlaciona los fallos.
  const adjustedKelly = fullKelly.div(1 + correlationFactor);

  // 4. Aplicar Fractional Kelly (Preferencia de Riesgo del Usuario)
  let stakePercent = adjustedKelly.mul(fraction);
  
  // 5. Normalización de Probabilidad de Cola (Tail Risk)
  // En lugar de un corte duro (Hard Cap), usamos una función asintótica (Sigmoide) para suavizar
  // las apuestas gigantes hacia el límite seguro, sin "cortar" el valor matemático.
  // f(x) = MAX_CAP * (1 - e^(-x / MAX_CAP))
  // Esto permite que una ventaja MASIVA (ej. 20% edge) se acerque asintóticamente al Cap sin tocarlo,
  // mientras que ventajas pequeñas crecen linealmente.
  
  const MAX_ALLOCATION = 0.035; // Subimos el Hard Cap teórico a 3.5%
  const rawStake = stakePercent.toNumber();
  
  // Aplicar suavizado integral (Dampening)
  const dampenedStake = MAX_ALLOCATION * (1 - Math.exp(-rawStake / MAX_ALLOCATION));
  
  stakePercent = new Decimal(dampenedStake);

  if (stakePercent.isNegative()) stakePercent = new Decimal(0);
  
  return {
    percentage: stakePercent.toNumber() * 100, // Devolver en formato 5.5% para consistencia
    amount: parseFloat(stakePercent.mul(bankroll).toFixed(2)),
    fractionUsed: fraction,
    rawKelly: fullKelly.toNumber() // Para debug
  };
};
