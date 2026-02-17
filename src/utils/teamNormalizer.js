// Diccionario normalizado de equipos
// Clave: Nombre "sucio" de Altenar/DoradoBet
// Valor: Nombre "limpio" o estandarizado
export const TEAM_MAPPINGS = {
  // Altenar Name : API Sports Name
  "Man City": "Manchester City",
  "Man Utd": "Manchester United",
  "Woves": "Wolverhampton Wanderers",
  "Spurs": "Tottenham Hotspur",
  // Agrega aquí los casos que vayas descubriendo en los logs
};

/**
 * Normaliza el nombre de un equipo para facilitar el cruce de datos.
 * Aplica mapeo directo y limpieza básica de strings.
 * @param {string} rawName - Nombre que viene de Altenar
 * @returns {string} - Nombre normalizado
 */
export const normalizeTeamName = (rawName) => {
  if (!rawName) return '';

  let name = rawName.trim();
  
  // 1. Mapeo Directo (Diccionario)
  if (TEAM_MAPPINGS[name]) {
    return TEAM_MAPPINGS[name];
  }

  // 2. Limpieza Genérica
  // Eliminar categorías sub-algo (U20, U19, Sub-20)
  name = name.replace(/\sU\d+$/, ''); 
  name = name.replace(/\sSub-\d+$/, '');
  
  // Eliminar parternas comunes "FC", "CF" al final
  // Cuidado: A veces es parte real del nombre, esto es aproximado.
  // name = name.replace(/\sFC$/, '').replace(/\sCF$/, '');

  return name;
};

/**
 * Función de cruce difuso (Fuzzy Match) simplificada.
 * Si no hay match exacto, intenta ver si uno contiene al otro.
 * @param {string} altenarName 
 * @param {string} apiSportsName 
 */
export const isSameTeam = (altenarName, apiSportsName) => {
  const a = normalizeTeamName(altenarName).toLowerCase();
  const b = apiSportsName.toLowerCase();

  return a === b || a.includes(b) || b.includes(a);
};
