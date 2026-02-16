#!/bin/bash
# Setup script for whisper.cpp model download
# Downloads the model file directly into whisper-node's expected location.

set -e

MODEL_NAME="${1:-base.en}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== vibesOnly Whisper Setup ==="
echo ""

# Check for ffmpeg (needed for audio format conversion)
if ! command -v ffmpeg &> /dev/null; then
  echo "WARNING: ffmpeg is not installed."
  echo "  ffmpeg is required for converting recorded audio to WAV format."
  echo ""
  echo "  Install with:"
  echo "    macOS:  brew install ffmpeg"
  echo "    Ubuntu: sudo apt-get install ffmpeg"
  echo "    Docker: apt-get install -y ffmpeg"
  echo ""
  exit 1
fi

# Check for node_modules
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "Installing npm dependencies..."
  cd "$PROJECT_DIR" && npm install
fi

# Ensure whisper-node is installed and compiled
WHISPER_CPP_DIR="$PROJECT_DIR/node_modules/whisper-node/lib/whisper.cpp"
MODELS_DIR="$WHISPER_CPP_DIR/models"
MODEL_FILE="$MODELS_DIR/ggml-${MODEL_NAME}.bin"

if [ ! -d "$WHISPER_CPP_DIR" ]; then
  echo "ERROR: whisper-node not installed. Run 'npm install' first."
  exit 1
fi

# Build whisper.cpp if main binary doesn't exist
if [ ! -f "$WHISPER_CPP_DIR/main" ]; then
  echo "Building whisper.cpp..."
  cd "$WHISPER_CPP_DIR" && make
fi

# Download model if not already present
if [ -f "$MODEL_FILE" ]; then
  echo "Model '$MODEL_NAME' already downloaded at:"
  echo "  $MODEL_FILE"
  echo ""
else
  echo "Downloading whisper model: $MODEL_NAME"
  echo "This may take a few minutes depending on model size and connection..."
  echo ""

  DOWNLOAD_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin"

  curl -L --progress-bar -o "$MODEL_FILE" "$DOWNLOAD_URL"

  if [ ! -f "$MODEL_FILE" ]; then
    echo "ERROR: Download failed."
    exit 1
  fi

  FILE_SIZE=$(ls -lh "$MODEL_FILE" | awk '{print $5}')
  echo ""
  echo "Downloaded: $MODEL_FILE ($FILE_SIZE)"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Model '$MODEL_NAME' is ready."
echo "Start the server with: npm start"
echo ""
