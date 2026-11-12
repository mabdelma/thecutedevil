// Shared by the command-line scripts. Owner: core. Builds the same ctx the server uses (env → config → db → registries).
import { createContext } from '../index.js';
import { tick } from '../jobs/runner.js';

/** ['TCD-…', '--reason', 'text', '--flag=value'] → { args: ['TCD-…'], flags: { reason: 'text', flag: 'value' } } */
export function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { flags[a.slice(2)] = argv[i + 1]; i += 1; } else flags[a.slice(2)] = true;
    } else args.push(a);
  }
  return { args, flags };
}

/** Run `work(ctx)`, then the jobs it queued (refund, e-mail), print the result as JSON, and close the database. */
export async function runScript(work) {
  let ctx = null;
  let code = 0;
  try {
    ctx = await createContext({ log: { log() {}, info() {}, warn: (l) => console.error(l), error: (l) => console.error(l) } });
    if (!ctx.db) throw Object.assign(new Error('Commerce is off: set COMMERCE_MODE and DATABASE_URL (the same values the server uses).'), { code: 'COMMERCE_OFF' });
    const result = await work(ctx);
    const jobs = await tick(ctx, { budgetMs: 30000 });
    console.log(JSON.stringify({ ...result, jobs: { ran: jobs.ran, failed: jobs.failed, remaining: jobs.remaining } }, null, 2));
  } catch (err) {
    code = 1;
    console.error(`${err.code || 'ERROR'}: ${err.message}`);
  } finally {
    if (ctx && ctx.db) await ctx.db.destroy();
  }
  process.exitCode = code;
}
