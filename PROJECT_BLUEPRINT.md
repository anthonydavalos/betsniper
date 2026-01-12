# PROJECT BLUEPRINT: BetSniper V3 - Sistema de Arbitraje y Trading Deportivo

**Rol:** Actúa como Arquitecto de Software Senior y Experto en Matemáticas Financieras (Trading).
**Objetivo:** Construir una aplicación Full-Stack para detectar apuestas de valor (Value Bets) y oportunidades en vivo (Live Trading) cruzando datos de API-Sports (Pinnacle) y Altenar (DoradoBet).

---

## 1. STACK TECNOLÓGICO

* **Backend:** Node.js (ES Modules), Express.
* **HTTP Client:** Axios (Configuración Avanzada Anti-Bot).
* **Base de Datos:** lowdb (JSON local) o SQLite. *Objetivo: Caching agresivo para minimizar peticiones API.*
* **Frontend:** React + Vite + TailwindCSS.
* **Matemáticas:** Cálculo de Probabilidad Implícita, Valor Esperado (EV+) y Criterio de Kelly.

---

## 2. ARQUITECTURA DE DATOS (DATABASE)

El sistema debe persistir datos para no gastar la cuota de 100 llamadas/día de API-Sports ni ser detectado por Altenar.

**Estructura sugerida (`db.json`):**

```json
{
  "config": { "bankroll": 1000, "kellyFraction": 0.25 },
  "mappedTeams": { "Man City": "Manchester City" }, // Diccionario de normalización
  "upcomingMatches": [
    {
      "id": "fixture_id_apisports",
      "home": "Team A",
      "away": "Team B",
      "date": "ISO_DATE",
      "league": "Premier League",
      "pinnacleOdds": { "1": 1.5, "X": 4.0, "2": 6.5 },
      "realProbabilities": { "home": 65.5, "draw": 20.0, "away": 14.5 },
      "isAnalyzed": true
    }
  ],
  "liveTracking": [] // Partidos en seguimiento para estrategia "Volteada"
}
```

---

## 3. MÓDULOS DEL BACKEND (Lógica de Negocio)

### MÓDULO A: "Source of Truth" (API-Sports)
**Restricción:** Máximo 100 llamadas/día.

**Estrategia:**
1.  **Filtro Previo:** No solo consultar ligas TOP (Premier, LaLiga, Bundesliga, Serie A, Champions, Liga 1 Perú) sinó tambien las demas ya que puede haber oportunidad en las demas también.
2.  **Batching:** Consultar `/fixtures` para los próximos 2 días.
3.  **Extracción de Valor:** Para cada partido filtrado, llamar a `/odds?bookmaker=4` (Pinnacle).
4.  **Matemática:**
    * Calcular el margen de la casa (Vig) de Pinnacle.
    * Eliminar el Vig para obtener la Probabilidad Real (Fair Odds).
    * Guardar en DB.

### MÓDULO B: "The Opportunity" (Altenar Wrapper)

**Configuración Axios (CRÍTICA - "Inmortal Headers"):**
Todas las peticiones a `sb2frontend-altenar2.biahosted.com` deben usar:
* `User-Agent`: (Chrome Windows Real)
* `integration`: doradobet
* `numFormat`: en-GB
* `countryCode`: PE
* **SIN HEADER Authorization** (Para evitar caducidad de token).

#### 1. Implementación de Endpoints

* **GetUpcoming:** Cruzar con la DB de API-Sports. Si `Cuota DoradoBet > (1 / ProbabilidadReal)`, alerta **VALUE BET**.
* **GetTopEvents & GetPopularBets:** Para identificar liquidez y partidos relevantes.
* **GetStreamingEvents:** Prioridad alta. Si hay video, la data es más rápida.
* **GetFavouritesChamps:** Para generar menú de navegación.

#### 2. Requisitos de Configuración HTTP (Axios)

Debes crear una instancia de axios (`client`) configurada para evitar bloqueos y garantizar la estabilidad de los datos numéricos:

