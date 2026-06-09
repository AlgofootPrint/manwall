import { useEffect, useRef, useState } from "react";
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
  const disconnectedByUser = useRef(true);

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
    const accountsChanged = (accounts: string[]) => {
      if (!disconnectedByUser.current) void refresh(accounts[0] ?? "").catch(() => undefined);
    };
    const chainChanged = () => {
      if (!disconnectedByUser.current) void refresh().catch(() => undefined);
    };
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

  async function revokeAccountPermission() {
    if (!window.ethereum) return false;
    try {
      await window.ethereum.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }]
      });
      return true;
    } catch {
      return false;
    }
  }

  async function waitForAccountPermissionToClear() {
    if (!window.ethereum) return true;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const accounts = await window.ethereum.request({ method: "eth_accounts" }) as string[];
      if (accounts.length === 0) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    return false;
  }

  async function requestAccountSelection() {
    if (!window.ethereum) return [];
    const revoked = await revokeAccountPermission();
    if (revoked) await waitForAccountPermissionToClear();
    return window.ethereum.request({ method: "eth_requestAccounts" }) as Promise<string[]>;
  }

  async function connect(_forcePrompt = false) {
    let connectedAccount = "";
    await run(async () => {
      if (!window.ethereum) throw new Error("No injected wallet detected. Install MetaMask or another EVM wallet.");
      disconnectedByUser.current = true;
      setAccount("");
      setChainId("");
      setBalance("");
      setSignature("");
      const accounts = await requestAccountSelection();
      connectedAccount = accounts[0] ?? "";
      disconnectedByUser.current = false;
      await refresh(connectedAccount);
    });
    return connectedAccount;
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

  async function signEvidence(message: string) {
    let signed = "";
    await run(async () => {
      if (!window.ethereum || !account) throw new Error("Connect a wallet before approving evidence.");
      if (!onMantleSepolia) throw new Error("Switch to Mantle Sepolia before approving evidence.");
      const provider = new BrowserProvider(window.ethereum as any);
      const signer = await provider.getSigner();
      signed = await signer.signMessage(message);
      setSignature(signed);
    });
    return signed;
  }

  async function disconnect() {
    disconnectedByUser.current = true;
    setAccount("");
    setChainId("");
    setBalance("");
    setSignature("");
    setBusy(true);
    setError("");
    try {
      const revoked = await revokeAccountPermission();
      if (revoked) await waitForAccountPermissionToClear();
    } finally {
      setBusy(false);
    }
  }

  return {
    installed, account, chainId, balance, signature, busy, error, onMantleSepolia,
    connect, disconnect, switchToMantle, signEvidence
  };
}
