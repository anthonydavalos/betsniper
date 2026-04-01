import altenarClient from '../src/config/axiosClient.js';
import { getAltenarPublicRequestConfig, maybeAutoRenewWidgetToken } from '../src/config/altenarPublicConfig.js';
import db, { initDB } from '../src/db/database.js';

import { fileURLToPath } from 'url';

const parsePositiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getPrematchHybridWindow = () => {
  const now = new Date();
  const primaryHours = parsePositiveNumber(process.env.PREMATCH_WINDOW_PRIMARY_HOURS, 6);
  const prefetchHours = parsePositiveNumber(process.env.PREMATCH_WINDOW_PREFETCH_HOURS, 6);
  const overlapMinutes = parsePositiveNumber(process.env.PREMATCH_WINDOW_OVERLAP_MINUTES, 30);
  const totalHours = primaryHours + prefetchHours;

  const startDate = new Date(now.getTime() - (overlapMinutes * 60 * 1000));
  const primaryEndDate = new Date(now.getTime() + (primaryHours * 60 * 60 * 1000));
  const finalEndDate = new Date(now.getTime() + (totalHours * 60 * 60 * 1000));

  return {
    now,
    startDate,
    primaryEndDate,
    endDate: finalEndDate,
    overlapMinutes,
    primaryHours,
    prefetchHours,
    totalHours
  };
};

