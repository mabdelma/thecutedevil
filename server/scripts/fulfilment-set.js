// A person closes a parked (`manual`) parcel. Owner: core. Contract: section b (fulfilment status `manual`).
//   node server/scripts/fulfilment-set.js TCD-260101-ABCD 1 submitted [--ref SUPPLIER-ORDER-NO]
//   node server/scripts/fulfilment-set.js TCD-260101-ABCD 1 shipped --carrier DHL --tracking 123456 [--url https://…]
//   node server/scripts/fulfilment-set.js TCD-260101-ABCD 1 delivered
//   node server/scripts/fulfilment-set.js TCD-260101-ABCD 1 cancelled     (then cancel-order.js to refund)
// `shipped` sends the customer the tracking e-mail. Needs the same env as the server.
import { parseArgs, runScript } from './_cli.js';
import { setManualFulfilment } from '../orders/service.js';

const { args, flags } = parseArgs(process.argv.slice(2));
const text = (v) => (typeof v === 'string' ? v : undefined);
if (args.length < 3 || flags.help) {
  console.error('usage: node server/scripts/fulfilment-set.js <order id> <parcel number> <submitted|shipped|delivered|cancelled> [--carrier X] [--tracking N] [--url https://…] [--ref R]');
  process.exitCode = 1;
} else {
  await runScript((ctx) => setManualFulfilment(ctx, args[0].toUpperCase(), Number(args[1]), {
    status: args[2], carrier: text(flags.carrier), tracking: text(flags.tracking), url: text(flags.url), ref: text(flags.ref),
  }));
}
