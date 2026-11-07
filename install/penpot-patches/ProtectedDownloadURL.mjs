// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) Weerocks LLC

/** Native exports may contain the backend's configured (now stale) origin.
 * Keep native storage IDs, but resolve them through this editor's protected
 * same-origin route. No arbitrary remote URL is fetched or proxied here.
 * Standalone upstream builds without the opt-in retain their exact behavior.
 */
export function resolveDownload(value, protectedBase, locationOrigin) {
  if (!protectedBase) return value;
  const base = new URL(protectedBase);
  if (base.origin !== locationOrigin || base.protocol !== 'https:' || base.username || base.password
    || base.search || base.hash || !base.pathname.endsWith('/')) throw new Error('Invalid design download boundary');
  const uri = new URL(String(value), base);
  if (uri.protocol === 'blob:' && uri.origin === locationOrigin) return value;
  if (uri.protocol === 'data:' && /^data:(?:image\/(?:png|jpeg|webp|svg\+xml)|text\/plain)[;,]/i.test(String(value))) return value;
  if (!['http:', 'https:'].includes(uri.protocol) || uri.username || uri.password || uri.search || uri.hash) {
    throw new Error('Unsupported design download');
  }
  const path = uri.pathname.startsWith(base.pathname) ? '/' + uri.pathname.slice(base.pathname.length) : uri.pathname;
  const match = /^\/assets\/by-id\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(path);
  if (!match) throw new Error('Unsupported design download');
  return new URL('assets/by-id/' + match[1], base).href;
}
