#!/bin/sh
# Print the HMN key-encryption key from the login Keychain, creating it once.
# The key is not written to a file. Redirect this into a Docker secret yourself
# if you run the container:  scripts/keychain-kek.sh > kek.secret && chmod 600 kek.secret
set -eu
if ! security find-generic-password -s hmn.kek -a hmn -w >/dev/null 2>&1; then
  key=$(openssl rand -base64 32 | tr -d '\n' | tr '+/' '-_' | cut -c1-43)
  security add-generic-password -s hmn.kek -a hmn -w "$key" -U
fi
security find-generic-password -s hmn.kek -a hmn -w