* **Base URL:** `https://sb2frontend-altenar2.biahosted.com/api/widget`
* **Headers:** Simula un navegador real pero SIN usar token de autorización.
    * `User-Agent`: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...'
    * `Referer`: 'https://doradobet.com/'
    * `Origin`: 'https://doradobet.com'
    * `Sec-Fetch-Dest`: 'empty', `Sec-Fetch-Mode`: 'cors', `Sec-Fetch-Site`: 'cross-site'
* **Parámetros Globales (Query Params):**
    * `culture=es-ES`
    * `timezoneOffset=300` (Hora Perú UTC-5)
    * `integration=doradobet` (Crítico para las cuotas correctas)
    * `deviceType=1` (Desktop)
    * `numFormat=en-GB` (Para recibir decimales con punto, ej: 1.50)
    * `countryCode=PE`
    * `sportId=66` (Solo Fútbol)

#### 3. Estructura de los Datos (JSON Relacional)

La API no devuelve un JSON anidado simple. Devuelve un modelo RELACIONAL normalizado. Debes implementar una función helper llamada `parseRelationalData(data)` que reconstruya los objetos.

**Estructura del JSON recibido (Ejemplo):**
```json
{
  "events": [
    { "id": 14967576, "name": "Equipo A vs Equipo B", "marketIds": [1342240087, ...], "score": [1, 0], "liveTime": "13'" }
  ],
  "markets": [
    { "id": 1342240087, "name": "1x2", "typeId": 1, "oddIds": [3322312241, 3322312242, 3322312243] }
  ],
  "odds": [
    { "id": 3322312241, "typeId": 1, "price": 4.20 },
    { "id": 3322312242, "typeId": 2, "price": 3.75 },
    { "id": 3322312243, "typeId": 3, "price": 1.68 }
  ]
}
```

**Lógica de Parseo:**
1.  Crear Maps (Diccionarios) para `markets` y `odds` usando sus IDs como clave para acceso rápido O(1).
2.  Iterar sobre `events`.
3.  Para cada evento, iterar sobre sus `marketIds`.
4.  Buscar el mercado correspondiente en el Map de mercados.
5.  Si el mercado es "1x2" (Generalmente typeId: 1 o name: "1x2"), iterar sobre sus `oddIds`.
6.  Buscar la cuota en el Map de odds.
    * Odd TypeId 1 = Local (Home)
    * Odd TypeId 2 = Empate (Draw)
    * Odd TypeId 3 = Visita (Away)

#### A. getUpcomingMatches(limit = 20)
* **Endpoint:** `/GetUpcoming`
* **Params:** `eventCount={limit}`

#### B. getLiveMatches()
* **Endpoint:** `/GetLivenow`
* **Params:** `eventCount=50` (Traer suficientes para escanear)

---

#### Detalle de las otras APIS:

**MÓDULO: TOP EVENTS (GetTopEvents)**
* **Objetivo:** Obtener los eventos destacados para la Home.
* **Endpoint:** `/GetTopEvents`
* **Configuración Axios:** Params: `culture=es-ES`, `integration=doradobet`, `countryCode=PE`, `numFormat=en-GB`, `timezoneOffset=300`.
* **Estructura JSON (Relacional):** Recibes arrays separados: `events`, `markets`, `odds`, `competitors`.
* **Lógica de Negocio:**
    1.  Crea un Map de `competitors` por ID para obtener nombres de equipos rápido.
    2.  Itera `events`. Cada evento tiene `marketIds`.
    3.  Busca SOLO el mercado "1x2" (Ganador del partido) dentro de los `markets` disponibles para mostrar la cuota principal en la tarjeta del evento.
    4.  Devuelve un array limpio: `[{ id, name, leagueName, homeTeam, awayTeam, date, odds: { 1: X, X: Y, 2: Z } }]`.

