# Retoques y Correcciones Técnicas: BetSniper V3

Este documento detalla exhaustivamente los problemas encontrados, las soluciones técnicas implementadas y las recomendaciones operativas derivadas de la fase de estabilización del sistema (14 de Enero, 2026).

---

## 1. Integración Crítica con Altenar (DoradoBet)

### 🔴 El Error: "Bad Request 400" en Ingesta Masiva
**Síntoma:** Aunque las peticiones individuales funcionaban, el script de ingesta masiva fallaba sistemáticamente con un código HTTP 400 al intentar traer la lista completa de eventos.
**Análisis Profundo:**
- Se identificó que el parámetro `eventCount` en la query string (usado anteriormente para limitar resultados) entraba en conflicto con la configuración actual del WSDK de Altenar cuando se combinaba con ciertos rangos de fechas.
- La API interpretaba la petición como mal formada al intentar paginar parámetros inconsistentes.

**✅ La Solución Técnica:**
- Se eliminó el parámetro `eventCount` de `ingest-altenar.js`.
- Se simplificó la petición para solicitar "todos los eventos disponibles" dentro del rango de tiempo, dejando que la API gestione el retorno natural (aprox. 700+ eventos).
- **Código Afectado:** `scripts/ingest-altenar.js`.

**💡 Recomendación:**
- No intentar trocear artificialmente las llamadas a Altenar (ej. "dame los primeros 10"). Es más estable pedir el bloque completo y filtrar en memoria localmente.

---

## 2. Limitaciones del Proveedor API-Sports (Pinnacle)

### 🔴 El Error: "Acceso Denegado / Plan Limit" por Ligas
**Síntoma:** Al intentar optimizar el sistema para buscar solo ligas "Top" (Premier League, La Liga), la API retornaba errores indicando que el plan gratuito no tiene acceso a datos de la temporada actual filtrados por liga.
**Análisis Profundo:**
- El plan gratuito de API-Sports ("Odds Endpoint") es extremadamente restrictivo.
- **Restricción 1:** Límite duro de peticiones por día (aprox 10-50 dependiendo de la carga).
- **Restricción 2:** No permite filtrar por `league_id` para temporadas activas de alto perfil sin pagar. Solo permite "dump" general de cuotas.

**✅ La Solución Técnica:**
- Se revirtió la lógica de "filtrado inteligente por liga" en `scripts/ingest.js`.
- Se implementó una estrategia de **"Paginación Defensiva"**: El script ahora solicita ciegamente las primeras 3 páginas de cuotas (aprox 50-60 partidos) y se detiene. Esto asegura que obtengamos *algo* de datos (benchmark) sin bloquear la cuenta por "Rate Limit".

**💡 Recomendación:**
- Para operación real a escala, es **imperativo** actualizar al plan "Basic" de API-Sports. Esto desbloqueará el filtrado por ligas y permitirá traer los 700 partidos necesarios para cruzar con toda la oferta de Altenar.

---

## 3. Lógica del "Linker" y Correcciones Matemáticas

### 🔴 El Error: Crash `TypeError: op.kellyStake.toFixed is not a function`
**Síntoma:** El script `run_linker.js` se detenía abruptamente al intentar mostrar la tabla de resultados en consola.
**Análisis Profundo:**
- La función de utilidad matemática `calculateKellyStake` fue refactorizada para devolver un objeto rico `{ percentage: 0.05, amount: 25.00 }` en lugar de un simple número.
- El script de visualización seguía tratando la variable como un número flotante, intentando llamar a `.toFixed(2)` sobre un objeto entero.

**✅ La Solución Técnica:**
- Se corrigió el acceso a la propiedad en `scripts/run_linker.js`.
- Cambio: De `op.kellyStake.toFixed(2)` a `op.kellyStake.amount.toFixed(2)`.

**💡 Recomendación:**
- Al modificar funciones "core" en `utils/math.js`, siempre auditar todos los consumidores (scripts de ingesta y endpoints de API) para asegurar compatibilidad de tipos.

### 🟡 El Desafío: Persistencia de IDs
**Situación:** ¿Cómo recordar que "Team A" es igual a "Team B" sin recalcularlo siempre?
**Solución:**
- El archivo `db.json` ahora actúa como memoria a largo plazo. Una vez que el Linker asocia un evento de Pinnacle con uno de Altenar, guarda el `altenarId` dentro del objeto de datos en la base de datos local. Las ejecuciones futuras verifican esto antes de intentar el emparejamiento por nombre difuso (Fuzzy Matching).

---

## 4. Escáner en Vivo y Transición a Producción

### 🔴 El Error: Falsos Positivos "Demo"
**Síntoma:** El sistema reportaba constantemente una oportunidad de arbitraje del 24% en "Manchester City vs Luton Town", independientemente de la hora o día.
**Análisis Profundo:**
- Existía un bloque de código "MOCK" (simulación) dentro de `scannerService.js` diseñado para pruebas de frontend cuando no hay partidos en vivo.
- Este código inyectaba datos falsos directamente en el flujo de procesamiento.

**✅ La Solución Técnica:**
- Se eliminó quirúrgicamente (o comentó) el bloque de inyección de datos Mock en `src/services/scannerService.js`.
- Se creó un script de validación `scripts/run_real_live_scan.js` que ejecuta una pasada única contra la API real para confirmar que no hay basura en la respuesta.

**💡 Recomendación:**
- Mantener los datos de prueba estrictamente separados en archivos `fakeData.js` y nunca "hardcodeados" en el servicio principal. Usar variables de entorno `NODE_ENV=test` si se requiere simulación.

---

## 5. Resumen del Flujo Operativo Estabilizado

Para garantizar la estabilidad diaria del sistema, se ha definido el siguiente protocolo secuencial estricto. Esto evita condiciones de carrera (intentar leer datos que no existen) y bloqueos de API.

1.  **Ingesta Altenar:** `node scripts/ingest-altenar.js` (Obtiene el volumen masivo, ~700 eventos).
2.  **Ingesta Pinnacle:** `node scripts/ingest.js` (Obtiene las cuotas justas de referencia, limitado por plan).
3.  **Vinculación (Linker):** `node scripts/run_linker.js` (Cruza ambas bases de datos y detecta Value Bets Pre-match).
4.  **Servidor (API):** `npm start` (Levanta el backend y el scanner en vivo en segundo plano).
5.  **Interfaz (Cliente):** `cd client && npm run dev` (Interfaz visual para el usuario).

---

**Estado Final:** El código actual en `scannerService.js`, `ingest-altenar.js`, y `run_linker.js` está limpio de errores de sintaxis y lógica conocidos, listo para operar bajo las restricciones de datos actuales.