export const ingestAltenarPrematch = async (force = false) => {
  await initDB();
  await db.read();

  const activeIntegration = altenarClient?.defaults?.params?.integration || 'unknown';

  // --- SMART SKIP LOGIC ---
  if (!force && db.data.altenarLastUpdate) {
      const lastRun = new Date(db.data.altenarLastUpdate).getTime();
      const nowMs = Date.now();
      const diffMins = (nowMs - lastRun) / 60000;
      
      if (diffMins < 100) { // 100 Minutos (1h 40m) de protección
          console.log(`⏳ INGESTA ALTENAR OMITIDA: Datos frescos (${diffMins.toFixed(1)} mins)`);
          return;
      }
  }

  console.log(`🚀 INICIANDO INGESTA MASIVA PRE-MATCH ALTENAR (${activeIntegration})...`);

  try {
    const windowCfg = getPrematchHybridWindow();
    const { now, startDate, primaryEndDate, endDate } = windowCfg;

    console.log(
      `🧭 Ventana híbrida Altenar: ${startDate.toISOString()} -> ${endDate.toISOString()} ` +
      `(primaria +${windowCfg.primaryHours}h, precarga +${windowCfg.prefetchHours}h, overlap ${windowCfg.overlapMinutes}m).`
    );
    console.log(`📡 Consultando API Altenar /GetUpcoming (objetivo hasta: ${endDate.toISOString()})...`);

    // Para ACity, esta configuración agrega Authorization automáticamente
    // (cuando corresponde) y mantiene consistencia de perfil sin cruces.
    const response = await altenarClient.get(
      '/GetUpcoming',
      getAltenarPublicRequestConfig({
        sportId: 66,
        _: Date.now()
      })
    );

    const events = response.data.events || [];
    if (events.length === 0) {
      console.log('⚠️ No se recibieron eventos de Altenar.');
      return;
    }

    console.log(`📦 Recibidos ${events.length} eventos crudos.`);

    // 2. Procesar y Limpiar Data
    // No necesitamos guardar TODA la basura relacional, solo lo útil para el cruce
    // Aplanamos la estructura aquí para que el Scanner sea rápido.
    
    // [NEW] Mapas de Ligas y Países (Relational Data)
    const champsMap = new Map();
    if (Array.isArray(response.data.champs)) {
        response.data.champs.forEach(c => champsMap.set(c.id, c.name));
    }

    const catsMap = new Map();
    if (Array.isArray(response.data.categories)) {
        response.data.categories.forEach(c => catsMap.set(c.id, c.name));
    }

    // Maps de Mercados y Odds
    const marketsMap = new Map((response.data.markets || []).map(m => [m.id, m]));
    const oddsMap = new Map((response.data.odds || []).map(o => [o.id, o]));

    const existingEvents = db.data.altenarUpcoming || [];
    const existingById = new Map(existingEvents.map(ev => [String(ev.id), ev]));
    const cleanEvents = [];

    for (const event of events) {
      // 🟢 FILTRO DE FECHAS (ventana híbrida deslizante)
      if (!event.startDate) continue;
      const eventDate = new Date(event.startDate);
      if (eventDate < startDate || eventDate > endDate) continue;

      // Extract League and Country names
      const leagueName = champsMap.get(event.champId) || "Unknown League";
      const countryName = catsMap.get(event.catId) || "Unknown Country";

      // Extraer cuotas 1x2, Totales y BTTS
      const odds = extractOdds(event, marketsMap, oddsMap);
      
      // Filtramos si no tiene al menos una cuota válida de algún tipo
      // Puede que solo tenga 1x2, o solo Totales, etc.
      // Modificamos para ser permisivos si hay ALGUNA información útil.
      const previous = existingById.get(String(event.id));
      const extractedHasDc = Boolean(
        odds?.doubleChance?.homeDraw || odds?.doubleChance?.homeAway || odds?.doubleChance?.drawAway
      );
      const mergedDoubleChance = extractedHasDc
        ? odds.doubleChance
        : (previous?.odds?.doubleChance || {});

      if (odds.home || odds.draw || odds.away || odds.totals.length > 0 || odds.btts.yes || extractedHasDc) {
        const cleanObj = {
          id: event.id,
          name: event.name,
          startDate: event.startDate,
          status: event.status, // 0 = Not started
          champId: event.champId,
          catId: event.catId,   // ID de Categoría/País
          league: leagueName,   // [NEW] Stored Name
          country: countryName, // [NEW] Stored Name
          competitors: event.competitorIds, // IDs para referencia futura
          odds: {
              home: odds.home,
              draw: odds.draw,
              away: odds.away,
              doubleChance: mergedDoubleChance,
              totals: odds.totals, // Array [{ line, over, under }]
              btts: odds.btts      // { yes, no }
          },
          lastUpdated: new Date().toISOString()
        };
        cleanEvents.push(cleanObj);
      }
    }

    // [DEBUG] Loguear muestra para verificar extracción de Liga/País
    if (cleanEvents.length > 0) {
        console.log(`\n🔍 MUESTRA DE DATOS EXTRAÍDOS (Evento #1):`);
        const sample = cleanEvents[0];
        console.log(`   - Evento: ${sample.name}`);
        console.log(`   - Liga: "${sample.league}"`);
        console.log(`   - País: "${sample.country}"`);
    }

    console.log(`✅ Filtrado: ${cleanEvents.length} eventos válidos (de ${events.length}).`);
    // Mantener eventos recientes de Altenar en memoria aunque desaparezcan del endpoint /Upcoming
    // LOGICA SIMPLIFICADA: Si es de HOY (00:00 - 23:59), se queda.
    
    const nowMs = Date.now();
    const NEAR_LIVE_GRACE_MS = 10 * 60 * 1000;
    const preserveStartMs = startDate.getTime() - NEAR_LIVE_GRACE_MS;
    const preserveEndMs = endDate.getTime();

    const keptEvents = existingEvents.filter(oldEv => {
      const oldDate = new Date(oldEv.startDate);
      const oldTs = oldDate.getTime();

      // Conservamos eventos de la ventana activa (con un pequeño margen hacia atrás)
      // para evitar huecos entre barridos y no resucitar ghost prematch lejanos.
      const inHybridWindow = Number.isFinite(oldTs) && oldTs >= preserveStartMs && oldTs <= preserveEndMs;
      const isReplaced = cleanEvents.some(newEv => newEv.id === oldEv.id);
      const isNearLiveOrPast = Number.isFinite(oldTs) && oldTs <= (nowMs + NEAR_LIVE_GRACE_MS);

      return inHybridWindow && isNearLiveOrPast && !isReplaced;
    });

    console.log(`   ♻️  Preservando ${keptEvents.length} eventos Altenar previos (ventana híbrida activa).`);
    console.log(`   🆕 Insertando/Actualizando ${cleanEvents.length} eventos frescos.`);

    const finalEventList = [...keptEvents, ...cleanEvents];
    finalEventList.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
    
    console.log(`💾 Guardando Total: ${finalEventList.length} eventos optimizados en DB...`);
    
    db.data.altenarUpcoming = finalEventList;
    db.data.lastUpdate = new Date().toISOString(); // Master update
    db.data.altenarLastUpdate = new Date().toISOString(); // Específico
    await db.write();

    console.log('✅ INGESTA ALTENAR COMPLETADA.');

  } catch (error) {
    maybeAutoRenewWidgetToken(error, 'ingestAltenarPrematch.GetUpcoming');
    console.error('❌ Error ingestion Altenar:', error.message);
  }
};

