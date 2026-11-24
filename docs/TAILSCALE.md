# Tailscale

HMN does not open a port on the router. When the phone is away from home it reaches the mini over Tailscale. The server already speaks TLS. Tailscale is the private network, not a substitute for the API key or the certificate pin.

These steps are for the owner's Mac and iPhone. They are not run from this repository.

1. Install Tailscale on the Mac mini and on the iPhone, and sign both into the same tailnet.
2. Leave HMN bound to `0.0.0.0:8787` on the mini, or bind it to the Tailscale address only if the phone will never use the LAN address. Do not forward 8787 on the home router.
3. On the mini, `tailscale ip -4` prints the address. The phone's server URL is `https://<that-address>:8787`.
4. The certificate is a private CA. Copy `data/tls/ca.crt` to the phone only if you want the system to trust it. The app also pins the fingerprint printed at startup. Put that fingerprint in Settings. A different certificate is refused even if something else on the tailnet answers.
5. Pair the phone from the mini (`deploy/hmn pair`, or Pair a phone in the menu bar) and type the code in Settings. Do not copy the owner key into the phone.
6. Confirm from the phone, on cellular with Wi-Fi off, that Today loads and that a machine outside the tailnet cannot open the port.

If the mini reboots, Tailscale should start before HMN. A launchd plist or Docker restart policy is enough. The Keychain must be unlocked before HMN can unwrap the database key, which means a login session, not only a power-on.
