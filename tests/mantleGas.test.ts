import { afterEach, describe, expect, it } from "vitest";
import { estimateMantleFees } from "../server/mantleGas.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("live Mantle fee estimation", () => {
  it("combines measured gas units with Mantle Sepolia fee data", async () => {
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "eth_chainId") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x138b" });
      if (request.method === "eth_gasPrice") return Response.json({ jsonrpc: "2.0", id: 1, result: "0xba43b7400" });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { number: "0x64", baseFeePerGas: "0xba43b7400" } });
    };

    const estimate = await estimateMantleFees(21_000n, 25_000n);
    expect(estimate.status).toBe("live");
    expect(estimate.chainId).toBe(5003);
    expect(estimate.blockNumber).toBe(100);
    expect(Number(estimate.securedCostMnt)).toBeGreaterThan(Number(estimate.vulnerableCostMnt));
  });

  it("rejects fee data from a non-Mantle RPC", async () => {
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "eth_chainId") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
      if (request.method === "eth_gasPrice") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { number: "0x1", baseFeePerGas: "0x1" } });
    };
    expect((await estimateMantleFees(21_000n, 25_000n)).status).toBe("unavailable");
  });
});
