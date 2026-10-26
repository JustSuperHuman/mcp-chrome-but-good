import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { config } from 'dotenv';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import Icons from 'unplugin-icons/vite';
import Components from 'unplugin-vue-components/vite';
import IconsResolver from 'unplugin-icons/resolver';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local') });

// Release builds (`JUSTBROWSE_RELEASE=1`, see scripts/package-release.mjs) carry JustBrowse's public key, so
// the unpacked extension has the same ID wherever it is installed and the native host can authorize it.
// Development builds keep the path-derived ID of the checkout they are loaded from.
// CHROME_EXTENSION_KEY overrides both.
const IS_RELEASE = process.env.JUSTBROWSE_RELEASE === '1';
const JUSTBROWSE_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlQGenfqNfisaq4ng9Tcvz1vGNYPUUHeYOKA85e8gTp6PMqHw0h2M8IAesVtCQkN3QQdD5SDagTfBzDJo9Uxikty6yyG7VI3jyKIlTq7+T554wNrED6JX5YokAYFnDNHvdPa5LifcbjfRkxOuDaZoeE4lAAhqs26K2gw+ZfW9y4n519bO5RqcEFMrEmBV5tnzfowcaUJO+QLOnSzcpj0T4t67VR0fmijsgsK66wf6azj4I6RH6albZ23A0THQ33eZixYNaHC1/1rH75Y53lIIE02rMdbFaRaMLRXOClvsWuWisUkfF+hNOBUUZlxc/Nro1mDW+IHvXd6Hl8weQrgkQwIDAQAB';
const CHROME_EXTENSION_KEY =
  process.env.CHROME_EXTENSION_KEY || (IS_RELEASE ? JUSTBROWSE_PUBLIC_KEY : undefined);
// Detect dev mode early for manifest-level switches
const IS_DEV = process.env.NODE_ENV !== 'production' && process.env.MODE !== 'production';
let staticAssetsEmitted = false;

function stableStaticAssets() {
  const roots = [
    { source: resolve('inject-scripts'), output: 'inject-scripts' },
    { source: resolve('workers'), output: 'workers' },
    { source: resolve('_locales'), output: '_locales' },
  ];
  const filesIn = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesIn(path) : [path];
    });

  return {
    name: 'justbrowse-stable-static-assets',
    apply: 'build',
    generateBundle() {
      // WXT invokes the Vite config for several extension entrypoint bundles.
      // They share one output directory, so emit the common assets once.
      if (staticAssetsEmitted) return;
      staticAssetsEmitted = true;
      for (const root of roots) {
        for (const path of filesIn(root.source)) {
          const suffix = relative(root.source, path).split(sep).join('/');
          this.emitFile({
            type: 'asset',
            fileName: `${root.output}/${suffix}`,
            source: readFileSync(path),
          });
        }
      }
    },
  };
}

