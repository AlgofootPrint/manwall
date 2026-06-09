import { Contract, formatEther, formatUnits, getAddress, JsonRpcProvider } from "ethers";

const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

export interface WalletScanIssue {
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
  recommendation: string;
}

function parseAddressList(value = "") {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean).map(getAddress);
}

function riskSummary(issues: WalletScanIssue[]) {
  if (issues.some((issue) => issue.severity === "critical" || issue.severity === "high")) return "review-required";
  if (issues.some((issue) => issue.severity === "medium")) return "caution";
  return "low-risk";
}

export async function scanWallet(address: string) {
  const wallet = getAddress(address);
  const provider = new JsonRpcProvider(process.env.MANTLE_RPC_URL ?? "https://rpc.sepolia.mantle.xyz");
  const [network, balance, transactionCount, code] = await Promise.all([
    provider.getNetwork(),
    provider.getBalance(wallet),
    provider.getTransactionCount(wallet),
    provider.getCode(wallet)
  ]);

  const issues: WalletScanIssue[] = [];
  const nativeBalance = Number(formatEther(balance));
  if (nativeBalance === 0) {
    issues.push({
      severity: "medium",
      title: "No MNT available for recovery transactions",
      detail: "This wallet has no native Mantle Sepolia balance.",
      recommendation: "Keep a small MNT balance available before interacting with protocols or revoking approvals."
    });
  }
  if (code !== "0x") {
    issues.push({
      severity: "info",
      title: "Smart contract wallet detected",
      detail: "The scanned address has deployed bytecode.",
      recommendation: "Review owner/module configuration and do not treat this like a simple EOA."
    });
  }
  if (transactionCount === 0) {
    issues.push({
      severity: "info",
      title: "No outbound activity on Mantle Sepolia",
      detail: "The wallet has no transaction nonce on the configured Mantle RPC.",
      recommendation: "If this is a demo wallet, fund and use it before presenting live approval flows."
    });
  }

  const tokenAddresses = parseAddressList(process.env.MANTLE_WALLET_SCAN_TOKENS);
  const spenderAddresses = parseAddressList(process.env.MANTLE_WALLET_SCAN_SPENDERS);
  const allowances = [];
  for (const tokenAddress of tokenAddresses) {
    const token = new Contract(tokenAddress, erc20Abi, provider);
    const [symbol, decimals, tokenBalance] = await Promise.all([
      token.symbol().catch(() => "TOKEN"),
      token.decimals().catch(() => 18),
      token.balanceOf(wallet).catch(() => 0n)
    ]);
    for (const spender of spenderAddresses) {
      const allowance = await token.allowance(wallet, spender).catch(() => 0n);
      const formattedAllowance = formatUnits(allowance, decimals);
      const formattedBalance = formatUnits(tokenBalance, decimals);
      allowances.push({ token: tokenAddress, symbol, spender, allowance: formattedAllowance, balance: formattedBalance });
      if (allowance > 0n) {
        issues.push({
          severity: "high",
          title: `Active ${symbol} approval`,
          detail: `${spender} can spend up to ${formattedAllowance} ${symbol} from this wallet.`,
          recommendation: "Revoke unused approvals and prefer limited allowances for Mantle protocol interactions."
        });
      }
    }
  }

  if (!tokenAddresses.length || !spenderAddresses.length) {
    issues.push({
      severity: "info",
      title: "Allowance scan needs monitored token and spender lists",
      detail: "Manwall checked native wallet posture. ERC-20 allowance checks require MANTLE_WALLET_SCAN_TOKENS and MANTLE_WALLET_SCAN_SPENDERS.",
      recommendation: "Configure known Mantle protocol tokens and spender contracts to enable approval exposure checks."
    });
  }

  return {
    wallet,
    network: { name: "Mantle Sepolia", chainId: Number(network.chainId) },
    nativeBalanceMnt: formatEther(balance),
    transactionCount,
    accountType: code === "0x" ? "EOA" : "contract",
    allowances,
    issues,
    summary: riskSummary(issues),
    scannedAt: new Date().toISOString()
  };
}
