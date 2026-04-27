import { useCallback, useEffect, useState } from "react";
import { Button } from "antd";
import { tauriInvoke } from "../lib/tauri";
import nexaraIconUrl from "../assets/nexara.png";

type NexaraBalancePayload = {
  balance: number;
  currency: string;
  rate_per_min: number;
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  RUB: "₽",
  USD: "$",
  EUR: "€",
};

function formatBalance(balance: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? currency;
  const formatted = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(balance);
  return `${formatted} ${symbol}`;
}

export function NexaraBalance() {
  const [balance, setBalance] = useState<NexaraBalancePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [spinKey, setSpinKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await tauriInvoke<NexaraBalancePayload>("get_nexara_balance");
      setBalance(result);
    } catch (err) {
      setBalance(null);
      console.warn("Failed to load Nexara balance:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefresh = useCallback(() => {
    setSpinKey((k) => k + 1);
    void load();
  }, [load]);

  if (!balance) {
    return null;
  }

  const display = formatBalance(balance.balance, balance.currency);
  const titleText = `Баланс Nexara · ставка ${balance.rate_per_min}/мин`;

  return (
    <div className="nexara-balance" title={titleText}>
      <img
        src={nexaraIconUrl}
        alt=""
        aria-hidden="true"
        className="nexara-balance-icon"
      />
      <span
        className={`nexara-balance-value${loading ? " is-loading" : ""}`}
      >
        {display}
      </span>
      <Button
        htmlType="button"
        type="text"
        className="nexara-balance-refresh"
        aria-label="Обновить баланс"
        title="Обновить баланс"
        onClick={handleRefresh}
        disabled={loading}
      >
        <svg
          key={spinKey}
          className={spinKey > 0 ? "refresh-icon-spin" : undefined}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            d="M20 12a8 8 0 1 1-2.34-5.66"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M20 4v5h-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Button>
    </div>
  );
}
