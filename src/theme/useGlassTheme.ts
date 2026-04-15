import { useMemo } from "react";
import { theme, type ConfigProviderProps } from "antd";
import clsx from "clsx";
import styles from "./glassTheme.module.css";

export function useGlassTheme(): ConfigProviderProps {
  return useMemo<ConfigProviderProps>(
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
      app: {
        className: styles.app,
      },
      card: {
        classNames: {
          root: styles.cardRoot,
        },
      },
      modal: {
        classNames: {
          container: styles.modalContainer,
        },
      },
      button: {
        classNames: ({ props }) => ({
          root: clsx(
            styles.buttonRoot,
            (props.variant !== "solid" || props.color === "default" || props.type === "default") &&
              styles.buttonRootDefaultColor
          ),
        }),
      },
      alert: {
        className: clsx(styles.glassBox, styles.notBackdropFilter),
      },
      dropdown: {
        classNames: {
          root: styles.dropdownRoot,
        },
      },
      select: {
        classNames: {
          root: clsx(styles.glassBox, styles.notBackdropFilter),
          popup: {
            root: styles.glassBox,
          },
        },
      },
      input: {
        classNames: {
          root: clsx(styles.glassBox, styles.notBackdropFilter),
        },
      },
      inputNumber: {
        classNames: {
          root: clsx(styles.glassBox, styles.notBackdropFilter),
        },
      },
      popover: {
        classNames: {
          container: styles.glassBox,
        },
      },
      switch: {
        classNames: {
          root: styles.switchRoot,
        },
      },
      radio: {
        classNames: {
          root: styles.radioButtonRoot,
        },
      },
      segmented: {
        className: styles.segmentedRoot,
      },
      progress: {
        classNames: {
          track: styles.glassBorder,
        },
        styles: {
          track: {
            height: 12,
          },
          rail: {
            height: 12,
          },
        },
      },
    }),
    []
  );
}
