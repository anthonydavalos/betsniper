import { PINNACLE_TO_ALTENAR_IDS } from './idMapping.js';

/**
 * UTILIDAD DE NORMALIZACIÓN Y MATCHING DE EQUIPOS
 * Combina limpieza de strings + Levenshtein Distance + Ventanas de Tiempo
 */

// Palabras "ruido" que no aportan identidad al equipo
const STOP_WORDS = [
    'fc', 'sc', 'sk', 'fk', 'club', 'cd', 'cf', 'ca',
    'u20', 'u21', 'u23', 'u19',
    '(f)', '(res.)', 'women', 'w', 'reserves',
    'olympic', 'olympique', 'belediye', 'spor', 'buyuksehir', 'bb',
    'borough', 'ketema', 'kenema', 'iii', 'ii', 'b', // 'b' para equipos B
    'clube', 'fa', 'jk', 'sv', 'ec', 'ac', 'ad', 'as', 'ss', 'esporte', 'futebol', 'wanderers', 'sp', // Sufijos comunes internacionales
    'brasil', 'brazil', // Nombres de paises que a veces se cuelan en el nombre del equipo
    'fr', 'bc', 'gnk', 'deportivo', 'msk', // Stop words adicionales (Botafogo FR, Atalanta BC, GNK Dinamo, Deportivo, MSK)
    // 'tzeirey', 'hapoel', 'maccabi', 'beitar', 'ironi', 'bnei', 'sectzia', 'ahva', // PREFIJOS ISRAELIES (Comentados para preservar identidad)
    // SUFIJOS DE ESTADOS BRASILEÑOS (CRÍTICOS para normalización)
    'mg', 'rs', 'rj', 'ce', 'ba', 'go', 'pr', 'df', 'es', 'ac', 'al', 'am', 'ap', 'ma', 'mt', 'ms', 'pa', 'pb', 'pe', 'pi', 'rn', 'ro', 'rr', 'se', 'to',
    // SUFIJOS INTERNACIONALES ADICIONALES
    'sk', 'nk', 'fk', 'calcio', 'unidos', 'united', 'city', 'town', 'bor.', 'borussia',
    // SUFIJOS NÓRDICOS / EUROPEOS
    'bk', 'if', 'pfc', 'fcm', 'kv', 'ik', 'ff', 'osk', 'afc', 'res', 'b'
  ];

