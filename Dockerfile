FROM node:20

# Install ffmpeg for audio format conversion and build tools for whisper.cpp
RUN apt-get update && apt-get install -y ffmpeg build-essential curl

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

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

# Create uploads directory for temp audio files
RUN mkdir -p uploads

# Expose port
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
