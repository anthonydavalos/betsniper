
import fs from 'fs';
import path from 'path';

const dbPath = path.resolve('db.json');
const pinPath = path.resolve('data/pinnacle_live.json');

const findInFile = (filePath, term, label) => {
    try {
        if (!fs.existsSync(filePath)) {
            console.log(`[${label}] Archivo no existe.`);
            return;
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        
        console.log(`\n--- Buscando "${term}" en [${label}] ---`);
        
        // Estrategia de búsqueda recursiva simple o iterativa dependiendo de la estructura
        // Asumimos que son arrays de objetos o objetos con claves
        
        let found = 0;
        
        const search = (obj, pathStr = '') => {
            if (!obj) return;
            if (typeof obj === 'string') {
                if (obj.toLowerCase().includes(term.toLowerCase())) {
                    console.log(`Found at ${pathStr}: ${obj}`);
                    found++;
                }
            } else if (Array.isArray(obj)) {
                obj.forEach((item, i) => search(item, `${pathStr}[${i}]`));
            } else if (typeof obj === 'object') {
                Object.keys(obj).forEach(key => search(obj[key], `${pathStr}.${key}`));
            }
        };
        
        // Para db.json, focuseamos en altenarUpcoming o liveOpportunities
        if (label === 'DB') {
            if (data.altenarUpcoming) {
                console.log("Searching in altenarUpcoming...");
                search(data.altenarUpcoming, 'altenarUpcoming');
            }
             if (data.liveOpportunities) {
                console.log("Searching in liveOpportunities...");
                search(data.liveOpportunities, 'liveOpportunities');
            }
             if (data.valueBets) {
                console.log("Searching in valueBets...");
                search(data.valueBets, 'valueBets');
            }
        } else {
            // Pinnacle Live structure
            search(data, 'root');
        }

        if (found === 0) console.log("No hits.");

    } catch (e) {
        console.error(`Error leyendo ${label}:`, e.message);
    }
};

findInFile(pinPath, 'Thai', 'PINNACLE');
findInFile(pinPath, 'Cup', 'PINNACLE');
