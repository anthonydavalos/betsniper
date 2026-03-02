# PROJECT BLUEPRINT: BetSniper V3 - Sistema de Arbitraje y Trading Deportivo

**Rol:** Actúa como Arquitecto de Software Senior y Experto en Matemáticas Financieras (Trading).
**Objetivo:** Construir una aplicación Full-Stack para detectar apuestas de valor (Value Bets) y oportunidades en vivo (Live Trading) cruzando datos de Pinnacle (Arcadia API) y Altenar (DoradoBet).

---

## 1. STACK TECNOLÓGICO

* **Backend:** Node.js (ES Modules), Express.
* **HTTP Client:** Axios (Configuración Avanzada Anti-Bot).
* **Base de Datos:** lowdb (JSON local) o SQLite. *Objetivo: Caching agresivo para minimizar peticiones API.*
* **Frontend:** React + Vite + TailwindCSS.
* **Matemáticas:** Cálculo de Probabilidad Implícita, Valor Esperado (EV+) y Criterio de Kelly.

## 1.1 FUENTES DE DATOS Y ARQUITECTURA
**1. Pinnacle (Real Odds):** API Arcadia (`guest.api.arcadia.pinnacle.com`). Fuente de la verdad para probabilidades reales.
**2. Altenar (Soft Bookie):** API de DoradoBet (`sb2frontend-altenar2.biahosted.com`). Fuente para encontrar ineficiencias (Value Bets).

---

## 2. ARQUITECTURA DE DATOS (DATABASE)

El sistema debe persistir datos para minimizar peticiones y evitar bloqueos.

**Estructura sugerida (`db.json`):**

```json
{
  "config": { "bankroll": 1000, "kellyFraction": 0.25 },
  "mappedTeams": { "Man City": "Manchester City" }, // Diccionario de normalización
  "upcomingMatches": [
    {
      "id": "pinnacle_match_id",
      "home": "Team A",
      "away": "Team B",
      "date": "ISO_DATE",
      "league": { "name": "Premier League" },
      "bookmaker": "Pinnacle",
      "odds": { "home": 1.5, "draw": 4.0, "away": 6.5 },
      "altenarId": 123456, // ID Enlazado
      "altenarName": "Team A vs Team B"
    }
  ],
  "altenarUpcoming": [], // Cache de eventos Altenar (ventana 48h)
  "liveTracking": [] // Partidos en seguimiento para estrategia "Volteada"
}
```

---

## 3. MÓDULOS DEL BACKEND (Lógica de Negocio)

### MÓDULO A: "Source of Truth" (Pinnacle Arcadia)
**Endpoint:** `guest.api.arcadia.pinnacle.com/0.1` (Guest API Unofficial).
**Restricción:** Usar Headers/Cookies de "Invitado" y throttling para no ser bloqueado por WAF.

**Estrategia (Implementada en `ingest-pinnacle.js`):**
1.  **Discovery:** Consultar `/sports/29/leagues?hasMatchups=true` para obtener ligas activas.
2.  **Filtrado Inteligente:**
    *   Obtener matchups por liga: `/leagues/{id}/matchups`.
    *   **Filtro en Memoria:** Descartar partidos más allá de 48h para reducir volumen.
3.  **Extracción de Cuotas:**
    *   Para cada partido filtrado, llamar a `/matchups/{id}/markets/related/straight`.
    *   Detectar mercado "Moneyline" (`s;0;m`).
    *   Convertir cuotas Americanas a Decimales.
4.  **Matemática:**
    *   Guardar Odds crudas en DB.
    *   El Scanner calculará la Probabilidad Real (Fair Odds) eliminando el Vig al vuelo.

#### Estructura de Datos (Arcadia)

**Matchups Response (`/leagues/{id}/matchups`):**
```json
[
  {
    "id": 1599583,
    "type": "matchup",
    "startTime": "2026-05-15T14:00:00Z",
    "participants": [
      { "name": "Team Home", "alignment": "home" },
      { "name": "Team Away", "alignment": "away" }
    ],
    "leagues": [ { "id": 29, "name": "Premier League" } ]
  }
]
```

**Odds Response (`/matchups/{id}/markets/related/straight`):**
```json
[
  {
    "key": "s;0;m", // Moneyline
    "prices": [
      { "designation": "home", "price": -150 }, // American Odds
      { "designation": "away", "price": 130 }
    ]
  }
]
```

### MÓDULO B: "The Opportunity" (Altenar Wrapper)

