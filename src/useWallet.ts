import { useEffect, useState } from "react";
import { BrowserProvider, formatEther } from "ethers";

const MANTLE_SEPOLIA = {
  chainId: "0x138b",
  chainName: "Mantle Sepolia Testnet",
  nativeCurrency: { name: "Mantle", symbol: "MNT", decimals: 18 },
  rpcUrls: ["https://rpc.sepolia.mantle.xyz"],
  blockExplorerUrls: ["https://explorer.sepolia.mantle.xyz"]
};

type InjectedProvider = {
  request: (request: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, listener: (...args: any[]) => void) => void;
  removeListener?: (event: string, listener: (...args: any[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: InjectedProvider;
  }
}

export function useWallet() {
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState("");
  const [balance, setBalance] = useState("");
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const installed = typeof window !== "undefined" && !!window.ethereum;
  const onMantleSepolia = chainId.toLowerCase() === MANTLE_SEPOLIA.chainId;

  async function refresh(nextAccount?: string) {
    if (!window.ethereum) return;
    const accounts = await window.ethereum.request({ method: "eth_accounts" }) as string[];
    const activeAccount = nextAccount ?? accounts[0] ?? "";
    const currentChain = await window.ethereum.request({ method: "eth_chainId" }) as string;
    setAccount(activeAccount);
    setChainId(currentChain);
    setSignature("");
    if (activeAccount) {
      const provider = new BrowserProvider(window.ethereum as any);
      setBalance(formatEther(await provider.getBalance(activeAccount)));
    } else {
      setBalance("");
    }
  }

  useEffect(() => {
    if (!window.ethereum) return;
    void refresh();
    const accountsChanged = (accounts: string[]) => void refresh(accounts[0] ?? "");
    const chainChanged = () => void refresh();
    window.ethereum.on?.("accountsChanged", accountsChanged);
    window.ethereum.on?.("chainChanged", chainChanged);
    return () => {
      window.ethereum?.removeListener?.("accountsChanged", accountsChanged);
      window.ethereum?.removeListener?.("chainChanged", chainChanged);
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Wallet request failed";
      setError(message.includes("user rejected") ? "Wallet request rejected" : message);
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    await run(async () => {
      if (!window.ethereum) throw new Error("No injected wallet detected. Install MetaMask or another EVM wallet.");
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
      await refresh(accounts[0]);
    });
  }

  async function switchToMantle() {
    await run(async () => {
      if (!window.ethereum) throw new Error("No injected wallet detected.");
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: MANTLE_SEPOLIA.chainId }]
        });
      } catch (reason: any) {
        if (reason?.code !== 4902) throw reason;
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [MANTLE_SEPOLIA]
        });
      }
      await refresh();
    });
  }

  async function signEvidence(scanId: string, evidenceHash: string) {
    await run(async () => {
      if (!window.ethereum || !account) throw new Error("Connect a wallet before approving evidence.");
      if (!onMantleSepolia) throw new Error("Switch to Mantle Sepolia before approving evidence.");
      const provider = new BrowserProvider(window.ethereum as any);
      const signer = await provider.getSigner();
      const message = [
        "manwall evidence approval",
        `scan: ${scanId}`,
        `evidence: ${evidenceHash}`,
        "network: Mantle Sepolia (5003)",
        "This signature approves the evidence record. It does not submit a transaction."
      ].join("\n");
      setSignature(await signer.signMessage(message));
    });
  }

  function disconnect() {
    setAccount("");
    setBalance("");
    setSignature("");
    setError("");
  }

  return {
    installed, account, chainId, balance, signature, busy, error, onMantleSepolia,
    connect, disconnect, switchToMantle, signEvidence
  };
}