// Alias conhecidos para corrección manual inmediata
export const TEAM_ALIASES = {
    // --- NUEVOS AGREGADOS (BATCH 1) ---
    "arminia bielefeld": "bielefeld",
    "bielefeld": "arminia bielefeld",
    "auckland reserves": "auckland fc b", // 'reserves' might be stripped?
    // "reserves" is in START_WORDS? No, STOP_WORDS.
    // If "Auckland FC Reserves" -> "auckland". "Auckland FC II" -> "auckland ii".
    // "ii" is also a stop word. So both become "auckland". They SHOULD match exact.
    // Why did they fail?
    // "Auckland FC II vs Bula" -> "auckland" vs "bula"
    // "Auckland FC Reserves vs. Bula FC" -> "auckland" vs "bula"
    // Exact match should have worked.
    // Let's re-check the log for that one.
    // "Auckland FC II" normalized: "auckland" (II removed).
    // "Auckland FC Reserves" normalized: "auckland" (Reserves removed).
    // Wait, let me check STOP_WORDS list again. 'reserves' is there. 'ii' is there.
    
    // --- ALEMANIA ---
    "arminia bielefeld": "bielefeld", 
    "bielefeld": "arminia bielefeld",
    "wsc hertha": "hertha wels",
    "hertha wels": "wsc hertha",
    
    // --- FRANCIA ---
    "bourg en bresse": "bourg peronnas",
    "bourg peronnas": "bourg en bresse",
    "le puy": "le puy foot",
    "le puy foot": "le puy",
    "villefranche": "villefranche beaujolais",
    "villefranche beaujolais": "villefranche",
    
    // --- ISRAEL ---
    "beitar tel aviv": "beitar tel aviv bat yam",
    "beitar tel aviv bat yam": "beitar tel aviv",
    "herzliya": "herzelia",
    "herzelia": "herzliya",
    "dimona": "dimona sport",
    "dimona sport": "dimona",
    "netanya kolet": "netanya kolet koen",
    "netanya kolet koen": "netanya kolet",
    
    // --- PAISES BAJOS ---
    "cambuur": "cambuur leeuwaarden",
    "cambuur leeuwaarden": "cambuur",
    "maastricht": "mvv maastricht",
    "mvv maastricht": "maastricht",
    "vitesse": "vitesse arnhem",
    "vitesse arnhem": "vitesse",
    
    // --- ITALIA ---
    // "carrarese": "carrarese calcio", // REMOVED to avoid loop mismatch
    "carrarese calcio": "carrarese",
    
    // --- ARGENTINA ---
    "talleres": "talleres de cordoba",
    "talleres de cordoba": "talleres",
    "newells": "newells old boys",
    "newells old boys": "newells",

    "mas taborsko": "taborsko",
    "taborsko": "mas taborsko",
    
    "jong utrecht": "utrecht", // res stripped
    "utrecht": "jong utrecht",
    
    "nxt": "brugge", 
    "brugge": "nxt",
    
    "ittihad bahrain": "ittihad",
    "ittihad": "ittihad bahrain",

    // --- ASIA / OTROS ---
    "dagon": "dagon star",
    "dagon star": "dagon",
    "gol gohar": "gol gohar sirjan",
    "gol gohar sirjan": "gol gohar",
    "umm hassam": "um alhassam",
    "um alhassam": "umm hassam",
    "zob ahan": "zob ahan isfahan",
    "zob ahan isfahan": "zob ahan",
    "we": "telecom egypt", // WE is the brand of Telecom Egypt
    "telecom egypt": "we",
    
    // --- GALES ---
    "briton ferry": "briton ferry llansawel",
    "briton ferry llansawel": "briton ferry",
    "rhyl": "cpd y rhyl 1879", // 1879 might remain if not strict digit removal
    "cpd y rhyl 1879": "rhyl",
    
    // --- RUMANIA ---
    "metaloglobus": "metaloglobus bucuresti",
    "metaloglobus bucuresti": "metaloglobus",
    "arges": "arges pitesti",
    "arges pitesti": "arges",
    
    // --- AZERBAIJAN ---
    "neftchi": "neftchi baku",
    "neftchi baku": "neftchi",
    "neftchi baku pfc": "neftchi",
    
    // --- BELGICA ---
    "charleroi": "royal charleroi chatelet farciennes",
    "royal charleroi chatelet farciennes": "charleroi",
    "olympic charleroi": "royal charleroi chatelet farciennes",
    "club nxt": "club brugge b", // Club NXT is simply the youth team name
    "club brugge b": "club nxt",
    "brugge kv": "club nxt", // Loose match but okay

    // --- MEXICO ---
    "tepatitlan": "tepatitlan de morelos",
    "tepatitlan de morelos": "tepatitlan",
    
    // --- AUSTRIA ---
    "lask": "lask linz",
    "lask linz": "lask",
    "traiskirchen": "traiskirchen fcm",
    "traiskirchen fcm": "traiskirchen",
    
    // --- MYANMAR ---
    "mahar": "sagaing", // Confirmed alias via user report
    "sagaing": "mahar",
    
    // --- COLOMBIA ---
    "international de bogota": "la equidad", // User report
    "la equidad": "international de bogota",
    
    // --- TUNEZ ---
    "js el omrane": "js omrane",
    "js omrane": "js el omrane",

    // --- URUGUAY / ARGENTINA ---
    "nacional de montevideo": "nacional",
    "nacional de football": "nacional",
    "instituto cordoba": "instituto", // AC removido por stop words
    "instituto ac cordoba": "instituto", // Por si acaso no se remueve

    // --- CORRECCIONES MANUALES USUARIO ---
    "dinamo": "dinamo zagreb", 
    "gnk dinamo": "dinamo zagreb",
    "deportivo guastatoya": "guastatoya", 
    
    // --- TURQUÍA ---
    "erzurum bb": "erzurumspor",
    "buyuksehir belediye erzurumspor": "erzurumspor",
    "rizespor": "caykur rizespor",
    "caykur rizespor": "rizespor",
    "besiktas jk": "besiktas",
    "fenerbahce sk": "fenerbahce",
    "galatasaray sk": "galatasaray",
    "kafr qasim shouaa": "kfar casem shua", // Hapoel removido por stop word
    "kfar casem shua": "kafr qasim shouaa",
    "hakoah amidar ramat gan": "hakoah ramat gan",
    "hakoah ramat gan": "hakoah amidar ramat gan",
    "yf juventus": "yf juventus zurich",
    "yf juventus zurich": "yf juventus",

    // --- MANUALES ANTHONY ---
    "fac wien": "floridsdorfer", // Target norm = floridsdorfer
    "floridsdorfer": "fac wien", 
    
    "imisli": "mil mugan",
    "mil mugan": "imisli",
    "tps akatemia": "turun palloseura",
    "turun palloseura": "tps akatemia",
    "kiryat yam": "kiryat yam", // MSK removido por stop words
    "hapoel rishon lezion": "hapoel rishon lezion", // FC removido

    // "al" es stop word (estado Brasil), asi que "Al Hussein" -> "hussein"
    "hussein irbid": "hussein", 
    "hussein": "hussein irbid",

    "la roche vf": "roche sur yon",
    "roche sur yon": "la roche vf",
    "chambly oise": "chambly",
    "chambly": "chambly oise",

    // --- EGIPTO ---
    "itesalat": "telecom egypt",
    "telecom egypt": "itesalat",
    "el daklyeh": "el dakhleya",
    "el dakhleya": "el daklyeh",
    "modern sport": "future",
    "future": "modern sport",

    // --- PAÍSES BAJOS (Jong / Res) ---
    "jong utrecht": "fc utrecht res",
    "fc utrecht res": "jong utrecht",
    "jong ajax": "ajax res",
    "ajax res": "jong ajax",
    "jong psv": "psv eindhoven res",
    "psv eindhoven res": "jong psv",
    "jong az": "az alkmaar res",
    "az alkmaar res": "jong az",

    // --- BRASIL ---
    "nacional de patos": "nacional pb",
    "nacional pb": "nacional de patos",
    "murici": "murici fc al",
    "murici fc al": "murici",
    
    // --- ITALIA ---
    "picerno": "az picerno",
    "az picerno": "picerno",
    "citta di pontedera": "pontedera",
    "pontedera": "citta di pontedera",
    "latina": "latina calcio 1932",
    "latina calcio 1932": "latina",

    // --- GRECIA y CHIPRE ---
    "volos": "volos nps",
    "volos nps": "volos",
    "aris limassol": "aris", // Cuidado con Aris Thessaloniki
    "apollon limassol": "apollon",
    "apollon": "apollon limassol",
    "apoel nicosia": "apoel",
    "apoel": "apoel nicosia",

    // --- NICARAGUA ---
    "club sport sebaco": "hyh export sebaco",
    "hyh export sebaco": "club sport sebaco",
    "hyh export sebaco fc": "club sport sebaco",

    // --- ESPAÑA (Filiales 3RFEF) ---
    "san sebastian reyes ii": "san sebastian reyes b",
    "san sebastian reyes b": "san sebastian reyes ii",
    "union adarve": "ad union adarve",
    "ad union adarve": "union adarve",
    "ce europa ii": "ce europa b",
    "ce europa b": "ce europa ii",

    // --- ITALIA ---
    "napoles": "napoli",
    "napoli": "napoles",
    "sporting trestina": "trestina",
    "trestina": "sporting trestina",
    "bologna": "bolonia",
    "bolonia": "bologna",
    "internazionale": "inter",
    "inter milan": "inter",

    // --- ALEMANIA ---
    "1. koln": "koln",
    "koln": "1. koln",
    "wolfsburg": "vfl wolfsburg",
    "vfl wolfsburg": "wolfsburg",
    "hertha bsc": "hertha berlin",
    "hertha berlin": "hertha bsc",
    "tsv havelse": "havelse",
    "havelse": "tsv havelse",
    "hoffenheim ii": "tsg hoffenheim ii", // Caso especial de reservas
    
    // --- FRANCIA ---
    "strasbourg": "estrasburgo",
    "estrasburgo": "strasbourg",
    "olympique lyon": "lyon",
    "olympique de marseille": "marseille",
    
    // --- ESPAÑA ---
    "logrones": "ud logrones",
    "ud logrones": "logrones",
    "elche ilicitano": "elche b",
    "elche b": "elche ilicitano",
    "ue porreres": "porreres",
    "porreres": "ue porreres",
    "fuerte san francisco": "fuerte san francisco morazan",
    "fuerte san francisco morazan": "fuerte san francisco",
    
    // --- HOLANDA ---
    "sparta rotterdam": "sparta de roterdam",
    "sparta de roterdam": "sparta rotterdam",
    
    // --- PORTUGAL ---
    "sporting cp": "sporting lisboa",
    "sporting lisboa": "sporting cp",
    
    // --- BÉLGICA ---
    "k beerschot va": "beerschot",
    "beerschot": "k beerschot va",
    "royal knokke fc": "royal knokke",
    "royal knokke": "royal knokke fc",

    // --- BRASIL ---
    "bragantino": "rb bragantino",
    "rb bragantino": "bragantino",
    "inter de limeira": "internacional limeira", 
    "internacional limeira": "inter de limeira",
    "sao jose ec sp": "sao jose",
    "sao jose": "sao jose ec sp",
    "centro sportivo alagoano": "csa",
    "csa": "centro sportivo alagoano",
    "tuntum ma": "tuntum",
    "tuntum": "tuntum ma",
    "iape ma": "iape",
    "iape": "iape ma",
    "capixaba sc es": "capixaba",
    "capixaba": "capixaba sc es",
    "academica vitoria": "aad vitoria tabocas", // aad no es stop word, pe sí.
    "aad vitoria tabocas": "academica vitoria",
    "betim": "betim", // Normalizacion betim = betim (ya sin futebol)
    "betim futebol": "betim",
    "guarany de bage": "guarany", // FC y RS son stop words
    "guarany": "guarany de bage", 
    "tirol": "atletas do tirol", // CF y CE son stop words
    "atletas do tirol": "tirol",
    
    // --- BRASIL ---
    "andraus brasil pr": "andraus",
    "andraus": "andraus brasil pr",
    "operario ferroviario": "operario", // PR es Stop Word
    "operario": "operario ferroviario",
    "america mineiro": "america", // MG es stop word
    "america": "america mineiro",

    // --- OTROS ---
    "chapelton": "chapelton maroons",
    "chapelton maroons": "chapelton",
    "ceilandia": "ceilandia", // Esporte clube removed
    "ceilandia esporte clube": "ceilandia",
    "inter fa": "inter formando un atleta",
    "inter formando un atleta": "inter fa",
    "cs cartagines": "cartagines",
    "cartagines": "cs cartagines",
    "mazatlan fc": "mazatlan",
    "mazatlan": "mazatlan fc",
    "chivas guadalajara": "guadalajara", // (F) is stripped
    "guadalajara": "chivas guadalajara",
    
    "havant & wville": "havant & waterlooville",
    "havant & waterlooville": "havant & wville",
    "ucv": "universidad central de venezuela", // UCV es el target (Pinnacle), Universidad... es el Candidate (Altenar)
    "universidad central de venezuela": "ucv", // Viceversa por si acaso

    // --- BARBADOS ---
    "kickstart rush": "kick start",
    "kick start": "kickstart rush",

    "dinamo bucuresti": "din bucarest",
    "din bucarest": "dinamo bucuresti",
    "ad san carlos": "san carlos",
    "san carlos": "ad san carlos",
    "penang fa": "penang",
    "penang": "penang fa",
    "d. concepcion": "deportes concepcion",
    "coquimbo unido": "coquimbo",
    "coquimbo": "coquimbo unido",
    "correcaminos de la uat iii": "correcaminos uat reserves",
    "hampton & richmond": "hampton and richmond borough"
};
  
  /**
   * Normaliza un nombre de equipo:
   * 1. Minúsculas y trim.
   * 2. Quita acentos (diacríticos).
   * 3. Estandariza "Al-" árabe.
   * 4. Elimina Stop Words.
   */
  export const normalizeName = (name) => {
    if (!name) return '';
    
    let clean = name.toLowerCase().trim();
  
    // 1. Quitar acentos y prefijos numéricos: "1. FC Koln" -> "FC Koln"
    clean = clean.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    clean = clean.replace(/^\d+\.\s*/, ''); // Remove "1. " at start

    // 2. Normalizar Prefijos Árabes: "al-orobah" -> "al orobah"
    clean = clean.replace(/al-/g, "al ");

    // 2.b Normalizar Símbolos: "&" -> "and", "." -> "" (U.A.T -> UAT), "-" -> " "
    clean = clean.replace(/&/g, " and ");
    clean = clean.replace(/\./g, "");
    clean = clean.replace(/-/g, " "); // Importante para América-MG -> América MG
  
    // 3. Eliminar Stop Words
    // MEJORA: Regex compatible con caracteres especiales como paréntesis: (f), (res.), etc.
    // Si la palabra contiene símbolos no-alfanuméricos, la escapamos y NO usamos boundaries \b
    STOP_WORDS.forEach(word => {
        const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Si la palabra contiene solo letras/numeros, usar boundary \b para evitar parciales (ej. 'u23' vs 'u230')
        // Si tiene simbolos (parentesis), buscar literal.
        const useBoundary = /^[a-z0-9]+$/i.test(word);
        
        const pattern = useBoundary ? `\\b${escapedWord}\\b` : escapedWord;
        const regex = new RegExp(pattern, 'g');
        clean = clean.replace(regex, '');
    });
  
    // 4. Limpieza final de espacios dobles y caracteres residuales
    clean = clean.replace(/['"().]/g, '').replace(/\s+/g, ' ').trim();

    return clean;
  };
  
  export const levenshteinDistance = (a, b) => {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            Math.min(
              matrix[i][j - 1] + 1,   // insertion
              matrix[i - 1][j] + 1    // deletion
            )
          );
        }
      }
    }
    return matrix[b.length][a.length];
  };
  
  export const getSimilarity = (s1, s2) => {
    const longer = s1.length > s2.length ? s1 : s2;
    if (longer.length === 0) return 1.0;
    return (longer.length - levenshteinDistance(s1, s2)) / longer.length;
  };