**Configuración Axios (CRÍTICA - "Inmortal Headers"):**
Todas las peticiones a `sb2frontend-altenar2.biahosted.com` deben usar:
* `User-Agent`: (Chrome Windows Real)
* `integration`: doradobet
* `numFormat`: en-GB
* `countryCode`: PE
* **SIN HEADER Authorization** (Para evitar caducidad de token).

#### 1. Implementación de Endpoints

* **GetUpcoming:** Cruzar con la DB de Pinnacle Arcadia.
    * Si `Cuota DoradoBet > (1 / ProbabilidadReal)`, alerta **VALUE BET**.
    * **Mercados Objetivo:** 1x2, Totales (Over/Under 1.5/2.5/3.5) y Ambos Marcan (Yes/No).
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

**Estructura del JSON recibido (Ejemplo Genérico - Relacional):**
```json
{
    "topSports": [
        {
            "id": 66,
            "name": "Fútbol",
            "iconName": "soccer",
            "hasStream": false,
            "count": 0
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
        },
        {
            "typeId": 18,
            "name": "Total",
            "mst": 0,
            "odds": [
                {
                    "id": 12,
                    "name": "más de"
                },
                {
                    "id": 13,
                    "name": "menos de"
                }
            ],
            "specialOdd": {
                "typeId": 1,
                "name": "Goles"
            }
        },
        {
            "typeId": 29,
            "name": "Ambos equipos marcan",
            "mst": 0,
            "odds": [
                {
                    "id": 74,
                    "name": "sí"
                },
                {
                    "id": 76,
                    "name": "no"
                }
            ]
        }
    ],
    "pageCount": 1,
    "page": 1,
    "markets": [
        {
            "oddIds": [
                3348420078,
                3348420079,
                3348420080
            ],
            "typeId": 1,
            "isMB": false,
            "sportMarketId": 70472,
            "id": 1351757720,
            "name": "1x2"
        },
        {
            "oddIds": [
                3348419941,
                3348419942
            ],
            "typeId": 18,
            "isMB": true,
            "sportMarketId": 70520,
            "sv": "2.5",
            "sn": "2.5",
            "id": 1351757682,
            "name": "Total"
        },
        {
            "oddIds": [
                3348419989,
                3348419990
            ],
            "typeId": 29,
            "isMB": false,
            "sportMarketId": 70545,
            "id": 1351757706,
            "name": "Ambos equipos marcan"
        },
        {
            "oddIds": [
                3368321926,
                3368321927
            ],
            "typeId": 18,
            "isMB": true,
            "sportMarketId": 70520,
            "sv": "3.5",
            "sn": "3.5",
            "id": 1359043082,
            "name": "Total"
        },
        {
            "oddIds": [
                3360281023,
                3360281024
            ],
            "typeId": 18,
            "isMB": true,
            "sportMarketId": 70520,
            "sv": "1.5",
            "sn": "1.5",
            "id": 1356184822,
            "name": "Total"
        }
    ],
    "odds": [
        {
            "typeId": 1,
            "price": 3.4000,
            "isMB": false,
            "oddStatus": 0,
            "competitorId": 56784,
            "id": 3348420078,
            "name": "Western Sydney Wanderers (F)"
        },
        {
            "typeId": 2,
            "price": 4.0000,
            "isMB": false,
            "oddStatus": 0,
            "id": 3348420079,
            "name": "Empate"
        },
        {
            "typeId": 3,
            "price": 1.8000,
            "isMB": false,
            "oddStatus": 0,
            "competitorId": 50696,
            "id": 3348420080,
            "name": "Brisbane Roar (F)"
        },
        {
            "typeId": 12,
            "price": 1.5556,
            "isMB": true,
            "oddStatus": 0,
            "id": 3348419941,
            "name": "Más de 2.5"
        },
        {
            "typeId": 13,
            "price": 2.2858,
            "isMB": true,
            "oddStatus": 0,
            "id": 3348419942,
            "name": "Menos de 2.5"
        },
        {
            "typeId": 74,
            "price": 1.5455,
            "isMB": false,
            "oddStatus": 0,
            "id": 3348419989,
            "name": "Sí"
        },
        {
            "typeId": 76,
            "price": 2.2500,
            "isMB": false,
            "oddStatus": 0,
            "id": 3348419990,
            "name": "No"
        },
        {
            "typeId": 12,
            "price": 2.2858,
            "isMB": true,
            "oddStatus": 0,
            "id": 3368321926,
            "name": "Más de 3.5"
        },
        {
            "typeId": 13,
            "price": 1.5556,
            "isMB": true,
            "oddStatus": 0,
            "id": 3368321927,
            "name": "Menos de 3.5"
        },
        {
            "typeId": 12,
            "price": 1.6667,
            "isMB": true,
            "oddStatus": 0,
            "id": 3360281023,
            "name": "Más de 1.5"
        },
        {
            "typeId": 13,
            "price": 2.0000,
            "isMB": true,
            "oddStatus": 0,
            "id": 3360281024,
            "name": "Menos de 1.5"
        }
    ],
    "events":
        {
            "marketIds": [
                1351757720,
                1351757777,
                1351757714,
                1351757723,
                1351757682,
                1351757706
            ],
            "isBooked": true,
            "isParlay": false,
            "offers": [
                {
                    "type": 6
                }
            ],
            "code": 4508,
            "hasStream": false,
            "extId": "fp32_ar:match:401858",
            "sc": 1184,
            "mc": 140,
            "rc": false,
            "pId": 32,
            "et": 0,
            "hasStats": true,
            "competitorIds": [
                56784,
                50696
            ],
            "sportId": 66,
            "catId": 550,
            "champId": 3117,
            "status": 0,
            "startDate": "2026-01-16T08:00:00Z",
            "id": 14120778,
            "name": "Western Sydney Wanderers (F) vs. Brisbane Roar (F)"
        },
        {
            "marketIds": [
                1359043088,
                1359043097,
                1359043086,
                1359043090,
                1359043082,
                1359043084
            ],
            "isBooked": true,
            "isParlay": false,
            "offers": [
                {
                    "type": 6
                }
            ],
            "code": 2721,
            "hasStream": false,
            "extId": "fp32_ar:match:421157",
            "sc": 485,
            "mc": 32,
            "rc": false,
            "pId": 32,
            "et": 0,
            "hasStats": false,
            "competitorIds": [
                65023,
                2013518
            ],
            "sportId": 66,
            "catId": 567,
            "champId": 32128,
            "status": 0,
            "startDate": "2026-01-16T08:30:00Z",
            "id": 15281244,
            "name": "Garhwal FC vs. M2M FC"
        },
        {
            "marketIds": [
                1356184833,
                1356184853,
                1356184829,
                1356184836,
                1356184822
            ],
            "isBooked": true,
            "isParlay": false,
            "offers": [
                {
                    "type": 6
                }
            ],
            "code": 2348,
            "hasStream": false,
            "extId": "fp32_ar:match:416186",
            "sc": 634,
            "mc": 57,
            "rc": false,
            "pId": 32,
            "et": 0,
            "hasStats": true,
            "competitorIds": [
                729888,
                65217
            ],
            "sportId": 66,
            "catId": 564,
            "champId": 3060,
            "status": 0,
            "startDate": "2026-01-16T10:00:00Z",
            "id": 15214883,
            "name": "Sheger Ketema vs. Fasil Kenema"
        }
    ],
    "sports": [
        {
            "catIds": [
                550,
                567,
                564
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
                3117,
                3032
            ],
            "iso": "AUS",
            "hasLiveEvents": false,
            "id": 550,
            "name": "Australia"
        },
        {
            "champIds": [
                32128
            ],
            "iso": "IND",
            "hasLiveEvents": false,
            "id": 567,
            "name": "India"
        },
        {
            "champIds": [
                3060
            ],
            "iso": "ETH",
            "hasLiveEvents": false,
            "id": 564,
            "name": "Etiopía"
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
            "id": 3117,
            "name": "A-League, Feminino"
        },
        {
            "offers": [
                {
                    "type": 6
                }
            ],
            "hasLiveEvents": false,
            "id": 32128,
            "name": "Delhi Senior Division"
        },
        {
            "offers": [
                {
                    "type": 6
                }
            ],
            "hasLiveEvents": false,
            "id": 3060,
            "name": "Liga Premier"
        }
    ],
    "competitors": [
        {
            "hasConfigLogo": true,
            "id": 56784,
            "name": "Western Sydney Wanderers (F)"
        },
        {
            "hasConfigLogo": true,
            "id": 50696,
            "name": "Brisbane Roar (F)"
        }
    ]
}
```

