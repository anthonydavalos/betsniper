import dotenv from 'dotenv';
import { importBookyPnlBaseFromSpy, getBookyPnlBaseSnapshot } from '../src/services/bookyAccountService.js';

dotenv.config();

const args = process.argv.slice(2);
const profileArg = args.find((arg) => arg.startsWith('--profile='));
const fileArg = args.find((arg) => arg.startsWith('--file='));

const profile = (profileArg?.split('=')[1] || process.env.BOOK_PROFILE || 'doradobet').trim();
const filePath = (fileArg?.split('=')[1] || '').trim() || null;

const run = async () => {
  const imported = await importBookyPnlBaseFromSpy({ profileKey: profile, filePath });

  if (!imported?.success) {
    console.error('❌ No se pudo sincronizar base PnL desde spy-cashflow.');
    console.error(JSON.stringify(imported, null, 2));
    process.exit(1);
  }

  const snapshot = await getBookyPnlBaseSnapshot({ profileKey: profile });
  console.log('✅ Base PnL sincronizada desde spy-cashflow.');
  console.log(JSON.stringify({ imported, resolved: snapshot?.resolved, configuredFromDate: snapshot?.configuredFromDate }, null, 2));
};

run().catch((error) => {
  console.error(`❌ Error en sync-booky-pnl-base-from-spy: ${error.message}`);
  process.exit(1);
});