// Helper Unificado para extraer todas las cuotas
const extractOdds = (event, marketsMap, oddsMap) => {
  if (!event.marketIds) return { home: 0, draw: 0, away: 0, totals: [], btts: {} };

  const flattenMarketOddIds = (market) => {
    if (!market) return [];
    if (Array.isArray(market.oddIds)) return market.oddIds.filter(Boolean);
    if (Array.isArray(market.desktopOddIds)) return market.desktopOddIds.flat().filter(Boolean);
    if (Array.isArray(market.mobileOddIds)) return market.mobileOddIds.flat().filter(Boolean);
    return [];
  };

  const extractLineFromText = (value = '') => {
    const normalized = String(value).toLowerCase().replace(',', '.');
    const match = normalized.match(/(\d+(?:\.\d+)?)/);
    if (!match) return NaN;
    const line = parseFloat(match[1]);
    return Number.isFinite(line) ? line : NaN;
  };

  const upsertTotal = (line, side, price) => {
    if (!Number.isFinite(line) || !Number.isFinite(price) || price <= 1) return;
    let entry = result.totals.find(t => Math.abs(t.line - line) < 0.01);
    if (!entry) {
      entry = { line, over: 0, under: 0 };
      result.totals.push(entry);
    }
    if (side === 'over' && (!entry.over || entry.over <= 0)) entry.over = price;
    if (side === 'under' && (!entry.under || entry.under <= 0)) entry.under = price;
  };
  
    let result = { 
      home: 0, 
      draw: 0, 
      away: 0,
      doubleChance: {},
      totals: [], // Lista de lineas over/under encontradas
      btts: {}    // Both Teams To Score
  };

  for (const marketId of event.marketIds) {
    const market = marketsMap.get(marketId);
    if (!market) continue;

    // A) Mercado 1x2 (typeId 1 o name '1x2')
    if (market.typeId === 1 || market.name === '1x2') {
      for (const oddId of flattenMarketOddIds(market)) {
        const odd = oddsMap.get(oddId);
        if (odd) {
          if (odd.typeId === 1) result.home = odd.price;
          if (odd.typeId === 2) result.draw = odd.price; 
          if (odd.typeId === 3) result.away = odd.price; 
        }
      }
    }

    // B) Mercado Totales (typeId 18 o name 'Total')
    // [FIX] Filtrado Estricto de Mercados de Totales (Over/Under)
    // Ignorar "Team Total", "First Half Total", etc.
    const mName = (market.name || "").toLowerCase();
    
    // Whitelist
    const isValidTotal = market.typeId === 18;
    
    // Blacklist
    const forbidden = [
        'corner', 'esquina', 'card', 'tarjeta', 'half', 'mitad', 'tiempo', '1st', '2nd', '1er', '2do',
        'team', 'equipo', 'player', 'doble', 'btts', 'result', 'handicap', 'asian', 'exact', 'rest',
        'both', 'ambos', 'marca', 'combinada', 'combo', 'winning', 'ganador', 'margin',
        '1x2', 'multi', 'escala', 'rango', 'range',
        // Team Totals Keywords
        'local', 'visitante', 'home', 'away', 'casa', 'fuera', 'anota', 'score', 'portería'
    ];

    let isTeamTotal = false;
    if (isValidTotal) {
      const hasCompetitorBinding = Number.isFinite(Number(market.competitorId)) ||
        (Array.isArray(market.competitorIds) && market.competitorIds.length > 0);
      if (hasCompetitorBinding) isTeamTotal = true;

        // Check blacklist
        if (forbidden.some(word => mName.includes(word))) isTeamTotal = true;
        
        // Check Team Name Match
        if (!isTeamTotal && event.name) {
          const normalizeName = (str = '') => String(str)
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
          const cleanName = (str = '') => normalizeName(str).split(/\s+/).filter(w => w.length >= 2);
          const eventParts = String(event.name || '').split(/\s+vs\.?\s+/i);
          const homeParts = cleanName(eventParts[0] || '');
          const awayParts = cleanName(eventParts[1] || '');
            
            const stopWords = ['fc', 'sc', 'cd', 'ca', 'club', 'de', 'la', 'el', 'los', 'al', 'united', 'city', 'real', 'sport', 'res', 'u21', 'women', 'femenino'];

            if ([...homeParts, ...awayParts].some(part => {
                if (stopWords.includes(part)) return false; 
                return part.length >= 3 && mName.includes(part); 
            })) {
                isTeamTotal = true;
            }

            if (!isTeamTotal) {
              const oddTexts = (market.oddIds || [])
                .map(id => oddsMap.get(id))
                .filter(Boolean)
                .map(o => String(o.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));

              if (oddTexts.some(txt => [...homeParts, ...awayParts].some(part => part.length >= 3 && !stopWords.includes(part) && txt.includes(part)))) {
                isTeamTotal = true;
              }
            }
        }
    }

    if (isValidTotal && !isTeamTotal) {
          const marketLine = parseFloat(market.sv || market.sn || market.activeLine || market.specialOddValue);

          for (const oddId of flattenMarketOddIds(market)) {
            const odd = oddsMap.get(oddId);
            if (!odd) continue;

            const nameLower = String(odd.name || '').toLowerCase();
            const oddLine = extractLineFromText(nameLower);
            const lineVal = Number.isFinite(oddLine) ? oddLine : (Number.isFinite(marketLine) ? marketLine : NaN);

            if (!Number.isFinite(lineVal)) continue;

            if (odd.typeId === 12 || nameLower.includes('más') || nameLower.includes('over')) {
              upsertTotal(lineVal, 'over', odd.price);
            }

            if (odd.typeId === 13 || nameLower.includes('menos') || nameLower.includes('under')) {
              upsertTotal(lineVal, 'under', odd.price);
            }
          }
    }

    // C) Mercado BTTS (typeId 29 o name 'Ambos equipos marcan')
    if (market.typeId === 29 || (market.name && market.name.toLowerCase().includes('ambos teams'))) {
         let yesPrice = 0;
         let noPrice = 0;

         for (const oddId of flattenMarketOddIds(market)) {
             const odd = oddsMap.get(oddId);
             if (odd) {
                 // TypeId 74 = Yes, TypeId 76 = No (Segun Blueprint)
                 const nameLower = (odd.name || "").toLowerCase();
                 if (odd.typeId === 74 || nameLower === 'sí' || nameLower === 'yes') yesPrice = odd.price;
                 if (odd.typeId === 76 || nameLower === 'no') noPrice = odd.price;
             }
         }

         if (yesPrice > 0 && noPrice > 0) {
             result.btts = { yes: yesPrice, no: noPrice };
         }
    }

    // D) Mercado Double Chance (typeId 10 o nombre compatible)
    if (market.typeId === 10 || (market.name && /double chance|doble oportunidad/i.test(market.name))) {
      for (const oddId of flattenMarketOddIds(market)) {
        const odd = oddsMap.get(oddId);
        if (!odd || !Number.isFinite(Number(odd.price)) || Number(odd.price) <= 1) continue;

        // Mapeo estable por typeId del proveedor (9=1X, 10=12, 11=X2).
        if (Number(odd.typeId) === 9) {
          result.doubleChance.homeDraw = Number(odd.price);
          continue;
        }
        if (Number(odd.typeId) === 10) {
          result.doubleChance.homeAway = Number(odd.price);
          continue;
        }
        if (Number(odd.typeId) === 11) {
          result.doubleChance.drawAway = Number(odd.price);
          continue;
        }

        const nameCompact = String(odd.name || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/\s+/g, '');

        if (nameCompact.includes('1x') || nameCompact.includes('homedraw') || nameCompact.includes('localempate')) {
          result.doubleChance.homeDraw = Number(odd.price);
        }
        if (nameCompact.includes('12') || nameCompact.includes('homeaway') || nameCompact.includes('localvisitante')) {
          result.doubleChance.homeAway = Number(odd.price);
        }
        if (nameCompact.includes('x2') || nameCompact.includes('drawaway') || nameCompact.includes('empatevisitante')) {
          result.doubleChance.drawAway = Number(odd.price);
        }
      }
    }
  }

  // Mantener solo líneas completas (over+under)
  result.totals = result.totals.filter(t => t.over > 0 && t.under > 0);
  
  // Ordenar totales por linea para consistencia (1.5, 2.5, 3.5)
  result.totals.sort((a,b) => a.line - b.line);
  
  return result;
};

// Ejecución directa si se llama desde CLI (node scripts/ingest-altenar.js)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const force = process.argv.includes('--force');
    ingestAltenarPrematch(force);
}