*Estructura del JSON recibido (Estructura simplificada manteniendo un elementode ejemplo):*
```json
{
  "markets": [
    {
      "oddIds": [
        3259402881,
        3259402885,
        3259402888
      ],
      "headerName": "1x2",
      "typeId": 1,
      "isMB": false,
      "sportMarketId": 70472,
      "id": 1319122595,
      "name": "1x2"
    }
  ],
  "odds": [
    {
      "typeId": 1,
      "price": 1.125,
      "isMB": false,
      "oddStatus": 0,
      "offers": [
        {
          "type": 0,
          "parameter": 2
        }
      ],
      "competitorId": 43703,
      "id": 3259402881,
      "name": "Liverpool FC"
    }
  ],
  "events": [
    {
      "score": [],
      "marketIds": [
        1319122595
      ],
      "isBooked": true,
      "isParlay": false,
      "offers": [
        {
          "type": 0,
          "parameter": 2
        },
        {
          "type": 2
        },
        {
          "type": 6
        }
      ],
      "code": 1276,
      "hasStream": false,
      "extId": "fp32_ar:match:402842",
      "sc": 25577,
      "mc": 392,
      "rc": false,
      "pId": 32,
      "et": 0,
      "hasStats": true,
      "competitorIds": [
        43703,
        43626
      ],
      "sportId": 66,
      "catId": 497,
      "champId": 2935,
      "status": 0,
      "startDate": "2026-01-12T19:45:00Z",
      "id": 14942029,
      "name": "Liverpool FC vs. Barnsley"
    }
  ],
  "sports": [
    {
      "catIds": [
        497,
        503,
        502,
        501,
        496
      ],
      "typeId": 1,
      "iconName": "soccer",
      "hasLiveEvents": false,
      "id": 66,
      "name": "Fútbol"
    }
  ],
  "categories": [
    {
      "champIds": [
        2935
      ],
      "iso": "ENG",
      "hasLiveEvents": false,
      "id": 497,
      "name": "Inglaterra"
    }
  ],
  "champs": [
    {
      "offers": [
        {
          "type": 0,
          "parameter": 2
        },
        {
          "type": 2
        },
        {
          "type": 6
        }
      ],
      "hasLiveEvents": false,
      "id": 2935,
      "name": "FA Cup"
    }
  ],
  "competitors": [
    {
      "hasConfigLogo": true,
      "id": 43703,
      "name": "Liverpool FC"
    }
  ]
}
```

**MÓDULO: STREAMING (GetStreamingEvents)**
* **Objetivo:** Detectar partidos con video en vivo (Low Latency).
* **Endpoint:** `/GetStreamingEvents`
* **Params Extra:** `deviceType=1` (Desktop).
* **Análisis JSON:**
    * El objeto `event` tiene la propiedad `hasStream: true`.
    * `streamProvider`: Indica la fuente (ID entero).
* **Acción:**
    * Esta función debe devolver solo una lista de IDs de eventos: `[15226765, 15226809, ...]`.
    * Usaremos esta lista para poner un icono de "TV" o "LIVE" en tu interfaz.

*Estructura del JSON recibido (Estructura simplificada manteniendo un elementode ejemplo):*
```json
{
  "events": [
    {
      "streamProvider": 6,
      "extId": "fp32_ar:match:416189",
      "competitorIds": [
        46310,
        46303
      ],
      "liveTime": "1º set",
      "ls": "1º set",
      "score": [
        0,
        0
      ],
      "server": 2,
      "pointScore": [
        "15",
        "0"
      ],
      "currentSetScore": [
        5,
        5
      ],
      "marketIds": [],
      "isBooked": true,
      "isParlay": false,
      "code": 6636,
      "hasStream": true,
      "sc": 750,
      "mc": 100,
      "rc": false,
      "pId": 32,
      "et": 0,
      "hasStats": false,
      "sportId": 68,
      "catId": 553,
      "champId": 3791,
      "status": 1,
      "startDate": "2026-01-12T08:09:00Z",
      "id": 15226765,
      "name": "Darya Kasatkina vs. Maria Sakkari"
    }
  ],
  "sports": [
    {
      "catIds": [
        701
      ],
      "typeId": 12,
      "iconName": "basketball",
      "hasLiveEvents": false,
      "id": 67,
      "name": "Baloncesto"
    }
  ],
  "categories": [
    {
      "champIds": [
        3791,
        3796
      ],
      "iso": "",
      "hasLiveEvents": false,
      "id": 553,
      "name": "WTA"
    }
  ],
  "champs": [
    {
      "hasLiveEvents": false,
      "id": 3791,
      "name": "ATP Adelaide, Australia, Mujeres Sencillos "
    }
  ],
  "competitors": [
    {
      "hasConfigLogo": true,
      "id": 46310,
      "name": "Darya Kasatkina"
    }
  ]
}
```

