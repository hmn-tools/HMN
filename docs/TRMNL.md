# TRMNL on the mini

A TRMNL OG on the LAN can show HMN. The server speaks the device's [BYOS API](https://docs.trmnl.com/go/diy/byos): setup, display, and log. The image is drawn here. Nothing is fetched from TRMNL, and no firmware file is offered.

The panel is 800×480 for a TRMNL OG, and 1872×1404 for a TRMNL X. The device sends `Model: og` or `Model: x`. Point it at the mini's TLS address, the same port as the phone (`https://<mini>:8787`). The device must trust the mini's CA, or a proxy on the LAN must. Do not publish port 8787.

The screen is the Public deck: today, upcoming, commitments, quiet. Family, tasks, and sealed notes are not in the image, even if the caller holds the owner key. The picture is the same one the shared display is allowed to show.

## Pair a display

The device calls setup with its MAC address in the `ID` header and no key yet. HMN answers HTTP 200 with a JSON `status` of 404, a `friendly_id`, and an image that shows that id. No key is issued. HMN records the address of that call. The key goes only to that address. If another address asks as the same display before the key is delivered, the pairing stops: revoke the display on the mini and restart it. A display that was never claimed is removed after one hour.

On the mini:

```sh
curl --cacert "$CA" -H "Authorization: Bearer $HMN_OWNER_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Kitchen"}' \
  -X POST "https://127.0.0.1:8787/api/v1/trmnl/devices/FRIENDLY/claim"
```

`FRIENDLY` is the six characters on the panel. This call is accepted only from loopback. It returns `api_key` once. The next setup from that MAC returns the same key once, then forgets it. The display stores the key and sends it as `Access-Token` after that.

If you already know the MAC, you can skip the waiting step:

```sh
curl --cacert "$CA" -H "Authorization: Bearer $HMN_OWNER_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Kitchen","mac":"41:B4:10:39:A1:24"}' \
  -X POST https://127.0.0.1:8787/api/v1/trmnl/devices
```

That is also loopback only. The key is a read credential, maximum tier Public, with the ceiling forced to Public. It cannot open the vault, and it is not the owner key or the shared display key.

`GET /api/v1/trmnl/devices` lists displays. It does not list keys.

## The fridge: a household display

A display can be claimed at Household, for the people who live in the home. Add `"ceiling": "household"` to the claim:

```sh
curl --cacert "$CA" -H "Authorization: Bearer $HMN_OWNER_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Fridge","ceiling":"household"}' \
  -X POST "https://127.0.0.1:8787/api/v1/trmnl/devices/FRIENDLY/claim"
```

- Its key is a read credential at Household. It is the only display key that reads above Public. Hide from the mini pushes it down to Public.
- It shows four household screens, one for each time of day, in the owner's time zone: This morning (06:00), This week (09:00), Tonight and tomorrow (16:00), and Good night (21:00). [ONTOLOGY.md](ONTOLOGY.md), section 5.3, has the design.
- The morning and evening screens show the children's routines that are due today, one row for each child: what is left, or "all done". A tick on a phone changes the picture, so the fridge shows it at its next refresh.
- The evening screen ends with the list that changed last (a project of the kind `list`), its open items on one yellow row with black text. The list keeps its row when the evening is full. A list above Household is not on the fridge.
- The image name changes only when the picture changes, and the display asks again every ten minutes or at the next window. So the panel refreshes only for a change.
- The image is `GET /api/trmnl/fridge.png` (or `.bmp` for a black and white panel). It answers 404 for every key that is not a household display.

### The TRMNL BWRY (black, white, red, yellow)

The four-colour TRMNL sends `Model: og_4clr` (a newer board sends `og_gen2_4clr`). HMN then draws a 2-bit indexed PNG with the four exact inks, as TRMNL serves a colour image: black text, red for the next start and for a task due today, a yellow line under the title, and in the evening the list on a yellow band. A Public display on this panel gets the same deck as before, in black and white, as a palette PNG: a 1-bit BMP is not safe on this panel. To set the inks by hand, add `"palette": "bwry"` (or `"bw"`) to the claim. One colour refresh takes about 13 seconds.

