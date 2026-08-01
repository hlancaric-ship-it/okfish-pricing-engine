import fs from 'fs';
const d = JSON.parse(fs.readFileSync('.cache/state.json','utf-8'));
const plId = Object.keys(d.prices)[0];
const prod = Object.keys(d.prices[plId])[0];
d.prices[plId][prod] = '123.45'; // Set an artificial old price to force a diff
fs.writeFileSync('.cache/state.json', JSON.stringify(d, null, 2));
console.log('Modified cache for', prod, 'in plId', plId, 'to 123.45 to ensure diff');
