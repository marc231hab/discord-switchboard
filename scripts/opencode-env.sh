# Shared environment for opencode bindings. Source with the channel config path as $1.
# Secrets are read from 0600 files; never pass them in argv.
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
source "${GLOBAL_ENV_FILE:-$ROOT_DIR/config/global.env}"
source "${1:?opencode channel configuration is required}"
set +a
export OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_AUTOUPDATE=1
if [[ -n "${OPENCODE_CONFIG:-}" ]]; then export OPENCODE_CONFIG; else unset OPENCODE_CONFIG; fi
OPENCODE_SERVER_PASSWORD="$(cat "$OPENCODE_PASSWORD_FILE")"
export OPENCODE_SERVER_PASSWORD