export const getTokenSimilarity = (name1, name2) => {
    const tokens1 = new Set(name1.split(/\s+/));
    const tokens2 = new Set(name2.split(/\s+/));
    
    // Intersección
    let intersection = 0;
    tokens1.forEach(t => {
        // Buscamos coincidencia exacta o muy cercana (plurales simples, leones vs leon)
        if (tokens2.has(t)) {
            intersection++;
        } else {
            // Check singular/plural simple (spanish/english)
            const singular = t.endsWith('s') ? t.slice(0, -1) : t;
            const plural = t + 's';
            if (tokens2.has(singular) || tokens2.has(plural)) intersection++;
        }
    });

    const union = new Set([...tokens1, ...tokens2]).size;
    return union === 0 ? 0 : intersection / union;
  };
  
  // Detecta discrepancias graves de categoría (Reservas, Femenino, Youth)
  const isCategoryMismatch = (rawTarget, rawCandidate, targetLeague = '') => {
      const t = rawTarget.toLowerCase();
      const c = rawCandidate.toLowerCase();
      const l = targetLeague ? targetLeague.toLowerCase() : '';

      // Lista de tokens peligrosos (sin espacios, validaremos con boundaries)
      // Separation: Tokens that can appear in League Name vs Tokens that must be in Team Name Only
      
      const FULL_CONTEXT_TOKENS = ['u20', 'u19', 'u21', 'u23', 'reserve', 'reserves', 'res.', 'women', '(f)', 'fem', 'femenil'];
      const TEAM_ONLY_TOKENS = ['ii', 'iii', 'b', '(a)']; // 'b' in league name is dangerous (Serie B)

      const allTokens = [...FULL_CONTEXT_TOKENS, ...TEAM_ONLY_TOKENS];
      
      for (const token of allTokens) {
          // Regex con boundaries para evitar falsos positivos ("club" contiene "b" -> falso)
          // Escapar caracteres especiales como "." en "res." o "()" en "(f)"
          const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`(^|\\s|\\()${escapedToken}($|\\s|\\))`, 'i');
          
          // Determine if we should check League context
          const checkLeague = FULL_CONTEXT_TOKENS.includes(token);

          // Check Target (Team Name OR League Name if allowed)
          const tHas = regex.test(t) || (checkLeague && regex.test(l));
          const cHas = regex.test(c);
          
          if (tHas !== cHas) {
              // Excepción: Si uno es "Women" y el otro "(F)" se considera igual.
              const isWomenVar = (token === 'women' || token === '(f)' || token === 'fem' || token === 'w' || token === 'femenil');
              if (isWomenVar) {
                   const rWomen = /(^|\s|\()(women|femenil|\(f\)|fem|w)($|\s|\))/i;
                   // Re-evaluate with broad regex including League context for Target IF checkLeague is true (it is for women)
                   const tIsFem = rWomen.test(t) || rWomen.test(l);
                   const cIsFem = rWomen.test(c);
                   if (tIsFem === cIsFem) continue; 
              }

              // Excepción: Reservas y Equipos B (II, b, res, reserve, u23, (a))
              const isReserveVar = (token === 'reserve' || token === 'reserves' || token === 'res.' || token === 'ii' || token === 'b' || token === 'u23' || token === '(a)');
              if (isReserveVar) {
                   const rRes = /(^|\s|\()(reserve|reserves|res\.|ii|b|u23|\(a\))($|\s|\))/i;
                   // Aqui es tricky. Si 'b' fue detectado en team-only, tHas es true.
                   // Si 'b' no fue detectado en team, tHas es false.
                   // Pero si re-evaluamos con rRes que incluye todo, podríamos re-introducir el error de Serie B.
                   
                   // New Logic: Check mismatch type independently
                   // If tHas (detected correctly based on token type) != cHas
                   
                   // Si el token original era 'b', NO queremos checkear l con rRes en el re-eval.
                   // Solo si el token original era de FULL_CONTEXT.

                   // Simplificación: Si ya detectamos un mismatch con la lógica fina de arriba, confiamos en ella.
                   // PERO, el problema es si token="b" (mismatch porque uno tiene 'b' y otro 'ii').
                   // Si uno tiene 'b' y otro 'ii', no son iguales para el token loop, pero SI semánticamente.
                   
                   // Cross-check all reserve keywords
                   // Check Team Names ONLY for strict tokens, Team+League for context tokens
                   
                   const hasReserveKeyword = (str, leagueStr) => {
                       // 1. Check Team Only Tokens in NAME ONLY
                       for (const k of TEAM_ONLY_TOKENS) {
                            const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const rx = new RegExp(`(^|\\s|\\()${esc}($|\\s|\\))`, 'i');
                            if (rx.test(str)) return true;
                       }
                       // 2. Check Context Tokens in NAME OR LEAGUE
                       for (const k of FULL_CONTEXT_TOKENS) {
                            const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const rx = new RegExp(`(^|\\s|\\()${esc}($|\\s|\\))`, 'i');
                            if (rx.test(str) || (leagueStr && rx.test(leagueStr))) return true;
                       }
                       return false;
                   };
                   
                   const tIsRes = hasReserveKeyword(t, l);
                   const cIsRes = hasReserveKeyword(c, ''); // Candidate doesn't have league context usually provided here
                   
                   if (tIsRes === cIsRes) continue; 
              }
              
              return true; // Mismatch detectado real
          }
      }
      return false;
  };

  export const isTimeMatch = (dateStr1, dateStr2, toleranceMinutes = 5) => { // Tolerancia reducida a 5m (Estricta)
    const d1 = new Date(dateStr1).getTime();
    const d2 = new Date(dateStr2).getTime();
    const diffMs = Math.abs(d1 - d2);
    const diffMins = diffMs / (1000 * 60);
    return diffMins <= toleranceMinutes;
  };
  
  /**
   * FUNCIÓN PRINCIPAL DE CRUCE
   * @param {string} targetTeamName - Nombre del equipo buscado (Pinnacle)
   * @param {string} targetDate - Fecha ISO del evento
   * @param {Array} candidatesList - Lista de eventos de Altenar
   * @param {number|string} [targetId] - (Opcional) ID de participante en Pinnacle para match directo
   * @param {string} [targetLeague] - (Opcional) Nombre de la liga (Pinnacle) para contexto (Women, Reserves)
   */
  export const findMatch = (targetTeamName, targetDate, candidatesList, targetId = null, targetLeague = '') => {
    const isDebug = false; // Set true if needed

    // 0. Match Directo por ID (Priority #1)
    if (targetId) {
        const mappedAltenarId = PINNACLE_TO_ALTENAR_IDS[targetId];
        if (mappedAltenarId) {
            // Buscamos si algún candidato (evento) tiene este competitorId
            // Como candidatesList son eventos, y un evento tiene 'competitors' array de IDs
            const exactIdMatch = candidatesList.find(c => 
                c.competitors && c.competitors.includes(mappedAltenarId) &&
                isTimeMatch(targetDate, c.startDate || c.date) // Aun validamos tiempo por seguridad
            );

            if (exactIdMatch) {
                return { match: exactIdMatch, score: 1.0, method: 'id_map_direct' };
            }
        }
    }

    // 1. Filtrar por TIEMPO (Paso Eficiente)
    const timeCandidates = candidatesList.filter(c => 
        isTimeMatch(targetDate, c.startDate || c.date)
    );
  
    const normTarget = normalizeName(targetTeamName);
    const aliasTarget = TEAM_ALIASES[normTarget]; 
    
    let bestMatch = null;
    let highestScore = 0;

    // Solo ejecutamos la lógica estricta si hay candidatos en la ventana principal
    if (timeCandidates.length > 0) {
  
    // 2. Comparar Nombres
    for (const candidate of timeCandidates) {
        let candidateNameRaw = candidate.home || candidate.name; 
        const originalCandidateName = candidateNameRaw; // Backup para check de categoría

        // ROBUST SPLITTER: Split by " vs " or " vs. " or "vs" with surrounding spaces/tabs
        // Handles multiple spaces/tabs like "Wolfsburg               vs. FC St Pauli"
        const splitMatch = candidateNameRaw.match(/\s+vs\.?\s+/i);
        if (splitMatch) {
            candidateNameRaw = candidateNameRaw.split(splitMatch[0])[0];
        } else if (candidateNameRaw.includes(' vs ')) {
             candidateNameRaw = candidateNameRaw.split(' vs ')[0];
        }

        // 0. SAFETY CHECK: Categoría (Evita Reserves vs Pro, Women vs Men)
        // Usamos el nombre YA EXTRACTO (Home) para evitar falsos positivos con el Away (Ej. Getafe B)
        // Pasamos targetLeague para que "Women" en liga contectualice al equipo
        if (isCategoryMismatch(targetTeamName, candidateNameRaw, targetLeague)) {
             // console.log(`Ignorando mismatch categoría: ${targetTeamName} vs ${candidateNameRaw}`);
             continue;
        }

        const normCandidate = normalizeName(candidateNameRaw);
        
        // A. Match Exacto (Resolución Completa de Aliases)
        const strictTarget = TEAM_ALIASES[normTarget] || normTarget;
        const strictCand = TEAM_ALIASES[normCandidate] || normCandidate;

        if (strictTarget === strictCand) {
            return { match: candidate, score: 1.0, method: 'alias_strict_resolved' };
        }

        // A. Match Exacto (Legacy - redundante pero seguro)
        if (normTarget === normCandidate) {
            return { match: candidate, score: 1.0, method: 'exact' };
        }

        // A.2 Aliases (Legacy - cubierto por arriba pero mantenemos por si acaso)
        if (aliasTarget && aliasTarget === normCandidate) {
             return { match: candidate, score: 1.0, method: 'alias' };
        }
        if (TEAM_ALIASES[normCandidate] === normTarget) {
             return { match: candidate, score: 1.0, method: 'alias_reverse' };
        }
  
        // B. Token Matching (Mejorado sobre .includes)
        // Reemplaza la lógica simple de includes que causaba "Club Leon" == "Leones Negros"
        const tokenScore = getTokenSimilarity(normTarget, normCandidate);
        if (tokenScore >= 0.5) { // al menos 50% de overlap de palabras
             // Si target es corto (1 palabra), requiere 100% de esa palabra (exactitud)
             // "Leon" vs "Leones" -> tokenScore bajo si no matchea plural.
             
             if (tokenScore > highestScore) {
                 highestScore = tokenScore;
                 bestMatch = { match: candidate, score: tokenScore, method: 'token_match' };
             }
        }
  
        // C. Levenshtein
        const score = getSimilarity(normTarget, normCandidate);
        if (score > highestScore) {
            highestScore = score;
            bestMatch = { match: candidate, score: score, method: 'fuzzy' };
        }
    }
  
    if (highestScore >= 0.77) {
        return bestMatch;
    }
    } // END of strict window matching check
  
    // --- FALLBACK: Búsqueda con ventana de tiempo ampliada (30 min) ---
    // Si no hubo match fuerte, intentamos buscar en una ventana más amplia (30 min)
    // PERO SOLO ACEPTAMOS:
    // 1. Coincidencia EXACTA de nombres normalizados.
    // 2. Coincidencia de ALIAS conocido.
    {
        const EXTENDED_WINDOW = 30; // 30 minutos
        console.log(`DEBUG Extended: Buscando en ventana ${EXTENDED_WINDOW}m para ${targetTeamName}`);
        const extendedCandidates = candidatesList.filter(c => {
             const inWindow = isTimeMatch(targetDate, c.startDate || c.date, EXTENDED_WINDOW);
             const alreadyChecked = isTimeMatch(targetDate, c.startDate || c.date, 5);
             if (inWindow && !alreadyChecked) console.log(`  -> Candidato aceptado para extended: ${c.home || c.name}`);
             return inWindow && !alreadyChecked;
        });

        for (const candidate of extendedCandidates) {
             let cName = candidate.home || candidate.name; 
             const splitMatch = cName.match(/\s+vs\.?\s+/i);
             if (splitMatch) cName = cName.split(splitMatch[0])[0];
             else if (cName.includes(' vs ')) cName = cName.split(' vs ')[0];

             if (isCategoryMismatch(targetTeamName, cName, targetLeague)) continue;
             const nCand = normalizeName(cName);
             
             // RESOLUCIÓN DE ALIAS DOBLE (Extended Window)
             const rTarget = TEAM_ALIASES[normTarget] || normTarget;
             const rCand = TEAM_ALIASES[nCand] || nCand;

             // A. Match Exacto (Nombre Normalizado o Alias)
             if (rTarget === rCand) {
                 return { match: candidate, score: 0.99, method: 'exact_extended_resolved' };
             }
        }
    }

    return null;
  };
