# Hallazgos y Lecciones Aprendidas: BetSniper V3 (Fases 1-5)

Este documento registra detalladamente las correcciones críticas, descubrimientos técnicos y patrones de diseño implementados durante el desarrollo del sistema, desde la arquitectura inicial hasta el despliegue de la interfaz de usuario.

---

## 🏗️ Fase 1: Arquitectura y Configuración Inicial

### 1. Estructura de Proyecto Monorepo (Híbrido)
**Hallazgo:** Inicialmente se planteó una estructura plana, pero rápidamente se evidenció la necesidad de separar claramente el Backend del Frontend para evitar conflictos de dependencias (`package.json`) y entornos de ejecución.
**Implementación:**
- Raíz: Backend (Node.js/Express) + Documentación.
- `/client`: Frontend (React/Vite).
- **Lección:** Mantener `node_modules` separados previene el "infierno de dependencias".

### 2. Base de Datos Local vs. Nube
**Decisión:** Se optó por `lowdb` (JSON local) en lugar de PostgreSQL/Mongo.
**Motivo:** La naturaleza de los datos es efímera (cuotas cambian segundos tras segundo). La persistencia a largo plazo no es prioritaria, pero la velocidad de lectura/escritura y la simplicidad de configuración sí lo son.
**Corrección:** Se implementó una estructura relacional dentro del JSON (`mappedTeams`, `upcomingMatches`) en lugar de guardar objetos gigantes duplicados.

---

## 🔌 Fase 2: Ingesta de Datos (El Protocolo "Inmortal")

Esta fue la fase más crítica donde ingeniería inversa fue necesaria para conectar con DoradoBet (Altenar).

### 1. El Error del Token de Autorización
**Error:** Intentar usar Bearer Tokens extraídos del navegador.
**Consecuencia:** El bot funcionaba por 15-30 minutos y luego moría con errores 401/403.
**Hallazgo Crítico:** La API de Altenar **NO requiere header Authorization** para datos públicos si se configuran correctamente los headers de origen.
**Solución (Protocolo Inmortal):**
- Eliminar por completo el header `Authorization`.
- Configurar estrictamente:
  - `integration: doradobet`
  - `Origin: https://doradobet.com`
  - `Referer: https://doradobet.com/`

### 2. Formato Numérico (Localización)
**Error:** Recibir cuotas como "1,50" (String con coma) rompía los cálculos matemáticos (`parseFloat` devuelve 1).
**Corrección:** Se añadió el parámetro `numFormat=en-GB` en todas las peticiones Axios. Esto fuerza a la API a devolver "1.50" (con punto), listo para operar matemáticamente.

### 3. Estructura de Datos Relacional (Parsing)
**Desafío:** La API de Altenar no devuelve un objeto bonito como:
```json
{ "evento": "Real Madrid vs Barça", "cuota": 1.5 }
```
Devuelve Arrays separados (`events`, `markets`, `odds`, `competitors`) unidos por IDs.
**Implementación:** Se creó una lógica de "Rehidratación" de objetos:
1. Crear Mapas (HashMaps) de Mercados y Cuotas por ID para acceso O(1).
2. Iterar Eventos -> buscar IDs de Mercados -> buscar IDs de Cuotas.
**Lección:** Nunca asumir estructuras anidadas en APIs de alto rendimiento (envían datos normalizados para ahorrar ancho de banda).

---

## 🧠 Fase 3: Algoritmos de Pareo (Matching)

### 1. Normalización de Nombres de Equipos
**Problema:** Pinnacle llama al equipo "Man City" y DoradoBet "Manchester City". El string match `===` fallaba siempre.
**Solución Refinada:**
- Se implementó una función de limpieza (`normalizeTeamName`) que:
  - Convierte a minúsculas.
  - Elimina acentos (Diacríticos).
  - Elimina palabras comunes inútiles ("fc", "cf", "cd", "utd", "united").
  - Elimina espacios extra.
- **Fuzzy Match casero:** Si la limpieza no basta, se revisa contención parcial de strings significativos.

### 2. Sincronización Temporal
**Error:** Descartar partidos porque la hora no coincidía exactamante.
**Hallazgo:** Las APIs pueden tener ligeras variaciones (segundos o minutos) o diferencias de Timezone mal interpretadas.
**Corrección:** Se implementó una ventana de tolerancia de 24 horas (excesiva, luego ajustada) para "Encontrar el partido de X equipo contra Y equipo en una fecha cercana". La clave es el **nombre de los rivales**, la fecha es secundaria para filtrar duplicados lejanos.

---

## 📉 Fase 4: Matemáticas Financieras (Cálculos)

### 1. Probabilidad Real vs. Implícita
**Concepto Clarificado:**
- *Probabilidad Implícita:* `1 / Cuota`. Incluye el margen de ganancia de la casa (Vig).
- *Probabilidad Real:* La probabilidad "justa" calculada eliminando el Vig de una casa afilada (Pinnacle).
**Corrección:** El cálculo del EV (Valor Esperado) **SIEMPRE** debe usar la Probabilidad Real de Pinnacle como base de verdad, comparada contra la Cuota ofrecida por la Soft Book (DoradoBet).

### 2. Criterio de Kelly Fraccional
**Ajuste de Riesgo:** El Kelly puro es muy agresivo y puede llevar a la ruina por varianza (`Drawdown`).
**Implementación:** Se aplicó un multiplicador fijo de `0.25` (Kelly/4) en el backend y frontend. Esto reduce la volatilidad manteniendo el crecimiento geométrico positivo.

---

## 🖥️ Fase 5: Interfaz Frontend y Despliegue

### 1. Errores de Rutas en Terminal (Windows)
**Error Recurrente:** `Error: CNT NOT FOUND` o `Syntax Error` al intentar correr comandos de backend en la carpeta de frontend.
**Causa:** Windows maneja los paths con backslash `\` y a veces las terminales (Git Bash / Powershell) se confunden si no se escapan. Además, el usuario frecuentemente olvidaba hacer `cd client`.
**Solución Procedimental:**
- **Regla de Oro:** Siempre verificar `pwd` (Current Working Directory).
- Uso de rutas absolutas con forward slashes `/` en los comandos automatizados para evitar ambigüedad.
- Correr Backend y Frontend en terminales separadas (o procesos background independientes).

### 2. Conectividad CORS (Cross-Origin Resource Sharing)
**Desafío:** El Frontend (Port 5173) no podía hablar con el Backend (Port 3000) por seguridad del navegador.
**Solución:** Aunque se puede configurar CORS en Express, la práctica moderna con Vite es configurar el Backend con headers permisivos inicialmente o usar un Proxy en desarrollo. En nuestro caso, habilitamos CORS en el servidor Express (`app.use(cors())`) para desarrollo rápido.

### 3. UX Reactiva
**Mejora:** El cálculo de "Cuánto apostar" (Stake) se movió al Frontend para ser dinámico.
**Motivo:** El usuario quiere cambiar su "Bankroll" en el input y ver **instantáneamente** cómo cambian los montos sugeridos sin recargar la página ni llamar al backend.

---

## ✅ Resumen de Arquitectura Final

1. **Ingesta:** `scanService.js` obtiene cuotas crudas (Pinnacle/Dorado).
2. **Procesamiento:** Normalización y cruce matemático (EV+).
3. **Persistencia:** `db.json` guarda el "Snapshot" actual.
4. **Presentación:** API Express sirve JSON -> React consume y renderiza tabla visual.

Este documento debe servir como referencia antes de realizar cambios estructurales en el futuro.
