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

echo "Opening firewall ports..."

if command -v ufw &> /dev/null; then
    ufw allow 4000/tcp
    ufw allow 51820/udp
    echo "ufw rules added: 4000/tcp, 51820/udp"
elif command -v iptables &> /dev/null; then
    iptables -C INPUT -p tcp --dport 4000 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 4000 -j ACCEPT
    iptables -C INPUT -p udp --dport 51820 -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport 51820 -j ACCEPT
    echo "iptables rules added: 4000/tcp, 51820/udp"
else
    echo "Warning: no firewall tool found. Please manually open 4000/tcp and 51820/udp."
fi

echo "Enabling IP forwarding..."
sysctl -w net.ipv4.ip_forward=1

echo "Configuring forwarding for WireGuard mesh traffic..."
if command -v ufw &> /dev/null; then
    ufw default allow forward 2>/dev/null || true
    echo "ufw default forward policy set to allow"
elif command -v iptables &> /dev/null; then
    iptables -C FORWARD -i wg0 -o wg0 -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
        iptables -I FORWARD -i wg0 -o wg0 -m state --state ESTABLISHED,RELATED -j ACCEPT
    iptables -C FORWARD -i wg0 -o wg0 -m state --state NEW -j ACCEPT 2>/dev/null || \
        iptables -I FORWARD -i wg0 -o wg0 -m state --state NEW -j ACCEPT
    echo "iptables FORWARD rules added for wg0"
fi
