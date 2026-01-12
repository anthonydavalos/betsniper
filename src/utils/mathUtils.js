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

/**
 * Criterio de Kelly (Fraccional)
 * F = (bp - q) / b
 * Donde:
 * b = Cuota - 1
 * p = Probabilidad Real (0.0 - 1.0)
 * q = 1 - p (Probabilidad de perder)
 * 
 * @param {number} realProbPercent - Probabilidad Real %
 * @param {number} odd - Cuota ofrecida
 * @param {number} bankroll - Bankroll actual
 * @param {number} fraction - Fracción de Kelly (default 0.25 según Blueprint)
 * @returns {Object} - { percentage: %, amount: $ }
 */
export const calculateKellyStake = (realProbPercent, odd, bankroll, fraction = 0.25) => {
  const p = new Decimal(realProbPercent).div(100);
  const b = new Decimal(odd).minus(1);
  const q = new Decimal(1).minus(p);

  // Fórmula Full Kelly: (bp - q) / b
  const fullKelly = b.mul(p).minus(q).div(b);

  // Aplicar Fracción y asegurar que no sea negativo
  let stakePercent = fullKelly.mul(fraction);
  if (stakePercent.isNegative()) stakePercent = new Decimal(0);

  // Límite de seguridad (Max stake 5% por ejemplo, opcional pero recomendado)
  // Aquí usamos la matemática pura del blueprint
  
  return {
    percentage: stakePercent.mul(100).toNumber(),
    amount: stakePercent.mul(bankroll).toDecimalPlaces(2).toNumber()
  };
};
