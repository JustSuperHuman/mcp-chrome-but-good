# Chrome MCP Bridge Installation Guide

This document describes how Chrome MCP Bridge is installed and registered.

## Installation Overview

Chrome MCP Bridge is installed and registered as follows:

```
npm install -g mcp-chrome-bridge
└─ postinstall.js
   ├─ Copy executables to npm_prefix/bin   ← Always writable (user or root)
   ├─ Try user-level registration          ← No sudo needed, succeeds in most cases
   └─ If that fails ➜ ask the user to run mcp-chrome-bridge register --system
      └─ Must be run manually with administrator privileges
```

The flow above shows the full process, from the global install to a finished registration.

## Installation Steps

### 1. Global install

```bash
npm install -g mcp-chrome-bridge
```

After installation, it automatically tries to register the Native Messaging host in the user directory. This needs no administrator privileges and is the recommended way to install.

### 2. User-level registration

User-level registration creates the manifest file in the following locations:

```
Manifest file locations
├─ User level (no administrator privileges needed)
│  ├─ Windows: %APPDATA%\Google\Chrome\NativeMessagingHosts\
│  ├─ macOS:   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
│  └─ Linux:   ~/.config/google-chrome/NativeMessagingHosts/
│
└─ System level (administrator privileges needed)
   ├─ Windows: %ProgramFiles%\Google\Chrome\NativeMessagingHosts\
   ├─ macOS:   /Library/Google/Chrome/NativeMessagingHosts/
   └─ Linux:   /etc/opt/chrome/native-messaging-hosts/
```

If automatic registration fails, or you want to register manually, run:

```bash
mcp-chrome-bridge register
```

**Recommended: run the diagnostic tool to check for problems:**

```bash
mcp-chrome-bridge doctor
```

### 3. System-level registration

If user-level registration fails (for example because of permission problems), you can try system-level registration. It needs administrator privileges, but there are two convenient ways to do it.

The two ways to register at system level:

#### Option 1: use the `--system` flag (recommended)

```bash
# macOS/Linux
sudo mcp-chrome-bridge register --system

# Windows (run Command Prompt as administrator)
mcp-chrome-bridge register --system
```

A system-level install needs administrator privileges to write to system directories and the registry.

#### Option 2: run with administrator privileges directly

**Windows**:
Run Command Prompt or PowerShell as administrator, then run:

```
mcp-chrome-bridge register
```

**macOS/Linux**:
Use sudo:

```
sudo mcp-chrome-bridge register
```

## Registration in Detail

### Registration flowchart

```
Registration
├─ User-level registration (mcp-chrome-bridge register)
│  ├─ Get the user-level manifest path
│  ├─ Create the user directory
│  ├─ Generate the manifest content
│  ├─ Write the manifest file
│  └─ Windows: create the user-level registry entry
│
└─ System-level registration (mcp-chrome-bridge register --system)
   ├─ Check for administrator privileges
   │  ├─ Privileged → create the system directory and write the manifest directly
   │  └─ Not privileged → ask the user to run with administrator privileges
   └─ Windows: create the system-level registry entry
```

### Manifest file structure

```
manifest.json
├─ name: "com.chromemcp.nativehost"
├─ description: "Node.js Host for Browser Bridge Extension"
├─ path: "/path/to/run_host.sh"       ← Startup script path
├─ type: "stdio"                      ← Communication type
└─ allowed_origins: [                 ← Extensions allowed to connect
   "chrome-extension://EXTENSION_ID/"
]
```

### User-level registration steps

1. Determine the user-level manifest file path
2. Create the required directories
3. Generate the manifest content, including:
   - Host name
   - Description
   - Node.js executable path
   - Communication type (stdio)
   - Allowed extension IDs
   - Startup arguments
4. Write the manifest file
5. On Windows, also create the matching registry entry

### System-level registration steps

1. Check whether administrator privileges are already available
2. If they are:
   - Create the system-level directory directly
   - Write the manifest file
   - Set the appropriate permissions
   - On Windows, create the system-level registry entry
3. If they are not:
   - Ask the user to rerun the command with administrator privileges
   - macOS/Linux: `sudo mcp-chrome-bridge register --system`
   - Windows: run Command Prompt as administrator

## Verifying the Installation

### Verification flowchart

```
Verify the installation
├─ Check the manifest file
│  ├─ File exists → check that its content is correct
│  └─ File missing → reinstall
│
├─ Check the Chrome extension
│  ├─ Extension installed → check its permissions
│  └─ Extension not installed → install it
│
└─ Test the connection
   ├─ Connected → installation complete
   └─ Connection failed → check the error logs → see Troubleshooting
```

