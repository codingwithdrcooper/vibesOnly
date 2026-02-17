# Stage 1: Build
FROM node:24 AS builder

# Install ffmpeg for audio format conversion and build tools for whisper.cpp
RUN apt-get update && apt-get install -y ffmpeg build-essential curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all dependencies (including dev for TypeScript compilation)
COPY package*.json ./
RUN npm ci

# Build whisper.cpp for this platform
# The bundled Makefile uses -mcpu=native which fails on aarch64 Docker (QEMU),
# so we replace it with a safe generic target before compiling.
RUN cd node_modules/whisper-node/lib/whisper.cpp && \
    sed -i 's/-mcpu=native/-mcpu=generic+fp+simd/g' Makefile && \
    make -j$(nproc) main

# Download whisper base.en model into whisper-node's expected location
RUN curl -L --progress-bar -o node_modules/whisper-node/lib/whisper.cpp/models/ggml-base.en.bin \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

# Copy app files (.dockerignore excludes node_modules so the Linux binary is preserved)
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev dependencies to keep the production image lean
RUN npm prune --omit=dev

# Stage 2: Production
FROM node:24-slim

# Install only the runtime dependency (ffmpeg for audio conversion)
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built app and production-only node_modules from builder
COPY --from=builder /app .

# Create uploads directory for temp audio files
RUN mkdir -p uploads

# Expose port
EXPOSE 3000

# Create non-root user and fix ownership
RUN groupadd -r appuser && useradd -r -g appuser -d /app appuser && \
    chown -R appuser:appuser /app
USER appuser

# Start the app (TypeScript already compiled during build; just migrate + run)
CMD ["npm", "run", "start:built"]