**MÓDULO: SOCIAL PROOF (GetPopularBets)**
* **Objetivo:** Mostrar las apuestas más calientes del momento.
* **Endpoint:** `/GetPopularBets`
* **Estructura Crítica:**
    * La API devuelve `markets` específicos que están siendo muy apostados.
    * NO devuelve todos los mercados del evento, solo el "Popular".
* **Lógica:**
    1.  Extraer el evento y el mercado específico asociado.
    2.  Mostrar: "En el partido X, la gente está apostando a [Mercado Y - Cuota Z]".

*Estructura del JSON recibido (Estructura simplificada manteniendo un elementode ejemplo):*
```json
{
  "markets": [
    {
      "oddIds": [
        3228787018
      ],
      "typeId": 1,
      "isMB": false,
      "sportMarketId": 70472,
      "id": 1307677940,
      "name": "1x2"
    }
  ],
  "odds": [
    {
      "typeId": 3,
      "price": 1.3847,
      "isMB": false,
      "oddStatus": 0,
      "offers": [
        {
          "type": 0,
          "parameter": 2
        }
      ],
      "competitorId": 43605,
      "id": 3228787018,
      "name": "FC Barcelona"
    }
  ],
  "events": [
    {
      "marketIds": [
        1307677940
      ],
      "isBooked": true,
      "isParlay": false,
      "offers": [
        {
          "type": 0,
          "parameter": 2
        },
        {
          "type": 2
        },
        {
          "type": 6
        }
      ],
      "code": 2649,
      "hasStream": false,
      "extId": "fp32_ar:match:398825",
      "sc": 0,
      "mc": 0,
      "rc": false,
      "pId": 32,
      "et": 0,
      "hasStats": false,
      "competitorIds": [
        43755,
        43605
      ],
      "sportId": 66,
      "catId": 1133,
      "champId": 16808,
      "status": 0,
      "startDate": "2026-01-21T20:00:00Z",
      "id": 14927439,
      "name": "Slavia Prague vs. FC Barcelona"
    }
  ],
  "sports": [
    {
      "catIds": [
        1133
      ],
      "typeId": 1,
      "iconName": "soccer",
      "hasLiveEvents": false,
      "id": 66,
      "name": "Fútbol"
    }
  ],
  "categories": [
    {
      "champIds": [
        16808
      ],
      "iso": "",
      "hasLiveEvents": false,
      "id": 1133,
      "name": "Europa"
    }
  ],
  "champs": [
    {
      "offers": [
        {
          "type": 0,
          "parameter": 2
        },
        {
          "type": 2
        },
        {
          "type": 6
        }
      ],
      "hasLiveEvents": false,
      "id": 16808,
      "name": "UEFA Champions League"
    }
  ],
  "competitors": [
    {
      "hasConfigLogo": true,
      "id": 43755,
      "name": "Slavia Prague"
    }
  ]
}
```

**MÓDULO: LIVE SCANNER (GetLiveOverview)**
* **Objetivo:** Escaneo masivo de partidos en vivo para detectar oportunidades.
* **Endpoint:** `/GetLiveOverview`
* **Params:** `sportId=66` (Fútbol), `categoryId=0` (Mundo).
* **Procesamiento de Datos (Vital para el Bot):**
    1.  **LiveTime:** El campo viene como string (ej: "35\'"). Debes eliminar la comilla y convertir a Entero para cálculos matemáticos.
    2.  **Score:** Viene como array `[Local, Visita]` (ej: `[2, 0]`).
    3.  **Mapeo Relacional:**
        * Cruza `event.marketIds` con el array `markets`.
        * Busca mercados de "Línea de Gol" (Over/Under) y "Hándicap".
