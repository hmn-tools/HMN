# TestFlight

The Xcode project leaves the signing team empty on purpose. Filling it in is a local change and should not be committed.

1. Open `ios/HMN.xcodeproj` on the Mac. Set the Development Team on the HMN target and the HMNWidget target to the owner's Apple Developer team.
2. Create the App Group `group.org.hmn` for both targets. Until that group exists, the widget shows "Open HMN and set the server." The app still runs.
3. Confirm the bundle ids stay `org.hmn` and `org.hmn.widget`.
4. Raise the build number (`CURRENT_PROJECT_VERSION`) for each upload. App Store Connect refuses a build number that it has. The version of the app, the server, and the release tag is the same number (0.2.0 for the release of 2026-11-23).
5. Build to a phone once before archiving. Check three things: the certificate pin rejects a substituted certificate, Face ID or the passcode runs before a vault grant, and the widget snapshot does not contain family names. The snapshot is requested with the widget ceiling.
6. Archive the HMN scheme and upload it to App Store Connect. Add the owner as an internal tester. The build points at the Tailscale URL from [TAILSCALE.md](TAILSCALE.md), typed into Settings on the phone. The address must start with `https://`. The URL is not compiled into the app.
7. Do not ship a build that was started with `HMN_INSECURE_DEV_KEK`. The mini that the TestFlight build talks to uses the Keychain key.

Linux cannot archive this app. Nothing in that pipeline is claimed to have run here.