### Verification steps

After installation, you can verify that it succeeded as follows:

1. Check that the manifest file exists in the right directory
   - User level: check the manifest file in the user directory
   - System level: check the manifest file in the system directory
   - Confirm the manifest content is correct

2. Install the matching extension in Chrome
   - Make sure the extension is installed correctly
   - Make sure the extension has the `nativeMessaging` permission

3. Try connecting to the local service through the extension
   - Use the extension's test feature to try connecting
   - Check Chrome's extension logs for errors

## Troubleshooting

### Troubleshooting flowchart

```
Troubleshooting
├─ Permission problems
│  ├─ Check user permissions
│  │  ├─ Sufficient permissions → check directory permissions
│  │  └─ Insufficient permissions → try a system-level install
│  │
│  ├─ Execute permission problems (macOS/Linux)
│  │  ├─ "Permission denied" error
│  │  ├─ "Native host has exited" error
│  │  └─ Run mcp-chrome-bridge fix-permissions
│  │
│  └─ Try mcp-chrome-bridge register --system
│
├─ Path problems
│  ├─ Check the Node.js install (node -v)
│  └─ Check the global NPM path (npm root -g)
│
├─ Registry problems (Windows)
│  ├─ Check registry access permissions
│  └─ Try creating the registry entry manually
│
└─ Other problems
   ├─ Check the console error messages
   └─ Open an issue on the project repository
```

### Common fixes

If you run into problems during installation, try the following steps:

1. Make sure Node.js is installed correctly
   - Run `node -v` and `npm -v` to check the versions
   - Make sure the Node.js version is >= 20.x

2. Check that you have permission to create files and directories
   - A user-level install needs write access to the user directory
   - A system-level install needs administrator/root privileges

3. **Fix execute permission problems**

   **macOS/Linux**:

   **Problem**:
   - npm usually preserves file permissions, but pnpm may not
   - You may see "Permission denied" or "Native host has exited" errors
   - The Chrome extension cannot start the native host process

   **Solutions**:

   a) **Use the built-in fix command (recommended)**:

   ```bash
   mcp-chrome-bridge fix-permissions
   ```

   b) **Run the diagnostic tool to fix it automatically**:

   ```bash
   mcp-chrome-bridge doctor --fix
   ```

   c) **Set permissions manually**:

   ```bash
   # Find the install path
   npm list -g mcp-chrome-bridge
   # Or for pnpm
   pnpm list -g mcp-chrome-bridge

   # Set execute permissions (replace with the actual path)
   chmod +x /path/to/node_modules/mcp-chrome-bridge/run_host.sh
   chmod +x /path/to/node_modules/mcp-chrome-bridge/index.js
   chmod +x /path/to/node_modules/mcp-chrome-bridge/cli.js
   ```

   **Windows**:

   **Problem**:
   - `.bat` files on Windows usually need no execute permission, but other problems can occur
   - Files may be marked read-only
   - You may see "Access denied" or errors about files that cannot be executed

   **Solutions**:

   a) **Use the built-in fix command (recommended)**:

   ```cmd
   mcp-chrome-bridge fix-permissions
   ```

   b) **Run the diagnostic tool to fix it automatically**:

   ```cmd
   mcp-chrome-bridge doctor --fix
   ```

   c) **Check the file attributes manually**:

   ```cmd
   # Find the install path
   npm list -g mcp-chrome-bridge

   # Check the file attributes (right-click -> Properties in File Explorer)
   # Make sure run_host.bat is not read-only
   ```

   d) **Reinstall and force permissions**:

   ```bash
   # Uninstall
   npm uninstall -g mcp-chrome-bridge
   # Or pnpm uninstall -g mcp-chrome-bridge

   # Reinstall
   npm install -g mcp-chrome-bridge
   # Or pnpm install -g mcp-chrome-bridge

   # If problems remain, run the permission fix
   mcp-chrome-bridge fix-permissions
   ```

4. On Windows, make sure registry access is not restricted
   - Check that you can access `HKCU\Software\Google\Chrome\NativeMessagingHosts\`
   - For system level, check `HKLM\Software\Google\Chrome\NativeMessagingHosts\`

5. Try a system-level install
   - Use the `mcp-chrome-bridge register --system` command
   - Or run directly with administrator privileges

6. Check the error messages in the console output
   - Detailed error messages usually point to the problem
   - Add the `--verbose` flag for more log output

If the problem persists, open an issue on the project repository and include:

- Operating system version
- Node.js version
- Install command
- Error messages
- What you have already tried