* **Salida Esperada:** Objeto optimizado para análisis algorítmico:
    `{ matchId, time: 35, score: "2-0", markets: { over25: 1.80, under25: 1.90 } }`

*Estructura del JSON recibido (Estructura simplificada manteniendo un elementode ejemplo):*
```json
{
  "liveSports": [
    {
      "id": 66,
      "name": "Fútbol",
      "iconName": "soccer",
      "hasStream": false,
      "count": 4
    }
  ],
  "headers": [
    {
      "typeId": 1,
      "name": "1x2",
      "mst": 0,
      "odds": [
        {
          "id": 1,
          "name": "1"
        },
        {
          "id": 2,
          "name": "empate"
        },
        {
          "id": 3,
          "name": "2"
        }
      ]
    }
  ],
  "pageCount": 0,
  "page": 0,
  "markets": [
    {
      "oddIds": [
        3322312241,
        3322312242,
        3322312243
      ],
      "typeId": 1,
      "isMB": false,
      "sportMarketId": 70472,
      "id": 1342240087,
      "name": "1x2"
    }
  ],
  "odds": [
    {
      "typeId": 1,
      "price": 1.9524,
      "isMB": false,
      "oddStatus": 0,
      "competitorId": 169148,
      "id": 3322312241,
      "name": "PSBS Biak"
    }
  ],
  "events": [
    {
      "liveTime": "35'",
      "lst": "2026-01-12T08:30:04Z",
      "ls": "1ª parte",
      "score": [
        1,
        0
      ],
      "marketIds": [
        1342240087,
        1342240081,
        1342240090,
        1342240051,
        1342240073
      ],
      "isBooked": true,
      "isParlay": false,
      "offers": [
        {
          "type": 6
        }
      ],
      "code": 1792,
      "hasStream": false,
      "extId": "fp32_ar:match:401151",
      "sc": 754,
      "mc": 96,
      "rc": false,
      "pId": 32,
      "et": 0,
      "hasStats": false,
      "competitorIds": [
        169148,
        65746
      ],
      "sportId": 66,
      "catId": 902,
      "champId": 4927,
      "status": 1,
      "startDate": "2026-01-12T08:30:00Z",
      "id": 14967576,
      "name": "PSBS Biak vs. Bhayangkara Solo FC"
    }
  ],
  "sports": [
    {
      "catIds": [
        902,
        738
      ],
      "typeId": 1,
      "iconName": "soccer",
      "hasLiveEvents": false,
      "id": 66,
      "name": "Fútbol"
    }
  ],
  "categories": [
    {
      "champIds": [
        4927,
        5325
      ],
      "iso": "IDN",
      "hasLiveEvents": false,
      "id": 902,
      "name": "Indonesia"
    }
  ],
  "champs": [
    {
      "offers": [
        {
          "type": 6
        }
      ],
      "hasLiveEvents": false,
      "id": 4927,
      "name": "Liga 1"
    }
  ],
  "competitors": [
    {
      "hasConfigLogo": true,
      "id": 169148,
      "name": "PSBS Biak"
    }
  ]
}
```

**MÓDULO: NAVIGATION (GetFavouritesChamps)**
* **Objetivo:** Obtener estructura de ligas top.
* **Endpoint:** `/GetFavouritesChamps`
* **Lógica:**
    * Recibes `champs` (Ligas) y `categories` (Países).
    * Agrupa las Ligas por `iso` (Código de país) o `iconName`.
    * Retorna un árbol de navegación: `País -> Lista de Ligas`.

*Estructura del JSON recibido (Estructura simplificada manteniendo un elementode ejemplo):*
```json
{
  "champs": [
    {
      "offers": [
        {
          "type": 0,
          "parameter": 2
        },
        {
          "type": 2
        }
      ],
      "iconName": "PER",
      "hasLiveEvents": false,
      "id": 4042,
      "name": "Liga 1 - Perú"
    }
  ],
  "sports": [
    {
      "catIds": [
        814,
        501,
        497,
        506,
        502,
        503,
        582,
        560,
        593,
        496,
        569,
        1134
      ],
      "typeId": 1,
      "iconName": "soccer",
      "hasLiveEvents": false,
      "id": 66,
      "name": "Fútbol"
    }
  ],
  "categories": [
    {
      "champIds": [
        4042
      ],
      "iso": "PER",
      "hasLiveEvents": false,
      "id": 814,
      "name": "Perú"
    }
  ]
}
```

