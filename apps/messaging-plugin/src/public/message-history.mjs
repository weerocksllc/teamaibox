// Page sizes bound each request, not the amount of history a member can read.
export class MessageHistory {
  #request;
  #states = new Map();
  #pending = new Map();
  constructor(request) { this.#request = request; }
  get(id) { return this.#states.get(id) ?? { messages: [], hasOlder: false }; }
  invalidate(id) { return this.#serialize(id, () => { this.#states.delete(id); }); }
  #serialize(id, operation) {
    const promise = (this.#pending.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.#pending.set(id, promise);
    promise.finally(() => { if (this.#pending.get(id) === promise) this.#pending.delete(id); }).catch(() => {});
    return promise;
  }
  #merge(state, page) {
    const values = new Map(state.messages.map(item => [item.id, item]));
    for (const item of page) values.set(item.id, item);
    state.messages = [...values.values()].sort((a, b) => a.sequence - b.sequence);
  }
  async #page(id, cursor) {
    const response = await this.#request(`/api/v1/messaging/conversations/${id}/messages?${cursor}&limit=100`);
    const page = Array.isArray(response) ? response : response?.data;
    if (!Array.isArray(page) || page.some(item => !Number.isSafeInteger(item.sequence) || item.sequence < 1)) throw new Error('Invalid message history response');
    return page;
  }
  refresh(id) {
    return this.#serialize(id, async () => {
      let state = this.#states.get(id);
      if (!state) {
        const page = await this.#page(id, `before=${Number.MAX_SAFE_INTEGER}`);
        state = { messages: page, hasOlder: page.length === 100 && (page[0]?.sequence ?? 1) > 1 };
        this.#states.set(id, state);
      } else {
        let after = state.messages.at(-1)?.sequence ?? 0;
        for (;;) {
          const page = await this.#page(id, `after=${after}`);
          if (page.length && page.at(-1).sequence <= after) throw new Error('Message history cursor did not advance');
          this.#merge(state, page);
          if (page.length < 100) break;
          after = page.at(-1).sequence;
        }
      }
      return this.get(id);
    });
  }
  older(id) {
    return this.#serialize(id, async () => {
      const state = this.#states.get(id);
      if (!state?.hasOlder) return this.get(id);
      const before = state.messages[0].sequence;
      const page = await this.#page(id, `before=${before}`);
      if (page.some(item => item.sequence >= before)) throw new Error('Message history cursor did not advance');
      this.#merge(state, page);
      state.hasOlder = page.length === 100 && (state.messages[0]?.sequence ?? 1) > 1;
      return this.get(id);
    });
  }
  async focus(id, message) {
    await this.refresh(id);
    if (this.get(id).messages.some(item => item.id === message.id)) return this.get(id);
    // Jump directly to a search result; don't download years of intervening messages.
    return this.#serialize(id, async () => {
      const page = await this.#page(id, `before=${message.sequence + 1}`);
      const state = { messages: page, hasOlder: page.length === 100 && (page[0]?.sequence ?? 1) > 1 };
      this.#states.set(id, state);
      return state;
    });
  }
}
