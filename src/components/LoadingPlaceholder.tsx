import { Spin } from "antd";

type LoadingPlaceholderProps = {
  label: string;
  className?: string;
  ariaLabel?: string;
};

export function LoadingPlaceholder({ label, className, ariaLabel }: LoadingPlaceholderProps) {
  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-label={ariaLabel ?? label}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "60px 20px",
        gap: 12,
      }}
    >
      <Spin />
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
    </div>
  );
}
