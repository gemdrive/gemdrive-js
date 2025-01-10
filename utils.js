class NReader {

  #reader;
  #remainder;

  constructor(reader) {
    this.#reader = reader;
    this.#remainder = new Uint8Array();
  }

  async readExactly(n) {

    if (this.#remainder.length >= n) {
      const buf = this.#remainder.slice(0, n);
      this.#remainder = this.#remainder.slice(n);
      return buf;
    }

    const buf = new Uint8Array(n);
    let offset = 0;

    while (offset < n) {
      const { value, done } = await this.#reader.read();
      if (done) {
        throw new Error("Done too soon");
      }

      const needed = n - offset;

      if (value.length >= needed) {
        buf.set(value.slice(0, needed), offset);
        this.#remainder = value.slice(needed);
        break;
      }
      else {
        buf.set(value, offset);
        offset += value.length;
      }
    }

    return buf;
  }
}

async function* readStreamLines(readableStream) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let lines = buffer.split("\n");

      buffer = lines.pop();

      for (const line of lines) {
        yield line;
      }
    }

    if (buffer) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}



export {
  readStreamLines,
}