**MÓDULO: FAST TRACKER (GetEventTrackerInfo)**
* **Objetivo:** Actualización ultrarápida de marcador y tiempo.
* **Endpoint:** `/GetEventTrackerInfo`
* **Params:** `eventId={id}`.
* **Uso Estratégico:**
    * NO trae cuotas (Odds). Solo estado del partido.
    * Úsala en un `setInterval` corto (3s) para detectar Goles o Tarjetas Rojas (campo `rc: true/false`).
    * Si detectas cambio de marcador aquí, dispara una llamada a `GetEventDetails` para ver cómo cambiaron las cuotas.

*Estructura del JSON recibido (Estructura simplificada manteniendo un elementode ejemplo):*
```json
{
  "events": [
    {
      "competitorIds": [
        169148,
        65746
      ],
      "liveTime": "42'",
      "ls": "1ª parte",
      "score": [
        2,
        0
      ],
      "lmt": {
        "id": 3,
        "matchId": "62082894"
      },
      "scoreBoard": {
        "id": 3,
        "matchId": "62082894"
      },
      "variant": 0,
      "rc": false,
      "pId": 32,
      "hasStats": false,
      "sportId": 66,
      "catId": 902,
      "champId": 4927,
      "status": 1,
      "startDate": "2026-01-12T08:30:00Z",
      "id": 14967576,
      "name": "PSBS Biak vs. Bhayangkara Solo FC"
    }
  ],
  "sports": [
    {
      "typeId": 1,
      "iconName": "soccer",
      "hasLiveEvents": true,
      "id": 66,
      "name": "Fútbol"
    }
  ],
  "categories": [
    {
      "iso": "IDN",
      "hasLiveEvents": true,
      "id": 902,
      "name": "Indonesia"
    }
  ],
  "champs": [
    {
      "hasLiveEvents": true,
      "id": 4927,
      "name": "Liga 1"
    }
  ],
  "competitors": [
    {
      "hasConfigLogo": true,
      "id": 169148,
      "name": "PSBS Biak"
    }
  ]
}
```

**MÓDULO: DEEP DIVE (GetEventDetails)**
* **Objetivo:** Obtener data profunda para cálculo de probabilidades.
* **Endpoint:** `/GetEventDetails`
* **Params:** `eventId={id}`.
* **Estructura Compleja (MarketGroups):**
    * La respuesta trae `marketGroups` (Pestañas: Principal, Corners, Tarjetas, Minutos).
    * Debes implementar una función `findMarketByGroup(groupName, marketName)`.
* **Extracción de Estadísticas Implícitas:**
    * Altenar no siempre da "5 corners". Da el mercado "Total Corners Más de 5.5".
    * **Algoritmo de Inferencia:** Si el mercado activo es "Más de 9.5 corners" (cuota ~1.8), puedes inferir que actualmente hay aprox. 9 corners.
    * Busca IDs de mercados `typeId`:
        * `166`: Total Corners.
        * `172`: Corners Par/Impar.
        * `10`: Doble Oportunidad (para ver cobertura).
* **Salida:** Objeto completo del partido para la vista de detalle.

