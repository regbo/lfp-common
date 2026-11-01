#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

has_command() {
  command_path=$(command -v "$1" 2>/dev/null || true)
  [ -n "$command_path" ]
}

for command_name in node python python3 uv; do
  if has_command "$command_name"; then
    echo "Expected a Node-free, zero-Python image, but found $command_name." >&2
    exit 1
  fi
done

apt-get update -qq
apt-get install -y -qq --no-install-recommends build-essential ca-certificates
rm -rf /var/lib/apt/lists/*

for command_name in node python python3 uv; do
  if has_command "$command_name"; then
    echo "Host preparation unexpectedly installed $command_name." >&2
    exit 1
  fi
done

mkdir -p /work/pyfig /work/pynect
tar -C /source/pyfig \
  --exclude=.git --exclude=.venv --exclude=build --exclude=dist --exclude=node_modules \
  -cf - . | tar -C /work/pyfig -xf -
tar -C /source/pynect \
  --exclude=.git --exclude=.venv --exclude=build --exclude=dist --exclude=node_modules \
  -cf - . | tar -C /work/pynect -xf -

cd /work/pyfig
bun install --ignore-scripts
bun run build
bun run test:zero-python

cd /work/pynect
bun install --ignore-scripts
rm -rf /work/pynect/node_modules/pyfig
ln -s /work/pyfig /work/pynect/node_modules/pyfig
bun run build:ts
test ! -f /work/pynect/build/Release/pynect_addon.node
bun run test:python-boundary

for command_name in node python python3 uv; do
  if has_command "$command_name"; then
    echo "The Node-free simulation unexpectedly exposed $command_name." >&2
    exit 1
  fi
done
