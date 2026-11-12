// Cancel an order before production and refund it. Owner: core. Contract: section g.4.
//   node server/scripts/cancel-order.js TCD-260101-ABCD [--reason "customer asked"]
// Needs the same env as the server (COMMERCE_MODE, DATABASE_URL, provider keys). Prints CANNOT_CANCEL and
// changes nothing when a parcel is already in production or a supplier refuses.
import { parseArgs, runScript } from './_cli.js';
import { cancelOrder } from '../orders/service.js';

const { args, flags } = parseArgs(process.argv.slice(2));
if (!args[0] || flags.help) {
  console.error('usage: node server/scripts/cancel-order.js <order id, e.g. TCD-260101-ABCD> [--reason "text"]');
  process.exitCode = 1;
} else {
  await runScript((ctx) => cancelOrder(ctx, args[0].toUpperCase(), { reason: typeof flags.reason === 'string' ? flags.reason : 'cancelled by the shop' }));
}
