import fs from 'fs';
const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
const map = db.mappedTeams || {};
const mahar = Object.entries(map).filter(([k,v]) => k.toLowerCase().includes('mahar'));
console.log('Mahar Mapping:', mahar);
const we = Object.entries(map).filter(([k,v]) => k.toLowerCase().includes('we '));
console.log('WE Mapping:', we);
const auck = Object.entries(map).filter(([k,v]) => k.toLowerCase().includes('auckland'));
console.log('Auckland Mapping:', auck);