*Estructura del JSON recibido (Estructura simplificada manteniendo 2 ó 3 elementode ejemplo):*
```json
{
  "id": 14967576,
  "feedEventId": 17150775,
  "name": "PSBS Biak vs. Bhayangkara Solo FC",
  "et": 0,
  "liveTime": "49'",
  "sport": {
    "typeId": 1,
    "iconName": "soccer",
    "hasLiveEvents": false,
    "id": 66,
    "name": "Fútbol"
  },
  "champ": {
    "hasLiveEvents": false,
    "id": 4927,
    "name": "Liga 1"
  },
  "marketGroups": [
    {
      "type": 0,
      "marketIds": [
        31046,
        1342240087
      ],
      "isBundle": false,
      "sortOrder": 0,
      "id": 1,
      "name": "Principal"
    },
    {
      "type": 0,
      "marketIds": [
        1353667840,
        1353071496
      ],
      "isBundle": false,
      "sortOrder": 0,
      "id": 5,
      "name": "Tiros esquina"
    },
    {
      "type": 0,
      "marketIds": [
        1353668738,
        1353668748
      ],
      "isBundle": false,
      "sortOrder": 0,
      "id": 4,
      "name": "Combinación"
    }
  ],
  "markets": [
    {
      "shortName": "Total Tiros De Esquina",
      "desktopOddIds": [
        [
          3353627582
        ],
        [
          3353627583
        ]
      ],
      "mobileOddIds": [
        [
          3353627582
        ],
        [
          3353627583
        ]
      ],
      "isBB": false,
      "variant": 8,
      "so": 0,
      "typeId": 166,
      "isMB": true,
      "sportMarketId": 70739,
      "sv": "15.5",
      "id": 1353667840,
      "name": "Total Tiros De Esquina"
    },
    {
      "shortName": "Tiros de esquina Par/Impar",
      "desktopOddIds": [
        [
          3351943103
        ],
        [
          3351943104
        ]
      ],
      "mobileOddIds": [
        [
          3351943103
        ],
        [
          3351943104
        ]
      ],
      "isBB": false,
      "so": 0,
      "typeId": 172,
      "isMB": false,
      "sportMarketId": 70742,
      "id": 1353071496,
      "name": "Tiros de esquina Par/Impar"
    },
    {
      "shortName": "Doble oportunidad",
      "desktopOddIds": [
        [
          3322312216
        ],
        [
          3322312214
        ],
        [
          3322312215
        ]
      ],
      "mobileOddIds": [
        [
          3322312216,
          3322312214,
          3322312215
        ]
      ],
      "isBB": false,
      "so": 0,
      "typeId": 10,
      "isMB": false,
      "sportMarketId": 70495,
      "id": 1342240081,
      "name": "Doble oportunidad"
    }
  ],
  "odds": [
    {
      "typeId": 12,
      "price": 1.92,
      "isMB": true,
      "oddStatus": 0,
      "sv": "15.5",
      "id": 3353627582,
      "name": "Más de 15.5"
    },
    {
      "typeId": 70,
      "price": 1.8334,
      "isMB": false,
      "oddStatus": 0,
      "id": 3351943103,
      "name": "Impar"
    },
    {
      "typeId": 9,
      "price": 1,
      "isMB": false,
      "oddStatus": 7,
      "competitorId": 169148,
      "id": 3322312216,
      "name": "PSBS Biak o empate"
    }
  ]
}
```

**MÓDULO: CONTEXT (GetBreadcrumbEvents)**
* **Objetivo:** Navegación cruzada y partidos relacionados.
* **Endpoint:** `/GetBreadcrumbEvents`
* **Params:** `champId={id}`, `isLive=false` (para ver próximos), `isLive=true` (para ver otros en vivo de la misma liga).
* **Uso:** Muestra una lista "Otros partidos de la Liga 1 Perú" debajo del partido actual.

