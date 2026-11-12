// Supplier registry: loads only the adapters whose env vars are present. Owner: sup.
// Each factory returns null when its config group is null. `manual` exists whenever commerce is not off;
// `mock` only in mode 'mock'. Nothing loads when commerce is off.
import { assertSupplierAdapter } from './interface.js';
import { create as printful } from './printful.js';
import { create as printify } from './printify.js';
import { create as gelato } from './gelato.js';
import { create as printlet } from './printlet.js';
import { create as mock } from './mock.js';
import { create as manual } from './manual.js';

/** @type {Array<(config: object, deps: object) => (import('./interface.js').SupplierAdapter | null)>} */
const FACTORIES = [printful, printify, gelato, printlet, mock, manual];

/** @returns {{ get(id: string): object|null, list(): object[], has(id: string): boolean }} */
export function loadSuppliers(config, deps = {}) {
  const map = new Map();
  if (config.mode !== 'off') {
    for (const create of FACTORIES) {
      const adapter = create(config, deps);
      if (adapter) map.set(adapter.id, assertSupplierAdapter(adapter));
    }
  }
  return {
    get: (id) => map.get(id) || null,
    has: (id) => map.has(id),
    list: () => Array.from(map.values()),
  };
}
