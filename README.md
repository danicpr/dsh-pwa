# dsh-pwa

Desktop wrapper for DeepSeek Harness (`dsh web`) on Linux, built with Electron.

This project was vibecoded to have a standalone desktop window and system tray for `dsh web` without relying on browser-specific PWA quirks.

## Features

- **Automatic server lifecycle**: Connects to an existing `dsh web` instance on `127.0.0.1:3080`, or starts `dsh --profile web` automatically on launch and stops it when quitting.
- **Local session auth**: Reads `~/.dsh/.credentials.yaml` to sign the local session cookie automatically.
- **System tray**: Closing the window hides it to the tray instead of killing active sessions. Supports `Show`/`Hide`, `Reload`, and `Quit`, plus `dsh-pwa --minimized` to start hidden.
- **Wayland & GPU support**: Runs natively on Wayland/X11 (`--ozone-platform-hint=auto`) with WebGL2 and hardware video decoding enabled.
- **Clean host environment**: Even when running from the AppImage, `dsh web` is spawned with AppImage variables stripped so local tools and file associations work normally.

## Requirements

- `dsh` CLI installed in your user environment (`fnm`, `nvm`, `pnpm`, or `~/.local/bin`).

## Installation

Grab the latest package from [Releases](https://github.com/danicpr/dsh-pwa/releases):

### Arch Linux / CachyOS
Uses the system `electron43` package:
```bash
sudo pacman -U dsh-pwa-1.2.0-1-any.pkg.tar.zst
```

Or build from `pkgbuild/`:
```bash
cd pkgbuild
makepkg -si
```

### Fedora / RHEL / openSUSE
Bundles its own Electron runtime:
```bash
sudo dnf install ./dsh-pwa-1.2.0-x86_64.rpm
```

### AppImage
Bundles its own Electron runtime:
```bash
chmod +x dsh-pwa-1.2.0-x86_64.AppImage
./dsh-pwa-1.2.0-x86_64.AppImage
```

## Building from source

```bash
npm install
npm run build:appimage
npm run build:rpm
```

## Environment Variables

- `DSH_PWA_PORT`: Port for `dsh web` (default: `3080`)
- `DSH_PWA_HOST`: Host for `dsh web` (default: `127.0.0.1`)
- `DSH_BIN`: Explicit path to the `dsh` executable
