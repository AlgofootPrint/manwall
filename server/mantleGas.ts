import { formatEther, formatUnits } from "ethers";

export interface MantleFeeEstimate {
  status: "live" | "unavailable";
  network: "Mantle Sepolia";
  chainId: 5003;
  sampledAt: string;
  blockNumber?: number;
  gasPriceWei?: string;
  gasPriceGwei?: string;
  baseFeeWei?: string;
  baseFeeGwei?: string;
  vulnerableCostMnt?: string;
  securedCostMnt?: string;
  detail: string;
}

async function rpc(method: string, params: unknown[]) {
  const response = await fetch(process.env.MANTLE_RPC_URL ?? "https://rpc.sepolia.mantle.xyz", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8_000)
  });
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (!response.ok || body.error || body.result === undefined) {
    throw new Error(body.error?.message ?? `Mantle RPC ${method} failed with HTTP ${response.status}.`);
  }
  return body.result;
}

export async function estimateMantleFees(vulnerableGas: bigint, securedGas: bigint): Promise<MantleFeeEstimate> {
  const sampledAt = new Date().toISOString();
  try {
    const [chainIdHex, gasPriceHex, block] = await Promise.all([
      rpc("eth_chainId", []),
      rpc("eth_gasPrice", []),
      rpc("eth_getBlockByNumber", ["latest", false])
    ]) as [string, string, { number?: string; baseFeePerGas?: string }];
    if (Number(BigInt(chainIdHex)) !== 5003) throw new Error(`Configured RPC returned chain ID ${Number(BigInt(chainIdHex))}, expected Mantle Sepolia 5003.`);
    const gasPrice = BigInt(gasPriceHex);
    const baseFee = block.baseFeePerGas ? BigInt(block.baseFeePerGas) : undefined;
    return {
      status: "live",
      network: "Mantle Sepolia",
      chainId: 5003,
      sampledAt,
      blockNumber: block.number ? Number(BigInt(block.number)) : undefined,
      gasPriceWei: gasPrice.toString(),
      gasPriceGwei: formatUnits(gasPrice, "gwei"),
      baseFeeWei: baseFee?.toString(),
      baseFeeGwei: baseFee ? formatUnits(baseFee, "gwei") : undefined,
      vulnerableCostMnt: formatEther(vulnerableGas * gasPrice),
      securedCostMnt: formatEther(securedGas * gasPrice),
      detail: "Estimated with measured proof gas units and live Mantle Sepolia eth_gasPrice. Public RPC does not expose rollup_gasPrices."
    };
  } catch (reason) {
    return {
      status: "unavailable",
      network: "Mantle Sepolia",
      chainId: 5003,
      sampledAt,
      detail: reason instanceof Error ? reason.message : "Mantle fee data unavailable."
    };
  }
}
