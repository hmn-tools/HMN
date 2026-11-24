/**
 * Design tokens: Garden, from docs/UX.md, "Design system". The Swift themes of the app, the widget, and the menu
 * bar app have the same values. Each colour has a light value here and a dark value in `dark`.
 */
export const tokens = {
  ground: "#EAEAE7",
  card: "#FFFFFF",
  ink: "#0D0D0D",
  paper: "#F4F4F2",
  graphite: "#434343",
  stone: "#595956",
  hair: "#D3D3CF",
  rule: "#ECECE9",
  teal: "#6FA8A0",
  tealDark: "#3F6F68",
  tealTint: "#E8F1EF",
  danger: "#A33A2E",
  lilac: "#9A8BB0",
  coral: "#D98A82",
  sand: "#E8CF8A",
  icon: "#1D1C1A",
} as const;

export const dark: Record<keyof typeof tokens, string> = {
  ground: "#121211",
  card: "#1E1E1C",
  ink: "#EDEDEA",
  paper: "#121211",
  graphite: "#C6C6C1",
  stone: "#9E9E98",
  hair: "#3A3A36",
  rule: "#2C2C29",
  teal: "#7DB8AF",
  tealDark: "#8FC8BF",
  tealTint: "#1E2E2B",
  danger: "#EC8A7A",
  lilac: "#A898BF",
  coral: "#E0958D",
  sand: "#E3CB88",
  icon: "#EDEDEA",
};
