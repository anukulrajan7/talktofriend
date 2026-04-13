#!/bin/bash
# Generate PWA icons from icon.svg
# Requires macOS sips or rsvg-convert

SVG="public/icon.svg"
OUT192="public/icon-192.png"
OUT512="public/icon-512.png"

if command -v rsvg-convert &> /dev/null; then
  rsvg-convert -w 192 -h 192 "$SVG" -o "$OUT192"
  rsvg-convert -w 512 -h 512 "$SVG" -o "$OUT512"
elif command -v sips &> /dev/null; then
  sips -s format png -Z 192 "$SVG" --out "$OUT192" 2>/dev/null || echo "sips doesn't support SVG directly"
else
  echo "Install librsvg (brew install librsvg) or similar to generate icons"
  exit 1
fi
echo "Icons generated"
