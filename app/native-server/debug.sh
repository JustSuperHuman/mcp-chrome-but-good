#!/bin/bash
# Absolute directory of this script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="/Users/hang/code/tencent/ai/chrome-mcp-server/app/native-server/dist/logs" # Or any directory you know you can write to

# Timestamp for the log file names, so runs don't overwrite each other
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
WRAPPER_LOG="${LOG_DIR}/native_host_wrapper_${TIMESTAMP}.log"

# Actual path of the Node.js script
NODE_SCRIPT="${SCRIPT_DIR}/index.js"

# Make sure the log directory exists
mkdir -p "${LOG_DIR}"

# Log that the wrapper script was called
echo "Wrapper script called at $(date)" > "${WRAPPER_LOG}"
echo "SCRIPT_DIR: ${SCRIPT_DIR}" >> "${WRAPPER_LOG}"
echo "LOG_DIR: ${LOG_DIR}" >> "${WRAPPER_LOG}"
echo "NODE_SCRIPT: ${NODE_SCRIPT}" >> "${WRAPPER_LOG}"
echo "Initial PATH: ${PATH}" >> "${WRAPPER_LOG}"

# Find the Node.js executable
NODE_EXEC=""
# 1. Try which (it uses the current PATH, but Chrome's PATH may be incomplete)
if command -v node &>/dev/null; then
    NODE_EXEC=$(command -v node)
    echo "Found node using 'command -v node': ${NODE_EXEC}" >> "${WRAPPER_LOG}"
fi

# 2. If which finds nothing, try some common Node.js install paths on macOS
if [ -z "${NODE_EXEC}" ]; then
    COMMON_NODE_PATHS=(
        "/usr/local/bin/node"            # Homebrew on Intel Macs / direct install
        "/opt/homebrew/bin/node"         # Homebrew on Apple Silicon
        "$HOME/.nvm/versions/node/$(ls -t $HOME/.nvm/versions/node | head -n 1)/bin/node" # NVM (latest installed)
        # Add more paths that may exist in your environment as needed
    )
    for path_to_node in "${COMMON_NODE_PATHS[@]}"; do
        if [ -x "${path_to_node}" ]; then
            NODE_EXEC="${path_to_node}"
            echo "Found node at common path: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
            break
        fi
    done
fi

# 3. If still not found, log an error and exit
if [ -z "${NODE_EXEC}" ]; then
    echo "ERROR: Node.js executable not found!" >> "${WRAPPER_LOG}"
    echo "Please ensure Node.js is installed and its path is accessible or configured in this script." >> "${WRAPPER_LOG}"
    # A Native Host has to keep running to receive messages, so exiting isn't ideal,
    # but without node the target script can't run at all.
    # We could send the extension an error message in the Native Messaging protocol (if possible)
    # or just let it fail; Chrome will report Native Host Exited.
    exit 1 # Must exit, otherwise the exec below fails
fi

echo "Using Node executable: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
echo "Node version found by script: $(${NODE_EXEC} -v)" >> "${WRAPPER_LOG}"
echo "Executing: ${NODE_EXEC} ${NODE_SCRIPT}" >> "${WRAPPER_LOG}"
echo "PWD: $(pwd)" >> "${WRAPPER_LOG}" # Log PWD, sometimes useful

exec "${NODE_EXEC}" "${NODE_SCRIPT}" 2>> "${LOG_DIR}/native_host_stderr_${TIMESTAMP}.log"