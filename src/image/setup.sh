#!/usr/bin/env bash
set -euo pipefail

# HAL9999 Golden Image Setup
# Run this on a fresh Debian 12 (Bookworm) instance, then snapshot it.
# Usage: ssh root@<ip> 'bash -s' < setup.sh

echo "==> Updating system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq

echo "==> Installing base tools"
apt-get install -y -qq \
  git \
  curl \
  wget \
  unzip \
  build-essential \
  ca-certificates \
  gnupg \
  jq \
  openssh-server

echo "==> Installing Node.js 22 LTS"
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq nodejs

echo "==> Installing bun"
curl -fsSL https://bun.sh/install | bash
cp /root/.bun/bin/bun /usr/local/bin/bun

echo "==> Creating agent user"
useradd -m -s /bin/bash -G sudo agent
echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent

# Copy bun to agent user
mkdir -p /home/agent/.bun/bin
cp /root/.bun/bin/bun /home/agent/.bun/bin/bun
chown -R agent:agent /home/agent/.bun
echo 'export BUN_INSTALL="$HOME/.bun"' >> /home/agent/.bashrc
echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> /home/agent/.bashrc

echo "==> Creating workspace directory"
mkdir -p /workspace
chown agent:agent /workspace

echo "==> Hardening SSH"
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config

# Copy root's authorized_keys to agent user so SSH access works
mkdir -p /home/agent/.ssh
cp /root/.ssh/authorized_keys /home/agent/.ssh/authorized_keys
chown -R agent:agent /home/agent/.ssh
chmod 700 /home/agent/.ssh
chmod 600 /home/agent/.ssh/authorized_keys

echo "==> Installing GitHub CLI (gh)"
mkdir -p -m 755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update -qq
apt-get install -y -qq gh

echo "==> Cleaning up to minimize snapshot size"
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

echo "==> Verifying installations"
echo "  git:  $(git --version)"
echo "  node: $(node --version)"
echo "  npm:  $(npm --version)"
echo "  bun:  $(bun --version)"
echo "  gh:   $(gh --version | head -1)"

echo ""
echo "Golden image setup complete."
echo "You can now snapshot this instance."
