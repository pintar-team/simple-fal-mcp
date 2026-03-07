const isNodeRuntime = typeof process !== "undefined" && Boolean(process.versions?.node);

function isReadableStream(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) {
    return true;
  }
  const candidate = value as { getReader?: () => unknown; pipe?: unknown };
  return typeof candidate.getReader === "function" || typeof candidate.pipe === "function";
}

function isFormDataInstance(value: unknown): boolean {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

export function createFetchWithDuplex(baseFetch: typeof fetch): typeof fetch {
  if (!isNodeRuntime) {
    return baseFetch;
  }

  const boundFetch = baseFetch.bind(globalThis);
  type DuplexRequestInit = RequestInit & { duplex?: "half" | "full" | "none" };

  const wrapped = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const RequestCtor = typeof Request !== "undefined" ? Request : null;
    if (RequestCtor && input instanceof RequestCtor) {
      const requestInit: DuplexRequestInit = (init ?? {}) as DuplexRequestInit;
      const hasBody =
        requestInit.body !== undefined ||
        (typeof input.body !== "undefined" && input.body !== null);
      if (requestInit.duplex === undefined && hasBody) {
        const patched = new RequestCtor(input, { ...requestInit, duplex: "half" } as RequestInit);
        return boundFetch(patched);
      }
    }

    if (init) {
      const nextInit = { ...(init as DuplexRequestInit) };
      const method = (nextInit.method ?? "GET").toUpperCase();
      if (nextInit.duplex === undefined) {
        const body = nextInit.body as unknown;
        if (
          method !== "GET" ||
          nextInit.body !== undefined ||
          isReadableStream(body) ||
          isFormDataInstance(body)
        ) {
          nextInit.duplex = "half";
          return boundFetch(input, nextInit);
        }
      }
    }

    return boundFetch(input, init);
  }) as typeof fetch;

  return Object.assign(wrapped, baseFetch);
}