**Lógica de Parseo:**
1.  Crear Maps (Diccionarios) para `markets` y `odds` usando sus IDs como clave para acceso rápido O(1).
2.  **[NUEVO]** Crear Maps para `champs` (Ligas) y `categories` (Países) usando sus IDs (`id` -> `name`).
    *   Iterar sobre `events` e inyectar `league: champsMap.get(event.champId)` y `country: catsMap.get(event.catId)`.
3.  Iterar sobre `events`.
4.  Para cada evento, iterar sobre sus `marketIds`.
5.  Buscar el mercado correspondiente en el Map de mercados.
5.  Si el mercado es "1x2" (Generalmente typeId: 1 o name: "1x2"), iterar sobre sus `oddIds` y buscar la cuota en el Map de odds.
    * Odd TypeId 1 = Local (Home)
    * Odd TypeId 2 = Empate (Draw)
    * Odd TypeId 3 = Visita (Away)
6.  **NUEVO (Value Bets Totales):** Si el mercado es "Total" (typeId: 18), verificar el valor `sv` (Special Value) que indica la línea (1.5, 2.5, 3.5).
    * Odd TypeId 12 = Más de (Over)
    * Odd TypeId 13 = Menos de (Under)
7.  **NUEVO (Value Bets BTTS):** Si el mercado es "Ambos equipos marcan" (typeId: 29).
    * Odd TypeId 74 = Sí (Yes)
    * Odd TypeId 76 = No (No)

