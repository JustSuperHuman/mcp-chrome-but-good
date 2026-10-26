# Fastify Chrome Native Messaging Service

A Fastify-based TypeScript project for native communication with the Chrome extension.

## Features

- Two-way communication with the Chrome extension over the Chrome Native Messaging protocol
- **Multi-browser support**: Chrome and Chromium (on Linux, macOS and Windows)
- RESTful API service
- Written entirely in TypeScript
- Includes a full test suite
- Follows code quality best practices

## Development Setup

### Prerequisites

- Node.js 20+
- npm 8+ or pnpm 8+

### Installation

```bash
git clone https://github.com/your-username/fastify-chrome-native.git
cd fastify-chrome-native
npm install
```

### Development

1. Build locally and register the native server

```bash
cd app/native-server
npm run dev
```

2. Start the chrome extension

```bash
cd app/chrome-extension
npm run dev
```

### Build

```bash
npm run build
```

### Register the Native Messaging Host

#### Detect and register all installed browsers

```bash
mcp-chrome-bridge register --detect
```

#### Register specific browsers

```bash
# Register Chrome only
mcp-chrome-bridge register --browser chrome

# Register Chromium only
mcp-chrome-bridge register --browser chromium

# Register all supported browsers
mcp-chrome-bridge register --browser all
```

#### Global install (registers detected browsers automatically)

```bash
npm i -g mcp-chrome-bridge
```

#### Browser support

| Browser       | Linux | macOS | Windows |
| ------------- | ----- | ----- | ------- |
| Google Chrome | ✓     | ✓     | ✓       |
| Chromium      | ✓     | ✓     | ✓       |

Registration locations:

- **Linux**: `~/.config/[browser-name]/NativeMessagingHosts/`
- **macOS**: `~/Library/Application Support/[Browser]/NativeMessagingHosts/`
- **Windows**: `%APPDATA%\[Browser]\NativeMessagingHosts\`

### Integrating with the Chrome Extension

A simple example of using this service from a Chrome extension:

```javascript
// background.js
let nativePort = null;
let serverRunning = false;

// Start the Native Messaging service
function startServer() {
  if (nativePort) {
    console.log('Already connected to the Native Messaging host');
    return;
  }

  try {
    nativePort = chrome.runtime.connectNative('com.yourcompany.fastify_native_host');

    nativePort.onMessage.addListener((message) => {
      console.log('Native message received:', message);

      if (message.type === 'started') {
        serverRunning = true;
        console.log(`Service started on port: ${message.payload.port}`);
      } else if (message.type === 'stopped') {
        serverRunning = false;
        console.log('Service stopped');
      } else if (message.type === 'error') {
        console.error('Native error:', message.payload.message);
      }
    });

    nativePort.onDisconnect.addListener(() => {
      console.log('Native connection lost:', chrome.runtime.lastError);
      nativePort = null;
      serverRunning = false;
    });

    // Start the server
    nativePort.postMessage({ type: 'start', payload: { port: 3000 } });
  } catch (error) {
    console.error('Error starting Native Messaging:', error);
  }
}

// Stop the server
function stopServer() {
  if (nativePort && serverRunning) {
    nativePort.postMessage({ type: 'stop' });
  }
}

// Test communication with the server
async function testPing() {
  try {
    const response = await fetch('http://localhost:3000/ping');
    const data = await response.json();
    console.log('Ping response:', data);
    return data;
  } catch (error) {
    console.error('Ping failed:', error);
    return null;
  }
}

// Connect to the native host when the extension starts
chrome.runtime.onStartup.addListener(startServer);

// API for the popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startServer') {
    startServer();
    sendResponse({ success: true });
  } else if (message.action === 'stopServer') {
    stopServer();
    sendResponse({ success: true });
  } else if (message.action === 'testPing') {
    testPing().then(sendResponse);
    return true; // We will send the response asynchronously
  }
});
```

### Testing

```bash
npm run test
```

### License

MIT
