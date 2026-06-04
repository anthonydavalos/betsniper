
import fs from 'fs';
import path from 'path';
import { readMergedDbSync } from './lib/read-split-db.mjs';

const pinPath = path.resolve('data/pinnacle_live.json');

const findInObject = (data, term, label) => {
    console.log(`\n--- Buscando "${term}" en [${label}] ---`);
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
            Object.keys(obj).forEach((key) => search(obj[key], `${pathStr}.${key}`));
        }
    };

    if (label === 'DB') {
        if (data.altenarUpcoming) {
            console.log('Searching in altenarUpcoming...');
            search(data.altenarUpcoming, 'altenarUpcoming');
        }
        if (data.liveOpportunities) {
            console.log('Searching in liveOpportunities...');
            search(data.liveOpportunities, 'liveOpportunities');
        }
        if (data.valueBets) {
            console.log('Searching in valueBets...');
            search(data.valueBets, 'valueBets');
        }
    } else {
        search(data, 'root');
    }

    if (found === 0) console.log('No hits.');
};

const findInFile = (filePath, term, label) => {
    try {
        if (!fs.existsSync(filePath)) {
            console.log(`[${label}] Archivo no existe.`);
            return;
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        findInObject(data, term, label);
    } catch (e) {
        console.error(`Error leyendo ${label}:`, e.message);
    }
};

const mergedDb = readMergedDbSync();
findInObject(mergedDb, 'Thai', 'DB');
findInObject(mergedDb, 'Cup', 'DB');
findInFile(pinPath, 'Thai', 'PINNACLE');
findInFile(pinPath, 'Cup', 'PINNACLE');
