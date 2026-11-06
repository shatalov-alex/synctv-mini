# Small production image for the VPS, cross-compiled so an arm64 Mac can build for amd64 at
# native speed. Only the features this deployment runs: no Kubernetes, OpenAPI or embedded web UI.
FROM --platform=$BUILDPLATFORM rust:slim-trixie AS builder

ARG TARGETARCH
ARG BUILD_JOBS=2

RUN set -e; \
    case "$TARGETARCH" in \
        amd64) cross=x86-64 ;; \
        arm64) cross=aarch64 ;; \
        *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y protobuf-compiler pkg-config build-essential lld libclang-dev nasm cmake \
        curl unzip perl perl-modules-5.40 "gcc-$cross-linux-gnu" "g++-$cross-linux-gnu"; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV SQLX_OFFLINE=true CARGO_INCREMENTAL=0
COPY . .

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,id=synctv-vps-rustup,target=/usr/local/rustup,sharing=locked \
    --mount=type=cache,id=synctv-vps-target-${TARGETARCH},target=/app/target,sharing=locked \
    set -e; \
    case "$TARGETARCH" in \
        amd64) triple=x86_64-unknown-linux-gnu; gnu=x86_64-linux-gnu ;; \
        arm64) triple=aarch64-unknown-linux-gnu; gnu=aarch64-linux-gnu ;; \
    esac; \
    env_triple=$(echo "$triple" | tr '-' '_'); \
    upper_triple=$(echo "$env_triple" | tr 'a-z' 'A-Z'); \
    export "CC_$env_triple=$gnu-gcc" "CXX_$env_triple=$gnu-g++" "AR_$env_triple=$gnu-ar"; \
    export "CARGO_TARGET_${upper_triple}_LINKER=$gnu-gcc"; \
    if [ -d "/usr/$gnu" ]; then export BINDGEN_EXTRA_CLANG_ARGS="--sysroot=/usr/$gnu -I/usr/$gnu/include"; fi; \
    export PKG_CONFIG_ALLOW_CROSS=1; \
    # Same flags as .cargo/config.toml, with fewer frontend threads to keep the build's RAM down.
    export RUSTFLAGS="-Zthreads=2 -Zshare-generics=y -Znext-solver=coherence -C link-arg=-fuse-ld=lld -C link-arg=-Wl,-z,pack-relative-relocs"; \
    rustup target add "$triple"; \
    cargo rustc --profile release --target "$triple" -j "$BUILD_JOBS" \
        --features mimalloc,web-ui-dynamic -p synctv --bin synctv; \
    cp "target/$triple/release/synctv" /synctv

FROM debian:trixie-slim

# ca-certificates: outgoing HTTPS. curl: the health check.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man

RUN useradd -m -u 1000 synctv && mkdir -p /app /data /run/synctv \
    && chown -R synctv:synctv /app /data /run/synctv
WORKDIR /app
COPY --from=builder /synctv /usr/local/bin/synctv
USER synctv

EXPOSE 8080
ENTRYPOINT ["synctv"]
CMD ["serve"]
