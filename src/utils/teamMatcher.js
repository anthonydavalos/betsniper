/**
 * UTILIDAD DE NORMALIZACIÓN Y MATCHING DE EQUIPOS
 * Combina limpieza de strings + Levenshtein Distance + Ventanas de Tiempo
 */

// Palabras "ruido" que no aportan identidad al equipo
const STOP_WORDS = [
    'fc', 'sc', 'sk', 'fk', 'club', 'cd', 'cf', 'ca',
    'u20', 'u21', 'u23', 'u19',
    '(f)', '(res.)', 'women', 'w', 'reserves',
    'olympic', 'belediye', 'spor', 'buyuksehir', 'bb'
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
    "coquimbo": "coquimbo unido"
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
  
  export const isTimeMatch = (dateStr1, dateStr2, toleranceMinutes = 1440) => { // Tolerancia ampliada a 24h (1440 min)
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
        
        // ROBUST SPLITTER: Split by " vs " or " vs. " or "vs" with surrounding spaces/tabs
        // Handles multiple spaces/tabs like "Wolfsburg               vs. FC St Pauli"
        const splitMatch = candidateNameRaw.match(/\s+vs\.?\s+/i);
        if (splitMatch) {
            candidateNameRaw = candidateNameRaw.split(splitMatch[0])[0];
        } else if (candidateNameRaw.includes(' vs ')) {
             candidateNameRaw = candidateNameRaw.split(' vs ')[0];
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
  
        // B. Inclusión
        if (normTarget.includes(normCandidate) || normCandidate.includes(normTarget)) {
             if (0.9 > highestScore) {
                 highestScore = 0.9;
                 bestMatch = { match: candidate, score: 0.9, method: 'includes' };
             }
        }
  
        // C. Levenshtein
        const score = getSimilarity(normTarget, normCandidate);
        if (score > highestScore) {
            highestScore = score;
            bestMatch = { match: candidate, score: score, method: 'fuzzy' };
        }
    }
  
    if (highestScore >= 0.65) {
        return bestMatch;
    }
  
    return null;
  };