#### A. getUpcomingMatches(limit = 20)
* **Endpoint:** `/GetUpcoming`
* **Params:** `eventCount={limit}`

#### 1. Implementación del Motor de Coincidencias (Matcher)
El principal desafío aquí es la normalización de dos factores críticos:

1.  **Nombres de Equipos (Fuzzy Logic):**
    *   La primera API usa nombres más limpios o en inglés, mientras que Altenar a veces usa abreviaturas, sufijos como `(F)` para femenino, `(Res.)` para reservas, o transliteraciones distintas (ej. `Al-Orobah` vs `Al Orubah`).
    *   **Lógica del Matcher:**
        1.  Toma un partido de Pinnacle (Reference).
        2.  Busca en la lista de Altenar SOLO los partidos que empiecen a la misma hora (+/- 20 min).
        3.  Aplica normalización (eliminar acentos, lowercase) + Levenshtein Distance para encontrar el par correcto.
        4.  Si hay match y EV+, genera la alerta.

2.  **Normalización de Tiempo (Timezone):**
    *   **Pinnacle / Fuente Principal:** Verificar zona horaria (generalmente UTC o UTC-5 según configuración).
    *   **Altenar:** Viene en UTC (Hora Zulu `Z`).
    *   **Diferencia:** Ajustar siempre a UTC antes de comparar.
    *   **Validación:** Si los nombres no son exactos "string-to-string" pero la hora coincide tras normalizar el timezone, y las cuotas están en un rango lógico (diferencia < 10%), asume que es el mismo partido.

#### B. getLiveMatches()
* **Endpoint:** `/GetLivenow`
* **Params:** `eventCount=50` (Traer suficientes para escanear)

*Estructura del JSON recibido (Ejemplo Live):*
```json
{
    "topSports": [...],
    "headers": [...],
    "pageCount": 0,
    "page": 0,
    "markets": [
        {
            "oddIds": [3373640465, 3373640466, 3373640467],
            "isAlt": true,
            "typeId": 1,
            "isMB": false,
            "sportMarketId": 0,
            "id": 3373640465,
            "name": "Prórroga - 1x2"
        },
        {
            "oddIds": [3373640465, 3373640466, 3373640467],
            "typeId": 113,
            "isMB": false,
            "sportMarketId": 70681,
            "id": 1360936639,
            "name": "Prórroga - 1x2"
        },
        {
            "oddIds": [3373398558, 3373398559],
            "typeId": 29,
            "isMB": false,
            "sportMarketId": 70545,
            "id": 1360851590,
            "name": "Ambos equipos marcan"
        },
        {
            "oddIds": [3373369213, 3373369212],
            "typeId": 18,
            "isMB": true,
            "sportMarketId": 70520,
            "sv": "3.5",
            "sn": "3,5",
            "id": 1360839697,
            "name": "Total"
        },
        {
            "oddIds": [3373595420, 3373595421],
            "typeId": 18,
            "isMB": true,
            "sportMarketId": 70520,
            "sv": "1.5",
            "sn": "1,5",
            "id": 1360918766,
            "name": "Total"
        },
        {
            "oddIds": [3370637335, 3370637336],
            "typeId": 18,
            "isMB": true,
            "sportMarketId": 70520,
            "sv": "2.5",
            "sn": "2,5",
            "id": 1359970567,
            "name": "Total"
        }
    ],
    "odds": [...],
    "events": [
        {
            "liveTime": "103'",
            "ls": "1ª Parte Adicional",
            "score": [1, 1],
            "marketIds": [3373640465, 1360936639, 1360936641],
            "isBooked": true,
            "isParlay": false,
            "code": 1422,
            "hasStream": false,
            "extId": "fp32_ar:match:419134",
            "sc": 14,
            "mc": 4,
            "rc": false,
            "pId": 32,
            "et": 0,
            "hasStats": false,
            "competitorIds": [47201, 47200],
            "sportId": 66,
            "catId": 499,
            "champId": 2968,
            "status": 1,
            "startDate": "2026-01-16T15:00:00Z",
            "id": 15214887,
            "name": "CS Constantine vs. ES Sétif"
        },
        {
            "liveTime": "94'",
            "lst": "2026-01-16T15:51:00Z",
            "ls": "2ª parte",
            "score": [2, 2],
            "marketIds": [],
            "isBooked": true,
            "isParlay": false,
            "offers": [{"type": 6}],
            "code": 3761,
            "hasStream": false,
            "extId": "fp32_ar:match:419983",
            "sc": 101,
            "mc": 13,
            "rc": false,
            "pId": 32,
            "et": 0,
            "hasStats": false,
            "competitorIds": [172812, 47092],
            "sportId": 66,
            "catId": 1131,
            "champId": 3099,
            "status": 1,
            "startDate": "2026-01-16T15:30:00Z",
            "id": 15266367,
            "name": "Vietnam Sub-23 vs. United Arab Emirates Sub-23"
        }
    ],
    "sports": [...],
    "categories": [...]
}
```

