#!/usr/bin/env node
// Lists a supplier's products and variant ids so server/catalogue/mapping.js can be filled. Owner: sup.
// Reads the same env vars as the server (through config.js); prints ids only, never keys.
//
//   PRINTFUL_API_KEY=… PRINTFUL_WEBHOOK_SECRET=x node server/suppliers/tools/list-catalogue.js printful
//       → the store's sync products and sync variants (use variantRef 'sync:<id>'), with their catalogue variant ids
//   … list-catalogue.js printful 380          → catalogue product 380: every variant id with size and colour
//   PRINTIFY_API_TOKEN=… PRINTIFY_SHOP_ID=… PRINTIFY_WEBHOOK_SECRET=x node … list-catalogue.js printify
//       → the shop's products (productRef) and enabled variants (variantRef)
//   PRINTLET_API_KEY=… PRINTLET_BASE_URL=https://printleteg.com/api/integrations/v1 PRINTLET_WEBHOOK_SECRET=x node … printlet
//       → catalogue products, variants and (with a product id as 2nd argument) print area keys
//   GELATO_API_KEY=… GELATO_WEBHOOK_SECRET=x node … list-catalogue.js gelato <catalogUid>
//       → productUids of one catalogue (e.g. t-shirts). Uses Gelato's product API, which was NOT readable during
//         development (unverified endpoint); if it fails, copy productUids from the Gelato dashboard instead.
// The webhook secret can be any value here; it is only needed so the config group counts as configured.
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../config.js';
import { createHttp } from '../http.js';
import { createPrintletApi } from '../printlet-api.js';

const need = (group, name) => { if (!group) throw new Error(`${name}: env vars are not set (see the header of this file)`); return group; };

export async function listCatalogue(supplier, arg, config, deps = {}) {
  const out = [];
  const say = (line) => out.push(line);
  if (supplier === 'printful') {
    const cfg = need(config.printful, 'printful');
    const http = createHttp({ provider: 'printful', baseUrl: 'https://api.printful.com', rate: { capacity: 120 }, deps, headers: () => ({ Authorization: `Bearer ${cfg.apiKey}`, ...(cfg.storeId ? { 'X-PF-Store-Id': cfg.storeId } : {}) }) });
    if (arg) {
      const { result } = (await http.get(`/products/${encodeURIComponent(arg)}`)).data;
      say(`catalogue product ${result.product.id}: ${result.product.title}`);
      for (const v of result.variants || []) say(`  variantRef '${v.id}'  ${v.size || ''} ${v.color || ''}  ${v.price || ''}`);
    } else {
      for (let offset = 0; ; offset += 100) {
        const page = (await http.get('/store/products', { query: { offset, limit: 100 } })).data;
        for (const p of page.result || []) {
          say(`sync product ${p.id}: ${p.name}`);
          const detail = (await http.get(`/store/products/${p.id}`)).data.result;
          for (const v of detail.sync_variants || []) say(`  variantRef 'sync:${v.id}'  ${v.name}  (catalogue variant ${v.variant_id}, catalogue product ${v.product ? v.product.product_id : '?'})`);
        }
        if (!page.result || page.result.length < 100) break;
      }
    }
  } else if (supplier === 'printify') {
    const cfg = need(config.printify, 'printify');
    const http = createHttp({ provider: 'printify', baseUrl: 'https://api.printify.com', rate: { capacity: 100 }, deps, headers: () => ({ Authorization: `Bearer ${cfg.token}`, 'User-Agent': 'Node.js commerce-server' }) });
    for (let page = 1; ; page += 1) {
      const res = (await http.get(`/v1/shops/${encodeURIComponent(cfg.shopId)}/products.json`, { query: { limit: 50, page } })).data;
      for (const p of res.data || []) {
        say(`productRef '${p.id}': ${p.title}`);
        for (const v of p.variants || []) if (v.is_enabled) say(`  variantRef '${v.id}'  ${v.title}  sku ${v.sku}  cost ${v.cost}`);
      }
      if (!res.next_page_url) break;
    }
  } else if (supplier === 'printlet') {
    const cfg = need(config.printlet, 'printlet');
    const api = deps.printletApi || createPrintletApi(cfg, deps);
    const eg = (await api.countries()).find((c) => c.code === 'EG');
    if (!eg) throw new Error('printlet: Egypt not found in /catalog/countries');
    if (arg) {
      const p = await api.product(arg, eg.id);
      say(`productRef '${p.id}': ${p.name}`);
      for (const v of p.variants || []) say(`  variantRef '${v.id}'  sku ${v.sku}  available ${v.available}`);
      for (const a of p.print_areas || []) say(`  print area key '${a.key}' (${a.name}): techniques ${(a.techniques || []).map((t) => t.name).join(', ')}`);
    } else {
      for (const p of await api.products(eg.id)) {
        say(`productRef '${p.id}': ${p.name} [${p.status}]`);
        for (const v of p.variants || []) say(`  variantRef '${v.id}'  sku ${v.sku}  available ${v.available}`);
      }
    }
  } else if (supplier === 'gelato') {
    const cfg = need(config.gelato, 'gelato');
    const http = createHttp({ provider: 'gelato', baseUrl: 'https://product.gelatoapis.com', rate: { capacity: 60 }, deps, headers: () => ({ 'X-API-KEY': cfg.apiKey }) });
    if (!arg) {
      for (const c of (await http.get('/v3/catalogs')).data || []) say(`catalogUid '${c.catalogUid}': ${c.title}`);
    } else {
      const res = (await http.post(`/v3/catalogs/${encodeURIComponent(arg)}/products:search`, { limit: 100, offset: 0 })).data;
      for (const p of (res && res.products) || []) say(`variantRef '${p.productUid}'  ${JSON.stringify(p.attributes || {})}`);
    }
  } else {
    throw new Error('usage: node server/suppliers/tools/list-catalogue.js <printful|printify|gelato|printlet> [id]');
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const lines = await listCatalogue(process.argv[2], process.argv[3], loadConfig(process.env));
    console.log(lines.join('\n') || '(nothing found)');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
