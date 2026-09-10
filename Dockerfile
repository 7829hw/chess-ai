# Static-only image: nginx serves the app, chess.js and the Stockfish WASM engine.
# There is no application server of any kind in this project.
FROM nginx:1.29-alpine

LABEL org.opencontainers.image.title="stockfish-chess" \
      org.opencontainers.image.description="Static browser chess UI playing against Stockfish WASM in a Web Worker" \
      org.opencontainers.image.licenses="GPL-3.0"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/

# Pre-compress the static assets at build time so `gzip_static` can serve them
# without re-compressing the ~7 MB engine binary on every request.
RUN find /usr/share/nginx/html -type f \
        \( -name '*.html' -o -name '*.css' -o -name '*.js' -o -name '*.mjs' \
           -o -name '*.wasm' -o -name '*.svg' -o -name '*.map' -o -name '*.txt' \) \
        -size +1k -exec gzip -9 -k -f {} + \
 && nginx -t

EXPOSE 80