---

#### Detalle de las otras APIS:

**MÓDULO: TOP EVENTS (GetTopEvents)**
* **Objetivo:** Obtener los eventos destacados para la Home.
* **Endpoint:** `/GetTopEvents`
* **Configuración Axios:** Params: `culture=es-ES`, `integration=doradobet`, `countryCode=PE`, `numFormat=en-GB`, `timezoneOffset=300`.
* **Lógica de Negocio:**
    1.  Crea un Map de `competitors` por ID para obtener nombres de equipos rápido.
    2.  Itera `events`.
    3.  Busca SOLO el mercado "1x2" dentro de los `markets` disponibles.
    4.  Devuelve un array limpio: `[{ id, name, leagueName, homeTeam, awayTeam, date, odds: { 1: X, X: Y, 2: Z } }]`.

*Estructura del JSON recibido (Ejemplo simplificado):*
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
* **Acción:** Devuelve lista de IDs de eventos: `[15226765, 15226809]`.

*Estructura del JSON recibido:*
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
* **Lógica:** Extraer el evento y el mercado específico asociado (Solo devuelve el mercado popular, no todos).

*Estructura del JSON recibido:*
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
* **Endpoint:** `/GetLivenow` (Actualizado desde `/GetLiveOverview` para mejor soporte de mercados y tiempos).
* **Params:** `sportId=66` (Fútbol), `categoryId=0` (Mundo), `eventCount=100`.
* **Procesamiento de Datos:**
    1.  **LiveTime "Final":** Si m > 90 o status indica prórroga, retornar string "Final" para gatillar liquidación inmediata.
    2.  **Score:** Viene como array `[1, 0]`.
    3.  **Mapeo:** Cruzar markets para buscar líneas de gol y hándicap.

*Estructura del JSON recibido:*
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
* **Lógica:** Agrupar `champs` (Ligas) usando `categories` (Países).

*Estructura del JSON recibido:*
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
* **Uso:** `setInterval` corto (3s). Verificar `rc` (Red Card) y cambios en `score`.

*Estructura del JSON recibido:*
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
* **Estructura Compleja (MarketGroups):** Implementar `findMarketByGroup`.
* **Inferencia de Stats:** Si el mercado de Corners activo es "Más de 9.5", inferir que hay 9 corners.

*Estructura del JSON recibido:*
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

**MÓDULO: RESULTS (GetEventResults)**
* **Objetivo:** Obtener resultados oficiales de partidos finalizados (Solución Zombie Matches).
* **Endpoint:** `/GetEventResults`
* **BaseURL:** `https://sb2ris-altenar2.biahosted.com/api/WidgetResults`
* **Params:** `sportId=66`, `categoryId={catId}`, `date={YYYY-MM-DD}`.
* **Lógica:** 
    * Altenar mueve los partidos finalizados a este endpoint y los borra del feed en vivo.
    * Requiere tener guardado el `catId` (Categoría/País) del evento.

