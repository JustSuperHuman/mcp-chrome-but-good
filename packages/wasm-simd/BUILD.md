# WASM SIMD Build Guide

## 🚀 Quick Build

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install wasm-pack
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
```

### Build Options

1. **Build from the project root** (recommended):

   ```bash
   # Build WASM and copy it into the Chrome extension automatically
   npm run build:wasm
   ```

2. **Build only the WASM package**:

   ```bash
   # From the packages/wasm-simd directory
   npm run build

   # Or from anywhere with a pnpm filter
   pnpm --filter @chrome-mcp/wasm-simd build
   ```

3. **Development build**:
   ```bash
   npm run build:dev  # unoptimized, builds faster
   ```

### Build Output

After the build, `pkg/` contains:

- `simd_math.js` - JavaScript bindings
- `simd_math_bg.wasm` - WebAssembly binary
- `simd_math.d.ts` - TypeScript type definitions
- `package.json` - NPM package info

### Chrome Extension Integration

The WASM files are copied automatically to `app/chrome-extension/workers/`, where the Chrome extension can use them directly:

```typescript
// Use in the Chrome extension
const wasmUrl = chrome.runtime.getURL('workers/simd_math.js');
const wasmModule = await import(wasmUrl);
```

## 🔧 Development Workflow

1. Edit the Rust code in `src/lib.rs`
2. Run `npm run build` to rebuild
3. The Chrome extension picks up the new WASM files automatically

## 📊 Benchmarks

```bash
# Run the benchmark in the Chrome extension
import { runSIMDBenchmark } from './utils/simd-benchmark';
await runSIMDBenchmark();
```
