# 🎛 MASCHINE Project Uploader

**rclone-powered Google Drive backup GUI for Native Instruments MASCHINE projects**

Upload your MASCHINE projects, samples, and presets to Google Drive with a clean, real-time browser interface — no terminal required.

---

## Features

- **Smart file scanning** — filter by time window (2h → 7d → All) and file type presets
- **Real-time upload progress** — SSE streaming per-file and overall progress bars
- **Dry-run mode** — simulate uploads without any actual transfer
- **Selective upload** — checkbox selection with select all/none/invert/by-type
- **Bandwidth throttling** — via rclone `--bwlimit`
- **Conflict handling** — overwrite / skip if exists / skip if checksum matches
- **Upload history** — session log with file counts, duration, destination
- **Directory browser** — GUI folder picker for source path
- **Extension stats** — clickable type breakdown (mxprj, wav, nki, etc.)
- **Search & sort** — filter files by name/directory, sort by date/size/name
- **Config persistence** — settings saved to `~/.maschine-uploader/config.json`
- **Keyboard shortcuts** — `R` scan, `U` upload, `L` log, `Ctrl+S` save config

---

## Requirements

- **Node.js** ≥ 18
- **rclone** configured with a Google Drive remote

### Install rclone (macOS)
```bash
brew install rclone
rclone config  # follow prompts to add your gdrive: remote
```

---

## Setup

```bash
cd MaschineProjectUploader
npm install
npm start
```

Then open **http://localhost:3847** in your browser.

---

## Configuration

All settings persist to `~/.maschine-uploader/config.json`.

| Key | Default | Description |
|-----|---------|-------------|
| `sourceFolder` | `/Volumes/STUDIO/PROJECTS/MASCHINE` | Local path to scan |
| `gdriveRemote` | `gdrive:` | rclone remote name |
| `gdriveFolderName` | `MASCHINE_BACKUP` | Destination folder prefix |
| `appendDate` | `true` | Append `___YYYY-MM-DD_HH-MM-SS` to folder name |
| `gdriveFolderId` | — | Google Drive folder ID for direct link after upload |
| `defaultHours` | `48` | Default time window |
| `extensions` | `mxprj nki nksf nkm nkp wav aif aiff mp3 flac ogg m4a mid midi` | File types to include |
| `excludePatterns` | `*.backup *.tmp *~` | Patterns to exclude |
| `transfers` | `2` | Parallel rclone transfers |
| `bwLimit` | — | Bandwidth limit (e.g. `10M`, `2.5M`) |
| `conflictMode` | `overwrite` | `overwrite` / `skip` / `checksum` |

---

## Supported File Types

| Type | Extensions | Color |
|------|-----------|-------|
| MASCHINE Project | `.mxprj` | Violet |
| Audio | `.wav` `.aif` `.aiff` | Teal |
| Compressed Audio | `.mp3` `.flac` `.ogg` `.m4a` | Blue |
| NI Formats | `.nki` `.nksf` `.nkm` `.nkp` `.nkc` `.nkb` `.nks` | Amber |
| MIDI | `.mid` `.midi` | Green |

---

## Phusion Passenger Deployment

The server uses `app.listen(PORT)` with no host argument for Passenger compatibility.

Set environment variable `PORT` if needed:
```bash
PORT=3847 npm start
```

---

## Project Structure

```
MaschineProjectUploader/
├── server.js          Express backend + SSE upload streaming
├── public/
│   └── index.html     Single-file frontend (no build step)
├── package.json
└── README.md
```

---

*by doerd — [doerd.de](https://doerd.de)*