// CJK characters in the emitted JavaScript (our escaped regexes, and the tokenizer, ELK and linkify tables of
// dependencies) are written as \uXXXX escapes, so the shipped extension holds no literal Chinese text.
// JavaScript reads an escape exactly like the character in strings, regexes and templates.
const CJK = /[\u2e80-\u2fff\u3000-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/g;
function escapeCjk() {
  return {
    name: 'justbrowse-escape-cjk',
    enforce: 'post' as const,
    // after every renderChunk (Vite's es2015 transpile writes escapes back out as characters)
    generateBundle: {
      order: 'post' as const,
      handler(_options: unknown, bundle: Record<string, { type: string; code?: string }>) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type === 'chunk' && chunk.code && chunk.code.match(CJK)) {
            chunk.code = chunk.code.replace(
              CJK,
              (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
            );
          }
        }
      },
    },
  };
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  // a release build goes beside the development one, never over the copy loaded in a browser
  outDir: IS_RELEASE ? '.output-release' : '.output',
  modules: ['@wxt-dev/module-vue'],
  runner: {
    // Option 1: don't launch a browser (recommended)
    disabled: true,

    // Option 2: launch one with your existing profile by uncommenting the settings below
    // chromiumArgs: [
    //   '--user-data-dir=' + homedir() + (process.platform === 'darwin'
    //     ? '/Library/Application Support/Google/Chrome'
    //     : process.platform === 'win32'
    //     ? '/AppData/Local/Google/Chrome/User Data'
    //     : '/.config/google-chrome'),
    //   '--remote-debugging-port=9222',
    // ],
  },
  manifest: {
    // JustBrowse's key for release builds (a stable extension ID), else none
    key: CHROME_EXTENSION_KEY,
    default_locale: 'en',
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    permissions: [
      'nativeMessaging',
      'tabs',
      'tabGroups',
      'activeTab',
      'scripting',
      'contextMenus',
      'downloads',
      'webRequest',
      'webNavigation',
      'debugger',
      'history',
      'bookmarks',
      'offscreen',
      'storage',
      'declarativeNetRequest',
      'alarms',
      // Allow programmatic control of Chrome Side Panel
      'sidePanel',
    ],
    host_permissions: ['<all_urls>'],
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    action: {
      default_popup: 'popup.html',
      default_title: 'Chrome MCP Server',
    },
    // Chrome Side Panel entry for workflow management
    // Ref: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
    side_panel: {
      default_path: 'sidepanel.html',
    },
    // Keyboard shortcuts for quick triggers
    commands: {
      // run_quick_trigger_1: {
      //   suggested_key: { default: 'Ctrl+Shift+1' },
      //   description: 'Run quick trigger 1',
      // },
      // run_quick_trigger_2: {
      //   suggested_key: { default: 'Ctrl+Shift+2' },
      //   description: 'Run quick trigger 2',
      // },
      // run_quick_trigger_3: {
      //   suggested_key: { default: 'Ctrl+Shift+3' },
      //   description: 'Run quick trigger 3',
      // },
      // open_workflow_sidepanel: {
      //   suggested_key: { default: 'Ctrl+Shift+O' },
      //   description: 'Open workflow sidepanel',
      // },
      toggle_web_editor: {
        suggested_key: { default: 'Ctrl+Shift+O', mac: 'Command+Shift+O' },
        description: 'Toggle Web Editor mode',
      },
      toggle_quick_panel: {
        suggested_key: { default: 'Ctrl+Shift+U', mac: 'Command+Shift+U' },
        description: 'Toggle Quick Panel AI Chat',
      },
    },
    web_accessible_resources: [
      {
        resources: [
          '/models/*', // everything under public/models/
          '/workers/*', // the worker files
          '/inject-scripts/*', // helper files that content scripts inject
        ],
        matches: ['<all_urls>'],
      },
    ],
    // These security policies block the dev server's assets, so they apply to production builds
    // only; development uses WXT's default policy.
    ...(IS_DEV
      ? {}
      : {
          cross_origin_embedder_policy: { value: 'require-corp' as const },
          cross_origin_opener_policy: { value: 'same-origin' as const },
          content_security_policy: {
            // Allow inline styles injected by Vite (compiled CSS) and data images used in UI thumbnails
            extension_pages:
              "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;",
          },
        }),
  },
  vite: (env) => ({
    plugins: [
      escapeCjk(),
      // TailwindCSS v4 Vite plugin – no PostCSS config required
      tailwindcss(),
      // Auto-register SVG icons as Vue components; all icons are bundled locally
      Components({
        dts: false,
        resolvers: [IconsResolver({ prefix: 'i', enabledCollections: ['lucide', 'mdi', 'ri'] })],
      }) as any,
      Icons({ compiler: 'vue3', autoInstall: false }) as any,
      // Production assets are Rollup outputs, so WXT cannot enumerate a
      // half-copied directory. Keep the static-copy middleware for dev serving.
      ...(env.command === 'build'
        ? [stableStaticAssets()]
        : (viteStaticCopy({
            targets: [
              { src: 'inject-scripts/*.js', dest: 'inject-scripts' },
              { src: ['workers/*'], dest: 'workers' },
              { src: '_locales/**/*', dest: '_locales' },
            ],
            watch: {} as any,
          }) as any)),
    ],
    build: {
      // the output must run on ES6
      target: 'es2015',
      // source maps outside production
      sourcemap: env.mode !== 'production',
      // skip the gzip size report: compressing large files is slow
      reportCompressedSize: false,
      // warn about chunks over 1500 kB
      chunkSizeWarningLimit: 1500,
      minify: false,
    },
  }),
});
