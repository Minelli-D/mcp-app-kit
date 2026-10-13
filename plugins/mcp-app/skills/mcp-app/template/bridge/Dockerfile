# The bridge: an MCP server that speaks over standard input and output, made reachable over
# HTTP (stateless streamable HTTP) for the gateway. Only the gateway talks to it.
FROM node:22-alpine
# The npm packages of the MCP server, with their versions (the setting MCP_PACKAGES).
# k8s/deploy.sh gives them to the build, so the image always holds exactly these.
ARG MCP_PACKAGES="@modelcontextprotocol/server-filesystem@2026.8.31"
RUN npm install -g --omit=dev supergateway@4.1.0 ${MCP_PACKAGES} \
    && npm cache clean --force
COPY entrypoint.sh /usr/local/bin/bridge-entrypoint
RUN chmod 755 /usr/local/bin/bridge-entrypoint
ENV HOME=/tmp
# The command that starts the MCP server (the setting MCP_COMMAND). The pod sets it too.
ENV MCP_COMMAND="mcp-server-filesystem /data"
WORKDIR /data
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/bridge-entrypoint"]
