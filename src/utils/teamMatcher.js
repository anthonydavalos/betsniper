/**
 * UTILIDAD DE NORMALIZACIÓN Y MATCHING DE EQUIPOS
 * Combina limpieza de strings + Levenshtein Distance + Ventanas de Tiempo
 */

// Palabras "ruido" que no aportan identidad al equipo
const STOP_WORDS = [
    'fc', 'sc', 'sk', 'fk', 'club', 'cd', 'cf', 'ca',
    'u20', 'u21', 'u23', 'u19',
    '(f)', '(res.)', 'women', 'w', 'reserves',
    'olympic', 'belediye', 'spor', 'buyuksehir', 'bb',
    'borough', 'ketema', 'kenema', 'iii', 'ii', 'b', // 'b' para equipos B
    'tzeirey', 'hapoel', 'maccabi', 'beitar', 'ironi', 'bnei', 'sectzia', 'ahva' // PREFIJOS ISRAELIES COMUNES (Evitan matches falsos por prefijo)
    // 'royal', 'real', 'sporting', 'athletic', 'atletico' -> COMENTADO POR SEGURIDAD
  ];

// Alias conhecidos para corrección manual inmediata
const TEAM_ALIASES = {
    "itesalat": "telecom egypt",
    "telecom egypt": "itesalat",
    "el daklyeh": "el dakhleya",
    "el dakhleya": "el daklyeh",
    "erzurum bb": "erzurumspor",
    "buyuksehir belediye erzurumspor": "erzurumspor",
    "rizespor": "caykur rizespor",
    "caykur rizespor": "rizespor",
    "napoles": "napoli",
    "napoli": "napoles",
    "sporting trestina": "trestina",
    "trestina": "sporting trestina",
    "1. koln": "koln",
    "koln": "1. koln",
    "havant & wville": "havant & waterlooville",
    "havant & waterlooville": "havant & wville",
    "wolfsburg": "vfl wolfsburg",
    "vfl wolfsburg": "wolfsburg",
    "sparta rotterdam": "sparta de roterdam",
    "sparta de roterdam": "sparta rotterdam",
    "bragantino": "rb bragantino",
    "rb bragantino": "bragantino",
    "sporting cp": "sporting lisboa",
    "sporting lisboa": "sporting cp",
    "inter de limeira": "internacional limeira", 
    "internacional limeira": "inter de limeira",
    "sao jose ec sp": "sao jose",
    "sao jose": "sao jose ec sp",
    "deportes concepcion": "d. concepcion",
    "d. concepcion": "deportes concepcion",
    "centro sportivo alagoano": "csa",
    "csa": "centro sportivo alagoano",
    "coquimbo unido": "coquimbo",
    "coquimbo": "coquimbo unido",
    // NUEVOS ALIAS
    "elche ilicitano": "elche b",
    "elche b": "elche ilicitano",
    "hertha bsc": "hertha berlin",
    "hertha berlin": "hertha bsc",
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

    // 2.b Normalizar Símbolos: "&" -> "and", "." -> "" (U.A.T -> UAT)
    clean = clean.replace(/&/g, " and ");
    clean = clean.replace(/\./g, "");
  
    // 3. Eliminar Stop Words
    STOP_WORDS.forEach(word => {
        const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedWord}\\b`, 'g');
        clean = clean.replace(regex, '');
    });
  
    // 4. Limpieza final de espacios dobles y caracteres residuales
    clean = clean.replace(/\(|\)/g, '').replace(/\s+/g, ' ').trim();

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

  // Calcula similitud de tokens (palabras completas)
  const getTokenSimilarity = (name1, name2) => {
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
  const isCategoryMismatch = (rawTarget, rawCandidate) => {
      const t = rawTarget.toLowerCase();
      const c = rawCandidate.toLowerCase();

      // Lista de tokens peligrosos que deben coincidir si aparecen
      const CRITICAL_TOKENS = ['u20', 'u19', 'u21', 'u23', 'reserve', 'res.', 'women', '(f)', 'fem', 'ii', 'iii', ' b ']; // ' b ' con espacios para evitar subset
      
      for (const token of CRITICAL_TOKENS) {
          const tHas = t.includes(token);
          const cHas = c.includes(token);
          
          if (tHas !== cHas) {
              // Excepción: Si uno es "Women" y el otro "(F)" se considera igual.
              const isWomenVar = (token === 'women' || token === '(f)' || token === 'fem');
              if (isWomenVar) {
                   const tIsFem = t.includes('women') || t.includes('(f)') || t.includes('fem');
                   const cIsFem = c.includes('women') || c.includes('(f)') || c.includes('fem');
                   if (tIsFem === cIsFem) continue; // Ambos son femeninos
              }
              return true; // Mismatch detectado
          }
      }
      return false;
  };

  export const isTimeMatch = (dateStr1, dateStr2, toleranceMinutes = 180) => { // Tolerancia reducida a 3h (180 min) para mayor precisión
    const d1 = new Date(dateStr1).getTime();
    const d2 = new Date(dateStr2).getTime();
    const diffMs = Math.abs(d1 - d2);
    const diffMins = diffMs / (1000 * 60);
    return diffMins <= toleranceMinutes;
  };
  
  /**
   * FUNCIÓN PRINCIPAL DE CRUCE
   */
  export const findMatch = (targetTeamName, targetDate, candidatesList) => {
    const isDebug = false; // Set true if needed

    // 1. Filtrar por TIEMPO (Paso Eficiente)
    const timeCandidates = candidatesList.filter(c => 
        isTimeMatch(targetDate, c.startDate || c.date)
    );
  
    if (timeCandidates.length === 0) return null;
  
    const normTarget = normalizeName(targetTeamName);
    const aliasTarget = TEAM_ALIASES[normTarget]; 
    
    let bestMatch = null;
    let highestScore = 0;
  
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
        // Usamos targetTeamName original y originalCandidateName
        if (isCategoryMismatch(targetTeamName, originalCandidateName)) {
             // console.log(`Ignorando mismatch categoría: ${targetTeamName} vs ${originalCandidateName}`);
             continue;
        }

        const normCandidate = normalizeName(candidateNameRaw);

        // A. Match Exacto
        if (normTarget === normCandidate) {
            return { match: candidate, score: 1.0, method: 'exact' };
        }

        // A.2 Aliases
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
  
    return null;
  };
