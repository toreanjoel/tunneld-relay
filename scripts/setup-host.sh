#!/bin/bash
set -e

echo "Checking WireGuard kernel module..."

if lsmod | grep -q "^wireguard"; then
    echo "WireGuard module already loaded."
    exit 0
fi

if modprobe wireguard 2>/dev/null; then
    echo "WireGuard module loaded."
    exit 0
fi

echo "WireGuard module not available. Attempting to install..."

if command -v apt-get &> /dev/null; then
    apt-get update
    apt-get install -y wireguard linux-headers-$(uname -r)
    modprobe wireguard
elif command -v apk &> /dev/null; then
    apk add --no-cache wireguard-tools wireguard-linux-compat
    modprobe wireguard
else
    echo "Unsupported distro. Please install WireGuard kernel module manually."
    exit 1
fi

echo "WireGuard ready."
