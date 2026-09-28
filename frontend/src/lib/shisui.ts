import type { Monaco } from "@monaco-editor/react";

const properties = {
  ink100: "--sh-ink-100",
  ink300: "--sh-ink-300",
  ink500: "--sh-ink-500",
  ink700: "--sh-ink-700",
  paper: "--sh-paper",
  paper2: "--sh-paper-2",
  paper3: "--sh-paper-3",
  canvas: "--sh-canvas",
  gray200: "--sh-gray-200",
  gray400: "--sh-gray-400",
  gray500: "--sh-gray-500",
  gray900: "--sh-gray-900",
  success: "--sh-success",
  successBg: "--sh-success-bg",
  danger: "--sh-danger",
  dangerBg: "--sh-danger-bg",
  viz1: "--sh-viz-1",
  viz2: "--sh-viz-2",
  viz3: "--sh-viz-3",
  viz4: "--sh-viz-4",
  viz5: "--sh-viz-5",
  viz6: "--sh-viz-6",
  viz7: "--sh-viz-7",
  viz8: "--sh-viz-8",
  fontSans: "--sh-font-sans",
  fontMono: "--sh-font-mono",
  fontNumber: "--sh-font-number",
} as const;

export type ShisuiTheme = { [Token in keyof typeof properties]: string };

let resolvedTheme: ShisuiTheme | undefined;

export function resolveShisuiTheme(): ShisuiTheme {
  if (!resolvedTheme) {
    const styles = getComputedStyle(document.documentElement);
    resolvedTheme = Object.fromEntries(
      Object.entries(properties).map(([token, property]) => [token, styles.getPropertyValue(property).trim()]),
    ) as ShisuiTheme;
  }
  return resolvedTheme;
}

export const SHISUI_MONACO_THEME = "shisui";

const monacoColor = (value: string) => value.replace(/^#/, "");

export function configureShisuiMonaco(monaco: Monaco) {
  const theme = resolveShisuiTheme();
  monaco.editor.defineTheme(SHISUI_MONACO_THEME, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: monacoColor(theme.gray500), fontStyle: "italic" },
      { token: "keyword", foreground: monacoColor(theme.ink700), fontStyle: "bold" },
      { token: "number", foreground: monacoColor(theme.viz4) },
      { token: "string", foreground: monacoColor(theme.success) },
      { token: "type", foreground: monacoColor(theme.ink500) },
    ],
    colors: {
      "editor.background": theme.canvas,
      "editor.foreground": theme.gray900,
      "editorCursor.foreground": theme.ink700,
      "editorGutter.background": theme.canvas,
      "editorLineNumber.foreground": theme.gray400,
      "editorLineNumber.activeForeground": theme.ink700,
      "editor.lineHighlightBackground": theme.paper,
      "editor.selectionBackground": theme.ink100,
      "editor.inactiveSelectionBackground": theme.paper3,
      "editorWhitespace.foreground": theme.paper3,
      "editorIndentGuide.background1": theme.paper3,
      "editorIndentGuide.activeBackground1": theme.gray200,
      "diffEditor.insertedTextBackground": theme.successBg,
      "diffEditor.removedTextBackground": theme.dangerBg,
      "diffEditor.insertedLineBackground": theme.successBg,
      "diffEditor.removedLineBackground": theme.dangerBg,
      "diffEditor.insertedTextBorder": theme.success,
      "diffEditor.removedTextBorder": theme.danger,
      "diffEditor.diagonalFill": theme.paper3,
    },
  });
}
