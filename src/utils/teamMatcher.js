/**
 * UTILIDAD DE NORMALIZACIÓN Y MATCHING DE EQUIPOS
 * Combina limpieza de strings + Levenshtein Distance + Ventanas de Tiempo
 */

// Palabras "ruido" que no aportan identidad al equipo
const STOP_WORDS = [
    'fc', 'sc', 'sk', 'club', 'cd', 'cf', 
    'u20', 'u21', 'u23', 'u19',
    '(f)', '(res.)', 'women', 'w', 'reserves',
    'royal', 'real', 'sporting', 'athletic', 'atletico' // Opcional: A veces 'Real' distingue, pero en 'Real Madrid' vs 'Madrid' ayuda quitarlo.
  ];
  
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
  
    // 1. Quitar acentos: "Córdoba" -> "Cordoba", "Başakşehir" -> "Basaksehir"
    clean = clean.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  
    // 2. Normalizar Prefijos Árabes: "al-orobah" -> "al orobah"
    clean = clean.replace(/al-/g, "al ");
  
    // 3. Eliminar Stop Words con límites de palabra (\b) para no romper nombres reales
    // Ej: Elimina " fc" al final, o "(f)" en cualquier lado.
    STOP_WORDS.forEach(word => {
        // Escapar caracteres especiales para regex (como paréntesis)
        const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedWord}\\b`, 'g');
        clean = clean.replace(regex, '');
    });
  
    // 4. Limpieza final de espacios dobles y caracteres residuales
    clean = clean.replace(/\(|\)/g, '').replace(/\s+/g, ' ').trim();
  
    return clean;
  };
  
  /**
   * Calcula la Distancia de Levenshtein entre dos strings.
   * Retorna un número: pasos necesarios para transformar A en B.
   */
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
  
  /**
   * Calcula similitud (0 a 1) usando Levenshtein.
   * 1.0 = Idénticos.
   */
  export const getSimilarity = (s1, s2) => {
    const longer = s1.length > s2.length ? s1 : s2;
    if (longer.length === 0) return 1.0;
    return (longer.length - levenshteinDistance(s1, s2)) / longer.length;
  };
  
  /**
   * Compara fechas ignorando Zonas Horarias, basándose en UTC timestamps.
   * @param {string} dateStr1 ISO String (con offset o Z)
   * @param {string} dateStr2 ISO String (con offset o Z)
   * @param {number} toleranceMinutes Tolerancia en minutos
   */
  export const isTimeMatch = (dateStr1, dateStr2, toleranceMinutes = 20) => {
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
    // 1. Filtrar por TIEMPO (Paso Eficiente)
    const timeCandidates = candidatesList.filter(c => 
        isTimeMatch(targetDate, c.startDate || c.date)
    );
  
    if (timeCandidates.length === 0) return null;
  
    const normTarget = normalizeName(targetTeamName);
    let bestMatch = null;
    let highestScore = 0;
  
    // 2. Comparar Nombres
    for (const candidate of timeCandidates) {
        // A veces el candidato tiene .name (Altenar) o .home (Pinnacle)
        // Altenar viene como "Home vs Away", hay que extraer.
        let candidateNameRaw = candidate.home || candidate.name; 
        if (candidateNameRaw.includes(' vs ')) {
            candidateNameRaw = candidateNameRaw.split(' vs ')[0];
        }
  
        const normCandidate = normalizeName(candidateNameRaw);
  
        // A. Match Exacto post-normalización (Veloz)
        if (normTarget === normCandidate) {
            return { match: candidate, score: 1.0, method: 'exact' };
        }
  
        // B. Inclusión (Uno contiene al otro)
        // Ej: "Sheffield United" contiene "Sheffield"
        if (normTarget.includes(normCandidate) || normCandidate.includes(normTarget)) {
             // Inclusión es fuerte, pero damos un score de 0.9
             if (0.9 > highestScore) {
                 highestScore = 0.9;
                 bestMatch = { match: candidate, score: 0.9, method: 'includes' };
             }
        }
  
        // C. Levenshtein (Fuzzy)
        // Para "Orobah" vs "Orubah"
        const score = getSimilarity(normTarget, normCandidate);
        if (score > highestScore) {
            highestScore = score;
            bestMatch = { match: candidate, score: score, method: 'fuzzy' };
        }
    }
  
    // Umbral de Confianza: 0.70 (70% de similitud mínima)
    if (highestScore >= 0.65) {
        return bestMatch;
    }
  
    return null;
  };