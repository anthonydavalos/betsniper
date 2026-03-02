import fs from 'fs';
import { execSync } from 'child_process';

const prepare = JSON.parse(fs.readFileSync('tmp_prepare_new.json', 'utf8'));
if (!prepare.success) {
  console.error('prepare failed:', prepare.message || 'unknown');
  process.exit(1);
}

const tid = prepare.ticket.id;
console.log('TID', tid);

const dryRaw = execSync(
  `curl -sS -X POST "http://localhost:3000/api/booky/real/dryrun/${tid}" -H "Content-Type: application/json"`,
  { encoding: 'utf8' }
);
console.log('DRYRAW', dryRaw);

const confRaw = execSync(
  `curl -sS -X POST "http://localhost:3000/api/booky/real/confirm/${tid}" -H "Content-Type: application/json"`,
  { encoding: 'utf8' }
);
console.log('CONFRAW', confRaw);
