import { useMemo } from "react";
import type { ConfigProviderProps } from "antd/es/config-provider";
import theme from "antd/es/theme";
import clsx from "clsx";
import styles from "./glassTheme.module.css";

type GlassThemeConfig = ConfigProviderProps & {
  appClassName: string;
};

export function useGlassTheme(): GlassThemeConfig {
  return useMemo<GlassThemeConfig>(
    () => ({
      theme: {
        algorithm: theme.defaultAlgorithm,
        token: {
          borderRadius: 12,
          borderRadiusLG: 12,
          borderRadiusSM: 12,
          borderRadiusXS: 12,
          motionDurationSlow: "0.2s",
          motionDurationMid: "0.1s",
          motionDurationFast: "0.05s",
        },
      },
      appClassName: styles.app,
      card: {
        className: styles.cardRoot,
      },
      modal: {
        classNames: {
          content: styles.modalContent,
        },
      },
      button: {
        className: styles.buttonRoot,
      },
      alert: {
        className: clsx(styles.glassBox, styles.notBackdropFilter),
      },
      dropdown: {
        className: styles.dropdownRoot,
      },
      select: {
        className: clsx(styles.glassBox, styles.notBackdropFilter),
      },
      input: {
        className: clsx(styles.glassBox, styles.notBackdropFilter),
      },
      inputNumber: {
        className: clsx(styles.glassBox, styles.notBackdropFilter),
      },
      switch: {
        className: styles.switchRoot,
      },
      radio: {
        className: styles.radioButtonRoot,
      },
      segmented: {
        className: styles.segmentedRoot,
      },
      progress: {
        className: styles.glassBorder,
      },
    }),
    []
  );
}