**MÓDULO: CONTEXT (GetBreadcrumbEvents)**
* **Objetivo:** Navegación cruzada y partidos relacionados.
* **Endpoint:** `/GetBreadcrumbEvents`
* **Params:** `champId={id}`, `isLive=true/false`.
* **Uso:** "Otros partidos de la Liga".

*Estructura del JSON recibido:*
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

#### C. "The Sniper" (Live Strategy - La Volteada)
Este módulo debe correr en un bucle (`setInterval`) inteligente.

**Flujo de Trabajo:**
1.  **Escaneo Ligero:** Llamar a `GetLiveOverview` (trae todos los partidos en vivo).
2.  **Filtro "Trigger":**
    * ¿Está jugando un Favorito (según DB Pinnacle, o Cuota Pre-match < 1.80 / Prob > 55%)?
    * ¿El Favorito va perdiendo por 1 gol?
    * ¿Tiempo de juego entre 15' y 70'?
3.  **Análisis Profundo (Solo si pasa el filtro):**
    * Llamar a `GetEventDetails`.
    * Llamar a `GetEventTrackerInfo` (Verificar Tarjetas Rojas - `rc`).
    * Verificar Stats: ¿El favorito tiene posesión > 60% y Tiros a puerta > Rival?
4.  **Señal de Entrada:** Si todo es SI -> Calcular Stake con Kelly Criterion -> **ALERTA**.

#### D. MOTOR DE LIQUIDACIÓN Y PAPER TRADING (Settlement Engine)

El sistema de Paper Trading debe gestionar de forma inteligente el ciclo de vida de la apuesta para evitar falsos negativos y visualizar correctamente el estado.

**Requisito de Persistencia:**
Al crear una apuesta, **GUARDAR OBLIGATORIAMENTE**: `sportId`, `catId`, `champId`. Son necesarios para buscar el resultado oficial si el partido se vuelve "Zombie".

**Reglas de Cierre de Apuestas:**
1.  **Pre-Match Safety:** Las apuestas Pre-Match tienen un bloqueo de **2.2 horas** desde el inicio oficial (`matchDate`). NO se verifica el resultado antes de este tiempo salvo que el evento aparezca como "Final" en feeds oficiales.
2.  **Live Snipes (Smart Settlement & Self-Healing):**
    *   **Detección de Fin (Prórroga/Extra Time):** Si `liveTime >= 90'` o el estado contiene "Adicional/Prórroga", marcar inmediatamente como **"Final"** en Scanner y enviar a liquidación.
    *   **Zombie Protocol (Prioritario):** Si el evento desaparece del feed (`GetEventDetails` devuelve null):
        *   Consultar endpoint `GetEventResults` (API de Resultados) usando el `catId` y fecha. Si devuelve score, liquidar.
        *   **Immediate Check:** Si el partido era LIVE (`wasLive=true`) y desaparece, verificar resultados de inmediato sin esperar buffers de tiempo.
    *   **Time Fallback:** Si no hay API de resultados:
        *   Si `liveTime` >= 90 o (tiempo registrado + transcurrido) > 100', liquidar.
        *   **Frontend Cleanup:** Si han pasado > 120 minutos desde inicio y no hay data, visualizar como "Final" (FIN) para evitar bucles visuales de "90'+".

## 3.1 MEJORAS DE MATCHING (CRUCE DE DATOS)
Para evitar errores de cruce entre ligas dispares (Ej. Pro vs. U21/Reservas), se implementan reglas estrictas en `teamMatcher.js`:

1.  **Categoría Mismatch (Blocker):** Si un nombre contiene tokens de categoría (`U19`, `U21`, `(Res.)`, `III`, `II`, `Women`, `(F)`) y el otro NO, el match es **rechazado automáticamente**, aunque el nombre base coincida.
2.  **Token Similarity:** Se prioriza la coincidencia de palabras completas (Tokens) sobre `substrings` simples. Esto evita que "Leon" (4 letras) coincida con "Leones" (6 letras) solo por contener la raíz.
3.  **Ventana Temporal Estrecha:** Reducción de tolerancia de tiempo de cruce a **3 horas** (180 min) para evitar conflictos en fechas consecutivas.

---

## 4. LÓGICA MATEMÁTICA (Money Management - Portfolio Theory)

Implementar funciones puras en `mathUtils.js` basadas en "Simultaneous Kelly Betting":