This was tested against the firmware's own test files and HMN's tests. It was not tested on a real BWRY panel.

## What the device calls

Headers are the ones the firmware sends. `ID` is the MAC. `Access-Token` is the device key after setup. `Width`, `Height`, `Battery-Voltage`, `RSSI`, `FW-Version`, and `Model` are recorded on the device row. They are not written into the graph.

### Setup

`GET /api/setup`

Before a claim, JSON `status` is 404 and `api_key` is null. The firmware treats any status other than 200 as "not ready" and retries. After a claim, the next call returns `status` 200 and `api_key`. A later call returns `status` 200 and no key, so a retry does not mint a second secret. To pair again, revoke the display and claim it again.

### Display

`GET /api/display` with the `ID` header, and `GET /api/display/current`.

```json
{
  "status": 0,
  "image_url": "https://mini.local:8787/api/trmnl/image.bmp?access_token=...&screen=today",
  "filename": "today-ab12cd-1762848000",
  "refresh_rate": 3600,
  "reset_firmware": false,
  "update_firmware": false,
  "firmware_url": null,
  "special_function": "none",
  "maximum_compatibility": false,
  "temperature_profile": "default"
}
```

`status` 0 means draw the image. `refresh_rate` is a number of seconds, one hour, matching the deck. `reset_firmware` is false, so the device does not wipe its Wi-Fi. `update_firmware` is false and `firmware_url` is null, so the mini never asks the panel to download a binary. `special_function` stays `none`.

`filename` is at most 31 characters and changes when the pixels change, or when the hour changes. The same picture keeps the same name, so the panel does not rewrite flash on every wake.

A `GET /api/display` without the `ID` header is the older HMN payload: `image_url` points at `/api/display/<screen>.png`. Phones and tests use that path. It is still Public.

### Log

`POST /api/log` with `{"logs":[...]}` returns 204. Lines are truncated. A value that looks like an `hmn_` secret or an `access_token` query is stored as `[secret]`. Logs are not titles from the graph.

## Images

Drawn with the bitmap font already in the server. No network call.

| URL | Bytes |
| --- | --- |
| `/api/trmnl/image.bmp` | OG. BMP3, 800×480, 1 bit, 48062 bytes. Palette 0 is black, 1 is white. |
| `/api/trmnl/image.png` | OG. PNG greyscale, 1 bit. `depth=4` is four greys. |
| `/api/trmnl/image.png?model=x` | TRMNL X. PNG greyscale, 1872×1404, 4 bits (sixteen greys). The display response uses this URL when `Model` is `x`. |

The firmware picks the decoder from `Content-Type`: `image/bmp` or `image/png`. An OG image stays under 90000 bytes. An X image stays under 750000 bytes. The image URL includes `access_token` because the panel fetches the picture without a header. That query will show up in a proxy log. The key can only read Public. Keep the server on the LAN or the tailnet.

The deck advances once an hour, the same rule as the shared display. Forcing `?screen=today` on the image does not move the cursor. Week, inbox, and agents are not on this device.

## Revoke

```sh
curl --cacert "$CA" -H "Authorization: Bearer $HMN_OWNER_KEY" \
  -X POST "https://127.0.0.1:8787/api/v1/trmnl/devices/CREDENTIAL_ID/revoke"
```

The id may be the credential id, the device id, or the friendly id. The next display request with the old key is 401. `POST /api/v1/devices/:id/revoke` revokes the credential as well. Revocation is not limited to loopback, so a paired phone can retire a display. Minting a new key is loopback only.

## What this does not do

- It does not offer an OTA firmware URL.
- It does not show Private or Sealed rows, and it does not show the "sealed proposal" line. A kitchen panel should not announce that.
- It does not call out to trmnl.com, a font host, or an image host.
