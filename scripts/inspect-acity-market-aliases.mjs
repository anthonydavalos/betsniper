import fs from 'fs';

const filePath = 'data/booky/acity-live-socket-analysis.latest.json';
const raw = fs.readFileSync(filePath, 'utf8');
const json = JSON.parse(raw);
const requests = Array.isArray(json?.requests) ? json.requests : [];

const keywords = ['total', 'doble', '1x2', 'over', 'under', 'mas', 'menos', 'chance'];
const counts = new Map();

for (const row of requests) {
  const url = String(row?.url || '').toLowerCase();
  const isRelevant =
    url.includes('/api/widget/getliveoverview') ||
    url.includes('/api/widget/geteventdetails') ||
    url.includes('/api/widget/geteventsbyid') ||
    url.includes('/api/widget/getstreamingevents');
  if (!isRelevant) continue;

  const body = String(row?.bodySnippet || '');
  const regex = /"name"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let match;

  while ((match = regex.exec(body)) !== null) {
    const name = String(match[1] || '')
      .replace(/\\u[0-9a-fA-F]{4}/g, '')
      .replace(/\\"/g, '"')
      .trim()
      .toLowerCase();

    if (!name) continue;
    if (!keywords.some((k) => name.includes(k))) continue;

    counts.set(name, (counts.get(name) || 0) + 1);
  }
}

const top = Array.from(counts.entries())
  .sort((a, b) => b[1] - a[1])
  .slice(0, 60);

for (const [name, count] of top) {
  console.log(`${count}\t${name}`);
}
