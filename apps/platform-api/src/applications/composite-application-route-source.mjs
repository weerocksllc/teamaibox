export class CompositeApplicationRouteSource {
  #sources;
  constructor({ sources }) {
    if (!Array.isArray(sources) || sources.length < 1 || sources.some((source) => !source?.routes)) {
      throw new TypeError("Application route sources are incomplete");
    }
    this.#sources = [...sources];
  }
  async routes(options = {}) {
    const values = (await Promise.all(this.#sources.map((source) => source.routes(options)))).flat();
    const seen = new Set();
    for (const route of values) {
      if (seen.has(route.pluginKey)) throw new TypeError(`Duplicate application route: ${route.pluginKey}`);
      seen.add(route.pluginKey);
    }
    return Object.freeze(values.map((route) => Object.freeze({ ...route })));
  }
  async fetch(input) {
    const results = [];
    for (const source of this.#sources) {
      if (!source.fetch) continue;
      const value = await source.fetch(input);
      if (value !== null && value !== undefined) results.push(value);
    }
    if (results.length > 1) throw new TypeError(`Duplicate application content source: ${input.pluginKey}`);
    return results[0] ?? null;
  }
}