*Sin el parametro `isLive=true`:*
```json
{
  "events": [
    {
      "startDate": "2026-01-12T08:30:00Z",
      "liveTime": "Descanso",
      "score": [
        4,
        0
      ],
      "competitorIds": [
        169148,
        65746
      ],
      "rc": false,
      "id": 14967576,
      "name": "PSBS Biak vs. Bhayangkara Solo FC"
    },
    {
      "startDate": "2026-01-12T12:00:00Z",
      "score": [],
      "competitorIds": [
        166868,
        76576
      ],
      "rc": false,
      "id": 14967575,
      "name": "Persijap Jepara vs. Martapura FC"
    }
  ],
  "competitors": [
    {
      "hasConfigLogo": true,
      "id": 169148,
      "name": "PSBS Biak"
    },
    {
      "hasConfigLogo": true,
      "id": 65746,
      "name": "Bhayangkara Solo FC"
    },
    {
      "hasConfigLogo": true,
      "id": 166868,
      "name": "Persijap Jepara"
    },
    {
      "hasConfigLogo": true,
      "id": 76576,
      "name": "Martapura FC"
    }
  ]
}
```
*Con el parametro `isLive=true`:*
```json
{
  "events": [
    {
      "startDate": "2026-01-12T08:30:00Z",
      "liveTime": "52'",
      "score": [
        3,
        0
      ],
      "competitorIds": [
        169148,
        65746
      ],
      "rc": false,
      "id": 14967576,
      "name": "PSBS Biak vs. Bhayangkara Solo FC"
    }
  ],
  "competitors": [
    {
      "hasConfigLogo": true,
      "id": 169148,
      "name": "PSBS Biak"
    },
    {
      "hasConfigLogo": true,
      "id": 65746,
      "name": "Bhayangkara Solo FC"
    }
  ]
}
```

### MÓDULO C: "The Sniper" (Live Strategy - La Volteada)
Este módulo debe correr en un bucle (`setInterval`) inteligente.

**Flujo de Trabajo:**

1.  **Escaneo Ligero:** Llamar a `GetLiveOverview` (trae todos los partidos en vivo).
2.  **Filtro "Trigger":**
    * ¿Está jugando un Favorito (según DB API-Sports o Cuota Pre-match < 1.50)?
    * ¿El Favorito va perdiendo por 1 gol?
    * ¿Tiempo de juego entre 15' y 70'?
3.  **Análisis Profundo (Solo si pasa el filtro):**
    * Llamar a `GetEventDetails` (Data pesada).
    * Llamar a `GetEventTrackerInfo` (Verificar Tarjetas Rojas - `rc`).
    * Verificar Stats: ¿El favorito tiene posesión > 60% y Tiros a puerta > Rival?
4.  **Señal de Entrada:** Si todo es SI -> Calcular Stake con Kelly Criterion -> **ALERTA**, Si es posible sonora.

---

## 4. LÓGICA MATEMÁTICA (Money Management)

Implementar funciones puras en `mathUtils.js`:

1.  **Probabilidad Implícita (con Vig):** $P = 1 / Cuota$
2.  **Fair Odds (Sin Vig):** Normalizar las probabilidades inversas de Pinnacle para que sumen 100%.
3.  **Valor Esperado (EV):** $EV = (ProbabilidadReal \times CuotaDorado) - 1$
4.  **Criterio de Kelly (Gestión de Bankroll):**

    $$F = \frac{p(b+1) - 1}{b}$$

    * Donde: $p$ = Probabilidad Real, $b$ = (Cuota - 1).
    * **Kelly Fraccional:** Usar siempre `Kelly * 0.25` para reducir volatilidad.

---

## 5. REQUERIMIENTOS DEL FRONTEND (React)

1.  **Dashboard Home:**
    * Sección "Value Bets (Pre-match)": Tabla comparativa (Cuota Real vs DoradoBet | EV% | Kelly Stake).
    * Sección "Live Snipes": Tarjetas de partidos en vivo que cumplen la condición de "Volteada".
2.  **Filtros:** Toggle para ver "Solo con Streaming" (usando `GetStreamingEvents`).
3.  **Config:** Input para definir mi Bankroll actual.

---

## 6. PLAN DE EJECUCIÓN (Fases para Copilot)

* **FASE 1:** Configurar servidor Express, Axios Instance con Headers Altenar y Conexión a lowdb.
* **FASE 2:** Crear script `ingest.js` para consumir API-Sports (Pinnacle) y guardar Probabilidades Reales en DB.
* **FASE 3:** Implementar `GetLiveOverview` y lógica de "La Volteada" cruzando datos en tiempo real.
* **FASE 4:** Implementar cálculo de Kelly y EV en el backend.
* **FASE 5:** Construir el Frontend en React que consuma `GET /api/opportunities`.