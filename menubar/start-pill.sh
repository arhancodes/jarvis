#!/bin/bash
# Compile + run the JARVIS "Golden Gate" pill (standalone, ⌥-Space to summon).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$SCRIPT_DIR/jarvis-pill"
SOURCE="$SCRIPT_DIR/JarvisPill.swift"

pkill -f jarvis-pill 2>/dev/null

if [ ! -f "$BINARY" ] || [ "$SOURCE" -nt "$BINARY" ]; then
    echo "Compiling JARVIS pill..."
    swiftc -O "$SOURCE" -o "$BINARY" -framework Cocoa -framework Carbon 2>&1
    if [ $? -ne 0 ]; then
        echo "Failed to compile pill"
        exit 1
    fi
    echo "Pill compiled."
fi

"$BINARY" &
disown
echo "JARVIS pill is running — press ⌥-Space to summon."
