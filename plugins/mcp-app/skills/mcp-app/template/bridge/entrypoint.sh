#!/bin/sh
# Starts the bridge on a secret path. MCP_SECRET and MCP_COMMAND come from the container
# environment. The secret path is known to the gateway only.
set -eu
: "${MCP_SECRET:?MCP_SECRET is not set}"
: "${MCP_COMMAND:?MCP_COMMAND is not set}"
exec supergateway \
  --stdio "$MCP_COMMAND" \
  --outputTransport streamableHttp \
  --port 8000 \
  --streamableHttpPath "/mcp-${MCP_SECRET}"