1.  **Probabilidad Implícita (Fair Odds):** Normalizar las probabilidades inversas de Pinnacle para que sumen 100% (eliminando el Vig).
2.  **Valor Esperado (EV):** $EV = (ProbabilidadReal \times CuotaDorado) - 1$
3.  **Net Asset Value (NAV):** Para el cálculo del bankroll, usar siempre el **Patrimonio Neto Liquidable**:
    $$ NAV = \text{Balance Disponible} + \sum (\text{Stakes Activos}) $$
    *   *Razón:* Ignorar las apuestas activas causa sub-inversión sistemática ("Underbetting").
4.  **Gestión de Riesgo (Risk Profiles):**
    *   **PREMATCH_VALUE:** 0.25 Kelly (Baja Volatilidad).
    *   **LIVE_VALUE:** 0.125 Kelly (Ruido de Mercado).
    *   **LIVE_SNIPE:** 0.10 Kelly (Alta Incertidumbre).
5.  **Criterio de Kelly Simultáneo (Amortiguado):**
    En lugar de un "Hard Cap", usar una **Curva de Saturación Exponencial** para gestionar la utilidad marginal de apuestas simultáneas:
    $$ Stake = CAP \times (1 - e^{-\frac{KellyRaw}{CAP}}) $$
    *   Esto permite que apuestas con EV masivo crezcan asintóticamente sin romper el banco.

---

## 5. REQUERIMIENTOS DEL FRONTEND (React)

1.  **Dashboard Home:**
    *   Sección "Value Bets (Pre-match)": Tabla comparativa (Cuota Real vs DoradoBet | EV% | Kelly Stake).
    *   Sección "Live Snipes": Tarjetas de partidos en vivo que cumplen la condición de "Volteada".
    *   **Visualización de Estado:** Mostrar "FIN" para partidos finalizados en lugar de bucles de tiempo (Ej. "97'").
    *   **Footer de Totales:** Barra inferior (`tfoot`) en las tablas de historial que sume automáticamente el Stake Total Real y Sugerido del día.
2.  **Filtros:** Toggle para ver "Solo con Streaming".
3.  **Config:** Input para definir mi Bankroll actual.
4.  **Estructura Monorepo:** Mantener `/client` (Frontend) separado de la raíz (Backend) para evitar conflictos de `node_modules`.

---

## 6. PLAN DE EJECUCIÓN (Fases para Copilot)

* **FASE 1:** Configurar servidor Express, Axios Instance con Headers Altenar y Conexión a lowdb.
* **FASE 2:** Crear script `ingest-pinnacle.js` para consumir Pinnacle Arcadia API y guardar Probabilidades Reales en DB.
* **FASE 3:** Implementar `GetLiveOverview` y lógica de "La Volteada" cruzando datos en tiempo real.
* **FASE 4:** Implementar cálculo de Kelly y EV en el backend.
* **FASE 5:** Construir el Frontend en React que consuma `GET /api/opportunities`.
## 8. ACTUALIZACIONES V3.1 (Live-Trading V2)
- **Extracción de Ligas (Altenar):** Implementado mapeo relacional de `champs` y `categories` para obtener nombres reales.
- **Matching Estricto:** Se valida `League Name` para distinguir Femenino/Reservas.
- **Snapshot de Cuotas:** Persistencia de `pinnaclePrice` en el momento de la apuesta.
- **Arcadia WS:** Integración de WebSockets/Puppeteer documentada como estándar para PULL de datos Pinnacle.

---

## 9. ACTUALIZACIONES V3.2 (Sprint: Booky Real + Matcher Diagnostics)

### 9.1 MÓDULO: Booky Real Placement (Semi-Auto → Real Controlado)

**Archivos:** `src/routes/booky.js`, `src/services/bookySemiAutoService.js`, `src/services/bookyAccountService.js`

**Flujo de Operación:**
1. Seleccionar perfil: `npm run book:dorado` o `npm run book:acity` (escribe vars en `.env`).
2. Extraer JWT real: `npm run token:booky:wait-close` (Puppeteer captura token desde sesión autenticada).
3. Preparar ticket: `POST /api/booky/prepare` (genera draft desde oportunidad).
4. Verificar payload: `POST /api/booky/real/dryrun/:id` (construye `placeWidget` sin enviar).
5. Confirmar apuesta: `POST /api/booky/real/confirm/:id` o `confirm-fast/:id` (con guardas activas).

