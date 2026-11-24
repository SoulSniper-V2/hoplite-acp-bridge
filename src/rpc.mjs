// Newline-delimited JSON-RPC over a pair of streams.
import { StringDecoder } from "node:string_decoder";

export class Rpc {
  #next = 0;
  #pending = new Map();
  constructor({ input, output, idPrefix, onMessage, onBadLine }) {
    this.output = output;
    this.idPrefix = idPrefix;
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    input.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          onBadLine?.(line);
          continue;
        }
        if (message.method === undefined && this.#pending.has(message.id)) {
          const { resolve, reject } = this.#pending.get(message.id);
          this.#pending.delete(message.id);
          if (message.error) reject(new RpcError(message.error));
          else resolve(message.result);
          continue;
        }
        onMessage(message);
      }
    });
  }
  send(message) {
    if (this.closed || !this.output.writable) return;
    this.output.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }
  notify(method, params) {
    this.send({ method, params });
  }
  request(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(new RpcError({ code: -32603, message: "The Hoplite connection is closed." }));
    const id = `${this.idPrefix}${++this.#next}`;
    return new Promise((resolve, reject) => {
      let timer;
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      this.#pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new RpcError({ code: -32603, message: `Hoplite did not answer ${method} within ${timeoutMs / 1000}s.` }));
        }, timeoutMs);
        timer.unref?.();
      }
      this.send({ id, method, params });
    });
  }
  close(error) {
    this.closed = true;
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }
}

export class RpcError extends Error {
  constructor({ code, message, data }) {
    super(message);
    this.code = code ?? -32603;
    this.data = data;
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.data === undefined ? {} : { data: this.data }) };
  }
}
