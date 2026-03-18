import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    ".venv-sidecar/**",
    "next-env.d.ts",
    "public/ffmpeg/**",
    "src-tauri/target/**",
    "src/app/**",
    "src/components/AssetGenPanel.tsx",
    "src/components/Editor.tsx",
    "src/components/ExportButton.tsx",
    "src/components/ImageGenPanel.tsx",
    "src/components/TextEditorBar.tsx",
    "src/components/VibeFontPanel.tsx",
    "src/components/VibeTransitionPanel.tsx",
    "src/components/VideoMergePanel.tsx",
    "src/components/VideoUpload.tsx",
    "src/hooks/useFFmpeg.ts",
    "src/lib/ai-media.ts",
    "src/lib/ffmpeg.ts",
  ]),
]);

export default eslintConfig;