**Guardas de Seguridad (`enforceValueGuardsOrThrow`):**
- JWT con vida restante ≥ `BOOKY_TOKEN_MIN_REMAINING_MINUTES` (default: 2 min).
- EV del ticket ≥ `BOOKY_MIN_EV_PERCENT` (default: 2%).
- Drop de cuota desde snapshot ≤ `BOOKY_MAX_ODD_DROP` (default: 20%).
- `BOOKY_REAL_PLACEMENT_ENABLED=true` requerido (default: `false`).

**Estado Incierto:** Si `placeWidget` devuelve timeout sin confirmación → `archiveUncertainRealPlacement()`. Verificar via `GET /api/booky/account?refresh=1` antes de reintentar.

**Base de Bankroll Kelly (3 niveles de fallback):**
```
getKellyBankrollBase() → booky-real (balance real Altenar)
                       → portfolio (paper trading NAV)
                       → config.bankroll (valor estático)
```

**Estructura DB (`booky` en `db.json`):**
```json
{
  "booky": {
    "tickets": [],
    "captures": [],
    "byProfile": {
      "doradobet": { "balance": null, "history": [], "lastSync": null },
      "acity":     { "balance": null, "history": [], "lastSync": null }
    }
  }
}
```

---

### 9.2 MÓDULO: Scheduler Adaptativo Altenar Prematch

**Archivo:** `src/services/altenarPrematchScheduler.js`

**Objetivo:** Mantener datos prematch de Altenar actualizados sin saturar la API, priorizando eventos con mayor urgencia temporal o ya enlazados con Pinnacle.

**Lógica de Prioridad:**
- Score = `(1 / horasAlInicio) × factorEnlace × factorEV`
- Eventos con inicio < 6h o ya enlazados con Pinnacle tienen frecuencia de refresco más alta.
- Concurrencia máxima configurable (usa `p-limit`).
- Backoff exponencial por errores de red (3 intentos, luego skip hasta próximo ciclo).

**Integración en `server.js`:**
```javascript
import { startAltenarPrematchAdaptiveScheduler } from './src/services/altenarPrematchScheduler.js';
// Al boot:
startAltenarPrematchAdaptiveScheduler();
```

---

### 9.3 MÓDULO: Matcher — Hot-Reload + Diagnósticos

**Archivo:** `src/utils/teamMatcher.js`

**Hot-Reload de Aliases (`src/utils/dynamicAliases.json`):**
```json
{
  "Man City": "Manchester City",
  "Liverpool Montevideo": "Liverpool FC"
}
```
- Polling de `mtime` cada 30 segundos. Recarga sin reiniciar proceso.
- Permite correcciones de nombre en producción sin downtime.

**API de Diagnóstico (`diagnoseNoMatch`):**
```javascript
const diag = diagnoseNoMatch(teamName, startDate, candidates, league);
// diag.probableReason: 'time_window_5m' | 'category_mismatch' | 'similarity_below_threshold' | ...
// diag.bestScore: 0.0 - 1.0
// diag.inWindow5: boolean (¿está dentro de ±5 min?)
// diag.aliasApplied: string | null
```

**Razones de No-Match (codificadas):**
| Razón | Descripción | Acción |
|-------|-------------|--------|
| `time_window_5m` | Candidatos existen pero fuera de ±5 min | Aumentar `MATCH_TIME_TOLERANCE_MINUTES` |
| `time_window_exceeded` | Ningún candidato en ventana extendida | Verificar timezone o evento cancelado |
| `category_mismatch` | Token de categoría incompatible (U21, (F), Res.) | Normal — rechazo válido |
| `similarity_below_threshold` | Score fuzzy < umbral mínimo | Añadir alias en `dynamicAliases.json` |
| `no_candidates` | Altenar no tiene el deporte/liga | Sin acción |

**Variables de Entorno del Matcher:**
```env
MATCH_DIAGNOSTIC_LOG=1               # 0=off, 1=resumen ciclo, 2=verbose por evento
MATCH_FUZZY_THRESHOLD=0.77           # Levenshtein similarity mínima [0.5–0.99]
MATCH_MIN_ACCEPT_SCORE=0.60          # Score compuesto mínimo para aceptar match [0.4–0.9]
MATCH_TIME_TOLERANCE_MINUTES=5       # Ventana primaria ±min [1–60]
MATCH_TIME_EXTENDED_TOLERANCE_MINUTES=30  # Ventana secundaria ±min [10–120]
```

**Plantilla de Experimento A/B:** Ver `MATCH_DIAG_TEMPLATE.md` en la raíz del proyecto para protocolo de ajuste sistemático.
