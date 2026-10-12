# USB-C Feasibility: Android Deck to Windows Studio

**Status:** PocketDeck now has an ADB reverse TCP transport path that reuses
the TLS-pinned v2 WebSocket listener. It requires a data-capable cable,
Android USB debugging, the phone's ADB RSA authorization, and explicit
PocketDeck pairing approval. It has not been tested on physical USB hardware.

## Verified platform facts

- Android supports USB host mode on devices that implement it. In host mode
  Android powers/enumerates attached USB devices and uses `UsbManager`,
  `UsbDevice`, interfaces/endpoints, and `UsbDeviceConnection`. Android's
  documentation says not all Android devices guarantee USB host support and
  the app must request permission to access the attached USB device:
  [Android USB host](https://developer.android.com/develop/connectivity/usb/host).
- Android also supports USB accessory mode on supported devices. In accessory
  mode the external accessory is the USB host and Android is the USB device;
  the accessory must implement Android Open Accessory protocol:
  [Android USB accessory](https://developer.android.com/develop/connectivity/usb/accessory)
  and [AOA support](https://source.android.com/docs/core/interaction/accessories/protocol).
- Windows provides the in-box `Usbser.sys` driver for supported USB CDC
  communications devices. A device descriptor with the relevant CDC class and
  subclass can cause the driver to load; Windows exposes serial APIs, including
  `Windows.Devices.SerialCommunication` for UWP:
  [Microsoft USB Serial Driver (Usbser.sys)](https://learn.microsoft.com/en-us/windows-hardware/drivers/usbcon/usb-driver-installation-based-on-compatible-ids).
  This is a device/driver-class behavior, not evidence that a generic Android
  phone will enumerate as a Windows COM port.

## Compatibility assessment

A USB-C connector describes connector/role capabilities; it does not establish
that two computers can exchange application bytes over a cable. USB links
require compatible host/device data roles and a protocol/driver at each end.
Two ordinary host-role ports do not become a serial cable merely by connecting
them with a C-to-C cable. Role swaps, USB host/OTG support, USB accessory
support, charging/data cable wiring, vendor firmware, and OS APIs vary by
phone and PC.

The selected software transport is ADB reverse:

1. Windows enumerates Android devices with `adb devices -l` and exposes only
   devices whose ADB output explicitly identifies a USB transport.
2. After the phone is in the authorized `device` state, the Windows studio
   runs `adb -s <serial> reverse tcp:<port> tcp:<port>`.
3. Android connects to `127.0.0.1:<port>` over TLS, verifies the certificate
   fingerprint provisioned by the Windows QR code, and uses the existing v2
   WebSocket messages. Wi-Fi need not be enabled.
4. A first-time USB claim is PIN-free but is accepted only over the loopback
   listener. It remains pending until the user explicitly approves the phone
   in the Windows Devices page. Approval creates the same stored device
   credential used by Wi-Fi; USB access alone never authorizes actions.
5. Windows can remove PocketDeck's reverse mapping with the matching ADB
   `reverse --remove` command. Socket closure and the Android reconnect loop
   provide disconnect/reconnect signaling.

This is an ADB debugging transport, not native USB host/accessory or CDC
serial. ADB host authorization grants debugging capabilities beyond
PocketDeck, so it should only be enabled for a trusted development/device
pairing environment. Do not leave USB debugging authorized on shared or
untrusted computers.

Potential approaches, neither selected nor verified:

1. **Android phone as USB host, Windows as USB device/gadget.** The Android
   side can use documented host APIs, but the Windows PC must expose a
   compatible USB device function. Ordinary consumer PCs generally expose
   host ports; do not assume they can act as the accessory/peripheral.
2. **Windows-side accessory as host, Android in accessory mode.** Android
   supports AOA on compatible devices, but Windows must implement AOA's
   accessory protocol, device identity, power, and data interface. No such
   implementation exists in PocketDeck.
3. **CDC/ACM serial adapter or custom hardware.** Windows can use its CDC
   serial driver when the attached hardware enumerates compatibly. Android
   must access the corresponding USB interface in host mode, request user
   permission, and implement compatible serial framing. This adds adapter or
   firmware requirements and is not equivalent to direct phone-to-PC USB-C.
4. **USB networking/RNDIS-like link.** This would still require compatible
   gadget/driver roles, address assignment, discovery, and secure network
   transport. No evidence in this repository establishes it.

## Physical validation still required

1. Choose at least one named Android phone model, Windows PC/USB controller,
   cable/adapter, and supported Windows version.
2. Confirm the negotiated USB power and data roles and whether Windows sees a
   device/COM interface; record exact device IDs and driver. Test disconnect,
   suspend/resume, reconnect, permission denial, and USB hubs.
3. Confirm the selected phone enumerates with `usb:` metadata in `adb devices
   -l`, and that unauthorized/offline ADB states fail closed.
4. Verify ADB reverse survives reconnect and is removed after an intentional
   disconnect; exercise cable removal, phone lock, suspend/resume, and user
   denial of ADB debugging.
5. Run the same protocol-v2 conformance suite over the ADB reverse route and
   Wi-Fi. This repository's unit/integration tests do not substitute for the
   physical test.

## Decision and blockers

Do not describe USB as physically validated or universally compatible. The
implementation depends on Android developer options and Windows Android
Platform Tools. PocketDeck pairing approval, TLS pinning, and device
credentials remain mandatory. No phone is connected in the current workspace,
so disconnect/reconnect and actual data transfer still need hardware testing.
