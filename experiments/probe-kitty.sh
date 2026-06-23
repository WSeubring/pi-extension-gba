#!/usr/bin/env bash
# Kitty graphics probe — 4x4 red square, inline base64 (t=d).
# Run in your Ghostty. If red square visible = Ghostty Kitty graphics OK.
# Then we know issue is pi integration, not terminal.
set -eu

# 4x4 RGBA, all (255,0,0,255) = 64 bytes
python3 -c "
import base64, sys
data = bytes([255,0,0,255] * 16)
b64 = base64.b64encode(data).decode()
# chunked: fits under 4096 byte limit easily
sys.stdout.write(f'\x1b_Ga=T,f=32,s=4,v=4,q=2;{b64}\x1b\\\\')
sys.stdout.write('\n<-- if you see red square above this line, inline (t=d) works\n')
"

# File-based probe — matches extension's actual path
FILE=/dev/shm/probe-gba-$$.rgba
python3 -c "
import sys
sys.stdout.buffer.write(bytes([0,255,0,255]*16))
" > "$FILE"

# base64-encode the path (Kitty spec requires path be base64 in payload)
PATH_B64=$(printf '%s' "$FILE" | base64 -w0)
printf '\x1b_Ga=T,f=32,t=f,s=4,v=4,q=2;%s\x1b\\\n' "$PATH_B64"
echo "<-- if green square above, file transfer (t=f) works"
echo "probe file: $FILE (delete manually if needed)"
